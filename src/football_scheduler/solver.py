"""OR-Tools CP-SATを用いたFaaS非依存の技術検証スケジューラ。"""

from __future__ import annotations

from collections.abc import Mapping
from importlib.metadata import version
from time import perf_counter
from typing import Any

from ortools.sat.python import cp_model

from football_scheduler.models import (
    Diagnostic,
    MatchSpec,
    RefereeAssignment,
    RefereeKind,
    ScheduleRequest,
    ScheduleResult,
    Slot,
    SolverMetrics,
    SolverStatus,
    TeamRefereeCount,
)

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


def solve_schedule(request: ScheduleRequest | Mapping[str, Any]) -> ScheduleResult:
    """大会入力を検証し、日程を生成する。

    Lambdaなどの実行環境には依存しない。辞書を渡した場合もPydantic契約で検証してから
    CP-SATを実行する。
    """

    if not isinstance(request, ScheduleRequest):
        request = ScheduleRequest.model_validate(request)

    started_at = perf_counter()
    horizon = request.day.max_sections or max(1, len(request.matches) * 2)
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
    if minimum_horizon < horizon:
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

    return _solve_schedule_at_horizon(request, horizon, solver_time_budget)


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

    league_match_indexes = frozenset(
        index for index, match in enumerate(request.matches) if match.phase == "league"
    )
    league_match_count = len(league_match_indexes)
    used_sections_expression = sum(active_sections)
    primary_objective_weight = league_match_count + 1
    model.minimize(used_sections_expression)
    primary_solver = _configured_solver(solver_time_budget, request.random_seed)
    primary_status = _STATUS_MAP.get(primary_solver.solve(model), SolverStatus.UNKNOWN)
    wall_time = primary_solver.wall_time

    if primary_status not in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}:
        diagnostic = _failure_diagnostic(primary_status, request, horizon)
        return _result_without_schedule(request, primary_status, wall_time, (diagnostic,))

    solver = primary_solver
    status = SolverStatus.FEASIBLE
    best_primary_bound = primary_solver.best_objective_bound
    primary_used_sections = sum(
        primary_solver.boolean_value(section) for section in active_sections
    )
    remaining_time = solver_time_budget - wall_time
    fairness_time_threshold = (
        _LARGE_LEAGUE_FAIRNESS_TIME_SECONDS
        if league_match_count > 24
        else _MIN_FAIRNESS_TIME_SECONDS
    )
    if primary_status is SolverStatus.OPTIMAL and remaining_time >= fairness_time_threshold:
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
        ]
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

    diagnostics: tuple[Diagnostic, ...] = ()
    if status is SolverStatus.FEASIBLE:
        diagnostics = (
            Diagnostic(
                code="OPTIMALITY_NOT_PROVEN",
                message="実行可能な日程は見つかりましたが、制限時間内に最適性を証明できませんでした。",
            ),
        )

    return ScheduleResult(
        status=status,
        slots=tuple(slots),
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
            optimality_proven=status is SolverStatus.OPTIMAL,
        ),
        diagnostics=diagnostics,
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
