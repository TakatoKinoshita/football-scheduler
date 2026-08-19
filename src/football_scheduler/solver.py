"""OR-Tools CP-SATを用いたFaaS非依存の技術検証スケジューラ。"""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Mapping
from dataclasses import dataclass
from functools import cache
from importlib.metadata import version
from itertools import combinations, combinations_with_replacement, pairwise, product
from time import perf_counter
from typing import Any

from ortools.sat.python import cp_model

from football_scheduler.models import (
    ArrivalPreferenceEarlyMatch,
    Day1ArrivalPreferenceMetric,
    Diagnostic,
    MatchSpec,
    ObjectiveStageMetric,
    RefereeAssignment,
    RefereeKind,
    ScheduleRequest,
    ScheduleResult,
    Slot,
    SolverMetrics,
    SolverStatus,
    TeamRefereeCount,
)
from football_scheduler.timekeeping import expected_end_time, resolve_max_sections, section_timings

_STATUS_MAP = {
    cp_model.OPTIMAL: SolverStatus.OPTIMAL,
    cp_model.FEASIBLE: SolverStatus.FEASIBLE,
    cp_model.INFEASIBLE: SolverStatus.INFEASIBLE,
    cp_model.UNKNOWN: SolverStatus.UNKNOWN,
}
_ORTOOLS_VERSION = version("ortools")
_MAX_SOLVER_TIME_RESERVE_SECONDS = 4.5
_FULL_API_TIME_BUDGET_SECONDS = 30.0
_MIN_FAIRNESS_TIME_SECONDS = 2.0
_LARGE_LEAGUE_FAIRNESS_TIME_SECONDS = 8.0
_MINIMUM_HORIZON_TIME_SHARE = 0.85
_DAY1_HINT_PROOF_TIME_SECONDS = 5.0
_DAY1_ID = "day1"


def solve_schedule(request: ScheduleRequest | Mapping[str, Any]) -> ScheduleResult:
    """大会入力を検証し、日程を生成する。

    Lambdaなどの実行環境には依存しない。辞書を渡した場合もPydantic契約で検証してから
    CP-SATを実行する。
    """

    if not isinstance(request, ScheduleRequest):
        request = ScheduleRequest.model_validate(request)

    started_at = perf_counter()
    horizon = resolve_max_sections(request.day, max(1, len(request.matches) * 2))
    # モデル構築、JSON変換、独立検証も含めてAPIの時間上限内へ収める。
    solver_time_reserve = (
        _MAX_SOLVER_TIME_RESERVE_SECONDS
        if request.solver.max_time_seconds >= _FULL_API_TIME_BUDGET_SECONDS
        else 0.0
    )
    solver_time_budget = max(0.000001, request.solver.max_time_seconds - solver_time_reserve)

    preflight_diagnostics = _preflight(request, horizon)
    if preflight_diagnostics:
        return _result_without_schedule(
            request,
            SolverStatus.INFEASIBLE,
            perf_counter() - started_at,
            preflight_diagnostics,
        )

    minimum_horizon = (len(request.matches) + len(request.courts) - 1) // len(request.courts)
    strict_day1_league_referees = (
        request.day.id == _DAY1_ID
        and request.referees.team_referees_required_after_first
        and all(match.phase == "league" for match in request.matches)
    )
    if minimum_horizon < horizon and not strict_day1_league_referees:
        # 容量上の理論最小値で実行可能なら、第1目的の最適性は探索せずとも
        # 証明できる。広い未使用区間を持つモデルよりも安定して同じ解を得やすい。
        minimum_result = _solve_schedule_at_horizon(
            request,
            minimum_horizon,
            solver_time_budget * _MINIMUM_HORIZON_TIME_SHARE,
        )
        if minimum_result.slots:
            return minimum_result

        remaining_time = solver_time_budget - (perf_counter() - started_at)
        if remaining_time <= 0.001:
            return _result_without_schedule(
                request,
                SolverStatus.UNKNOWN,
                perf_counter() - started_at,
                (_failure_diagnostic(SolverStatus.UNKNOWN, request, horizon),),
            )
        fallback_result = _solve_schedule_at_horizon(request, horizon, remaining_time)
        return _with_total_solver_wall_time(
            fallback_result,
            minimum_result.metrics.wall_time_seconds,
        )

    if strict_day1_league_referees and _supports_compact_day1_league_model(request):
        return _solve_compact_day1_league(request, horizon, solver_time_budget)

    return _solve_schedule_at_horizon(request, horizon, solver_time_budget)


@dataclass(frozen=True)
class _CompactDay1LeagueModel:
    model: cp_model.CpModel
    placement: dict[tuple[int, int, int], cp_model.IntVar]
    match_in_section: dict[tuple[int, int], cp_model.IntVar]
    slot_occupied: dict[tuple[int, int], cp_model.IntVar]
    team_referee: dict[tuple[int, int, str], cp_model.IntVar]
    referee_counts: dict[str, cp_model.IntVar]
    referee_count_difference: cp_model.IntVar
    variable_count: int
    constraint_count: int


@dataclass(frozen=True)
class _ObjectiveAudit:
    best_bound: float | None
    optimality_proven: bool
    termination_reason: str


@dataclass(frozen=True)
class _ArrivalPreferenceObjective:
    early_match_count: cp_model.IntVar
    total_section_shortfall: cp_model.IntVar
    combined_score: cp_model.IntVar


def _add_day1_arrival_preference_objective(
    model: cp_model.CpModel,
    request: ScheduleRequest,
    match_in_section: Mapping[tuple[int, int], cp_model.IntVar],
    horizon: int,
) -> _ArrivalPreferenceObjective | None:
    """試合数、次に不足セクション数を最小化する安全な合成目的を作る。"""

    if not request.day1_arrival_preferences:
        return None
    earliest_by_team = {
        preference.team_id: preference.earliest_section
        for preference in request.day1_arrival_preferences
    }
    early_matches: list[cp_model.IntVar] = []
    shortfall_terms: list[cp_model.LinearExpr] = []
    shortfall_upper_bound = 0
    for match_index, match in enumerate(request.matches):
        team_violations: list[cp_model.IntVar] = []
        for team_id in sorted(match.possible_team_ids):
            earliest = earliest_by_team.get(team_id)
            if earliest is None:
                continue
            early = model.new_bool_var(f"arrival_early_{match_index}_{team_id}")
            early_sections = range(min(horizon, earliest - 1))
            model.add(
                early == sum(match_in_section[match_index, section] for section in early_sections)
            )
            team_violations.append(early)
            for section in early_sections:
                shortfall_terms.append(
                    (earliest - (section + 1)) * match_in_section[match_index, section]
                )
            shortfall_upper_bound += earliest - 1
        if team_violations:
            violated = model.new_bool_var(f"arrival_match_{match_index}_violated")
            model.add_max_equality(violated, team_violations)
            early_matches.append(violated)

    early_match_count = model.new_int_var(0, len(early_matches), "day1_arrival_early_match_count")
    model.add(early_match_count == sum(early_matches))
    total_shortfall = model.new_int_var(
        0,
        shortfall_upper_bound,
        "day1_arrival_total_section_shortfall",
    )
    model.add(total_shortfall == sum(shortfall_terms))
    multiplier = shortfall_upper_bound + 1
    combined = model.new_int_var(
        0,
        len(early_matches) * multiplier + shortfall_upper_bound,
        "day1_arrival_preference_score",
    )
    model.add(combined == early_match_count * multiplier + total_shortfall)
    return _ArrivalPreferenceObjective(early_match_count, total_shortfall, combined)


def _supports_compact_day1_league_model(request: ScheduleRequest) -> bool:
    """具体チームだけの厳格な1日目リーグを専用モデルへ振り分ける。"""

    return all(
        not match.organizer_referee_required
        and not match.prerequisite_match_ids
        and len(match.possible_home_team_ids) == 1
        and len(match.possible_away_team_ids) == 1
        for match in request.matches
    )


def _build_compact_day1_league_model(
    request: ScheduleRequest,
    horizon: int,
) -> _CompactDay1LeagueModel:
    """試合配置と直前スロットからの審判供給だけを持つ専用モデルを作る。"""

    model = cp_model.CpModel()
    matches = range(len(request.matches))
    sections = range(horizon)
    courts = range(len(request.courts))
    team_ids = tuple(team.id for team in request.teams)
    possible_matches_by_team = {
        team_id: tuple(
            match_index
            for match_index, match in enumerate(request.matches)
            if team_id in match.possible_team_ids
        )
        for team_id in team_ids
    }

    placement: dict[tuple[int, int, int], cp_model.IntVar] = {}
    match_in_section: dict[tuple[int, int], cp_model.IntVar] = {}
    for match in matches:
        for section in sections:
            in_section = model.new_bool_var(f"league_match_{match}_section_{section}")
            match_in_section[match, section] = in_section
            court_variables = []
            for court in courts:
                variable = model.new_bool_var(
                    f"league_match_{match}_section_{section}_court_{court}"
                )
                placement[match, section, court] = variable
                court_variables.append(variable)
            model.add(sum(court_variables) == in_section)
        model.add(sum(match_in_section[match, section] for section in sections) == 1)

    slot_occupied: dict[tuple[int, int], cp_model.IntVar] = {}
    for section in sections:
        section_slots = []
        for court in courts:
            occupied = model.new_bool_var(f"league_slot_{section}_{court}_occupied")
            model.add(sum(placement[match, section, court] for match in matches) == occupied)
            slot_occupied[section, court] = occupied
            section_slots.append(occupied)
        model.add(sum(section_slots) >= 1)
    model.add(
        sum(slot_occupied[0, court] for court in courts) <= request.referees.organizer_capacity
    )

    match_role: dict[tuple[str, int], cp_model.LinearExpr] = {}
    for team_id in team_ids:
        relevant_matches = possible_matches_by_team[team_id]
        for section in sections:
            role = cp_model.LinearExpr.sum(
                [match_in_section[match, section] for match in relevant_matches]
            )
            match_role[team_id, section] = role
            model.add(role <= 1)
        for section in range(horizon - 1):
            model.add(match_role[team_id, section] + match_role[team_id, section + 1] <= 1)

    team_referee: dict[tuple[int, int, str], cp_model.IntVar] = {}
    for section in range(1, horizon):
        for court in courts:
            candidates = []
            for team_id in team_ids:
                variable = model.new_bool_var(f"league_referee_{section}_{court}_{team_id}")
                team_referee[section, court, team_id] = variable
                candidates.append(variable)
                source_matches = possible_matches_by_team[team_id]
                model.add(
                    variable
                    <= sum(placement[match, section - 1, court] for match in source_matches)
                )
                model.add(variable + match_role[team_id, section] <= 1)
            model.add(sum(candidates) == slot_occupied[section, court])

    for team_id in team_ids:
        for section in range(1, horizon):
            referee_here = sum(team_referee[section, court, team_id] for court in courts)
            model.add(referee_here <= 1)
            model.add(match_role[team_id, section] + referee_here <= 1)
            if section + 1 < horizon:
                # 審判→試合は、その審判が直前試合から供給されるため
                # 試合→審判→試合として許可する。審判→審判だけを禁止する。
                model.add(
                    referee_here
                    + sum(team_referee[section + 1, court, team_id] for court in courts)
                    <= 1
                )

    referee_counts: dict[str, cp_model.IntVar] = {}
    for team_id in team_ids:
        count = model.new_int_var(0, len(request.matches), f"league_referee_count_{team_id}")
        model.add(
            count
            == sum(
                team_referee[section, court, team_id]
                for section in range(1, horizon)
                for court in courts
            )
        )
        referee_counts[team_id] = count
    minimum = model.new_int_var(0, len(request.matches), "league_referee_count_minimum")
    maximum = model.new_int_var(0, len(request.matches), "league_referee_count_maximum")
    difference = model.new_int_var(0, len(request.matches), "league_referee_count_difference")
    model.add_min_equality(minimum, list(referee_counts.values()))
    model.add_max_equality(maximum, list(referee_counts.values()))
    model.add(difference == maximum - minimum)
    model.minimize(0)
    return _CompactDay1LeagueModel(
        model=model,
        placement=placement,
        match_in_section=match_in_section,
        slot_occupied=slot_occupied,
        team_referee=team_referee,
        referee_counts=referee_counts,
        referee_count_difference=difference,
        variable_count=len(model.proto.variables),
        constraint_count=len(model.proto.constraints),
    )


