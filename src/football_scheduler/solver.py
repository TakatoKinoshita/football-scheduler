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
)

_STATUS_MAP = {
    cp_model.OPTIMAL: SolverStatus.OPTIMAL,
    cp_model.FEASIBLE: SolverStatus.FEASIBLE,
    cp_model.INFEASIBLE: SolverStatus.INFEASIBLE,
    cp_model.UNKNOWN: SolverStatus.UNKNOWN,
}
_ORTOOLS_VERSION = version("ortools")


def solve_schedule(request: ScheduleRequest | Mapping[str, Any]) -> ScheduleResult:
    """大会入力を検証し、日程を生成する。

    Lambdaなどの実行環境には依存しない。辞書を渡した場合もPydantic契約で検証してから
    CP-SATを実行する。
    """

    if not isinstance(request, ScheduleRequest):
        request = ScheduleRequest.model_validate(request)

    started_at = perf_counter()
    horizon = request.day.max_sections or max(1, len(request.matches) * 2)

    preflight_diagnostics = _preflight(request, horizon)
    if preflight_diagnostics:
        return _result_without_schedule(
            request,
            SolverStatus.INFEASIBLE,
            perf_counter() - started_at,
            preflight_diagnostics,
        )

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

    used_sections_expression = sum(active_sections)
    model.minimize(used_sections_expression)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = request.solver.max_time_seconds
    solver.parameters.random_seed = request.random_seed
    solver.parameters.num_search_workers = 1
    solver.parameters.randomize_search = False
    status_code = solver.solve(model)
    status = _STATUS_MAP.get(status_code, SolverStatus.UNKNOWN)
    wall_time = solver.wall_time

    if status not in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}:
        diagnostic = _failure_diagnostic(status, request, horizon)
        return _result_without_schedule(request, status, wall_time, (diagnostic,))

    used_sections = round(solver.objective_value)
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
            objective_value=solver.objective_value,
            best_objective_bound=solver.best_objective_bound,
            optimality_proven=status is SolverStatus.OPTIMAL,
        ),
        diagnostics=diagnostics,
    )


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
