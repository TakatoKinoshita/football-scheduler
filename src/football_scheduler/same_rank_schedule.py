"""同順位リーグ専用の2日目日程生成。"""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import time
from importlib.metadata import version
from itertools import pairwise
from time import perf_counter
from typing import Annotated, Any, Literal, Self

from ortools.sat.python import cp_model
from pydantic import Field, model_validator

from football_scheduler.day2_schedule import Day1ScheduleSource
from football_scheduler.league import LeaguePlan, LeagueTeam
from football_scheduler.models import (
    ContractModel,
    Court,
    Day2Fallback,
    DaySettings,
    Diagnostic,
    Identifier,
    ObjectiveStageMetric,
    RefereeKind,
    RefereeSettings,
    SectionTiming,
    SolverSettings,
    SolverStatus,
)
from football_scheduler.same_rank_league import (
    SameRankLeaguePlan,
    SameRankMatch,
    SameRankPlanInvariantError,
    validate_same_rank_plan_invariants,
)
from football_scheduler.timekeeping import (
    DayTimingError,
    expected_end_time,
    resolve_max_sections,
    section_timings,
)
from football_scheduler.tournament import LeagueRankRef, ParticipantResolution

_ORTOOLS_VERSION = version("ortools")
_MAX_SECTIONS = 128
_RANK_KEY = tuple[str, int]


class SameRankDay2ScheduleRequest(ContractModel):
    schema_version: Literal["0.2.0"] = "0.2.0"
    request_kind: Literal["same_rank_day2_schedule"]
    teams: Annotated[tuple[LeagueTeam, ...], Field(min_length=4, max_length=32)]
    courts: Annotated[tuple[Court, ...], Field(min_length=1, max_length=16)]
    league_plan: LeaguePlan
    day1_schedule: Day1ScheduleSource
    same_rank_plan: SameRankLeaguePlan
    day: DaySettings = DaySettings(id="day2", game_duration_minutes=35, margin_minutes=10)
    referees: RefereeSettings
    random_seed: int = 20260803
    solver: SolverSettings = SolverSettings()

    @model_validator(mode="after")
    def validate_source(self) -> Self:
        if self.day.id != "day2":
            raise ValueError("2日目設定のidはday2にしてください")
        team_ids = [team.id for team in self.teams]
        court_ids = [court.id for court in self.courts]
        if len(set(team_ids)) != len(team_ids):
            raise ValueError("チームIDは大会内で一意である必要があります")
        if len(set(court_ids)) != len(court_ids):
            raise ValueError("コートIDは大会内で一意である必要があります")
        planned_team_ids = {
            team_id for block in self.league_plan.blocks for team_id in block.team_ids
        }
        if planned_team_ids != set(team_ids):
            raise ValueError("リーグ計画と登録チームが一致しません")
        expected_rank_keys = {
            (block.id, rank)
            for block in self.league_plan.blocks
            for rank in range(1, len(block.team_ids) + 1)
        }
        participants = [
            participant
            for group in self.same_rank_plan.groups
            for participant in group.participants
        ]
        actual_rank_keys = {
            (participant.entry.block_id, participant.entry.rank) for participant in participants
        }
        if len(participants) != len(actual_rank_keys) or actual_rank_keys != expected_rank_keys:
            raise ValueError("同順位リーグの順位枠とリーグ計画が一致しません")
        annotations = [
            participant.team.team_id for participant in participants if participant.team is not None
        ]
        if self.same_rank_plan.participant_resolution is ParticipantResolution.RESOLVED:
            if len(annotations) != len(participants) or set(annotations) != set(team_ids):
                raise ValueError("同順位リーグの確定チームと登録チームが一致しません")
        elif annotations:
            raise ValueError("仮の同順位リーグにチーム注記を混在させることはできません")
        return self


class SameRankRefereeAssignment(ContractModel):
    kind: RefereeKind
    rank_ref: LeagueRankRef | None = None
    team_id: Identifier | None = None
    organizer_reason: Literal["first_section", "fallback"] | None = None
    fallback_reasons: tuple[Identifier, ...] = ()

    @model_validator(mode="after")
    def validate_assignment(self) -> Self:
        if self.kind is RefereeKind.TEAM:
            if self.rank_ref is None or self.organizer_reason is not None or self.fallback_reasons:
                raise ValueError("チーム審判には順位枠だけを供給元として指定してください")
        elif self.rank_ref is not None or self.team_id is not None:
            raise ValueError("主催者審判にチームまたは順位枠を指定できません")
        if self.organizer_reason == "fallback" and not self.fallback_reasons:
            raise ValueError("主催者フォールバックには理由が必要です")
        if self.organizer_reason != "fallback" and self.fallback_reasons:
            raise ValueError("フォールバック理由は主催者フォールバック時だけ指定できます")
        return self