def _hint_known_variables(
    model: cp_model.CpModel,
    solver: cp_model.CpSolver,
    variable_count: int,
) -> None:
    """直前段階で値を持つ変数だけを次の辞書式段階へhintする。"""

    model.clear_hints()  # type: ignore[no-untyped-call]
    for index in range(variable_count):
        variable = model.get_int_var_from_proto_index(index)
        model.add_hint(variable, solver.value(variable))


def _stage_solver(
    model: cp_model.CpModel,
    previous_solver: cp_model.CpSolver,
    objective: cp_model.IntVar,
    known_variable_count: int,
    max_time_seconds: float,
    random_seed: int,
) -> tuple[cp_model.CpSolver, SolverStatus, float, _ObjectiveAudit]:
    _hint_known_variables(model, previous_solver, known_variable_count)
    model.minimize(objective)
    candidate = _configured_solver(max_time_seconds, random_seed)
    status = _STATUS_MAP.get(candidate.solve(model), SolverStatus.UNKNOWN)
    if status not in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}:
        return (
            previous_solver,
            status,
            candidate.wall_time,
            _ObjectiveAudit(
                best_bound=(
                    candidate.best_objective_bound if status is not SolverStatus.UNKNOWN else None
                ),
                optimality_proven=False,
                termination_reason=status.value.lower(),
            ),
        )
    value = candidate.value(objective)
    audit = _ObjectiveAudit(
        best_bound=candidate.best_objective_bound,
        optimality_proven=status is SolverStatus.OPTIMAL,
        termination_reason=("optimal" if status is SolverStatus.OPTIMAL else "time_limit"),
    )
    if status is SolverStatus.OPTIMAL:
        model.add(objective == value)
        return candidate, status, candidate.wall_time, audit
    # 壁時計による打切り位置に左右されないよう、未証明のincumbentへは差し替えない。
    return previous_solver, status, candidate.wall_time, audit


def _league_referee_difference_lower_bound(
    request: ScheduleRequest,
    used_sections: int,
) -> int:
    """容量が完全に埋まる場合の審判回数差の算術下界を返す。"""

    court_count = len(request.courts)
    if len(request.matches) != used_sections * court_count:
        return 0
    team_referee_count = len(request.matches) - court_count
    return int(team_referee_count % len(request.teams) != 0)


def _add_compact_day1_movement_objective(
    compact: _CompactDay1LeagueModel,
    request: ScheduleRequest,
    horizon: int,
) -> cp_model.IntVar:
    model = compact.model
    courts = range(len(request.courts))
    sections = range(horizon)
    possible_matches_by_team = {
        team.id: tuple(
            index
            for index, match in enumerate(request.matches)
            if team.id in match.possible_team_ids
        )
        for team in request.teams
    }
    role_on_court: dict[tuple[str, int, int], cp_model.IntVar] = {}
    for team_id, relevant_matches in possible_matches_by_team.items():
        for section in sections:
            for court in courts:
                role = model.new_bool_var(f"league_role_{team_id}_{section}_{court}")
                referee = compact.team_referee.get((section, court, team_id), 0)
                model.add(
                    role
                    == sum(compact.placement[match, section, court] for match in relevant_matches)
                    + referee
                )
                role_on_court[team_id, section, court] = role

    moves: list[cp_model.IntVar] = []
    for team_id in possible_matches_by_team:
        last_court = []
        for court in courts:
            state = model.new_bool_var(f"league_last_court_{team_id}_0_{court}")
            model.add(state == 0)
            last_court.append(state)
        for section in sections:
            active = sum(role_on_court[team_id, section, court] for court in courts)
            for left_court in courts:
                for right_court in courts:
                    if left_court == right_court:
                        continue
                    moved = model.new_bool_var(
                        f"league_move_{team_id}_{section}_{left_court}_{right_court}"
                    )
                    current = role_on_court[team_id, section, right_court]
                    model.add(moved <= last_court[left_court])
                    model.add(moved <= current)
                    model.add(moved >= last_court[left_court] + current - 1)
                    moves.append(moved)
            next_last_court = []
            for court in courts:
                state = model.new_bool_var(f"league_last_court_{team_id}_{section + 1}_{court}")
                current = role_on_court[team_id, section, court]
                model.add(state >= current)
                model.add(state >= last_court[court] - active)
                model.add(state <= current + last_court[court])
                model.add(state <= current + 1 - active)
                next_last_court.append(state)
            last_court = next_last_court
    movement = model.new_int_var(0, len(moves), "league_team_court_change_count")
    model.add(movement == sum(moves))
    return movement


def _add_compact_day1_court_usage_objective(
    compact: _CompactDay1LeagueModel,
    request: ScheduleRequest,
    horizon: int,
) -> cp_model.IntVar:
    model = compact.model
    counts = []
    for court in range(len(request.courts)):
        count = model.new_int_var(0, len(request.matches), f"league_court_count_{court}")
        model.add(
            count
            == sum(
                compact.placement[match, section, court]
                for match in range(len(request.matches))
                for section in range(horizon)
            )
        )
        counts.append(count)
    minimum = model.new_int_var(0, len(request.matches), "league_court_count_minimum")
    maximum = model.new_int_var(0, len(request.matches), "league_court_count_maximum")
    difference = model.new_int_var(0, len(request.matches), "league_court_usage_difference")
    model.add_min_equality(minimum, counts)
    model.add_max_equality(maximum, counts)
    model.add(difference == maximum - minimum)
    return difference


def _solve_compact_day1_league(
    request: ScheduleRequest,
    maximum_horizon: int,
    solver_time_budget: float,
) -> ScheduleResult:
    """厳格な1日目リーグを固定horizonと供給スロット変数で解く。"""

    match_count = len(request.matches)
    court_count = len(request.courts)
    capacity_minimum = (match_count + court_count - 1) // court_count
    wall_time = 0.0
    compact: _CompactDay1LeagueModel | None = None
    solver: cp_model.CpSolver | None = None
    used_sections = capacity_minimum
    lower_horizons_proven_infeasible = True

    for candidate_horizon in range(capacity_minimum, maximum_horizon + 1):
        remaining = solver_time_budget - wall_time
        if remaining <= 0.001:
            lower_horizons_proven_infeasible = False
            break
        candidate_model = _build_compact_day1_league_model(request, candidate_horizon)
        horizon_budget = min(remaining, max(0.001, remaining * 0.25))
        candidate_solver = _configured_solver(horizon_budget, request.random_seed)
        candidate_status = _STATUS_MAP.get(
            candidate_solver.solve(candidate_model.model), SolverStatus.UNKNOWN
        )
        wall_time += candidate_solver.wall_time
        if candidate_status is SolverStatus.INFEASIBLE:
            continue
        if candidate_status not in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}:
            lower_horizons_proven_infeasible = False
            return _result_without_schedule(
                request,
                SolverStatus.UNKNOWN,
                wall_time,
                (_failure_diagnostic(SolverStatus.UNKNOWN, request, candidate_horizon),),
            )
        compact = candidate_model
        solver = candidate_solver
        used_sections = candidate_horizon
        break

    if compact is None or solver is None:
        status = (
            SolverStatus.INFEASIBLE if lower_horizons_proven_infeasible else SolverStatus.UNKNOWN
        )
        return _result_without_schedule(
            request,
            status,
            wall_time,
            (_failure_diagnostic(status, request, maximum_horizon),),
        )

    arrival_known_variable_count = len(compact.model.proto.variables)
    arrival_objective = _add_day1_arrival_preference_objective(
        compact.model,
        request,
        compact.match_in_section,
        used_sections,
    )
    arrival_objective_names = (
        (
            "day1_arrival_early_match_count",
            "day1_arrival_total_section_shortfall",
        )
        if arrival_objective is not None
        else ()
    )
    objective_order = (
        "used_sections",
        *arrival_objective_names,
        "league_team_referee_count_difference",
        "maximum_team_wait_sections",
        "team_court_change_count",
        "court_usage_difference",
    )
    audits: dict[str, _ObjectiveAudit] = {
        name: _ObjectiveAudit(None, False, "not_started") for name in objective_order
    }
    audits["used_sections"] = _ObjectiveAudit(
        float(used_sections),
        True,
        (
            "capacity_lower_bound"
            if used_sections == capacity_minimum
            else "infeasible_lower_horizons"
        ),
    )
    if match_count == used_sections * court_count:
        audits["court_usage_difference"] = _ObjectiveAudit(0.0, True, "capacity_balance")
    optimized = ["used_sections"]
    completed_upper_stages = True
    if arrival_objective is not None:
        remaining = solver_time_budget - wall_time
        if remaining > 0.001:
            candidate, stage_status, elapsed, audit = _stage_solver(
                compact.model,
                solver,
                arrival_objective.combined_score,
                arrival_known_variable_count,
                max(0.001, remaining / 4),
                request.random_seed,
            )
            wall_time += elapsed
            if stage_status is SolverStatus.OPTIMAL:
                solver = candidate
                early_value = candidate.value(arrival_objective.early_match_count)
                shortfall_value = candidate.value(arrival_objective.total_section_shortfall)
                audits["day1_arrival_early_match_count"] = _ObjectiveAudit(
                    float(early_value), True, audit.termination_reason
                )
                audits["day1_arrival_total_section_shortfall"] = _ObjectiveAudit(
                    float(shortfall_value), True, audit.termination_reason
                )
                optimized.extend(arrival_objective_names)
            else:
                failed_audit = _ObjectiveAudit(None, False, audit.termination_reason)
                audits["day1_arrival_early_match_count"] = failed_audit
                audits["day1_arrival_total_section_shortfall"] = failed_audit
                completed_upper_stages = False
        else:
            failed_audit = _ObjectiveAudit(None, False, "time_limit")
            audits["day1_arrival_early_match_count"] = failed_audit
            audits["day1_arrival_total_section_shortfall"] = failed_audit
            completed_upper_stages = False

    referee_lower_bound = _league_referee_difference_lower_bound(request, used_sections)
    compact.model.add(compact.referee_count_difference >= referee_lower_bound)
    remaining = solver_time_budget - wall_time
    if completed_upper_stages and remaining > 0.001:
        candidate, status, elapsed, audit = _stage_solver(
            compact.model,
            solver,
            compact.referee_count_difference,
            compact.variable_count,
            max(0.001, remaining / 4),
            request.random_seed,
        )
        wall_time += elapsed
        audits["league_team_referee_count_difference"] = audit
        if status is SolverStatus.OPTIMAL:
            solver = candidate
            optimized.append("league_team_referee_count_difference")
        else:
            completed_upper_stages = False
    elif completed_upper_stages:
        audits["league_team_referee_count_difference"] = _ObjectiveAudit(None, False, "time_limit")
        completed_upper_stages = False

    if completed_upper_stages:
        possible_matches_by_team = {
            team.id: tuple(
                index
                for index, match in enumerate(request.matches)
                if team.id in match.possible_team_ids
            )
            for team in request.teams
        }
        before_wait = len(compact.model.proto.variables)
        maximum_wait = _add_maximum_wait_objective(
            compact.model,
            possible_matches_by_team,
            compact.match_in_section,
            used_sections,
        )
        remaining = solver_time_budget - wall_time
        if remaining > 0.001:
            candidate, status, elapsed, audit = _stage_solver(
                compact.model,
                solver,
                maximum_wait,
                before_wait,
                max(0.001, remaining / 3),
                request.random_seed,
            )
            wall_time += elapsed
            audits["maximum_team_wait_sections"] = audit
            if status is SolverStatus.OPTIMAL:
                solver = candidate
                optimized.append("maximum_team_wait_sections")
            else:
                completed_upper_stages = False
        else:
            audits["maximum_team_wait_sections"] = _ObjectiveAudit(None, False, "time_limit")
            completed_upper_stages = False

    if completed_upper_stages:
        before_movement = len(compact.model.proto.variables)
        movement = _add_compact_day1_movement_objective(compact, request, used_sections)
        remaining = solver_time_budget - wall_time
        if remaining > 0.001:
            # 未証明の下位目的は返却解へ採用しないため、長時間を使い切らない。
            movement_budget = min(2.0, max(0.001, remaining / 2))
            candidate, status, elapsed, audit = _stage_solver(
                compact.model,
                solver,
                movement,
                before_movement,
                movement_budget,
                request.random_seed,
            )
            wall_time += elapsed
            audits["team_court_change_count"] = audit
            if status is SolverStatus.OPTIMAL:
                solver = candidate
                optimized.append("team_court_change_count")
            else:
                completed_upper_stages = False
        else:
            audits["team_court_change_count"] = _ObjectiveAudit(None, False, "time_limit")
            completed_upper_stages = False

    if completed_upper_stages:
        if match_count == used_sections * court_count:
            audits["court_usage_difference"] = _ObjectiveAudit(0.0, True, "capacity_balance")
            optimized.append("court_usage_difference")
        else:
            before_court_usage = len(compact.model.proto.variables)
            court_usage = _add_compact_day1_court_usage_objective(compact, request, used_sections)
            remaining = solver_time_budget - wall_time
            if remaining > 0.001:
                candidate, status, elapsed, audit = _stage_solver(
                    compact.model,
                    solver,
                    court_usage,
                    before_court_usage,
                    remaining,
                    request.random_seed,
                )
                wall_time += elapsed
                audits["court_usage_difference"] = audit
                if status is SolverStatus.OPTIMAL:
                    solver = candidate
                    optimized.append("court_usage_difference")
                else:
                    completed_upper_stages = False
            else:
                audits["court_usage_difference"] = _ObjectiveAudit(None, False, "time_limit")
                completed_upper_stages = False

    slots: list[Slot] = []
    for section in range(used_sections):
        for court, court_spec in enumerate(request.courts):
            match_index = next(
                (
                    match
                    for match in range(match_count)
                    if solver.boolean_value(compact.placement[match, section, court])
                ),
                None,
            )
            if match_index is None:
                slots.append(
                    Slot(
                        day_id=request.day.id,
                        section_no=section + 1,
                        court_id=court_spec.id,
                        match_id=None,
                        referee_assignment=None,
                    )
                )
                continue
            if section == 0:
                referee_assignment = RefereeAssignment(kind=RefereeKind.ORGANIZER)
            else:
                referee_team_id = next(
                    team.id
                    for team in request.teams
                    if solver.boolean_value(compact.team_referee[section, court, team.id])
                )
                referee_assignment = RefereeAssignment(
                    kind=RefereeKind.TEAM,
                    team_id=referee_team_id,
                )
            slots.append(
                Slot(
                    day_id=request.day.id,
                    section_no=section + 1,
                    court_id=court_spec.id,
                    match_id=request.matches[match_index].id,
                    referee_assignment=referee_assignment,
                )
            )

    frozen_slots = tuple(slots)
    audit_values = _audit_schedule_quality(request, frozen_slots)
    (
        arrival_metrics,
        arrival_early_match_count,
        arrival_total_shortfall,
        arrival_early_referee_count,
    ) = _audit_day1_arrival_preferences(request, frozen_slots)
    referee_counts = {team.id: 0 for team in request.teams}
    for slot in frozen_slots:
        assignment = slot.referee_assignment
        if assignment is not None and assignment.kind is RefereeKind.TEAM:
            assert assignment.team_id is not None
            referee_counts[assignment.team_id] += 1
    count_values = list(referee_counts.values())
    minimum_count = min(count_values, default=0)
    maximum_count = max(count_values, default=0)
    objective_values = {
        "used_sections": used_sections,
        **(
            {
                "day1_arrival_early_match_count": arrival_early_match_count,
                "day1_arrival_total_section_shortfall": arrival_total_shortfall,
            }
            if arrival_objective is not None
            else {}
        ),
        "league_team_referee_count_difference": maximum_count - minimum_count,
        "maximum_team_wait_sections": audit_values["maximum_team_wait_sections"],
        "team_court_change_count": audit_values["team_court_change_count"],
        "court_usage_difference": audit_values["court_usage_difference"],
    }
    all_proven = len(optimized) == len(objective_order)
    diagnostics: list[Diagnostic] = []
    if not all_proven:
        first_unproven = next(name for name in objective_order if name not in optimized)
        stage_audit = audits[first_unproven]
        details: dict[str, int | float | str | bool | list[str]] = {
            "first_unproven_objective": first_unproven,
            "termination_reason": stage_audit.termination_reason,
            "incumbent_value": objective_values[first_unproven],
        }
        if stage_audit.best_bound is not None:
            details["best_bound"] = stage_audit.best_bound
        diagnostics.append(
            Diagnostic(
                code="OPTIMALITY_NOT_PROVEN",
                message="実行可能な日程は見つかりましたが、下位目的の最適性は制限時間内に証明できませんでした。",
                details=details,
            )
        )
    arrival_diagnostic = _arrival_preference_diagnostic(
        arrival_metrics,
        arrival_early_match_count,
        arrival_total_shortfall,
        arrival_early_referee_count,
    )
    if arrival_diagnostic is not None:
        diagnostics.append(arrival_diagnostic)

    return ScheduleResult(
        status=SolverStatus.OPTIMAL if all_proven else SolverStatus.FEASIBLE,
        slots=frozen_slots,
        section_timings=section_timings(request.day, used_sections),
        expected_end_time=expected_end_time(request.day, used_sections),
        metrics=SolverMetrics(
            random_seed=request.random_seed,
            max_time_seconds=request.solver.max_time_seconds,
            ortools_version=_ORTOOLS_VERSION,
            wall_time_seconds=wall_time,
            model_variant="compact_day1_league",
            model_variable_count=compact.variable_count,
            model_constraint_count=compact.constraint_count,
            team_referee_variable_count=len(compact.team_referee),
            used_sections=used_sections,
            objective_value=float(used_sections),
            best_objective_bound=float(used_sections),
            league_team_referee_counts=tuple(
                TeamRefereeCount(team_id=team_id, count=referee_counts[team_id])
                for team_id in sorted(referee_counts)
            ),
            league_team_referee_count_min=minimum_count,
            league_team_referee_count_max=maximum_count,
            league_team_referee_count_difference=maximum_count - minimum_count,
            day1_arrival_preference_metrics=arrival_metrics,
            day1_arrival_early_match_count=(
                arrival_early_match_count if arrival_objective is not None else None
            ),
            day1_arrival_total_section_shortfall=(
                arrival_total_shortfall if arrival_objective is not None else None
            ),
            day1_arrival_early_referee_count=(
                arrival_early_referee_count if arrival_objective is not None else None
            ),
            maximum_team_wait_sections=audit_values["maximum_team_wait_sections"],
            referee_then_match_count=audit_values["referee_then_match_count"],
            league_previous_same_court_referee_count=audit_values[
                "league_previous_same_court_referee_count"
            ],
            adjacent_assignment_court_change_count=audit_values[
                "adjacent_assignment_court_change_count"
            ],
            team_court_change_count=audit_values["team_court_change_count"],
            court_usage_difference=audit_values["court_usage_difference"],
            organizer_referee_count=audit_values["organizer_referee_count"],
            tournament_team_referee_count=0,
            tournament_referee_fallback_count=0,
            unused_slot_count=len(frozen_slots) - match_count,
            optimized_objectives=tuple(optimized),
            objective_stages=tuple(
                ObjectiveStageMetric(
                    objective=name,
                    value=objective_values[name],
                    best_bound=audits[name].best_bound,
                    optimality_proven=audits[name].optimality_proven,
                    termination_reason=audits[name].termination_reason,
                )
                for name in objective_order
            ),
            optimality_proven=all_proven,
        ),
        diagnostics=tuple(diagnostics),
    )