class SameRankSlot(ContractModel):
    day_id: Literal["day2"] = "day2"
    section_no: Annotated[int, Field(gt=0)]
    court_id: Identifier
    match_id: Identifier | None
    referee_assignment: SameRankRefereeAssignment | None


class SameRankTeamRouteEntry(ContractModel):
    rank_ref: LeagueRankRef
    team_id: Identifier | None = None
    role: Literal["match", "referee"]
    match_id: Identifier
    section_no: Annotated[int, Field(gt=0)]
    court_id: Identifier


class SameRankRefereeCount(ContractModel):
    rank_ref: LeagueRankRef
    team_id: Identifier | None = None
    count: Annotated[int, Field(ge=0)]


class SameRankScheduleMetrics(ContractModel):
    random_seed: int
    num_search_workers: Literal[1] = 1
    max_time_seconds: float
    ortools_version: str
    wall_time_seconds: Annotated[float, Field(ge=0)]
    used_sections: Annotated[int, Field(ge=0)] | None = None
    referee_counts: tuple[SameRankRefereeCount, ...] = ()
    referee_count_min: Annotated[int, Field(ge=0)] | None = None
    referee_count_max: Annotated[int, Field(ge=0)] | None = None
    referee_count_difference: Annotated[int, Field(ge=0)] | None = None
    maximum_team_wait_sections: Annotated[int, Field(ge=0)] | None = None
    referee_then_match_count: Annotated[int, Field(ge=0)] | None = None
    previous_same_court_referee_count: Annotated[int, Field(ge=0)] | None = None
    gap_court_change_count: Annotated[int, Field(ge=0)] | None = None
    court_usage_difference: Annotated[int, Field(ge=0)] | None = None
    organizer_referee_count: Annotated[int, Field(ge=0)] | None = None
    fallback_count: Annotated[int, Field(ge=0)] | None = None
    unused_slot_count: Annotated[int, Field(ge=0)] | None = None
    layout_attempt_count: Annotated[int, Field(ge=0)] = 0
    optimized_objectives: tuple[Identifier, ...] = ()
    objective_stages: tuple[ObjectiveStageMetric, ...] = ()
    optimality_proven: bool


class SameRankDay2Schedule(ContractModel):
    schema_version: Literal["0.2.0"] = "0.2.0"
    schedule_scope: Literal["day2_same_rank_league"] = "day2_same_rank_league"
    participant_resolution: ParticipantResolution
    status: SolverStatus
    same_rank_matches: tuple[SameRankMatch, ...]
    slots: tuple[SameRankSlot, ...] = ()
    section_timings: tuple[SectionTiming, ...] = ()
    expected_end_time: time | None = None
    team_schedules: tuple[SameRankTeamRouteEntry, ...] = ()
    metrics: SameRankScheduleMetrics
    diagnostics: tuple[Diagnostic, ...] = ()