def _solve_schedule_at_horizon(
    request: ScheduleRequest,
    horizon: int,
    solver_time_budget: float,
) -> ScheduleResult:
    """指定した探索区間で日程を生成する。"""

    model = cp_model.CpModel()
    match_count = len(request.matches)
    section_indexes = range(horizon)
    court_indexes = range(len(request.courts))
    team_ids = tuple(team.id for team in request.teams)

    placement: dict[tuple[int, int, int], cp_model.IntVar] = {}
    match_in_section: dict[tuple[int, int], cp_model.IntVar] = {}
    for match_index in range(match_count):
        for section_index in section_indexes:
            section_var = model.new_bool_var(f"match_{match_index}_section_{section_index}")
            match_in_section[match_index, section_index] = section_var
            court_vars = []
            for court_index in court_indexes:
                slot_var = model.new_bool_var(
                    f"match_{match_index}_section_{section_index}_court_{court_index}"
                )
                placement[match_index, section_index, court_index] = slot_var
                court_vars.append(slot_var)
            model.add(sum(court_vars) == section_var)
        model.add(sum(match_in_section[match_index, section] for section in section_indexes) == 1)

    for section_index in section_indexes:
        for court_index in court_indexes:
            model.add(
                sum(
                    placement[match_index, section_index, court_index]
                    for match_index in range(match_count)
                )
                <= 1
            )

    active_sections = [
        model.new_bool_var(f"section_{section}_active") for section in section_indexes
    ]
    for section_index in section_indexes:
        section_match_count = sum(
            match_in_section[match_index, section_index] for match_index in range(match_count)
        )
        for match_index in range(match_count):
            model.add(
                match_in_section[match_index, section_index] <= active_sections[section_index]
            )
        if section_index + 1 < horizon:
            model.add(active_sections[section_index] >= active_sections[section_index + 1])
        model.add(section_match_count <= len(request.courts) * active_sections[section_index])
    model.add(sum(match_in_section[match_index, 0] for match_index in range(match_count)) >= 1)

    possible_matches_by_team = {
        team_id: tuple(
            match_index
            for match_index, match in enumerate(request.matches)
            if team_id in match.possible_team_ids
        )
        for team_id in team_ids
    }

    organizer_referee: dict[tuple[int, int], cp_model.IntVar] = {}
    team_referee: dict[tuple[int, int, str], cp_model.IntVar] = {}
    for match_index, match in enumerate(request.matches):
        eligible_referees = tuple(
            team_id for team_id in team_ids if team_id not in match.possible_team_ids
        )
        for section_index in section_indexes:
            organizer_var = model.new_bool_var(
                f"match_{match_index}_section_{section_index}_organizer_referee"
            )
            organizer_referee[match_index, section_index] = organizer_var
            ref_vars = []
            if section_index != 0 and not match.organizer_referee_required:
                for team_id in eligible_referees:
                    ref_var = model.new_bool_var(
                        f"match_{match_index}_section_{section_index}_referee_{team_id}"
                    )
                    team_referee[match_index, section_index, team_id] = ref_var
                    ref_vars.append(ref_var)

            if section_index == 0 or match.organizer_referee_required:
                model.add(organizer_var == match_in_section[match_index, section_index])
            elif request.referees.team_referees_required_after_first:
                model.add(organizer_var == 0)
                model.add(sum(ref_vars) == match_in_section[match_index, section_index])
            else:
                model.add(
                    organizer_var + sum(ref_vars) == match_in_section[match_index, section_index]
                )

    for section_index in section_indexes:
        model.add(
            sum(organizer_referee[match_index, section_index] for match_index in range(match_count))
            <= request.referees.organizer_capacity
        )

        for team_id in team_ids:
            participant_roles = [
                match_in_section[match_index, section_index]
                for match_index in possible_matches_by_team[team_id]
            ]
            referee_roles = [
                referee_var
                for (
                    match_index,
                    referee_section,
                    referee_team,
                ), referee_var in team_referee.items()
                if referee_section == section_index and referee_team == team_id
            ]
            model.add(sum((*participant_roles, *referee_roles)) <= 1)

    role_any, role_on_court, role_court, match_court = _add_team_role_court_state(
        model,
        placement,
        match_in_section,
        team_referee,
        possible_matches_by_team,
        horizon,
        len(request.courts),
    )
    league_match_indexes = frozenset(
        index for index, match in enumerate(request.matches) if match.phase == "league"
    )
    if request.day.id == _DAY1_ID:
        _add_league_team_referee_source_constraints(
            model,
            placement,
            match_in_section,
            team_referee,
            possible_matches_by_team,
            league_match_indexes,
            horizon,
            len(request.courts),
        )

    for team_id in team_ids:
        relevant_matches = possible_matches_by_team[team_id]
        for section_index in range(horizon - 1):
            model.add(
                sum(match_in_section[index, section_index] for index in relevant_matches)
                + sum(match_in_section[index, section_index + 1] for index in relevant_matches)
                <= 1
            )

    section_number: dict[int, cp_model.IntVar] = {}
    match_index_by_id = {match.id: index for index, match in enumerate(request.matches)}
    for match_index in range(match_count):
        section_var = model.new_int_var(1, horizon, f"match_{match_index}_section_number")
        section_number[match_index] = section_var
        model.add(
            section_var
            == sum(
                (section_index + 1) * match_in_section[match_index, section_index]
                for section_index in section_indexes
            )
        )
    for match_index, match in enumerate(request.matches):
        for prerequisite_id in match.prerequisite_match_ids:
            prerequisite_index = match_index_by_id[prerequisite_id]
            model.add(section_number[match_index] >= section_number[prerequisite_index] + 2)

    initial_hint_added = _add_day1_league_initial_hint(
        model,
        request,
        placement,
        match_in_section,
        active_sections,
        organizer_referee,
        team_referee,
        section_number,
        role_any,
        role_on_court,
        role_court,
        match_court,
        horizon,
    )

    league_match_count = len(league_match_indexes)
    used_sections_expression = sum(active_sections)
    primary_objective_weight = league_match_count + 1
    capacity_minimum = (match_count + len(request.courts) - 1) // len(request.courts)
    horizon_is_capacity_minimum = horizon == capacity_minimum
    if horizon_is_capacity_minimum:
        # 容量下限と探索範囲が一致するため、実行可能解が見つかれば
        # 使用セクション数の最適性も同時に証明できる。
        model.add(used_sections_expression == horizon)
        model.minimize(0)
    else:
        model.minimize(used_sections_expression)
    primary_solver = _configured_solver(solver_time_budget, request.random_seed)
    if initial_hint_added:
        # このモデルはチーム審判候補の対称性が大きく、最大入力では
        # presolveだけで時間上限へ達し得る。完全な実行可能hintを直接探索する。
        primary_solver.parameters.cp_model_presolve = False
        primary_solver.parameters.max_time_in_seconds = min(
            solver_time_budget,
            _DAY1_HINT_PROOF_TIME_SECONDS,
        )
    primary_status = _STATUS_MAP.get(primary_solver.solve(model), SolverStatus.UNKNOWN)
    wall_time = primary_solver.wall_time

    if primary_status not in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}:
        if primary_status is SolverStatus.UNKNOWN:
            constructed = _construct_day1_league_hint(request, horizon)
            if constructed is not None:
                return _result_from_day1_league_hint(
                    request,
                    constructed,
                    wall_time,
                )
        diagnostic = _failure_diagnostic(primary_status, request, horizon)
        return _result_without_schedule(request, primary_status, wall_time, (diagnostic,))

    if primary_status is SolverStatus.FEASIBLE:
        constructed = _construct_day1_league_hint(request, horizon)
        if constructed is not None:
            return _result_from_day1_league_hint(request, constructed, wall_time)

    solver = primary_solver
    status = SolverStatus.FEASIBLE
    optimized_objectives: list[str] = []
    if primary_status is SolverStatus.OPTIMAL:
        optimized_objectives.append("used_sections")
    primary_used_sections = sum(
        primary_solver.boolean_value(section) for section in active_sections
    )
    best_primary_bound = (
        float(primary_used_sections)
        if horizon_is_capacity_minimum
        else primary_solver.best_objective_bound
    )
    remaining_time = solver_time_budget - wall_time
    arrival_known_variable_count = len(model.proto.variables)
    arrival_objective = _add_day1_arrival_preference_objective(
        model,
        request,
        match_in_section,
        horizon,
    )
    arrival_stage_complete = arrival_objective is None
    if primary_status is SolverStatus.OPTIMAL and arrival_objective is not None:
        model.add(used_sections_expression == primary_used_sections)
        if remaining_time > 0.001:
            arrival_solver, arrival_status, arrival_wall_time, _arrival_audit = _stage_solver(
                model,
                solver,
                arrival_objective.combined_score,
                arrival_known_variable_count,
                max(0.001, remaining_time / 3),
                request.random_seed,
            )
            wall_time += arrival_wall_time
            if arrival_status is SolverStatus.OPTIMAL:
                solver = arrival_solver
                optimized_objectives.extend(
                    (
                        "day1_arrival_early_match_count",
                        "day1_arrival_total_section_shortfall",
                    )
                )
                arrival_stage_complete = True
            else:
                status = SolverStatus.FEASIBLE
        remaining_time = solver_time_budget - wall_time
    fairness_time_threshold = (
        _LARGE_LEAGUE_FAIRNESS_TIME_SECONDS
        if league_match_count > 24
        else _MIN_FAIRNESS_TIME_SECONDS
    )
    if (
        primary_status is SolverStatus.OPTIMAL
        and arrival_stage_complete
        and remaining_time >= fairness_time_threshold
    ):
        league_referee_count: dict[str, cp_model.IntVar] = {}
        for team_id in team_ids:
            count = model.new_int_var(0, league_match_count, f"league_referee_count_{team_id}")
            assignments = [
                variable
                for (
                    match_index,
                    _section_index,
                    referee_team_id,
                ), variable in team_referee.items()
                if match_index in league_match_indexes and referee_team_id == team_id
            ]
            model.add(count == sum(assignments))
            league_referee_count[team_id] = count

        minimum_league_referee_count = model.new_int_var(
            0, league_match_count, "minimum_league_referee_count"
        )
        maximum_league_referee_count = model.new_int_var(
            0, league_match_count, "maximum_league_referee_count"
        )
        league_referee_count_difference = model.new_int_var(
            0, league_match_count, "league_referee_count_difference"
        )
        model.add_min_equality(minimum_league_referee_count, list(league_referee_count.values()))
        model.add_max_equality(maximum_league_referee_count, list(league_referee_count.values()))
        model.add(
            league_referee_count_difference
            == maximum_league_referee_count - minimum_league_referee_count
        )
        model.add(used_sections_expression == primary_used_sections)
        model.minimize(
            used_sections_expression * primary_objective_weight + league_referee_count_difference
        )
        hint_variables = [
            *placement.values(),
            *match_in_section.values(),
            *active_sections,
            *organizer_referee.values(),
            *team_referee.values(),
            *section_number.values(),
            *role_any.values(),
            *role_on_court.values(),
            *role_court.values(),
            *match_court.values(),
        ]
        model.clear_hints()  # type: ignore[no-untyped-call]
        for variable in hint_variables:
            model.add_hint(variable, primary_solver.value(variable))

        difference_lower_bound = 0
        all_active_slots_are_filled = match_count == primary_used_sections * len(request.courts)
        all_matches_require_league_team_referees_after_first = (
            request.referees.team_referees_required_after_first
            and league_match_count == match_count
            and all(not match.organizer_referee_required for match in request.matches)
        )
        if all_active_slots_are_filled and all_matches_require_league_team_referees_after_first:
            fixed_team_referee_count = league_match_count - len(request.courts)
            if fixed_team_referee_count % len(team_ids) != 0:
                difference_lower_bound = 1

        for allowed_difference in range(difference_lower_bound, league_match_count + 1):
            remaining_time = solver_time_budget - wall_time
            if remaining_time <= 0.001:
                break
            candidate_model = model.clone()
            candidate_model.minimize(0)
            candidate_difference = candidate_model.get_int_var_from_proto_index(
                league_referee_count_difference.index
            )
            candidate_model.add(candidate_difference <= allowed_difference)
            fairness_solver = _configured_solver(remaining_time, request.random_seed)
            fairness_status = _STATUS_MAP.get(
                fairness_solver.solve(candidate_model), SolverStatus.UNKNOWN
            )
            wall_time += fairness_solver.wall_time
            if fairness_status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}:
                solver = fairness_solver
                status = SolverStatus.OPTIMAL
                best_primary_bound = primary_used_sections
                fairness_value = fairness_solver.value(candidate_difference)
                model.add(league_referee_count_difference == fairness_value)
                optimized_objectives.append("league_team_referee_count_difference")
                (
                    solver,
                    lower_status,
                    lower_wall_time,
                    lower_optimized,
                ) = _optimize_lower_objectives(
                    model,
                    request,
                    placement,
                    match_in_section,
                    possible_matches_by_team,
                    role_on_court,
                    solver,
                    solver_time_budget - wall_time,
                )
                wall_time += lower_wall_time
                optimized_objectives.extend(lower_optimized)
                if lower_status is SolverStatus.FEASIBLE:
                    status = SolverStatus.FEASIBLE
                break
            if fairness_status is not SolverStatus.INFEASIBLE:
                break

    used_sections = sum(solver.boolean_value(section) for section in active_sections)
    slots: list[Slot] = []
    for section_index in range(used_sections):
        for court_index, court in enumerate(request.courts):
            scheduled_match_index = next(
                (
                    match_index
                    for match_index in range(match_count)
                    if solver.boolean_value(placement[match_index, section_index, court_index])
                ),
                None,
            )
            if scheduled_match_index is None:
                slots.append(
                    Slot(
                        day_id=request.day.id,
                        section_no=section_index + 1,
                        court_id=court.id,
                        match_id=None,
                        referee_assignment=None,
                    )
                )
                continue

            referee_assignment = _extract_referee(
                solver,
                scheduled_match_index,
                section_index,
                organizer_referee,
                team_referee,
            )
            slots.append(
                Slot(
                    day_id=request.day.id,
                    section_no=section_index + 1,
                    court_id=court.id,
                    match_id=request.matches[scheduled_match_index].id,
                    referee_assignment=referee_assignment,
                )
            )

    league_referee_counts = {team_id: 0 for team_id in team_ids}
    match_by_id = {match.id: match for match in request.matches}
    for slot in slots:
        if slot.match_id is None or match_by_id[slot.match_id].phase != "league":
            continue
        assignment = slot.referee_assignment
        if assignment is not None and assignment.kind is RefereeKind.TEAM:
            assert assignment.team_id is not None
            league_referee_counts[assignment.team_id] += 1
    league_referee_count_values = list(league_referee_counts.values())
    minimum_league_referee_count_value = min(league_referee_count_values, default=0)
    maximum_league_referee_count_value = max(league_referee_count_values, default=0)
    audit = _audit_schedule_quality(request, tuple(slots))
    (
        arrival_metrics,
        arrival_early_match_count,
        arrival_total_shortfall,
        arrival_early_referee_count,
    ) = _audit_day1_arrival_preferences(request, tuple(slots))

    diagnostics: list[Diagnostic] = []
    if status is SolverStatus.FEASIBLE:
        diagnostics.append(
            Diagnostic(
                code="OPTIMALITY_NOT_PROVEN",
                message="実行可能な日程は見つかりましたが、制限時間内に最適性を証明できませんでした。",
            )
        )
    arrival_diagnostic = _arrival_preference_diagnostic(
        arrival_metrics,
        arrival_early_match_count,
        arrival_total_shortfall,
        arrival_early_referee_count,
    )
    if arrival_diagnostic is not None:
        diagnostics.append(arrival_diagnostic)

    return ScheduleResult(
        status=status,
        slots=tuple(slots),
        section_timings=section_timings(request.day, used_sections),
        expected_end_time=expected_end_time(request.day, used_sections),
        metrics=SolverMetrics(
            random_seed=request.random_seed,
            max_time_seconds=request.solver.max_time_seconds,
            ortools_version=_ORTOOLS_VERSION,
            wall_time_seconds=wall_time,
            used_sections=used_sections,
            objective_value=float(used_sections),
            best_objective_bound=float(best_primary_bound),
            league_team_referee_counts=tuple(
                TeamRefereeCount(
                    team_id=team_id,
                    count=league_referee_counts[team_id],
                )
                for team_id in sorted(team_ids)
            ),
            league_team_referee_count_min=minimum_league_referee_count_value,
            league_team_referee_count_max=maximum_league_referee_count_value,
            league_team_referee_count_difference=(
                maximum_league_referee_count_value - minimum_league_referee_count_value
            ),
            day1_arrival_preference_metrics=arrival_metrics,
            day1_arrival_early_match_count=(
                arrival_early_match_count if arrival_objective is not None else None
            ),
            day1_arrival_total_section_shortfall=(
                arrival_total_shortfall if arrival_objective is not None else None
            ),
            day1_arrival_early_referee_count=(
                arrival_early_referee_count if arrival_objective is not None else None
            ),
            maximum_team_wait_sections=audit["maximum_team_wait_sections"],
            referee_then_match_count=audit["referee_then_match_count"],
            league_previous_same_court_referee_count=audit[
                "league_previous_same_court_referee_count"
            ],
            adjacent_assignment_court_change_count=audit["adjacent_assignment_court_change_count"],
            team_court_change_count=audit["team_court_change_count"],
            court_usage_difference=audit["court_usage_difference"],
            organizer_referee_count=audit["organizer_referee_count"],
            tournament_team_referee_count=audit["tournament_team_referee_count"],
            tournament_referee_fallback_count=0,
            optimized_objectives=tuple(optimized_objectives),
            objective_stages=tuple(
                ObjectiveStageMetric(
                    objective=name,
                    value=value,
                    optimality_proven=name in optimized_objectives,
                )
                for name, value in (
                    ("used_sections", used_sections),
                    *(
                        (
                            ("day1_arrival_early_match_count", arrival_early_match_count),
                            (
                                "day1_arrival_total_section_shortfall",
                                arrival_total_shortfall,
                            ),
                        )
                        if arrival_objective is not None
                        else ()
                    ),
                    (
                        "league_team_referee_count_difference",
                        maximum_league_referee_count_value - minimum_league_referee_count_value,
                    ),
                    ("maximum_team_wait_sections", audit["maximum_team_wait_sections"]),
                    ("team_court_change_count", audit["team_court_change_count"]),
                    ("court_usage_difference", audit["court_usage_difference"]),
                )
            ),
            optimality_proven=status is SolverStatus.OPTIMAL,
        ),
        diagnostics=tuple(diagnostics),
    )


def _add_team_role_court_state(
    model: cp_model.CpModel,
    placement: Mapping[tuple[int, int, int], cp_model.IntVar],
    match_in_section: Mapping[tuple[int, int], cp_model.IntVar],
    team_referee: Mapping[tuple[int, int, str], cp_model.IntVar],
    possible_matches_by_team: Mapping[str, tuple[int, ...]],
    horizon: int,
    court_count: int,
) -> tuple[
    dict[tuple[str, int], cp_model.IntVar],
    dict[tuple[str, int, int], cp_model.IntVar],
    dict[tuple[str, int], cp_model.IntVar],
    dict[int, cp_model.IntVar],
]:
    """チームが各セクションで担当するコートを試合・審判共通で表す。"""

    sections, courts = range(horizon), range(court_count)
    match_count = max((match for match, _section in match_in_section), default=-1) + 1
    match_court: dict[int, cp_model.IntVar] = {}
    for match in range(match_count):
        court_value = model.new_int_var(1, court_count, f"match_{match}_court_number")
        model.add(
            court_value
            == sum(
                (court + 1) * placement[match, section, court]
                for section in sections
                for court in courts
            )
        )
        match_court[match] = court_value

    role_any: dict[tuple[str, int], cp_model.IntVar] = {}
    role_on_court: dict[tuple[str, int, int], cp_model.IntVar] = {}
    role_court: dict[tuple[str, int], cp_model.IntVar] = {}
    referee_roles_by_team_section: defaultdict[
        tuple[str, int], list[tuple[int, cp_model.IntVar]]
    ] = defaultdict(list)
    for (match, section, team_id), variable in team_referee.items():
        referee_roles_by_team_section[team_id, section].append((match, variable))
    for team_id, relevant_matches in possible_matches_by_team.items():
        for section in sections:
            referee_roles = referee_roles_by_team_section[team_id, section]
            activities = [
                *(match_in_section[match, section] for match in relevant_matches),
                *(variable for _match, variable in referee_roles),
            ]
            active = model.new_bool_var(f"role_any_{team_id}_{section}")
            model.add(active == sum(activities))
            role_any[team_id, section] = active

            court_roles = []
            for court in courts:
                assigned = model.new_bool_var(f"role_court_{team_id}_{section}_{court}")
                role_on_court[team_id, section, court] = assigned
                court_roles.append(assigned)
                for match in relevant_matches:
                    model.add(placement[match, section, court] <= assigned)
            model.add(sum(court_roles) == active)
            court_value = model.new_int_var(
                0, court_count, f"role_court_number_{team_id}_{section}"
            )
            model.add(court_value == sum((court + 1) * court_roles[court] for court in courts))
            role_court[team_id, section] = court_value

            for match, referee in referee_roles:
                model.add(court_value == match_court[match]).only_enforce_if(referee)

    return role_any, role_on_court, role_court, match_court


def _add_league_team_referee_source_constraints(
    model: cp_model.CpModel,
    placement: Mapping[tuple[int, int, int], cp_model.IntVar],
    match_in_section: Mapping[tuple[int, int], cp_model.IntVar],
    team_referee: Mapping[tuple[int, int, str], cp_model.IntVar],
    possible_matches_by_team: Mapping[str, tuple[int, ...]],
    league_match_indexes: frozenset[int],
    horizon: int,
    court_count: int,
) -> None:
    """1日目リーグの審判供給元と許可する連続担当を固定する。

    チーム審判は、直前セクションの同一コートでそのチームが出場した
    実試合からだけ供給する。審判→試合は試合→審判→試合として許可し、
    後半の試合は別コートでもよい。審判→審判は許可しない。
    """

    for (match_index, section, team_id), referee in team_referee.items():
        if match_index not in league_match_indexes:
            continue
        if section == 0:
            model.add(referee == 0)
            continue

        source_matches = possible_matches_by_team[team_id]
        for court in range(court_count):
            previous_same_court_matches = sum(
                placement[source_match, section - 1, court] for source_match in source_matches
            )
            model.add(
                referee + placement[match_index, section, court] <= previous_same_court_matches + 1
            )

    for team_id in possible_matches_by_team:
        for section in range(1, horizon - 1):
            current_referees = [
                variable
                for (_match, referee_section, referee_team), variable in team_referee.items()
                if referee_section == section and referee_team == team_id
            ]
            next_referees = [
                variable
                for (_match, referee_section, referee_team), variable in team_referee.items()
                if referee_section == section + 1 and referee_team == team_id
            ]
            model.add(sum((*current_referees, *next_referees)) <= 1)