class SameRankScheduleError(ValueError):
    def __init__(self, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.code, self.message, self.details = code, message, details


@dataclass(frozen=True, slots=True)
class _LayoutModel:
    model: cp_model.CpModel
    sections: tuple[cp_model.IntVar, ...]
    courts: tuple[cp_model.IntVar, ...]
    slots: tuple[cp_model.IntVar, ...]
    used_sections: cp_model.IntVar


@dataclass(frozen=True, slots=True)
class _Layout:
    sections: tuple[int, ...]
    courts: tuple[int, ...]
    used_sections: int
    optimal: bool


@dataclass(frozen=True, slots=True)
class _RefereeSolution:
    rank_by_match: tuple[int | None, ...]
    counts: tuple[int, ...]
    organizer_count: int
    fallback_count: int
    referee_then_match_count: int
    previous_same_court_referee_count: int
    optimal: bool


def generate_same_rank_day2_schedule(
    request: SameRankDay2ScheduleRequest | Mapping[str, object],
) -> SameRankDay2Schedule:
    """LeagueRankを参加者IDとして、仮・確定で同一構造の日程を生成する。"""

    data = (
        request
        if isinstance(request, SameRankDay2ScheduleRequest)
        else SameRankDay2ScheduleRequest.model_validate(request)
    )
    try:
        validate_same_rank_plan_invariants(data.same_rank_plan, data.league_plan)
    except SameRankPlanInvariantError as exc:
        raise SameRankScheduleError(
            "SAME_RANK_SOURCE_INVALID",
            "同順位リーグ計画と予選ブロックの対応を確認できませんでした。2日目を再作成してください。",
            reason=exc.reason,
            **exc.details,
        ) from exc
    matches = tuple(match for group in data.same_rank_plan.groups for match in group.matches)
    if not matches:
        return SameRankDay2Schedule(
            participant_resolution=data.same_rank_plan.participant_resolution,
            status=SolverStatus.OPTIMAL,
            same_rank_matches=(),
            metrics=_empty_metrics(data),
        )
    try:
        horizon = resolve_max_sections(
            data.day,
            min(_MAX_SECTIONS, max(1, len(matches))),
        )
    except DayTimingError as exc:
        raise SameRankScheduleError(exc.code, exc.message, **exc.details) from exc
    if horizon > _MAX_SECTIONS:
        raise SameRankScheduleError(
            "SECTION_LIMIT_EXCEEDED",
            f"セクション数が上限の{_MAX_SECTIONS}を超えています。",
            actual=horizon,
            maximum=_MAX_SECTIONS,
        )
    if len(matches) > horizon * len(data.courts):
        theoretical_minimum = (len(matches) + len(data.courts) - 1) // len(data.courts)
        return _failed_schedule(
            data,
            matches,
            SolverStatus.INFEASIBLE,
            "INSUFFICIENT_SLOTS",
            "利用可能なコートとセクションだけでは、同順位リーグの全試合を配置できません。",
            required_match_count=len(matches),
            available_slot_count=horizon * len(data.courts),
            theoretical_minimum_sections=theoretical_minimum,
        )

    rank_refs = _rank_refs(data.same_rank_plan)
    rank_index = {_rank_key(ref): index for index, ref in enumerate(rank_refs)}
    match_ranks = tuple(
        (rank_index[_rank_key(match.home)], rank_index[_rank_key(match.away)]) for match in matches
    )
    started = perf_counter()
    layout_model = _build_layout_model(
        match_ranks,
        len(rank_refs),
        len(data.courts),
        horizon,
        require_team_referees=data.referees.day2_fallback is Day2Fallback.STRICT,
    )
    attempts = 0
    current_used: int | None = None
    timed_out = False
    best_team: tuple[_Layout, _RefereeSolution] | None = None
    best_team_key: tuple[int, ...] | None = None
    best_fallback: tuple[_Layout, _RefereeSolution] | None = None
    best_fallback_key: tuple[int, ...] | None = None
    all_referee_stages_optimal = True
    while True:
        remaining = data.solver.max_time_seconds - (perf_counter() - started)
        if remaining <= 0:
            timed_out = True
            break
        layout_status, layout = _solve_layout(
            layout_model,
            data.random_seed,
            max(0.001, remaining * 0.65),
        )
        if layout is None:
            timed_out = layout_status is SolverStatus.UNKNOWN
            break
        attempts += 1
        if current_used is None:
            current_used = layout.used_sections
        elif layout.used_sections > current_used:
            if best_team is not None or best_fallback is not None:
                break
            current_used = layout.used_sections

        referee_status, referee = _solve_referees(
            match_ranks,
            layout,
            len(rank_refs),
            len(data.courts),
            data.referees,
            data.random_seed,
            max(0.001, data.solver.max_time_seconds - (perf_counter() - started)),
        )
        if referee_status is SolverStatus.UNKNOWN:
            timed_out = True
            break
        if referee is not None:
            key = _objective_key(match_ranks, layout, referee, len(data.courts))
            all_referee_stages_optimal = all_referee_stages_optimal and referee.optimal
            if referee.fallback_count:
                if best_fallback_key is None or key < best_fallback_key:
                    best_fallback = layout, referee
                    best_fallback_key = key
            elif best_team_key is None or key < best_team_key:
                best_team = layout, referee
                best_team_key = key
            _exclude_layout(layout_model, layout)
            continue
        _exclude_layout(layout_model, layout)

    best = best_team or best_fallback
    if best is not None:
        layout, referee = best
        fully_enumerated = not timed_out
        return _successful_schedule(
            data,
            matches,
            rank_refs,
            match_ranks,
            layout,
            referee,
            attempts,
            started,
            fully_enumerated and all_referee_stages_optimal,
        )

    status = SolverStatus.UNKNOWN if timed_out else SolverStatus.INFEASIBLE
    code = (
        "SAME_RANK_SCHEDULE_SEARCH_TIMEOUT"
        if status is SolverStatus.UNKNOWN
        else "SAME_RANK_REFEREE_UNAVAILABLE"
    )
    message = (
        "制限時間内に同順位リーグの日程を見つけられませんでした。条件を変えて再実行してください。"
        if status is SolverStatus.UNKNOWN
        else "指定された時間・休憩・審判条件では、同順位リーグの日程を作成できません。"
    )
    return _failed_schedule(
        data,
        matches,
        status,
        code,
        message,
        layout_attempt_count=attempts,
        wall_time_seconds=perf_counter() - started,
        required_match_count=len(matches),
        available_slot_count=horizon * len(data.courts),
        theoretical_minimum_sections=((len(matches) + len(data.courts) - 1) // len(data.courts)),
    )


def _rank_key(ref: LeagueRankRef) -> _RANK_KEY:
    return ref.block_id, ref.rank


def _rank_refs(plan: SameRankLeaguePlan) -> tuple[LeagueRankRef, ...]:
    return tuple(participant.entry for group in plan.groups for participant in group.participants)


def _build_layout_model(
    match_ranks: tuple[tuple[int, int], ...],
    rank_count: int,
    court_count: int,
    horizon: int,
    *,
    require_team_referees: bool,
) -> _LayoutModel:
    model = cp_model.CpModel()
    sections = tuple(
        model.new_int_var(0, horizon - 1, f"section_{match}") for match in range(len(match_ranks))
    )
    courts = tuple(
        model.new_int_var(0, court_count - 1, f"court_{match}") for match in range(len(match_ranks))
    )
    slots = tuple(
        model.new_int_var(0, horizon * court_count - 1, f"slot_{match}")
        for match in range(len(match_ranks))
    )
    for match in range(len(match_ranks)):
        model.add(slots[match] == sections[match] * court_count + courts[match])
    model.add_all_different(slots)
    for rank in range(rank_count):
        intervals = [
            model.new_fixed_size_interval_var(sections[index], 2, f"rest_{rank}_{index}")
            for index, pair in enumerate(match_ranks)
            if rank in pair
        ]
        if len(intervals) > 1:
            model.add_no_overlap(intervals)
    if require_team_referees:
        matches_by_rank = {
            rank: tuple(
                match for match, participants in enumerate(match_ranks) if rank in participants
            )
            for rank in range(rank_count)
        }
        for current, current_participants in enumerate(match_ranks):
            first_section = model.new_bool_var(f"first_section_{current}")
            model.add(sections[current] == 0).only_enforce_if(first_section)
            model.add(sections[current] != 0).only_enforce_if(~first_section)
            sources: list[cp_model.IntVar] = []
            for previous, previous_participants in enumerate(match_ranks):
                if previous == current:
                    continue
                for rank in previous_participants:
                    if rank in current_participants:
                        continue
                    source = model.new_bool_var(f"source_{previous}_{current}_{rank}")
                    sources.append(source)
                    model.add(sections[current] == sections[previous] + 1).only_enforce_if(source)
                    model.add(courts[current] == courts[previous]).only_enforce_if(source)
                    for following in matches_by_rank[rank]:
                        if following != previous:
                            model.add(sections[following] != sections[current] + 1).only_enforce_if(
                                source
                            )
            model.add(sum(sources) + first_section == 1)
    minimum = model.new_int_var(0, horizon - 1, "minimum_section")
    maximum = model.new_int_var(0, horizon - 1, "maximum_section")
    model.add_min_equality(minimum, sections)
    model.add_max_equality(maximum, sections)
    model.add(minimum == 0)
    used_sections = model.new_int_var(1, horizon, "used_sections")
    model.add(used_sections == maximum + 1)
    model.minimize(used_sections)
    return _LayoutModel(model, sections, courts, slots, used_sections)


def _solve_layout(
    built: _LayoutModel,
    random_seed: int,
    max_time_seconds: float,
) -> tuple[SolverStatus, _Layout | None]:
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max(0.001, max_time_seconds)
    solver.parameters.num_search_workers = 1
    solver.parameters.random_seed = random_seed
    status = solver.solve(built.model)
    if status == cp_model.INFEASIBLE:
        return SolverStatus.INFEASIBLE, None
    if status not in {cp_model.OPTIMAL, cp_model.FEASIBLE}:
        return SolverStatus.UNKNOWN, None
    solved_status = SolverStatus.OPTIMAL if status == cp_model.OPTIMAL else SolverStatus.FEASIBLE
    return (
        solved_status,
        _Layout(
            sections=tuple(solver.value(value) for value in built.sections),
            courts=tuple(solver.value(value) for value in built.courts),
            used_sections=solver.value(built.used_sections),
            optimal=status == cp_model.OPTIMAL,
        ),
    )


def _exclude_layout(built: _LayoutModel, layout: _Layout) -> None:
    equalities: list[cp_model.IntVar] = []
    for index, expected in enumerate(
        section * 10_000 + court
        for section, court in zip(layout.sections, layout.courts, strict=True)
    ):
        combined = built.model.new_int_var(0, 2_000_000, f"excluded_value_{len(equalities)}")
        built.model.add(combined == built.sections[index] * 10_000 + built.courts[index])
        equal = built.model.new_bool_var(f"excluded_equal_{index}_{expected}")
        built.model.add(combined == expected).only_enforce_if(equal)
        built.model.add(combined != expected).only_enforce_if(~equal)
        equalities.append(equal)
    built.model.add(sum(equalities) <= len(equalities) - 1)


def _solve_referees(
    match_ranks: tuple[tuple[int, int], ...],
    layout: _Layout,
    rank_count: int,
    court_count: int,
    settings: RefereeSettings,
    random_seed: int,
    max_time_seconds: float,
) -> tuple[SolverStatus, _RefereeSolution | None]:
    del court_count
    started = perf_counter()
    strict_budget = (
        max_time_seconds
        if settings.day2_fallback is Day2Fallback.STRICT
        else max(0.001, max_time_seconds / 2)
    )
    strict_status, strict_solution = _solve_referee_model(
        match_ranks,
        layout,
        rank_count,
        settings.organizer_capacity,
        False,
        random_seed,
        strict_budget,
    )
    if strict_solution is not None:
        return strict_status, strict_solution
    if settings.day2_fallback is Day2Fallback.STRICT:
        return strict_status, None
    remaining = max_time_seconds - (perf_counter() - started)
    if remaining <= 0:
        return SolverStatus.UNKNOWN, None
    fallback_status, fallback_solution = _solve_referee_model(
        match_ranks,
        layout,
        rank_count,
        settings.organizer_capacity,
        True,
        random_seed,
        remaining,
    )
    if fallback_solution is not None:
        return fallback_status, fallback_solution
    section_counts = Counter(layout.sections)
    if max(section_counts.values(), default=0) > settings.organizer_capacity:
        return fallback_status, None
    first_count = section_counts.get(0, 0)
    return (
        SolverStatus.FEASIBLE,
        _RefereeSolution(
            rank_by_match=(None,) * len(match_ranks),
            counts=(0,) * rank_count,
            organizer_count=len(match_ranks),
            fallback_count=len(match_ranks) - first_count,
            referee_then_match_count=0,
            previous_same_court_referee_count=0,
            optimal=False,
        ),
    )


def _solve_referee_model(
    match_ranks: tuple[tuple[int, int], ...],
    layout: _Layout,
    rank_count: int,
    organizer_capacity: int,
    allow_fallback: bool,
    random_seed: int,
    max_time_seconds: float,
) -> tuple[SolverStatus, _RefereeSolution | None]:
    model = cp_model.CpModel()
    organizer = tuple(model.new_bool_var(f"organizer_{match}") for match in range(len(match_ranks)))
    match_by_position = {
        (section, court): match
        for match, (section, court) in enumerate(zip(layout.sections, layout.courts, strict=True))
    }
    referee: dict[tuple[int, int], cp_model.IntVar] = {}
    for match, participants in enumerate(match_ranks):
        match_candidates: list[cp_model.IntVar] = []
        section = layout.sections[match]
        previous_match = match_by_position.get((section - 1, layout.courts[match]))
        previous_participants = match_ranks[previous_match] if previous_match is not None else ()
        for rank in previous_participants:
            if rank in participants or (match, rank) in referee:
                continue
            value = model.new_bool_var(f"referee_{match}_{rank}")
            referee[match, rank] = value
            match_candidates.append(value)
        model.add(sum(match_candidates) + organizer[match] == 1)
        if section == 0:
            model.add(organizer[match] == 1)
        elif not allow_fallback:
            model.add(organizer[match] == 0)

    matches_by_section: dict[int, list[int]] = defaultdict(list)
    for match, section in enumerate(layout.sections):
        matches_by_section[section].append(match)
    for section_matches in matches_by_section.values():
        model.add(sum(organizer[match] for match in section_matches) <= organizer_capacity)

    match_court_by_rank_section: dict[tuple[int, int], int] = {}
    for match, participants in enumerate(match_ranks):
        for rank in participants:
            match_court_by_rank_section[rank, layout.sections[match]] = layout.courts[match]
    for rank in range(rank_count):
        referee_by_section: dict[int, list[tuple[int, cp_model.IntVar]]] = defaultdict(list)
        for match in range(len(match_ranks)):
            variable = referee.get((match, rank))
            if variable is not None:
                referee_by_section[layout.sections[match]].append((match, variable))
        for section, section_candidates in referee_by_section.items():
            if (rank, section) in match_court_by_rank_section:
                for _, variable in section_candidates:
                    model.add(variable == 0)
            else:
                model.add(sum(variable for _, variable in section_candidates) <= 1)
            if (rank, section + 1) in match_court_by_rank_section:
                for _, variable in section_candidates:
                    model.add(variable == 0)
        for section, current in referee_by_section.items():
            following = referee_by_section.get(section + 1, ())
            for current_match, current_var in current:
                for next_match, next_var in following:
                    if layout.courts[current_match] != layout.courts[next_match]:
                        model.add(current_var + next_var <= 1)

    counts = tuple(
        model.new_int_var(0, len(match_ranks), f"count_{rank}") for rank in range(rank_count)
    )
    for rank in range(rank_count):
        model.add(
            counts[rank] == sum(referee.get((match, rank), 0) for match in range(len(match_ranks)))
        )
    minimum = model.new_int_var(0, len(match_ranks), "minimum_count")
    maximum = model.new_int_var(0, len(match_ranks), "maximum_count")
    difference = model.new_int_var(0, len(match_ranks), "count_difference")
    model.add_min_equality(minimum, counts)
    model.add_max_equality(maximum, counts)
    model.add(difference == maximum - minimum)
    organizer_count = model.new_int_var(0, len(match_ranks), "organizer_count")
    model.add(organizer_count == sum(organizer))
    referee_then_match_terms: list[cp_model.IntVar] = []
    previous_same_court_terms: list[cp_model.IntVar] = []
    for (match, rank), variable in referee.items():
        section = layout.sections[match]
        if (rank, section + 1) in match_court_by_rank_section:
            referee_then_match_terms.append(variable)
        previous_match = match_by_position.get((section - 1, layout.courts[match]))
        if previous_match is not None and rank in match_ranks[previous_match]:
            previous_same_court_terms.append(variable)
    referee_then_match = model.new_int_var(0, len(match_ranks), "referee_then_match")
    previous_same_court = model.new_int_var(0, len(match_ranks), "previous_same_court")
    model.add(referee_then_match == sum(referee_then_match_terms))
    model.add(previous_same_court == sum(previous_same_court_terms))

    started = perf_counter()
    stages: list[tuple[cp_model.IntVar, bool]] = []
    if allow_fallback:
        stages.append((organizer_count, False))
    stages.extend(((difference, False),))
    status: cp_model.CpSolverStatus = cp_model.UNKNOWN
    best_solver: cp_model.CpSolver | None = None
    all_optimal = True
    completed_stages = 0
    for objective, maximize in stages:
        remaining = max_time_seconds - (perf_counter() - started)
        if remaining <= 0:
            break
        if maximize:
            model.maximize(objective)
        else:
            model.minimize(objective)
        candidate = cp_model.CpSolver()
        candidate.parameters.max_time_in_seconds = max(0.001, remaining)
        candidate.parameters.num_search_workers = 1
        candidate.parameters.random_seed = random_seed
        status = candidate.solve(model)
        if status == cp_model.INFEASIBLE and best_solver is None:
            return SolverStatus.INFEASIBLE, None
        if status not in {cp_model.OPTIMAL, cp_model.FEASIBLE}:
            break
        best_solver = candidate
        completed_stages += 1
        if status != cp_model.OPTIMAL:
            all_optimal = False
            break
        model.add(objective == candidate.value(objective))
    if best_solver is None:
        return SolverStatus.UNKNOWN, None
    all_optimal = all_optimal and completed_stages == len(stages)
    solver = best_solver
    rank_by_match: list[int | None] = []
    for match in range(len(match_ranks)):
        selected = next(
            (
                rank
                for rank in range(rank_count)
                if (match, rank) in referee and solver.boolean_value(referee[match, rank])
            ),
            None,
        )
        rank_by_match.append(selected)
    org_count = solver.value(organizer_count)
    first_count = sum(section == 0 for section in layout.sections)
    solved_status = SolverStatus.OPTIMAL if all_optimal else SolverStatus.FEASIBLE
    return (
        solved_status,
        _RefereeSolution(
            rank_by_match=tuple(rank_by_match),
            counts=tuple(solver.value(count) for count in counts),
            organizer_count=org_count,
            fallback_count=max(0, org_count - first_count),
            referee_then_match_count=solver.value(referee_then_match),
            previous_same_court_referee_count=solver.value(previous_same_court),
            optimal=all_optimal,
        ),
    )


def _objective_key(
    match_ranks: tuple[tuple[int, int], ...],
    layout: _Layout,
    referee: _RefereeSolution,
    court_count: int,
) -> tuple[int, ...]:
    maximum_wait, gap_moves = _route_metrics(match_ranks, layout, referee)
    usage = [layout.courts.count(court) for court in range(court_count)]
    court_difference = max(usage, default=0) - min(usage, default=0)
    return (
        layout.used_sections,
        referee.fallback_count,
        max(referee.counts, default=0) - min(referee.counts, default=0),
        maximum_wait,
        gap_moves,
        court_difference,
    )


def _route_metrics(
    match_ranks: tuple[tuple[int, int], ...],
    layout: _Layout,
    referee: _RefereeSolution,
) -> tuple[int, int]:
    rank_count = len(referee.counts)
    match_sections: dict[int, list[int]] = defaultdict(list)
    roles: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for match, participants in enumerate(match_ranks):
        section, court = layout.sections[match], layout.courts[match]
        for rank in participants:
            match_sections[rank].append(section)
            roles[rank].append((section, court))
        referee_rank = referee.rank_by_match[match]
        if referee_rank is not None:
            roles[referee_rank].append((section, court))
    maximum_wait = 0
    gap_moves = 0
    for rank in range(rank_count):
        ordered_matches = sorted(match_sections[rank])
        maximum_wait = max(
            maximum_wait,
            max(
                (right - left - 1 for left, right in pairwise(ordered_matches)),
                default=0,
            ),
        )
        ordered_roles = sorted(roles[rank])
        gap_moves += sum(
            right_section - left_section > 1 and right_court != left_court
            for (left_section, left_court), (right_section, right_court) in pairwise(ordered_roles)
        )
    return maximum_wait, gap_moves


def _team_by_rank(plan: SameRankLeaguePlan) -> dict[_RANK_KEY, str]:
    return {
        _rank_key(participant.entry): participant.team.team_id
        for group in plan.groups
        for participant in group.participants
        if participant.team is not None
    }


def _successful_schedule(
    data: SameRankDay2ScheduleRequest,
    matches: tuple[SameRankMatch, ...],
    rank_refs: tuple[LeagueRankRef, ...],
    match_ranks: tuple[tuple[int, int], ...],
    layout: _Layout,
    referee: _RefereeSolution,
    attempts: int,
    started: float,
    optimality_proven: bool,
) -> SameRankDay2Schedule:
    team_by_rank = _team_by_rank(data.same_rank_plan)
    match_by_slot = {
        (section, court): index
        for index, (section, court) in enumerate(zip(layout.sections, layout.courts, strict=True))
    }
    slots: list[SameRankSlot] = []
    routes: list[SameRankTeamRouteEntry] = []
    for section in range(layout.used_sections):
        for court, court_spec in enumerate(data.courts):
            match_index = match_by_slot.get((section, court))
            if match_index is None:
                slots.append(
                    SameRankSlot(
                        section_no=section + 1,
                        court_id=court_spec.id,
                        match_id=None,
                        referee_assignment=None,
                    )
                )
                continue
            match = matches[match_index]
            referee_rank = referee.rank_by_match[match_index]
            if referee_rank is None:
                fallback = section > 0
                assignment = SameRankRefereeAssignment(
                    kind=RefereeKind.ORGANIZER,
                    organizer_reason="fallback" if fallback else "first_section",
                    fallback_reasons=("team_referee_unavailable",) if fallback else (),
                )
            else:
                rank_ref = rank_refs[referee_rank]
                assignment = SameRankRefereeAssignment(
                    kind=RefereeKind.TEAM,
                    rank_ref=rank_ref,
                    team_id=team_by_rank.get(_rank_key(rank_ref)),
                )
                routes.append(
                    SameRankTeamRouteEntry(
                        rank_ref=rank_ref,
                        team_id=team_by_rank.get(_rank_key(rank_ref)),
                        role="referee",
                        match_id=match.id,
                        section_no=section + 1,
                        court_id=court_spec.id,
                    )
                )
            slots.append(
                SameRankSlot(
                    section_no=section + 1,
                    court_id=court_spec.id,
                    match_id=match.id,
                    referee_assignment=assignment,
                )
            )
            for rank in match_ranks[match_index]:
                rank_ref = rank_refs[rank]
                routes.append(
                    SameRankTeamRouteEntry(
                        rank_ref=rank_ref,
                        team_id=team_by_rank.get(_rank_key(rank_ref)),
                        role="match",
                        match_id=match.id,
                        section_no=section + 1,
                        court_id=court_spec.id,
                    )
                )
    timings = section_timings(data.day, layout.used_sections)
    referee_counts = tuple(
        SameRankRefereeCount(
            rank_ref=rank_ref,
            team_id=team_by_rank.get(_rank_key(rank_ref)),
            count=referee.counts[index],
        )
        for index, rank_ref in enumerate(rank_refs)
    )
    maximum_wait, gap_moves = _route_metrics(match_ranks, layout, referee)
    court_usage = [layout.courts.count(court) for court in range(len(data.courts))]
    metrics = SameRankScheduleMetrics(
        random_seed=data.random_seed,
        max_time_seconds=data.solver.max_time_seconds,
        ortools_version=_ORTOOLS_VERSION,
        wall_time_seconds=perf_counter() - started,
        used_sections=layout.used_sections,
        referee_counts=referee_counts,
        referee_count_min=min(referee.counts, default=0),
        referee_count_max=max(referee.counts, default=0),
        referee_count_difference=(max(referee.counts, default=0) - min(referee.counts, default=0)),
        maximum_team_wait_sections=maximum_wait,
        referee_then_match_count=referee.referee_then_match_count,
        previous_same_court_referee_count=referee.previous_same_court_referee_count,
        gap_court_change_count=gap_moves,
        court_usage_difference=max(court_usage, default=0) - min(court_usage, default=0),
        organizer_referee_count=referee.organizer_count,
        fallback_count=referee.fallback_count,
        unused_slot_count=layout.used_sections * len(data.courts) - len(matches),
        layout_attempt_count=attempts,
        optimized_objectives=(
            "used_sections",
            "referee_count_difference",
            "maximum_team_wait_sections",
            "gap_court_change_count",
            "court_usage_difference",
        ),
        objective_stages=tuple(
            ObjectiveStageMetric(
                objective=name,
                value=value,
                optimality_proven=optimality_proven,
            )
            for name, value in (
                ("used_sections", layout.used_sections),
                (
                    "referee_count_difference",
                    max(referee.counts, default=0) - min(referee.counts, default=0),
                ),
                ("maximum_team_wait_sections", maximum_wait),
                ("gap_court_change_count", gap_moves),
                (
                    "court_usage_difference",
                    max(court_usage, default=0) - min(court_usage, default=0),
                ),
            )
        ),
        optimality_proven=optimality_proven,
    )
    return SameRankDay2Schedule(
        participant_resolution=data.same_rank_plan.participant_resolution,
        status=SolverStatus.OPTIMAL if metrics.optimality_proven else SolverStatus.FEASIBLE,
        same_rank_matches=matches,
        slots=tuple(slots),
        section_timings=timings,
        expected_end_time=expected_end_time(data.day, layout.used_sections),
        team_schedules=tuple(
            sorted(
                routes,
                key=lambda item: (
                    item.section_no,
                    item.court_id,
                    item.match_id,
                    item.role,
                    item.rank_ref.block_id,
                    item.rank_ref.rank,
                ),
            )
        ),
        metrics=metrics,
    )


def _empty_metrics(data: SameRankDay2ScheduleRequest) -> SameRankScheduleMetrics:
    return SameRankScheduleMetrics(
        random_seed=data.random_seed,
        max_time_seconds=data.solver.max_time_seconds,
        ortools_version=_ORTOOLS_VERSION,
        wall_time_seconds=0.0,
        used_sections=0,
        organizer_referee_count=0,
        fallback_count=0,
        unused_slot_count=0,
        optimized_objectives=("used_sections",),
        optimality_proven=True,
    )


def _failed_schedule(
    data: SameRankDay2ScheduleRequest,
    matches: tuple[SameRankMatch, ...],
    status: SolverStatus,
    code: str,
    message: str,
    **details: int | float | str | bool | list[str],
) -> SameRankDay2Schedule:
    attempt_value = details.get("layout_attempt_count", 0)
    attempt_count = attempt_value if isinstance(attempt_value, int) else 0
    wall_value = details.pop("wall_time_seconds", 0.0)
    wall_time = float(wall_value) if isinstance(wall_value, int | float) else 0.0
    return SameRankDay2Schedule(
        participant_resolution=data.same_rank_plan.participant_resolution,
        status=status,
        same_rank_matches=matches,
        metrics=SameRankScheduleMetrics(
            random_seed=data.random_seed,
            max_time_seconds=data.solver.max_time_seconds,
            ortools_version=_ORTOOLS_VERSION,
            wall_time_seconds=wall_time,
            layout_attempt_count=attempt_count,
            optimality_proven=False,
        ),
        diagnostics=(Diagnostic(code=code, message=message, details=dict(details)),),
    )