def _add_day1_league_initial_hint(
    model: cp_model.CpModel,
    request: ScheduleRequest,
    placement: Mapping[tuple[int, int, int], cp_model.IntVar],
    match_in_section: Mapping[tuple[int, int], cp_model.IntVar],
    active_sections: list[cp_model.IntVar],
    organizer_referee: Mapping[tuple[int, int], cp_model.IntVar],
    team_referee: Mapping[tuple[int, int, str], cp_model.IntVar],
    section_number: Mapping[int, cp_model.IntVar],
    role_any: Mapping[tuple[str, int], cp_model.IntVar],
    role_on_court: Mapping[tuple[str, int, int], cp_model.IntVar],
    role_court: Mapping[tuple[str, int], cp_model.IntVar],
    match_court: Mapping[int, cp_model.IntVar],
    horizon: int,
) -> bool:
    """1日目リーグの実行可能解を探索開始点にする。"""

    if request.day.id != _DAY1_ID or any(
        match.phase != "league" or match.prerequisite_match_ids for match in request.matches
    ):
        return False

    if request.referees.team_referees_required_after_first and all(
        not match.organizer_referee_required for match in request.matches
    ):
        constructed_hint = _construct_day1_league_hint(request, horizon)
        if constructed_hint is not None:
            constructed_assignment, constructed_referees = constructed_hint
            constructed_organizers = frozenset(
                match_index
                for match_index, (section, _court) in constructed_assignment.items()
                if section == 0
            )
            return _apply_day1_league_hint(
                model,
                request,
                constructed_assignment,
                constructed_organizers,
                constructed_referees,
                placement,
                match_in_section,
                active_sections,
                organizer_referee,
                team_referee,
                section_number,
                role_any,
                role_on_court,
                role_court,
                match_court,
            )

    if request.referees.organizer_capacity <= 0:
        return False

    section_capacities = [
        (
            min(len(request.courts), request.referees.organizer_capacity)
            if section == 0 or not request.referees.team_referees_required_after_first
            else len(request.courts)
        )
        for section in range(horizon)
    ]
    teams_by_section: list[set[str]] = [set() for _ in range(horizon)]
    match_count_by_section = [0 for _ in range(horizon)]
    assignment: dict[int, tuple[int, int]] = {}
    for match_index, match in enumerate(request.matches):
        possible_team_ids = set(match.possible_team_ids)
        position = next(
            (
                (section, match_count_by_section[section])
                for section in range(horizon)
                if match_count_by_section[section] < section_capacities[section]
                and not possible_team_ids.intersection(teams_by_section[section])
                and (
                    section == 0
                    or not possible_team_ids.intersection(teams_by_section[section - 1])
                )
            ),
            None,
        )
        if position is None:
            return False
        section, court = position
        assignment[match_index] = position
        teams_by_section[section].update(possible_team_ids)
        match_count_by_section[section] += 1

    organizer_matches: set[int] = set()
    referee_by_match: dict[int, str] = {}
    role_positions: dict[tuple[str, int], int] = {}
    for match_index, (section, court) in assignment.items():
        for team_id in request.matches[match_index].possible_team_ids:
            role_positions[team_id, section] = court
        if (
            section == 0
            or request.matches[match_index].organizer_referee_required
            or not request.referees.team_referees_required_after_first
        ):
            organizer_matches.add(match_index)
    match_role_positions = dict(role_positions)

    for section in range(horizon):
        organizer_count = sum(
            1 for match_index in organizer_matches if assignment[match_index][0] == section
        )
        if organizer_count > request.referees.organizer_capacity:
            return False

        needs_team_referee = [
            match_index
            for match_index, (match_section, _court) in assignment.items()
            if match_section == section and match_index not in organizer_matches
        ]
        candidates_by_match: dict[int, list[str]] = {}
        for match_index in needs_team_referee:
            court = assignment[match_index][1]
            candidates_by_match[match_index] = [
                team.id
                for team in request.teams
                if (match_index, section, team.id) in team_referee
                and (team.id, section) not in role_positions
                and match_role_positions.get((team.id, section - 1)) == court
            ]

        ordered_matches = sorted(
            needs_team_referee,
            key=lambda match_index: (len(candidates_by_match[match_index]), match_index),
        )
        chosen = _choose_distinct_team_referees(ordered_matches, candidates_by_match)
        if chosen is None:
            return False
        for match_index, team_id in chosen.items():
            referee_by_match[match_index] = team_id
            role_positions[team_id, section] = assignment[match_index][1]

    return _apply_day1_league_hint(
        model,
        request,
        assignment,
        frozenset(organizer_matches),
        referee_by_match,
        placement,
        match_in_section,
        active_sections,
        organizer_referee,
        team_referee,
        section_number,
        role_any,
        role_on_court,
        role_court,
        match_court,
    )


@cache
def _construct_day1_league_hint(
    request: ScheduleRequest,
    horizon: int,
) -> tuple[dict[int, tuple[int, int]], dict[int, str]] | None:
    """リーグのコート列を直接組み立て、審判供給元を含む完全hintを返す。"""

    if (
        request.day.id != _DAY1_ID
        or not request.referees.team_referees_required_after_first
        or any(match.phase != "league" or match.prerequisite_match_ids for match in request.matches)
        or any(match.organizer_referee_required for match in request.matches)
    ):
        return None
    match_count = len(request.matches)
    active_court_count = min(
        len(request.courts),
        request.referees.organizer_capacity,
        match_count,
    )
    if active_court_count == 0 or match_count > active_court_count * horizon:
        return None
    deadline = perf_counter() + min(5.0, request.solver.max_time_seconds * 0.2)

    participants = tuple(match.possible_team_ids for match in request.matches)
    guaranteed_referees = tuple(
        tuple(
            sorted(
                {
                    *(
                        match.possible_home_team_ids
                        if len(match.possible_home_team_ids) == 1
                        else ()
                    ),
                    *(
                        match.possible_away_team_ids
                        if len(match.possible_away_team_ids) == 1
                        else ()
                    ),
                }
            )
        )
        for match in request.matches
    )

    def batch_is_disjoint(batch: tuple[int, ...]) -> bool:
        occupied: set[str] = set()
        for match_index in batch:
            if occupied.intersection(participants[match_index]):
                return False
            occupied.update(participants[match_index])
        return True

    length_candidates: list[tuple[int, ...]] = []
    minimum_used = (match_count + active_court_count - 1) // active_court_count
    for used_sections in range(minimum_used, horizon + 1):
        for lengths in combinations_with_replacement(
            range(1, used_sections + 1), active_court_count
        ):
            if sum(lengths) == match_count and max(lengths) == used_sections:
                length_candidates.append(tuple(sorted(lengths, reverse=True)))
    length_candidates = list(dict.fromkeys(length_candidates))

    all_remaining = (1 << match_count) - 1
    for lengths in length_candidates:
        batch_sizes = tuple(
            sum(length > section for length in lengths) for section in range(max(lengths))
        )

        @cache
        def build(
            remaining: int,
            previous: tuple[int, ...],
            previous_referees: tuple[str, ...],
            section: int,
            section_sizes: tuple[int, ...] = batch_sizes,
        ) -> (
            tuple[tuple[tuple[int, ...], tuple[int, ...], tuple[tuple[int, str], ...]], ...] | None
        ):
            if perf_counter() >= deadline:
                return None
            if remaining == 0:
                return ()
            size = section_sizes[section]
            excluded: set[str] = set()
            for previous_match in previous:
                excluded.update(participants[previous_match])

            available_matches = tuple(
                match
                for match in range(match_count)
                if remaining & (1 << match) and participants[match].isdisjoint(excluded)
            )
            candidate_batches = combinations(available_matches, size)
            first_section_batch_seen = False
            for batch in candidate_batches:
                if not batch_is_disjoint(batch):
                    continue
                if section == 0 and first_section_batch_seen:
                    break
                first_section_batch_seen = True

                active_sources = combinations(previous, size) if previous else ((),)
                for sources in active_sources:
                    referee_choices = (
                        product(*(guaranteed_referees[match] for match in sources))
                        if sources
                        else ((),)
                    )
                    for selected_referees in referee_choices:
                        if len(set(selected_referees)) != len(selected_referees):
                            continue
                        referee_items = tuple(
                            (batch[index], referee)
                            for index, referee in enumerate(selected_referees)
                        )
                        next_remaining = remaining
                        for match in batch:
                            next_remaining &= ~(1 << match)
                        suffix = build(
                            next_remaining,
                            batch,
                            tuple(sorted(selected_referees)),
                            section + 1,
                        )
                        if suffix is not None:
                            return ((batch, tuple(sources), referee_items), *suffix)
            return None

        built = build(all_remaining, (), (), 0)
        if built is None:
            continue
        assignment: dict[int, tuple[int, int]] = {}
        referee_by_match: dict[int, str] = {}
        previous_courts: dict[int, int] = {}
        for section, (batch, sources, referees) in enumerate(built):
            courts = (
                tuple(previous_courts[source] for source in sources)
                if sources
                else tuple(range(len(batch)))
            )
            current_courts = dict(zip(batch, courts, strict=True))
            for match, court in current_courts.items():
                assignment[match] = section, court
            referee_by_match.update(referees)
            previous_courts = current_courts
        return assignment, referee_by_match
    return None


def _result_from_day1_league_hint(
    request: ScheduleRequest,
    constructed: tuple[dict[int, tuple[int, int]], dict[int, str]],
    wall_time_seconds: float,
) -> ScheduleResult:
    """CP-SATが時間切れでも、検証可能な構築済みリーグ日程を返す。"""

    assignment, referee_by_match = constructed
    used_sections = max(section for section, _court in assignment.values()) + 1
    match_by_id = {match.id: match for match in request.matches}
    match_by_position = {position: match_index for match_index, position in assignment.items()}
    slots: list[Slot] = []
    for section in range(used_sections):
        for court, court_spec in enumerate(request.courts):
            match_index = match_by_position.get((section, court))
            if match_index is None:
                slots.append(
                    Slot(
                        day_id=request.day.id,
                        section_no=section + 1,
                        court_id=court_spec.id,
                        match_id=None,
                        referee_assignment=None,
                    )
                )
                continue
            referee_team_id = referee_by_match.get(match_index)
            if section > 0:
                assert referee_team_id is not None
            slot_referee = (
                RefereeAssignment(kind=RefereeKind.ORGANIZER)
                if section == 0
                else RefereeAssignment(kind=RefereeKind.TEAM, team_id=referee_team_id)
            )
            slots.append(
                Slot(
                    day_id=request.day.id,
                    section_no=section + 1,
                    court_id=court_spec.id,
                    match_id=request.matches[match_index].id,
                    referee_assignment=slot_referee,
                )
            )

    frozen_slots = tuple(slots)
    audit = _audit_schedule_quality(request, frozen_slots)
    (
        arrival_metrics,
        arrival_early_match_count,
        arrival_total_shortfall,
        arrival_early_referee_count,
    ) = _audit_day1_arrival_preferences(request, frozen_slots)
    counts = {team.id: 0 for team in request.teams}
    for slot in frozen_slots:
        if slot.match_id is None or match_by_id[slot.match_id].phase != "league":
            continue
        audit_referee = slot.referee_assignment
        if audit_referee is not None and audit_referee.kind is RefereeKind.TEAM:
            assert audit_referee.team_id is not None
            counts[audit_referee.team_id] += 1
    count_values = list(counts.values())
    minimum = min(count_values, default=0)
    maximum = max(count_values, default=0)
    objective_values = (
        ("used_sections", used_sections),
        *(
            (
                ("day1_arrival_early_match_count", arrival_early_match_count),
                ("day1_arrival_total_section_shortfall", arrival_total_shortfall),
            )
            if request.day1_arrival_preferences
            else ()
        ),
        ("league_team_referee_count_difference", maximum - minimum),
        ("maximum_team_wait_sections", audit["maximum_team_wait_sections"]),
        ("team_court_change_count", audit["team_court_change_count"]),
        ("court_usage_difference", audit["court_usage_difference"]),
    )
    return ScheduleResult(
        status=SolverStatus.FEASIBLE,
        slots=frozen_slots,
        section_timings=section_timings(request.day, used_sections),
        expected_end_time=expected_end_time(request.day, used_sections),
        metrics=SolverMetrics(
            random_seed=request.random_seed,
            max_time_seconds=request.solver.max_time_seconds,
            ortools_version=_ORTOOLS_VERSION,
            wall_time_seconds=wall_time_seconds,
            used_sections=used_sections,
            objective_value=float(used_sections),
            league_team_referee_counts=tuple(
                TeamRefereeCount(team_id=team_id, count=counts[team_id])
                for team_id in sorted(counts)
            ),
            league_team_referee_count_min=minimum,
            league_team_referee_count_max=maximum,
            league_team_referee_count_difference=maximum - minimum,
            day1_arrival_preference_metrics=arrival_metrics,
            day1_arrival_early_match_count=(
                arrival_early_match_count if request.day1_arrival_preferences else None
            ),
            day1_arrival_total_section_shortfall=(
                arrival_total_shortfall if request.day1_arrival_preferences else None
            ),
            day1_arrival_early_referee_count=(
                arrival_early_referee_count if request.day1_arrival_preferences else None
            ),
            maximum_team_wait_sections=audit["maximum_team_wait_sections"],
            referee_then_match_count=audit["referee_then_match_count"],
            league_previous_same_court_referee_count=audit[
                "league_previous_same_court_referee_count"
            ],
            adjacent_assignment_court_change_count=audit["adjacent_assignment_court_change_count"],
            team_court_change_count=audit["team_court_change_count"],
            court_usage_difference=audit["court_usage_difference"],
            organizer_referee_count=audit["organizer_referee_count"],
            tournament_team_referee_count=audit["tournament_team_referee_count"],
            tournament_referee_fallback_count=0,
            objective_stages=tuple(
                ObjectiveStageMetric(
                    objective=name,
                    value=value,
                    optimality_proven=False,
                )
                for name, value in objective_values
            ),
            optimality_proven=False,
        ),
        diagnostics=tuple(
            item
            for item in (
                Diagnostic(
                    code="OPTIMALITY_NOT_PROVEN",
                    message="実行可能な日程は見つかりましたが、制限時間内に最適性を証明できませんでした。",
                ),
                _arrival_preference_diagnostic(
                    arrival_metrics,
                    arrival_early_match_count,
                    arrival_total_shortfall,
                    arrival_early_referee_count,
                ),
            )
            if item is not None
        ),
    )


def _apply_day1_league_hint(
    model: cp_model.CpModel,
    request: ScheduleRequest,
    assignment: Mapping[int, tuple[int, int]],
    organizer_matches: frozenset[int],
    referee_by_match: Mapping[int, str],
    placement: Mapping[tuple[int, int, int], cp_model.IntVar],
    match_in_section: Mapping[tuple[int, int], cp_model.IntVar],
    active_sections: list[cp_model.IntVar],
    organizer_referee: Mapping[tuple[int, int], cp_model.IntVar],
    team_referee: Mapping[tuple[int, int, str], cp_model.IntVar],
    section_number: Mapping[int, cp_model.IntVar],
    role_any: Mapping[tuple[str, int], cp_model.IntVar],
    role_on_court: Mapping[tuple[str, int, int], cp_model.IntVar],
    role_court: Mapping[tuple[str, int], cp_model.IntVar],
    match_court: Mapping[int, cp_model.IntVar],
) -> bool:
    """完全な日程と審判割当てを主モデルのhintへ変換する。"""

    used_sections = max((section for section, _court in assignment.values()), default=-1) + 1
    for (item_index, section, court), variable in placement.items():
        model.add_hint(variable, int(assignment[item_index] == (section, court)))
    for (item_index, section), variable in match_in_section.items():
        model.add_hint(variable, int(assignment[item_index][0] == section))
    for section, variable in enumerate(active_sections):
        model.add_hint(variable, int(section < used_sections))
    for (item_index, section), variable in organizer_referee.items():
        model.add_hint(
            variable,
            int(item_index in organizer_matches and assignment[item_index][0] == section),
        )
    for (item_index, section, team_id), variable in team_referee.items():
        model.add_hint(
            variable,
            int(
                assignment[item_index][0] == section and referee_by_match.get(item_index) == team_id
            ),
        )
    for item_index, variable in section_number.items():
        model.add_hint(variable, assignment[item_index][0] + 1)
    for item_index, variable in match_court.items():
        model.add_hint(variable, assignment[item_index][1] + 1)

    role_positions: dict[tuple[str, int], int] = {}
    for item_index, (section, court) in assignment.items():
        for team_id in request.matches[item_index].possible_team_ids:
            role_positions[team_id, section] = court
        referee_team_id = referee_by_match.get(item_index)
        if referee_team_id is not None:
            role_positions[referee_team_id, section] = court
    for key, variable in role_any.items():
        model.add_hint(variable, int(key in role_positions))
    for (team_id, section, court), variable in role_on_court.items():
        model.add_hint(variable, int(role_positions.get((team_id, section)) == court))
    for key, variable in role_court.items():
        model.add_hint(variable, role_positions[key] + 1 if key in role_positions else 0)
    return True


def _choose_distinct_team_referees(
    ordered_matches: list[int],
    candidates_by_match: Mapping[int, list[str]],
) -> dict[int, str] | None:
    """同一セクション内で重複しないチーム審判の組合せを返す。"""

    chosen: dict[int, str] = {}

    def assign(index: int, used_team_ids: set[str]) -> bool:
        if index == len(ordered_matches):
            return True
        match_index = ordered_matches[index]
        for team_id in candidates_by_match[match_index]:
            if team_id in used_team_ids:
                continue
            chosen[match_index] = team_id
            if assign(index + 1, {*used_team_ids, team_id}):
                return True
            chosen.pop(match_index)
        return False

    return chosen if assign(0, set()) else None


def _optimize_lower_objectives(
    model: cp_model.CpModel,
    request: ScheduleRequest,
    placement: Mapping[tuple[int, int, int], cp_model.IntVar],
    match_in_section: Mapping[tuple[int, int], cp_model.IntVar],
    possible_matches_by_team: Mapping[str, tuple[int, ...]],
    role_on_court: Mapping[tuple[str, int, int], cp_model.IntVar],
    initial_solver: cp_model.CpSolver,
    time_budget: float,
) -> tuple[cp_model.CpSolver, SolverStatus, float, tuple[str, ...]]:
    """証明済みの上位目的を固定し、残る目的を段階的に最適化する。"""

    if time_budget <= 0.001:
        return initial_solver, SolverStatus.FEASIBLE, 0.0, ()
    horizon = max(section for _, section in match_in_section) + 1
    court_count = len(request.courts)
    sections, courts = range(horizon), range(court_count)

    maximum_wait = _add_maximum_wait_objective(
        model, possible_matches_by_team, match_in_section, horizon
    )

    # 直前の割当てコートを状態として持ち、空きセクションを挟む移動も1回として数える。
    # 全セクション対の組合せを作らないため、最大入力でもモデルサイズを抑えられる。
    all_moves: list[cp_model.IntVar] = []
    for team_id in possible_matches_by_team:
        last_court: list[cp_model.IntVar] = [
            model.new_bool_var(f"last_court_{team_id}_0_{court}") for court in courts
        ]
        for state in last_court:
            model.add(state == 0)
        for section in sections:
            role_any = cp_model.LinearExpr.sum(
                [role_on_court[team_id, section, court] for court in courts]
            )
            for left_court in courts:
                for right_court in courts:
                    if left_court == right_court:
                        continue
                    moved = model.new_bool_var(
                        f"all_move_{team_id}_{section}_{left_court}_{right_court}"
                    )
                    right_role = role_on_court[team_id, section, right_court]
                    model.add(moved <= last_court[left_court])
                    model.add(moved <= right_role)
                    model.add(moved >= last_court[left_court] + right_role - 1)
                    all_moves.append(moved)
            next_last_court: list[cp_model.IntVar] = []
            for court in courts:
                state = model.new_bool_var(f"last_court_{team_id}_{section + 1}_{court}")
                role_here = role_on_court[team_id, section, court]
                model.add(state >= role_here)
                model.add(state >= last_court[court] - role_any)
                model.add(state <= role_here + last_court[court])
                model.add(state <= role_here + 1 - role_any)
                next_last_court.append(state)
            last_court = next_last_court
    all_move_count = model.new_int_var(0, len(all_moves), "team_court_change_count")
    model.add(all_move_count == sum(all_moves))

    court_counts: list[cp_model.IntVar] = []
    for court in courts:
        count = model.new_int_var(0, len(request.matches), f"all_match_court_count_{court}")
        model.add(
            count
            == sum(
                placement[index, section, court]
                for index in range(len(request.matches))
                for section in sections
            )
        )
        court_counts.append(count)
    minimum_court_count = model.new_int_var(0, len(request.matches), "court_count_min")
    maximum_court_count = model.new_int_var(0, len(request.matches), "court_count_max")
    court_usage_difference = model.new_int_var(0, len(request.matches), "court_usage_difference")
    model.add_min_equality(minimum_court_count, court_counts)
    model.add_max_equality(maximum_court_count, court_counts)
    model.add(court_usage_difference == maximum_court_count - minimum_court_count)

    stages: tuple[tuple[str, cp_model.IntVar, bool], ...] = (
        ("maximum_team_wait_sections", maximum_wait, False),
        ("team_court_change_count", all_move_count, False),
        ("court_usage_difference", court_usage_difference, False),
    )
    solver = initial_solver
    optimized: list[str] = []
    wall_time = 0.0
    final_status = SolverStatus.OPTIMAL
    for stage_index, (name, objective, maximize) in enumerate(stages):
        remaining = time_budget - wall_time
        if remaining <= 0.001:
            final_status = SolverStatus.FEASIBLE
            break
        stage_budget = remaining / (len(stages) - stage_index)
        if maximize:
            model.maximize(objective)
        else:
            model.minimize(objective)
        candidate = _configured_solver(stage_budget, request.random_seed)
        candidate_status = _STATUS_MAP.get(candidate.solve(model), SolverStatus.UNKNOWN)
        wall_time += candidate.wall_time
        if candidate_status not in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}:
            final_status = SolverStatus.FEASIBLE
            break
        if candidate_status is not SolverStatus.OPTIMAL:
            # 制限時間に依存する未証明解へ差し替えず、直前まで証明済みの解を維持する。
            final_status = SolverStatus.FEASIBLE
            break
        solver = candidate
        model.add(objective == candidate.value(objective))
        optimized.append(name)
    return solver, final_status, wall_time, tuple(optimized)


def _add_maximum_wait_objective(
    model: cp_model.CpModel,
    possible_matches_by_team: Mapping[str, tuple[int, ...]],
    match_in_section: Mapping[tuple[int, int], cp_model.IntVar],
    horizon: int,
) -> cp_model.IntVar:
    waiting_runs: list[cp_model.IntVar] = []
    for team_id, relevant_matches in possible_matches_by_team.items():
        activities = [
            sum(match_in_section[index, section] for index in relevant_matches)
            for section in range(horizon)
        ]
        previous_run: cp_model.IntVar | None = None
        for section in range(horizon):
            seen_before = model.new_bool_var(f"seen_before_{team_id}_{section}")
            future_after = model.new_bool_var(f"future_after_{team_id}_{section}")
            if section == 0:
                model.add(seen_before == 0)
            else:
                model.add_max_equality(seen_before, activities[:section])
            if section + 1 == horizon:
                model.add(future_after == 0)
            else:
                model.add_max_equality(future_after, activities[section + 1 :])
            between = model.new_bool_var(f"between_matches_{team_id}_{section}")
            model.add(between <= seen_before)
            model.add(between <= future_after)
            model.add(between + activities[section] <= 1)
            model.add(between >= seen_before + future_after - activities[section] - 1)
            run = model.new_int_var(0, horizon, f"waiting_run_{team_id}_{section}")
            prior = 0 if previous_run is None else previous_run
            model.add(run == prior + 1).only_enforce_if(between)
            model.add(run == 0).only_enforce_if(between.negated())
            waiting_runs.append(run)
            previous_run = run
    maximum_wait = model.new_int_var(0, horizon, "maximum_team_wait_sections")
    if waiting_runs:
        model.add_max_equality(maximum_wait, waiting_runs)
    else:
        model.add(maximum_wait == 0)
    return maximum_wait


def _audit_schedule_quality(request: ScheduleRequest, slots: tuple[Slot, ...]) -> dict[str, int]:
    match_by_id = {match.id: match for match in request.matches}
    team_assignments: defaultdict[str, list[tuple[int, str, str]]] = defaultdict(list)
    match_sections: defaultdict[str, set[int]] = defaultdict(set)
    organizer_count = 0
    tournament_team_referees = 0
    previous_same_court = 0
    slots_by_position = {(slot.section_no, slot.court_id): slot for slot in slots}
    for slot in slots:
        if slot.match_id is None:
            continue
        match = match_by_id[slot.match_id]
        for team_id in match.possible_team_ids:
            team_assignments[team_id].append((slot.section_no, slot.court_id, "match"))
            match_sections[team_id].add(slot.section_no)
        assignment = slot.referee_assignment
        if assignment is None:
            continue
        if assignment.kind is RefereeKind.ORGANIZER:
            organizer_count += 1
            continue
        assert assignment.team_id is not None
        team_assignments[assignment.team_id].append((slot.section_no, slot.court_id, "referee"))
        if match.phase != "league":
            tournament_team_referees += 1
        previous = slots_by_position.get((slot.section_no - 1, slot.court_id))
        if (
            previous is not None
            and previous.match_id is not None
            and assignment.team_id in match_by_id[previous.match_id].possible_team_ids
        ):
            previous_same_court += 1

    maximum_wait = max(
        (
            right - left - 1
            for sections in match_sections.values()
            for left, right in zip(sorted(sections), sorted(sections)[1:], strict=False)
        ),
        default=0,
    )
    referee_then_match = 0
    adjacent_moves = 0
    all_moves = 0
    for entries in team_assignments.values():
        ordered = sorted(entries)
        for left, right in pairwise(ordered):
            if left[1] != right[1]:
                all_moves += 1
                if right[0] == left[0] + 1 and left[2] == "match" and right[2] == "referee":
                    adjacent_moves += 1
            if left[2] == "referee" and right[2] == "match" and right[0] == left[0] + 1:
                referee_then_match += 1
    court_counts = Counter(slot.court_id for slot in slots if slot.match_id is not None)
    count_values = [court_counts[court.id] for court in request.courts]
    return {
        "maximum_team_wait_sections": maximum_wait,
        "referee_then_match_count": referee_then_match,
        "league_previous_same_court_referee_count": previous_same_court,
        "adjacent_assignment_court_change_count": adjacent_moves,
        "team_court_change_count": all_moves,
        "court_usage_difference": max(count_values, default=0) - min(count_values, default=0),
        "organizer_referee_count": organizer_count,
        "tournament_team_referee_count": tournament_team_referees,
    }


def _audit_day1_arrival_preferences(
    request: ScheduleRequest,
    slots: tuple[Slot, ...],
) -> tuple[tuple[Day1ArrivalPreferenceMetric, ...], int, int, int]:
    """開始セクション配慮を実配置から独立に再集計する。"""

    if not request.day1_arrival_preferences:
        return (), 0, 0, 0
    slot_by_match = {slot.match_id: slot for slot in slots if slot.match_id is not None}
    unique_early_match_ids: set[str] = set()
    total_shortfall = 0
    total_early_referees = 0
    metrics: list[Day1ArrivalPreferenceMetric] = []
    for preference in sorted(request.day1_arrival_preferences, key=lambda item: item.team_id):
        relevant_matches = sorted(
            match.id for match in request.matches if preference.team_id in match.possible_team_ids
        )
        early_matches: list[ArrivalPreferenceEarlyMatch] = []
        for match_id in relevant_matches:
            slot = slot_by_match.get(match_id)
            if slot is None or slot.section_no >= preference.earliest_section:
                continue
            shortfall = preference.earliest_section - slot.section_no
            unique_early_match_ids.add(match_id)
            total_shortfall += shortfall
            early_matches.append(
                ArrivalPreferenceEarlyMatch(
                    match_id=match_id,
                    section_no=slot.section_no,
                    section_shortfall=shortfall,
                )
            )
        early_referee_count = sum(
            1
            for slot in slots
            if slot.section_no < preference.earliest_section
            and slot.referee_assignment is not None
            and slot.referee_assignment.kind is RefereeKind.TEAM
            and slot.referee_assignment.team_id == preference.team_id
        )
        total_early_referees += early_referee_count
        metrics.append(
            Day1ArrivalPreferenceMetric(
                team_id=preference.team_id,
                earliest_section=preference.earliest_section,
                match_count=len(relevant_matches),
                early_match_count=len(early_matches),
                early_referee_count=early_referee_count,
                total_section_shortfall=sum(item.section_shortfall for item in early_matches),
                early_matches=tuple(early_matches),
                satisfied=not early_matches and early_referee_count == 0,
            )
        )
    return tuple(metrics), len(unique_early_match_ids), total_shortfall, total_early_referees


def _arrival_preference_diagnostic(
    metrics: tuple[Day1ArrivalPreferenceMetric, ...],
    early_match_count: int,
    total_shortfall: int,
    early_referee_count: int,
) -> Diagnostic | None:
    if early_match_count == 0 and early_referee_count == 0:
        return None
    affected = [item for item in metrics if not item.satisfied]
    return Diagnostic(
        code="DAY1_ARRIVAL_PREFERENCE_UNMET",
        message="指定チームを希望セクション以降へ完全には配置できませんでした。日程表の警告を確認してください。",
        details={
            "team_ids": [item.team_id for item in affected],
            "match_ids": sorted(
                {match.match_id for item in affected for match in item.early_matches}
            ),
            "early_match_count": early_match_count,
            "total_section_shortfall": total_shortfall,
            "early_referee_count": early_referee_count,
        },
    )


def _with_total_solver_wall_time(
    result: ScheduleResult,
    prior_wall_time_seconds: float,
) -> ScheduleResult:
    """段階探索で消費したCP-SAT時間を監査値へ合算する。"""

    metrics = result.metrics.model_copy(
        update={
            "wall_time_seconds": prior_wall_time_seconds + result.metrics.wall_time_seconds,
        }
    )
    return result.model_copy(update={"metrics": metrics})


def _configured_solver(max_time_seconds: float, random_seed: int) -> cp_model.CpSolver:
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max_time_seconds
    solver.parameters.random_seed = random_seed
    solver.parameters.num_search_workers = 1
    solver.parameters.randomize_search = False
    solver.parameters.ignore_names = True
    return solver


def _extract_referee(
    solver: cp_model.CpSolver,
    match_index: int,
    section_index: int,
    organizer_referee: Mapping[tuple[int, int], cp_model.IntVar],
    team_referee: Mapping[tuple[int, int, str], cp_model.IntVar],
) -> RefereeAssignment:
    if solver.boolean_value(organizer_referee[match_index, section_index]):
        return RefereeAssignment(kind=RefereeKind.ORGANIZER)
    for (candidate_match, candidate_section, team_id), variable in team_referee.items():
        if (
            candidate_match == match_index
            and candidate_section == section_index
            and solver.boolean_value(variable)
        ):
            return RefereeAssignment(kind=RefereeKind.TEAM, team_id=team_id)
    raise RuntimeError("配置済み試合に審判が割り当てられていません")


def _preflight(request: ScheduleRequest, horizon: int) -> tuple[Diagnostic, ...]:
    required_matches = len(request.matches)
    available_slots = len(request.courts) * horizon
    if required_matches > available_slots:
        return (
            Diagnostic(
                code="INSUFFICIENT_SLOTS",
                message="利用可能なコートとセクションだけでは、すべての試合を配置できません。",
                details={
                    "required_matches": required_matches,
                    "available_slots": available_slots,
                    "max_sections": horizon,
                },
            ),
        )

    cycle = _find_dependency_cycle(request.matches)
    if cycle:
        return (
            Diagnostic(
                code="TOURNAMENT_DEPENDENCY_CYCLE",
                message="試合の依存関係が循環しているため、日程を生成できません。",
                details={"match_ids": cycle},
            ),
        )
    return ()


def _find_dependency_cycle(matches: tuple[MatchSpec, ...]) -> list[str]:
    dependencies = {match.id: match.prerequisite_match_ids for match in matches}
    visiting: set[str] = set()
    visited: set[str] = set()
    stack: list[str] = []

    def visit(match_id: str) -> list[str]:
        if match_id in visiting:
            cycle_start = stack.index(match_id)
            return [*stack[cycle_start:], match_id]
        if match_id in visited:
            return []
        visiting.add(match_id)
        stack.append(match_id)
        for prerequisite_id in dependencies[match_id]:
            cycle = visit(prerequisite_id)
            if cycle:
                return cycle
        stack.pop()
        visiting.remove(match_id)
        visited.add(match_id)
        return []

    for current_match_id in dependencies:
        cycle = visit(current_match_id)
        if cycle:
            return cycle
    return []


def _failure_diagnostic(status: SolverStatus, request: ScheduleRequest, horizon: int) -> Diagnostic:
    details: dict[str, int | float | str | bool | list[str]] = {
        "required_matches": len(request.matches),
        "available_slots": len(request.courts) * horizon,
        "max_sections": horizon,
    }
    if status is SolverStatus.INFEASIBLE:
        if (
            request.day.id == _DAY1_ID
            and request.referees.team_referees_required_after_first
            and all(match.phase == "league" for match in request.matches)
        ):
            return Diagnostic(
                code="LEAGUE_REFEREE_UNAVAILABLE",
                message=(
                    "直前セクションの同じコートで試合したチームから安全な審判を"
                    "供給できるリーグ日程がありません。セクション数やコート数を確認してください。"
                ),
                details=details,
            )
        return Diagnostic(
            code="SCHEDULE_INFEASIBLE",
            message="指定された制約をすべて満たす日程は存在しません。",
            details=details,
        )
    return Diagnostic(
        code="SCHEDULE_SEARCH_TIMEOUT",
        message="制限時間内に実行可能な日程を見つけられませんでした。条件を変えて再実行してください。",
        details=details,
    )


def _result_without_schedule(
    request: ScheduleRequest,
    status: SolverStatus,
    wall_time_seconds: float,
    diagnostics: tuple[Diagnostic, ...],
) -> ScheduleResult:
    return ScheduleResult(
        status=status,
        metrics=SolverMetrics(
            random_seed=request.random_seed,
            max_time_seconds=request.solver.max_time_seconds,
            ortools_version=_ORTOOLS_VERSION,
            wall_time_seconds=max(0.0, wall_time_seconds),
            optimality_proven=status is SolverStatus.INFEASIBLE,
        ),
        diagnostics=diagnostics,
    )
