"""順位枠で構成した完全順位決定トーナメントを2日目へ配置する。"""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import time
from importlib.metadata import version
from itertools import combinations_with_replacement, pairwise
from time import perf_counter
from typing import Annotated, Any, Literal, Self

from ortools.sat.python import cp_model
from pydantic import Field, PrivateAttr, model_serializer, model_validator

from football_scheduler.league import LeaguePlan, LeagueTeam
from football_scheduler.models import (
    ContractModel,
    Court,
    Day2Fallback,
    DaySettings,
    Diagnostic,
    Identifier,
    ObjectiveStageMetric,
    PoolFinalMetric,
    RefereeAssignment,
    RefereeKind,
    RefereeSettings,
    ScheduleResult,
    SectionTiming,
    Slot,
    SolverMetrics,
    SolverSettings,
    SolverStatus,
    TeamRefereeCount,
)
from football_scheduler.placement_template_contract import (
    PLACEMENT_OBJECTIVES,
    CanonicalMatchPosition,
    CanonicalRefereeAssignment,
    PlacementTemplateEntry,
    PlacementTemplateKey,
    PlacementTemplateStatus,
    placement_referee_signature,
)
from football_scheduler.placement_template_runtime import (
    PlacementTemplateCatalogError,
    load_placement_template_entry,
)
from football_scheduler.timekeeping import (
    DayTimingError,
    expected_end_time,
    resolve_max_sections,
    section_timings,
)
from football_scheduler.tournament import (
    ConcreteTeamRef,
    LeagueRankRef,
    LoserOfRef,
    ParticipantResolution,
    TournamentEntry,
    TournamentPlan,
    TournamentPlanInvariantError,
    WinnerOfRef,
    validate_tournament_plan_invariants,
)

_ORTOOLS_VERSION = version("ortools")
_MAX_SECTIONS = 128
_MIN_SOLVER_SECONDS = 0.001

_RankKey = tuple[str, int]


class Day1ScheduleSource(ContractModel):
    """変更しない1日目日程の統合検証用入力。"""

    day: DaySettings
    slots: tuple[Slot, ...]


class Day2ScheduleRequest(ContractModel):
    schema_version: Literal["0.2.0"] = "0.2.0"
    request_kind: Literal["day2_schedule"]
    teams: Annotated[tuple[LeagueTeam, ...], Field(min_length=2, max_length=32)]
    courts: Annotated[tuple[Court, ...], Field(min_length=1, max_length=16)]
    league_plan: LeaguePlan
    day1_schedule: Day1ScheduleSource
    tournament_plan: TournamentPlan
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
        expected_rank_refs = {
            (block.id, rank)
            for block in self.league_plan.blocks
            for rank in range(1, len(block.team_ids) + 1)
        }
        seed_rank_refs = [
            (seed.block_id, seed.block_rank)
            for pool in self.tournament_plan.pools
            for seed in pool.seeds
        ]
        if len(seed_rank_refs) != len(set(seed_rank_refs)):
            raise ValueError("トーナメントの順位枠が重複しています")
        if set(seed_rank_refs) != expected_rank_refs:
            raise ValueError("トーナメントの順位枠とリーグ計画が一致しません")
        seed_values = [seed.team_id for pool in self.tournament_plan.pools for seed in pool.seeds]
        if self.tournament_plan.participant_resolution is ParticipantResolution.RESOLVED:
            if any(team_id is None for team_id in seed_values):
                raise ValueError("トーナメントの参加チームが確定していません")
            seed_team_ids = {team_id for team_id in seed_values if team_id is not None}
            if seed_team_ids != set(team_ids):
                raise ValueError("トーナメントの参加チームと登録チームが一致しません")
        elif any(team_id is not None for team_id in seed_values):
            raise ValueError("仮トーナメントにチームIDを混在させることはできません")
        return self


class ScheduledTournamentMatch(ContractModel):
    """配置・独立検証に使う参照付きトーナメント試合。"""

    id: Identifier
    phase: Literal["placement_tournament"] = "placement_tournament"
    pool_id: Identifier
    round: str
    round_no: Annotated[int, Field(gt=0)]
    home: TournamentEntry
    away: TournamentEntry
    rank_range: tuple[int, int]
    possible_rank_refs: tuple[LeagueRankRef, ...] = ()
    possible_team_ids: tuple[Identifier, ...] = ()
    prerequisite_match_ids: tuple[Identifier, ...]
    final: bool = False

    @model_validator(mode="after")
    def validate_participants(self) -> Self:
        rank_keys = [(ref.block_id, ref.rank) for ref in self.possible_rank_refs]
        if len(rank_keys) != len(set(rank_keys)):
            raise ValueError("試合の参加候補に重複した順位枠があります")
        if len(self.possible_team_ids) != len(set(self.possible_team_ids)):
            raise ValueError("試合の参加候補に重複したチームIDがあります")
        if (
            self.possible_rank_refs
            and self.possible_team_ids
            and (len(self.possible_rank_refs) != len(self.possible_team_ids))
        ):
            raise ValueError("試合の順位枠とチーム注記の件数が一致しません")
        return self


class TeamRouteEntry(ContractModel):
    rank_ref: LeagueRankRef | None = None
    team_id: Identifier | None = None
    role: Literal["match", "referee"]
    match_id: Identifier
    section_no: Annotated[int, Field(gt=0)]
    court_id: Identifier
    conditions: tuple[str, ...] = ()

    @model_validator(mode="after")
    def validate_participant(self) -> Self:
        if self.rank_ref is None and self.team_id is None:
            raise ValueError("チーム別経路に順位枠またはチームIDが必要です")
        return self


class Day2Schedule(ContractModel):
    schema_version: Literal["0.2.0"] = "0.2.0"
    schedule_scope: Literal["day2_tournament"] = "day2_tournament"
    participant_resolution: ParticipantResolution = ParticipantResolution.RESOLVED
    status: SolverStatus
    tournament_matches: tuple[ScheduledTournamentMatch, ...]
    slots: tuple[Slot, ...] = ()
    section_timings: tuple[SectionTiming, ...] = ()
    expected_end_time: time | None = None
    team_schedules: tuple[TeamRouteEntry, ...] = ()
    metrics: SolverMetrics
    diagnostics: tuple[Diagnostic, ...] = ()
    _legacy_resolution: bool = PrivateAttr(default=False)

    @model_validator(mode="after")
    def validate_resolution(self) -> Self:
        explicit_resolution = "participant_resolution" in self.model_fields_set
        if not explicit_resolution:
            return self
        if self.participant_resolution is ParticipantResolution.PROVISIONAL:
            if any(match.possible_team_ids for match in self.tournament_matches) or any(
                route.team_id is not None for route in self.team_schedules
            ):
                raise ValueError("仮の2日目日程にチームIDを含めることはできません")
            if any(not match.possible_rank_refs for match in self.tournament_matches) or any(
                route.rank_ref is None for route in self.team_schedules
            ):
                raise ValueError("仮の2日目日程に必要な順位枠が不足しています")
        elif self.tournament_matches and (
            any(not match.possible_rank_refs for match in self.tournament_matches)
            or any(not match.possible_team_ids for match in self.tournament_matches)
            or any(route.rank_ref is None or route.team_id is None for route in self.team_schedules)
        ):
            raise ValueError("確定済みの2日目日程に順位枠またはチーム注記が不足しています")
        if self.status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}:
            match_ids = {match.id for match in self.tournament_matches}
            if any(route.match_id not in match_ids for route in self.team_schedules):
                raise ValueError("チーム別経路に未定義の試合参照があります")
            expected_match_routes = {
                (match.id, rank_ref.block_id, rank_ref.rank)
                for match in self.tournament_matches
                for rank_ref in match.possible_rank_refs
            }
            actual_match_routes = {
                (route.match_id, route.rank_ref.block_id, route.rank_ref.rank)
                for route in self.team_schedules
                if route.role == "match" and route.rank_ref is not None
            }
            if actual_match_routes != expected_match_routes:
                raise ValueError("チーム別経路の順位枠注記が不足または矛盾しています")
        if self.participant_resolution is ParticipantResolution.RESOLVED:
            team_by_rank: dict[tuple[str, int], str] = {}
            rank_by_team: dict[str, tuple[str, int]] = {}
            for match in self.tournament_matches:
                for rank_ref, team_id in zip(
                    match.possible_rank_refs, match.possible_team_ids, strict=True
                ):
                    rank_key = (rank_ref.block_id, rank_ref.rank)
                    previous_team = team_by_rank.setdefault(rank_key, team_id)
                    previous_rank = rank_by_team.setdefault(team_id, rank_key)
                    if previous_team != team_id or previous_rank != rank_key:
                        raise ValueError("順位枠とチーム注記の対応が一意ではありません")
            for route in self.team_schedules:
                assert route.rank_ref is not None and route.team_id is not None
                rank_key = (route.rank_ref.block_id, route.rank_ref.rank)
                if team_by_rank.get(rank_key) != route.team_id:
                    raise ValueError("チーム別経路の順位枠とチーム注記が一致しません")
        return self

    def model_post_init(self, __context: Any) -> None:
        self._legacy_resolution = "participant_resolution" not in self.model_fields_set

    @model_serializer(mode="wrap")
    def serialize_with_legacy_compatibility(self, handler: Any) -> dict[str, Any]:
        data: dict[str, Any] = handler(self)
        if not self._legacy_resolution:
            return data
        data.pop("participant_resolution", None)
        for match in data.get("tournament_matches", ()):
            if isinstance(match, dict) and not match.get("possible_rank_refs"):
                match.pop("possible_rank_refs", None)
        for route in data.get("team_schedules", ()):
            if isinstance(route, dict) and route.get("rank_ref") is None:
                route.pop("rank_ref", None)
        return data


class Day2ScheduleError(ValueError):
    """利用者が修正できる2日目日程の入力エラー。"""

    def __init__(self, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.code, self.message, self.details = code, message, details


class _TemplateTopologyError(ValueError):
    """入力計画とテンプレートの対応を一意に復元できない。"""


@dataclass(frozen=True, slots=True)
class _PathModel:
    matches: tuple[ScheduledTournamentMatch, ...]
    paths_by_match: Mapping[str, Mapping[_RankKey, frozenset[frozenset[str]]]]
    dependencies: Mapping[str, frozenset[str]]
    conflict_pairs: frozenset[tuple[int, int]]
    team_by_rank: Mapping[_RankKey, str]
    final_indexes: tuple[int, ...]
    final_index_by_pool: Mapping[str, int]
    primary_final_index: int


@dataclass(frozen=True, slots=True)
class _ModelVariables:
    placement: Mapping[tuple[int, int, int], cp_model.IntVar]
    match_in_section: Mapping[tuple[int, int], cp_model.IntVar]
    match_on_court: Mapping[tuple[int, int], cp_model.IntVar]
    section_number: Mapping[int, cp_model.IntVar]
    active_sections: tuple[cp_model.IntVar, ...]
    used_sections: cp_model.IntVar
    maximum_wait: cp_model.IntVar
    non_primary_final_max_gap: cp_model.IntVar
    non_primary_final_sum_gap: cp_model.IntVar
    court_change_count: cp_model.IntVar
    court_usage_difference: cp_model.IntVar


@dataclass(frozen=True, slots=True)
class _SolvedLayout:
    solver: cp_model.CpSolver
    status: SolverStatus
    wall_time_seconds: float
    optimized_objectives: tuple[str, ...]
    primary_bound: float


def generate_day2_schedule(
    request: Day2ScheduleRequest | Mapping[str, object],
) -> Day2Schedule:
    """公開境界。検証済みテンプレートを優先し、破損時だけ既存solverへ戻す。"""

    data = (
        request
        if isinstance(request, Day2ScheduleRequest)
        else Day2ScheduleRequest.model_validate(request)
    )
    try:
        validate_tournament_plan_invariants(data.tournament_plan, data.league_plan)
    except TournamentPlanInvariantError as exc:
        raise Day2ScheduleError(
            "TOURNAMENT_SOURCE_INVALID",
            "順位決定トーナメント計画と予選ブロックの対応を確認できませんでした。2日目を再作成してください。",
            reason=exc.reason,
            **exc.details,
        ) from exc
    path_model = _build_path_model(data.tournament_plan)
    if not path_model.matches:
        return _generate_day2_schedule_with_solver(data)
    if data.referees.organizer_capacity == 0:
        return _failed_schedule(
            data,
            path_model.matches,
            SolverStatus.INFEASIBLE,
            "ORGANIZER_CAPACITY_INSUFFICIENT",
            "主催者審判の必要数が同一セクションの上限を超えます。コート数または審判設定を見直してください。",
            organizer_capacity=0,
        )

    try:
        horizon = _resolve_day2_horizon(data, path_model)
    except Day2ScheduleError:
        raise
    if len(path_model.matches) > horizon * len(data.courts):
        return _failed_schedule(
            data,
            path_model.matches,
            SolverStatus.INFEASIBLE,
            "INSUFFICIENT_SLOTS",
            "利用可能なコートとセクションだけでは、2日目の全試合を配置できません。",
            required_matches=len(path_model.matches),
            available_slots=horizon * len(data.courts),
        )

    try:
        key = _placement_template_key(data)
        entry = load_placement_template_entry(key)
        return _generate_day2_schedule_from_template(data, path_model, horizon, entry)
    except PlacementTemplateCatalogError as exc:
        return _schedule_with_template_fallback(data, exc.reason)
    except _TemplateTopologyError:
        return _schedule_with_template_fallback(data, "catalog_topology_inconsistent")


def _resolve_day2_horizon(data: Day2ScheduleRequest, path_model: _PathModel) -> int:
    try:
        horizon = resolve_max_sections(
            data.day,
            min(_MAX_SECTIONS, max(1, len(path_model.matches) * 2)),
        )
    except DayTimingError as exc:
        raise Day2ScheduleError(exc.code, exc.message, **exc.details) from exc
    if horizon > _MAX_SECTIONS:
        raise Day2ScheduleError(
            "SECTION_LIMIT_EXCEEDED",
            f"セクション数が上限の{_MAX_SECTIONS}を超えています。",
            actual=horizon,
            maximum=_MAX_SECTIONS,
        )
    return horizon


def _placement_template_key(data: Day2ScheduleRequest) -> PlacementTemplateKey:
    pools = data.tournament_plan.pools
    pool_sizes = {pool.participant_count for pool in pools}
    pool_indexes = {pool.pool_index for pool in pools}
    if len(pool_sizes) != 1 or pool_indexes != set(range(1, len(pools) + 1)):
        raise _TemplateTopologyError("順位帯の人数またはindexが正規形ではありません")
    try:
        return PlacementTemplateKey.normalized(
            pool_count=len(pools),
            pool_size=next(iter(pool_sizes)),
            court_count=len(data.courts),
            organizer_capacity=data.referees.organizer_capacity,
            day2_fallback=data.referees.day2_fallback,
        )
    except ValueError as exc:
        raise _TemplateTopologyError("テンプレートキーを正規化できません") from exc


def _generate_day2_schedule_from_template(
    data: Day2ScheduleRequest,
    path_model: _PathModel,
    horizon: int,
    entry: PlacementTemplateEntry,
) -> Day2Schedule:
    key = _placement_template_key(data)
    if entry.key != key:
        raise _TemplateTopologyError("要求キーとテンプレートentryが一致しません")
    if entry.status is PlacementTemplateStatus.PROVEN_INFEASIBLE:
        return _failed_schedule(
            data,
            path_model.matches,
            SolverStatus.INFEASIBLE,
            "TOURNAMENT_SCHEDULE_INFEASIBLE",
            "指定された時間・休憩・審判条件では、2日目の日程を作成できません。",
            required_matches=len(path_model.matches),
            available_slots=horizon * len(data.courts),
            required_final_match_id=path_model.matches[path_model.primary_final_index].id,
            required_final_rule="last_occupied_section",
            maximum_sections=horizon,
            court_count=len(data.courts),
            organizer_capacity=data.referees.organizer_capacity,
        )
    if entry.used_sections is None:
        raise _TemplateTopologyError("利用可能テンプレートに使用セクション数がありません")
    if horizon < entry.used_sections:
        return _failed_schedule(
            data,
            path_model.matches,
            SolverStatus.INFEASIBLE,
            "TOURNAMENT_SCHEDULE_INFEASIBLE",
            "指定された時間・休憩・審判条件では、2日目の日程を作成できません。",
            required_matches=len(path_model.matches),
            available_slots=horizon * len(data.courts),
            required_final_match_id=path_model.matches[path_model.primary_final_index].id,
            required_final_rule="last_occupied_section",
            minimum_sections=entry.used_sections,
            maximum_sections=horizon,
            court_count=len(data.courts),
            organizer_capacity=data.referees.organizer_capacity,
        )

    position_by_match_id = _canonical_positions(data)
    match_id_by_position = {
        position: match_id for match_id, position in position_by_match_id.items()
    }
    if len(match_id_by_position) != len(position_by_match_id):
        raise _TemplateTopologyError("トーナメント計画のcanonical位置が重複しています")
    if set(position_by_match_id) != {match.id for match in path_model.matches}:
        raise _TemplateTopologyError("canonical位置が全試合を覆っていません")
    template_positions = {slot.match_position for slot in entry.slots}
    if len(entry.slots) != len(path_model.matches) or template_positions != set(
        match_id_by_position
    ):
        raise _TemplateTopologyError("テンプレート配置が全試合を一度ずつ覆っていません")
    coordinates = {(slot.section_no, slot.court_index) for slot in entry.slots}
    if len(coordinates) != len(entry.slots):
        raise _TemplateTopologyError("テンプレート配置のslotが重複しています")

    match_by_coordinate = {
        (slot.section_no, slot.court_index): match_id_by_position[slot.match_position]
        for slot in entry.slots
    }
    slots = tuple(
        Slot(
            day_id=data.day.id,
            section_no=section_no,
            court_id=court.id,
            match_id=match_by_coordinate.get((section_no, court_index)),
            referee_assignment=None,
        )
        for section_no in range(1, entry.used_sections + 1)
        for court_index, court in enumerate(data.courts)
    )
    _validate_template_layout(path_model, slots, entry.used_sections)
    assignments, invalid_reasons = _assign_referees(data, path_model, slots)
    slots = tuple(
        slot.model_copy(update={"referee_assignment": assignments.get(slot.match_id)})
        if slot.match_id is not None
        else slot
        for slot in slots
    )
    if invalid_reasons and data.referees.day2_fallback is Day2Fallback.STRICT:
        raise _TemplateTopologyError("strictテンプレートで審判供給元が不足しています")
    organizer_by_section = Counter(
        slot.section_no
        for slot in slots
        if slot.match_id is not None
        and slot.referee_assignment is not None
        and slot.referee_assignment.kind is RefereeKind.ORGANIZER
    )
    if any(count > data.referees.organizer_capacity for count in organizer_by_section.values()):
        raise _TemplateTopologyError("テンプレートの主催者審判数が能力を超えています")
    _validate_referee_signature(entry, slots, position_by_match_id)

    routes = _team_routes(path_model, slots)
    metrics = _audit_template_metrics(data, path_model, slots, routes, entry)
    result_status = SolverStatus.OPTIMAL if metrics.optimality_proven else SolverStatus.FEASIBLE
    diagnostics = (
        ()
        if result_status is SolverStatus.OPTIMAL
        else (
            Diagnostic(
                code="OPTIMALITY_NOT_PROVEN",
                message="実行可能な2日目日程は見つかりましたが、下位の改善目標をすべて証明できませんでした。",
            ),
        )
    )
    return Day2Schedule(
        participant_resolution=data.tournament_plan.participant_resolution,
        status=result_status,
        tournament_matches=path_model.matches,
        slots=slots,
        section_timings=section_timings(data.day, entry.used_sections),
        expected_end_time=expected_end_time(data.day, entry.used_sections),
        team_schedules=routes,
        metrics=metrics,
        diagnostics=diagnostics,
    )


def _canonical_positions(data: Day2ScheduleRequest) -> dict[str, CanonicalMatchPosition]:
    positions: dict[str, CanonicalMatchPosition] = {}
    for pool in data.tournament_plan.pools:
        layout = pool.logical_layout
        if layout is None:
            raise _TemplateTopologyError("トーナメント計画にlogical_layoutがありません")
        for logical_position in layout.match_positions:
            if logical_position.match_id in positions:
                raise _TemplateTopologyError("logical_layoutに試合IDの重複があります")
            positions[logical_position.match_id] = CanonicalMatchPosition(
                pool_index=pool.pool_index,
                rank_range_start=logical_position.rank_range[0],
                rank_range_end=logical_position.rank_range[1],
                logical_order=logical_position.order,
            )
    return positions


def _validate_template_layout(
    path_model: _PathModel,
    slots: tuple[Slot, ...],
    used_sections: int,
) -> None:
    occupied = [slot for slot in slots if slot.match_id is not None]
    slot_by_match_id = {slot.match_id: slot for slot in occupied}
    if len(slot_by_match_id) != len(path_model.matches):
        raise _TemplateTopologyError("テンプレートの試合配置に不足または重複があります")
    if {slot.section_no for slot in occupied} != set(range(1, used_sections + 1)):
        raise _TemplateTopologyError("テンプレートに空の使用セクションがあります")
    if slot_by_match_id[path_model.matches[path_model.primary_final_index].id].section_no != (
        used_sections
    ):
        raise _TemplateTopologyError("最高順位帯の決勝が最終セクションにありません")
    for match_id, dependency_ids in path_model.dependencies.items():
        target_section = slot_by_match_id[match_id].section_no
        if any(
            target_section < slot_by_match_id[source_id].section_no + 2
            for source_id in dependency_ids
        ):
            raise _TemplateTopologyError("前提試合との完全休憩セクションが不足しています")
    matches = path_model.matches
    for left, right in path_model.conflict_pairs:
        left_section = slot_by_match_id[matches[left].id].section_no
        right_section = slot_by_match_id[matches[right].id].section_no
        if abs(left_section - right_section) <= 1:
            raise _TemplateTopologyError("参加経路が同一または連続セクションで衝突します")


def _validate_referee_signature(
    entry: PlacementTemplateEntry,
    slots: tuple[Slot, ...],
    position_by_match_id: Mapping[str, CanonicalMatchPosition],
) -> None:
    canonical: list[CanonicalRefereeAssignment] = []
    for slot in slots:
        if slot.match_id is None:
            continue
        assignment = slot.referee_assignment
        if assignment is None:
            raise _TemplateTopologyError("実試合に審判割当てがありません")
        canonical.append(
            CanonicalRefereeAssignment(
                match_position=position_by_match_id[slot.match_id],
                kind=assignment.kind.value,
                organizer_reason=assignment.organizer_reason,
                source_match_position=(
                    position_by_match_id[assignment.source_match_id]
                    if assignment.source_match_id is not None
                    else None
                ),
                fallback_reasons=tuple(sorted(assignment.fallback_reasons)),
            )
        )
    if placement_referee_signature(canonical) != entry.referee_signature:
        raise _TemplateTopologyError("テンプレートの審判署名が再構築結果と一致しません")


def _schedule_with_template_fallback(
    data: Day2ScheduleRequest,
    reason: str,
) -> Day2Schedule:
    schedule = _generate_day2_schedule_with_solver(data)
    if schedule.status not in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}:
        return schedule
    warning = Diagnostic(
        code="PLACEMENT_TEMPLATE_FALLBACK_USED",
        message="日程テンプレートを利用できなかったため、通常の日程計算で作成しました。",
        details={"reason": reason},
    )
    return schedule.model_copy(update={"diagnostics": (*schedule.diagnostics, warning)})


def _generate_day2_schedule_with_solver(
    request: Day2ScheduleRequest | Mapping[str, object],
) -> Day2Schedule:
    """仮または確定済みトーナメントから、1日目を変更せず日程を返す。"""

    data = (
        request
        if isinstance(request, Day2ScheduleRequest)
        else Day2ScheduleRequest.model_validate(request)
    )
    try:
        validate_tournament_plan_invariants(data.tournament_plan, data.league_plan)
    except TournamentPlanInvariantError as exc:
        raise Day2ScheduleError(
            "TOURNAMENT_SOURCE_INVALID",
            "順位決定トーナメント計画と予選ブロックの対応を確認できませんでした。2日目を再作成してください。",
            reason=exc.reason,
            **exc.details,
        ) from exc
    path_model = _build_path_model(data.tournament_plan)
    if not path_model.matches:
        metrics = _empty_metrics(data)
        return Day2Schedule(
            participant_resolution=data.tournament_plan.participant_resolution,
            status=SolverStatus.OPTIMAL,
            tournament_matches=(),
            metrics=metrics,
        )

    try:
        horizon = resolve_max_sections(
            data.day,
            min(_MAX_SECTIONS, max(1, len(path_model.matches) * 2)),
        )
    except DayTimingError as exc:
        raise Day2ScheduleError(exc.code, exc.message, **exc.details) from exc
    if horizon > _MAX_SECTIONS:
        raise Day2ScheduleError(
            "SECTION_LIMIT_EXCEEDED",
            f"セクション数が上限の{_MAX_SECTIONS}を超えています。",
            actual=horizon,
            maximum=_MAX_SECTIONS,
        )
    if len(path_model.matches) > horizon * len(data.courts):
        return _failed_schedule(
            data,
            path_model.matches,
            SolverStatus.INFEASIBLE,
            "INSUFFICIENT_SLOTS",
            "利用可能なコートとセクションだけでは、2日目の全試合を配置できません。",
            required_matches=len(path_model.matches),
            available_slots=horizon * len(data.courts),
        )

    started = perf_counter()
    model, variables = _build_cp_model(data, path_model, horizon)
    layout = _solve_lexicographically(model, variables, data, started)
    if layout.status not in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}:
        code = (
            "TOURNAMENT_SCHEDULE_INFEASIBLE"
            if layout.status is SolverStatus.INFEASIBLE
            else "TOURNAMENT_SCHEDULE_SEARCH_TIMEOUT"
        )
        message = (
            "指定された時間・休憩・審判条件では、2日目の日程を作成できません。"
            if layout.status is SolverStatus.INFEASIBLE
            else "制限時間内に2日目の日程を見つけられませんでした。条件を変えて再実行してください。"
        )
        return _failed_schedule(
            data,
            path_model.matches,
            layout.status,
            code,
            message,
            wall_time_seconds=layout.wall_time_seconds,
            required_matches=len(path_model.matches),
            available_slots=horizon * len(data.courts),
            required_final_match_id=path_model.matches[path_model.primary_final_index].id,
            required_final_rule="last_occupied_section",
            maximum_sections=horizon,
            court_count=len(data.courts),
            organizer_capacity=data.referees.organizer_capacity,
        )

    layout, slots, invalid_reasons, capacity_overruns = _find_referee_ready_layout(
        model,
        variables,
        data,
        path_model,
        layout,
        started,
    )
    if invalid_reasons and data.referees.day2_fallback is Day2Fallback.STRICT:
        return _failed_schedule(
            data,
            path_model.matches,
            SolverStatus.INFEASIBLE,
            "TOURNAMENT_REFEREE_UNAVAILABLE",
            "厳格な審判条件を満たせません。主催者への切替を許可するか、コート・時間を見直してください。",
            wall_time_seconds=layout.wall_time_seconds,
            match_ids=sorted(invalid_reasons),
        )
    if capacity_overruns:
        return _failed_schedule(
            data,
            path_model.matches,
            SolverStatus.INFEASIBLE,
            "ORGANIZER_CAPACITY_INSUFFICIENT",
            "主催者審判の必要数が同一セクションの上限を超えます。コート数または審判設定を見直してください。",
            wall_time_seconds=layout.wall_time_seconds,
            sections=[str(section) for section in sorted(capacity_overruns)],
        )

    used_sections = max((slot.section_no for slot in slots if slot.match_id is not None), default=0)
    routes = _team_routes(path_model, slots)
    metrics = _audit_metrics(
        data,
        path_model,
        slots,
        routes,
        layout,
        variables,
    )
    result_status = SolverStatus.OPTIMAL if metrics.optimality_proven else SolverStatus.FEASIBLE
    diagnostic_items: list[Diagnostic] = []
    if result_status is SolverStatus.FEASIBLE:
        diagnostic_items.append(
            Diagnostic(
                code="OPTIMALITY_NOT_PROVEN",
                message="実行可能な2日目日程は見つかりましたが、下位の改善目標をすべて証明できませんでした。",
            )
        )
    return Day2Schedule(
        participant_resolution=data.tournament_plan.participant_resolution,
        status=result_status,
        tournament_matches=path_model.matches,
        slots=slots,
        section_timings=section_timings(data.day, used_sections),
        expected_end_time=expected_end_time(data.day, used_sections),
        team_schedules=routes,
        metrics=metrics,
        diagnostics=tuple(diagnostic_items),
    )


def _finalize_fixed_horizon_candidate(
    data: Day2ScheduleRequest,
    path_model: _PathModel,
    horizon: int,
    slots: tuple[Slot, ...],
    wall_time_seconds: float,
) -> Day2Schedule | None:
    assignments, invalid_reasons = _assign_referees(data, path_model, slots)
    slots = tuple(
        slot.model_copy(update={"referee_assignment": assignments.get(slot.match_id)})
        if slot.match_id is not None
        else slot
        for slot in slots
    )
    organizer_by_section = Counter(
        slot.section_no
        for slot in slots
        if slot.match_id is not None
        and slot.referee_assignment is not None
        and slot.referee_assignment.kind is RefereeKind.ORGANIZER
    )
    capacity_overruns = {
        section: count
        for section, count in organizer_by_section.items()
        if count > data.referees.organizer_capacity
    }
    strict_invalid = bool(invalid_reasons) and (data.referees.day2_fallback is Day2Fallback.STRICT)
    if strict_invalid or capacity_overruns:
        return None

    audit_model, audit_variables = _build_cp_model(data, path_model, horizon)
    match_index_by_id = {match.id: index for index, match in enumerate(path_model.matches)}
    court_index_by_id = {court.id: index for index, court in enumerate(data.courts)}
    occupied_coordinates = {
        (
            match_index_by_id[slot.match_id],
            slot.section_no - 1,
            court_index_by_id[slot.court_id],
        )
        for slot in slots
        if slot.match_id is not None
    }
    for coordinate, variable in audit_variables.placement.items():
        audit_model.add(variable == int(coordinate in occupied_coordinates))
    audit_solver = _configured_solver(
        min(10.0, data.solver.max_time_seconds),
        data.random_seed,
    )
    audit_status = _status(audit_solver.solve(audit_model))
    total_wall_time = wall_time_seconds + audit_solver.wall_time
    if audit_status not in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}:
        return None
    layout = _SolvedLayout(
        solver=audit_solver,
        status=SolverStatus.FEASIBLE,
        wall_time_seconds=total_wall_time,
        optimized_objectives=("used_sections",),
        primary_bound=float(horizon),
    )
    routes = _team_routes(path_model, slots)
    metrics = _audit_metrics(
        data,
        path_model,
        slots,
        routes,
        layout,
        audit_variables,
    )
    return Day2Schedule(
        participant_resolution=data.tournament_plan.participant_resolution,
        status=(SolverStatus.OPTIMAL if metrics.optimality_proven else SolverStatus.FEASIBLE),
        tournament_matches=path_model.matches,
        slots=slots,
        section_timings=section_timings(data.day, horizon),
        expected_end_time=expected_end_time(data.day, horizon),
        team_schedules=routes,
        metrics=metrics,
        diagnostics=(
            ()
            if metrics.optimality_proven
            else (
                Diagnostic(
                    code="OPTIMALITY_NOT_PROVEN",
                    message="実行可能な2日目日程は見つかりましたが、下位の改善目標をすべて証明できませんでした。",
                ),
            )
        ),
    )


def _dense_template_candidate(
    data: Day2ScheduleRequest,
    path_model: _PathModel,
    horizon: int,
) -> tuple[tuple[Slot, ...], float] | None:
    """飽和する最小horizonを、空きのない順列モデルで構成する。"""

    common_contract = (
        data.referees.organizer_capacity >= 1
        and len(data.tournament_plan.pools) >= 2
        and len({pool.participant_count for pool in data.tournament_plan.pools}) == 1
        and len(path_model.matches) >= 8
    )
    if not common_contract:
        return None

    pool_count = len(data.tournament_plan.pools)
    pool_size = data.tournament_plan.pools[0].participant_count
    fixed_final_coordinates: dict[int, tuple[int, int]] = {}
    organizer_opening_coordinates: dict[int, list[tuple[int, int]]] = {}
    if data.referees.day2_fallback is Day2Fallback.STRICT:
        depth = pool_size.bit_length() - 1
        earliest_final = max(
            2 * depth - 1,
            (pool_size - 2 + data.referees.organizer_capacity - 1)
            // data.referees.organizer_capacity
            + 2,
        )
        initial_courts = 0
        useful_openings = 0
        opening_sections: tuple[int, ...] | None = None
        maximum_initial_courts = min(
            len(data.courts),
            data.referees.organizer_capacity,
        )
        for candidate_initial in range(maximum_initial_courts, 0, -1):
            maximum_openings = min(
                pool_count,
                len(data.courts) - candidate_initial,
            )
            for candidate_opening_count in range(maximum_openings, -1, -1):
                for candidate in combinations_with_replacement(
                    range(earliest_final, horizon + 1),
                    candidate_opening_count,
                ):
                    if (
                        candidate_opening_count == pool_count
                        and candidate
                        and candidate[-1] != horizon
                    ):
                        continue
                    if any(
                        candidate.count(section) > data.referees.organizer_capacity
                        for section in set(candidate)
                    ):
                        continue
                    capacity = candidate_initial * horizon + sum(
                        horizon - section + 1 for section in candidate
                    )
                    if capacity != len(path_model.matches):
                        continue
                    if not all(
                        sum(
                            (
                                int(opening <= section)
                                + sum(
                                    pool_size // (2**round_no)
                                    for round_no in range(1, depth)
                                    if opening - 2 * (depth - round_no) <= section
                                )
                            )
                            for opening in candidate
                        )
                        <= candidate_initial * section
                        + sum(max(0, section - opening + 1) for opening in candidate)
                        for section in range(1, horizon + 1)
                    ):
                        continue
                    initial_courts = candidate_initial
                    useful_openings = candidate_opening_count
                    opening_sections = candidate
                    break
                if opening_sections is not None:
                    break
            if opening_sections is not None:
                break
        if opening_sections is None:
            return None
        active_coordinates = [
            (section, court_index)
            for court_index in range(initial_courts)
            for section in range(horizon)
        ] + [
            (section, court_index)
            for court_index, opening_section in enumerate(
                opening_sections,
                initial_courts,
            )
            for section in range(opening_section - 1, horizon)
        ]
        non_primary_finals = list(path_model.final_indexes[1:])
        opening_finals: list[int]
        if useful_openings == pool_count:
            if not opening_sections or opening_sections[-1] != horizon:
                return None
            opening_finals = [
                *non_primary_finals[: useful_openings - 1],
                path_model.primary_final_index,
            ]
        elif not opening_sections:
            opening_finals = []
        elif len(opening_sections) <= len(non_primary_finals):
            opening_finals = non_primary_finals[: len(opening_sections)]
        else:
            return None
        fixed_final_coordinates.update(
            {
                final_index: (opening_section - 1, court_index)
                for final_index, (court_index, opening_section) in zip(
                    opening_finals,
                    enumerate(opening_sections, initial_courts),
                    strict=True,
                )
            }
        )
    elif data.referees.day2_fallback is Day2Fallback.ORGANIZER:
        active_court_count = min(
            len(data.courts),
            horizon * data.referees.organizer_capacity,
        )
        active_coordinates = [
            (section, court_index)
            for court_index in range(active_court_count)
            for section in range(
                court_index // data.referees.organizer_capacity,
                horizon,
            )
        ]
        surplus = len(active_coordinates) - len(path_model.matches)
        if not 0 <= surplus < active_court_count:
            return None
        removed: set[tuple[int, int]] = set()
        remaining_surplus = surplus
        removal_batch = max(1, active_court_count // 4)
        for section in range(horizon - 2, 0, -2):
            candidates = [
                (section, court_index)
                for court_index in reversed(range(active_court_count))
                if (section, court_index) in active_coordinates
                and section > court_index // data.referees.organizer_capacity
            ]
            selected = candidates[: min(removal_batch, remaining_surplus)]
            removed.update(selected)
            remaining_surplus -= len(selected)
            if remaining_surplus == 0:
                break
        if remaining_surplus:
            candidates = [
                coordinate
                for coordinate in reversed(active_coordinates)
                if coordinate not in removed
                and coordinate[0] > coordinate[1] // data.referees.organizer_capacity
            ]
            removed.update(candidates[:remaining_surplus])
        if len(removed) != surplus:
            return None
        active_coordinates = [
            coordinate for coordinate in active_coordinates if coordinate not in removed
        ]
        for court_index in range(active_court_count):
            court_coordinates = [
                coordinate for coordinate in active_coordinates if coordinate[1] == court_index
            ]
            if court_coordinates:
                first = min(court_coordinates)
                organizer_opening_coordinates.setdefault(first[0], []).append(first)
    else:
        return None
    active_coordinates.sort()
    model = cp_model.CpModel()
    match_count = len(path_model.matches)
    match_at_slot = [
        model.new_int_var(0, match_count - 1, f"dense_slot_{slot}") for slot in range(match_count)
    ]
    slot_by_match = [
        model.new_int_var(0, match_count - 1, f"dense_match_{match}")
        for match in range(match_count)
    ]
    model.add_inverse(match_at_slot, slot_by_match)
    slot_sections = [section + 1 for section, _court in active_coordinates]
    section_by_match = [
        model.new_int_var(1, horizon, f"dense_section_{match}") for match in range(match_count)
    ]
    for match_index in range(match_count):
        model.add_element(
            slot_by_match[match_index],
            slot_sections,
            section_by_match[match_index],
        )

    index_by_id = {match.id: index for index, match in enumerate(path_model.matches)}
    dependency_depth_by_id: dict[str, int] = {}

    def dependency_depth(match_id: str) -> int:
        cached = dependency_depth_by_id.get(match_id)
        if cached is not None:
            return cached
        dependencies = path_model.dependencies.get(match_id, ())
        value = (
            0
            if not dependencies
            else 1 + max(dependency_depth(dependency_id) for dependency_id in dependencies)
        )
        dependency_depth_by_id[match_id] = value
        return value

    dependents: dict[str, list[str]] = defaultdict(list)
    for match_id, dependency_ids in path_model.dependencies.items():
        for dependency_id in dependency_ids:
            dependents[dependency_id].append(match_id)
    descendant_depth_by_id: dict[str, int] = {}

    def descendant_depth(match_id: str) -> int:
        cached = descendant_depth_by_id.get(match_id)
        if cached is not None:
            return cached
        children = dependents.get(match_id, ())
        value = 0 if not children else 1 + max(descendant_depth(child) for child in children)
        descendant_depth_by_id[match_id] = value
        return value

    for match in path_model.matches:
        match_index = index_by_id[match.id]
        model.add(section_by_match[match_index] >= 1 + 2 * dependency_depth(match.id))
        model.add(section_by_match[match_index] <= horizon - 2 * descendant_depth(match.id))
    for match_id, dependency_ids in sorted(path_model.dependencies.items()):
        target = index_by_id[match_id]
        for dependency_id in sorted(dependency_ids):
            model.add(section_by_match[target] >= section_by_match[index_by_id[dependency_id]] + 2)
    for left, right in sorted(path_model.conflict_pairs):
        distance = model.new_int_var(0, horizon - 1, f"dense_gap_{left}_{right}")
        model.add_abs_equality(
            distance,
            section_by_match[left] - section_by_match[right],
        )
        model.add(distance >= 2)

    for final_index, coordinate in fixed_final_coordinates.items():
        model.add(slot_by_match[final_index] == active_coordinates.index(coordinate))
    model.add(section_by_match[path_model.primary_final_index] == horizon)
    final_in_section: dict[tuple[int, int], cp_model.IntVar] = {}
    for section in range(1, horizon + 1):
        for final_index in path_model.final_indexes:
            present = model.new_bool_var(f"dense_final_{final_index}_s{section}")
            final_in_section[final_index, section] = present
            model.add(section_by_match[final_index] == section).only_enforce_if(present)
            model.add(section_by_match[final_index] != section).only_enforce_if(present.negated())
        model.add(
            sum(final_in_section[final_index, section] for final_index in path_model.final_indexes)
            <= data.referees.organizer_capacity
        )
    for section, coordinates in organizer_opening_coordinates.items():
        opening_slot_indexes = [active_coordinates.index(coordinate) for coordinate in coordinates]
        final_uses_opening: dict[int, cp_model.IntVar] = {}
        for final_index in path_model.final_indexes:
            opening_matches: list[cp_model.IntVar] = []
            for slot_index in opening_slot_indexes:
                occupies_opening = model.new_bool_var(
                    f"dense_final_{final_index}_opening_{slot_index}"
                )
                model.add(slot_by_match[final_index] == slot_index).only_enforce_if(
                    occupies_opening
                )
                model.add(slot_by_match[final_index] != slot_index).only_enforce_if(
                    occupies_opening.negated()
                )
                opening_matches.append(occupies_opening)
            uses_opening = model.new_bool_var(f"dense_final_{final_index}_opens_s{section + 1}")
            model.add(uses_opening == sum(opening_matches))
            final_uses_opening[final_index] = uses_opening

        extra_finals: list[cp_model.IntVar] = []
        for final_index in path_model.final_indexes:
            extra = model.new_bool_var(f"dense_final_{final_index}_extra_organizer_s{section + 1}")
            present = final_in_section[final_index, section + 1]
            uses_opening = final_uses_opening[final_index]
            model.add(extra <= present)
            model.add(extra + uses_opening <= 1)
            model.add(extra >= present - uses_opening)
            extra_finals.append(extra)
        model.add(len(coordinates) + sum(extra_finals) <= data.referees.organizer_capacity)

    model.add_decision_strategy(
        section_by_match,
        cp_model.CHOOSE_MIN_DOMAIN_SIZE,
        cp_model.SELECT_MIN_VALUE,
    )
    model.add_decision_strategy(
        slot_by_match,
        cp_model.CHOOSE_FIRST,
        cp_model.SELECT_MIN_VALUE,
    )

    solver = _configured_solver(
        min(60.0, data.solver.max_time_seconds),
        data.random_seed,
    )
    if match_count >= 64 and data.referees.day2_fallback is Day2Fallback.STRICT:
        solver.parameters.cp_model_presolve = False
    solver.parameters.search_branching = cp_model.PARTIAL_FIXED_SEARCH
    status = _status(solver.solve(model))
    if status not in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}:
        return None

    match_by_coordinate = {
        coordinate: solver.value(match_at_slot[slot_index])
        for slot_index, coordinate in enumerate(active_coordinates)
    }
    slots = tuple(
        Slot(
            day_id=data.day.id,
            section_no=section + 1,
            court_id=court.id,
            match_id=(
                path_model.matches[match_by_coordinate[section, court_index]].id
                if (section, court_index) in match_by_coordinate
                else None
            ),
            referee_assignment=None,
        )
        for section in range(horizon)
        for court_index, court in enumerate(data.courts)
    )
    return slots, solver.wall_time


def _organizer_section_candidate(
    data: Day2ScheduleRequest,
    path_model: _PathModel,
    horizon: int,
) -> tuple[tuple[Slot, ...], float] | None:
    """sectionを先に解き、organizer用のコート順を決定的に復元する。"""

    if data.referees.day2_fallback is not Day2Fallback.ORGANIZER:
        return None
    model = cp_model.CpModel()
    match_count = len(path_model.matches)
    section_by_match = [
        model.new_int_var(1, horizon, f"organizer_section_{index}") for index in range(match_count)
    ]
    in_section: dict[tuple[int, int], cp_model.IntVar] = {}
    for match_index, section_var in enumerate(section_by_match):
        for section in range(1, horizon + 1):
            present = model.new_bool_var(f"organizer_m{match_index}_s{section}")
            in_section[match_index, section] = present
            model.add(section_var == section).only_enforce_if(present)
            model.add(section_var != section).only_enforce_if(present.negated())

    index_by_id = {match.id: index for index, match in enumerate(path_model.matches)}
    for match_id, dependency_ids in sorted(path_model.dependencies.items()):
        target = index_by_id[match_id]
        for dependency_id in sorted(dependency_ids):
            model.add(section_by_match[target] >= section_by_match[index_by_id[dependency_id]] + 2)
    for left, right in sorted(path_model.conflict_pairs):
        distance = model.new_int_var(0, horizon - 1, f"organizer_gap_{left}_{right}")
        model.add_abs_equality(
            distance,
            section_by_match[left] - section_by_match[right],
        )
        model.add(distance >= 2)

    for earlier, later in pairwise(path_model.final_indexes[1:]):
        model.add(section_by_match[earlier] <= section_by_match[later])
    model.add(section_by_match[path_model.primary_final_index] == horizon)
    section_counts: list[cp_model.IntVar] = []
    for section in range(1, horizon + 1):
        count = model.new_int_var(1, len(data.courts), f"organizer_count_s{section}")
        model.add(
            count == sum(in_section[match_index, section] for match_index in range(match_count))
        )
        section_counts.append(count)
        model.add(
            sum(in_section[final_index, section] for final_index in path_model.final_indexes)
            <= data.referees.organizer_capacity
        )
        if section == 1:
            model.add(count <= data.referees.organizer_capacity)
        else:
            model.add(count - section_counts[section - 2] <= data.referees.organizer_capacity)

    model.add_decision_strategy(
        section_by_match,
        cp_model.CHOOSE_MIN_DOMAIN_SIZE,
        cp_model.SELECT_MIN_VALUE,
    )
    solver = _configured_solver(
        min(30.0, data.solver.max_time_seconds),
        data.random_seed,
    )
    status = _status(solver.solve(model))
    if status not in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}:
        return None

    matches_by_section: dict[int, list[int]] = defaultdict(list)
    for match_index, section_var in enumerate(section_by_match):
        matches_by_section[solver.value(section_var)].append(match_index)
    match_by_coordinate: dict[tuple[int, int], int] = {}
    previous_courts: tuple[int, ...] = ()
    all_courts = tuple(range(len(data.courts)))
    final_indexes = frozenset(path_model.final_indexes)
    for section in range(1, horizon + 1):
        section_matches = sorted(matches_by_section[section])
        finals = [index for index in section_matches if index in final_indexes]
        non_finals = [index for index in section_matches if index not in final_indexes]
        new_courts = [index for index in all_courts if index not in previous_courts]
        growth = max(0, len(section_matches) - len(previous_courts))
        opening_finals = finals[: min(len(finals), growth)]
        remaining_finals = finals[len(opening_finals) :]
        assignments: dict[int, int] = {}
        for court_index, match_index in zip(new_courts, opening_finals, strict=False):
            assignments[court_index] = match_index
        available_previous = [
            court_index for court_index in previous_courts if court_index not in assignments
        ]
        team_referee_count = min(len(non_finals), len(available_previous))
        for court_index, match_index in zip(
            available_previous[:team_referee_count],
            non_finals[:team_referee_count],
            strict=True,
        ):
            assignments[court_index] = match_index
        remaining_matches = [*non_finals[team_referee_count:], *remaining_finals]
        available_courts = [index for index in all_courts if index not in assignments]
        if len(remaining_matches) > len(available_courts):
            return None
        for court_index, match_index in zip(
            available_courts[: len(remaining_matches)],
            remaining_matches,
            strict=True,
        ):
            assignments[court_index] = match_index
        match_by_coordinate.update(
            ((section - 1, court_index), match_index)
            for court_index, match_index in assignments.items()
        )
        previous_courts = tuple(sorted(assignments))

    slots = tuple(
        Slot(
            day_id=data.day.id,
            section_no=section + 1,
            court_id=court.id,
            match_id=(
                path_model.matches[match_by_coordinate[section, court_index]].id
                if (section, court_index) in match_by_coordinate
                else None
            ),
            referee_assignment=None,
        )
        for section in range(horizon)
        for court_index, court in enumerate(data.courts)
    )
    return slots, solver.wall_time


_P2_S16_ORGANIZER_O1_H12_WITNESS: tuple[tuple[int, int, int, int, int, int], ...] = (
    (1, 0, 2, 17, 32, 1),
    (2, 0, 2, 17, 32, 3),
    (2, 1, 2, 17, 32, 5),
    (3, 0, 2, 17, 32, 2),
    (3, 1, 2, 17, 32, 4),
    (3, 2, 2, 17, 32, 7),
    (4, 0, 1, 1, 16, 1),
    (4, 1, 2, 17, 32, 6),
    (4, 2, 2, 17, 32, 8),
    (4, 3, 2, 17, 24, 1),
    (5, 0, 1, 1, 16, 2),
    (5, 1, 1, 1, 16, 3),
    (5, 2, 1, 1, 16, 5),
    (5, 3, 1, 1, 16, 7),
    (5, 4, 2, 17, 24, 3),
    (6, 0, 1, 1, 16, 4),
    (6, 1, 1, 1, 16, 6),
    (6, 2, 1, 1, 16, 8),
    (6, 3, 2, 17, 24, 2),
    (6, 4, 2, 17, 24, 4),
    (6, 5, 2, 25, 32, 1),
    (7, 0, 1, 1, 8, 1),
    (7, 1, 1, 1, 8, 3),
    (7, 2, 1, 9, 16, 1),
    (7, 3, 2, 17, 20, 1),
    (7, 4, 2, 25, 32, 2),
    (7, 5, 2, 25, 32, 3),
    (7, 6, 2, 25, 32, 4),
    (8, 0, 1, 1, 8, 2),
    (8, 1, 1, 1, 8, 4),
    (8, 2, 1, 9, 16, 2),
    (8, 3, 1, 9, 16, 3),
    (8, 4, 1, 9, 16, 4),
    (8, 5, 2, 17, 20, 2),
    (8, 6, 2, 21, 24, 2),
    (8, 7, 2, 21, 24, 1),
    (9, 0, 1, 1, 4, 1),
    (9, 1, 1, 5, 8, 1),
    (9, 2, 2, 25, 28, 1),
    (9, 3, 2, 25, 28, 2),
    (9, 4, 2, 29, 32, 1),
    (9, 5, 2, 29, 32, 2),
    (10, 0, 1, 1, 4, 2),
    (10, 1, 1, 5, 8, 2),
    (10, 2, 1, 9, 12, 1),
    (10, 3, 1, 9, 12, 2),
    (10, 4, 1, 13, 16, 1),
    (10, 5, 1, 13, 16, 2),
    (10, 6, 2, 17, 18, 1),
    (10, 7, 2, 19, 20, 1),
    (11, 0, 2, 21, 22, 1),
    (11, 1, 2, 23, 24, 1),
    (11, 2, 2, 25, 26, 1),
    (11, 3, 2, 27, 28, 1),
    (11, 4, 2, 29, 30, 1),
    (11, 5, 2, 31, 32, 1),
    (12, 0, 1, 3, 4, 1),
    (12, 1, 1, 5, 6, 1),
    (12, 2, 1, 7, 8, 1),
    (12, 3, 1, 9, 10, 1),
    (12, 4, 1, 11, 12, 1),
    (12, 5, 1, 13, 14, 1),
    (12, 6, 1, 1, 2, 1),
    (12, 7, 1, 15, 16, 1),
)

_P4_S8_C12_O7_H6_WITNESS: tuple[tuple[int, int, int, int, int, int], ...] = (
    (1, 0, 2, 9, 16, 1),
    (1, 1, 2, 9, 16, 2),
    (1, 2, 2, 9, 16, 3),
    (1, 3, 2, 9, 16, 4),
    (1, 4, 3, 17, 24, 1),
    (1, 5, 3, 17, 24, 3),
    (2, 0, 1, 1, 8, 1),
    (2, 1, 1, 1, 8, 2),
    (2, 2, 1, 1, 8, 3),
    (2, 3, 1, 1, 8, 4),
    (2, 6, 3, 17, 24, 2),
    (2, 7, 3, 17, 24, 4),
    (2, 8, 4, 25, 32, 1),
    (2, 9, 4, 25, 32, 2),
    (2, 10, 4, 25, 32, 3),
    (2, 11, 4, 25, 32, 4),
    (3, 0, 2, 9, 12, 1),
    (3, 1, 2, 9, 12, 2),
    (3, 2, 2, 13, 16, 1),
    (3, 3, 2, 13, 16, 2),
    (3, 8, 3, 17, 20, 1),
    (3, 9, 3, 21, 24, 1),
    (4, 2, 1, 1, 4, 1),
    (4, 3, 1, 1, 4, 2),
    (4, 4, 3, 17, 20, 2),
    (4, 5, 3, 21, 24, 2),
    (4, 6, 4, 25, 28, 1),
    (4, 7, 4, 25, 28, 2),
    (4, 8, 1, 5, 8, 1),
    (4, 9, 1, 5, 8, 2),
    (4, 10, 4, 29, 32, 1),
    (4, 11, 4, 29, 32, 2),
    (5, 2, 2, 9, 10, 1),
    (5, 3, 2, 11, 12, 1),
    (5, 4, 2, 13, 14, 1),
    (5, 5, 2, 15, 16, 1),
    (6, 0, 1, 3, 4, 1),
    (6, 1, 1, 5, 6, 1),
    (6, 2, 1, 1, 2, 1),
    (6, 3, 1, 7, 8, 1),
    (6, 4, 3, 19, 20, 1),
    (6, 5, 3, 21, 22, 1),
    (6, 6, 3, 17, 18, 1),
    (6, 7, 4, 25, 26, 1),
    (6, 8, 3, 23, 24, 1),
    (6, 9, 4, 27, 28, 1),
    (6, 10, 4, 29, 30, 1),
    (6, 11, 4, 31, 32, 1),
)

_P4_S8_C14_O6_H6_WITNESS: tuple[tuple[int, int, int, int, int, int], ...] = (
    (1, 0, 2, 9, 16, 1),
    (1, 1, 2, 9, 16, 2),
    (1, 2, 2, 9, 16, 3),
    (1, 3, 2, 9, 16, 4),
    (1, 4, 3, 17, 24, 1),
    (1, 5, 3, 17, 24, 3),
    (2, 2, 1, 1, 8, 1),
    (2, 3, 1, 1, 8, 2),
    (2, 4, 1, 1, 8, 3),
    (2, 5, 1, 1, 8, 4),
    (2, 6, 3, 17, 24, 2),
    (2, 7, 3, 17, 24, 4),
    (2, 8, 4, 25, 32, 1),
    (2, 9, 4, 25, 32, 2),
    (2, 10, 4, 25, 32, 3),
    (2, 11, 4, 25, 32, 4),
    (3, 2, 2, 9, 12, 1),
    (3, 3, 2, 9, 12, 2),
    (3, 4, 2, 13, 16, 1),
    (3, 5, 2, 13, 16, 2),
    (3, 12, 3, 17, 20, 1),
    (3, 13, 3, 21, 24, 1),
    (4, 0, 1, 1, 4, 1),
    (4, 1, 1, 1, 4, 2),
    (4, 6, 3, 17, 20, 2),
    (4, 7, 3, 21, 24, 2),
    (4, 8, 4, 25, 28, 1),
    (4, 9, 4, 25, 28, 2),
    (4, 10, 4, 29, 32, 1),
    (4, 11, 4, 29, 32, 2),
    (4, 12, 1, 5, 8, 1),
    (4, 13, 1, 5, 8, 2),
    (5, 6, 2, 9, 10, 1),
    (5, 7, 2, 11, 12, 1),
    (5, 8, 2, 13, 14, 1),
    (5, 9, 2, 15, 16, 1),
    (6, 0, 1, 1, 2, 1),
    (6, 1, 3, 17, 18, 1),
    (6, 2, 1, 3, 4, 1),
    (6, 3, 1, 5, 6, 1),
    (6, 4, 1, 7, 8, 1),
    (6, 5, 3, 19, 20, 1),
    (6, 6, 4, 25, 26, 1),
    (6, 7, 3, 21, 22, 1),
    (6, 8, 4, 27, 28, 1),
    (6, 9, 3, 23, 24, 1),
    (6, 10, 4, 29, 30, 1),
    (6, 11, 4, 31, 32, 1),
)


def _placement_template_witness_candidate(
    data: Day2ScheduleRequest,
    path_model: _PathModel,
    horizon: int,
) -> tuple[Slot, ...] | None:
    """探索困難な最小構成をcanonical位置から安全に復元する。"""

    witness: tuple[tuple[int, int, int, int, int, int], ...] | None = None
    if (
        horizon == 12
        and data.referees.day2_fallback is Day2Fallback.ORGANIZER
        and data.referees.organizer_capacity == 1
        and len(data.courts) >= 8
        and len(data.tournament_plan.pools) == 2
        and all(pool.participant_count == 16 for pool in data.tournament_plan.pools)
    ):
        witness = _P2_S16_ORGANIZER_O1_H12_WITNESS
    elif (
        horizon == 6
        and data.referees.day2_fallback is Day2Fallback.ORGANIZER
        and len(data.tournament_plan.pools) == 4
        and all(pool.participant_count == 8 for pool in data.tournament_plan.pools)
        and data.referees.organizer_capacity >= 7
        and len(data.courts) >= 12
    ):
        witness = _P4_S8_C12_O7_H6_WITNESS
    elif (
        horizon == 6
        and data.referees.day2_fallback is Day2Fallback.ORGANIZER
        and len(data.tournament_plan.pools) == 4
        and all(pool.participant_count == 8 for pool in data.tournament_plan.pools)
        and data.referees.organizer_capacity == 6
        and len(data.courts) >= 14
    ):
        witness = _P4_S8_C14_O6_H6_WITNESS
    if witness is None:
        return None
    match_id_by_position: dict[tuple[int, int, int, int], str] = {}
    for pool in data.tournament_plan.pools:
        if pool.logical_layout is None:
            return None
        for position in pool.logical_layout.match_positions:
            match_id_by_position[
                (
                    pool.pool_index,
                    position.rank_range[0],
                    position.rank_range[1],
                    position.order,
                )
            ] = position.match_id
    if len(match_id_by_position) != len(path_model.matches):
        return None
    match_by_coordinate = {
        (section, court_index): match_id_by_position[
            (pool_index, rank_start, rank_end, logical_order)
        ]
        for section, court_index, pool_index, rank_start, rank_end, logical_order in (witness)
    }
    return tuple(
        Slot(
            day_id=data.day.id,
            section_no=section,
            court_id=court.id,
            match_id=match_by_coordinate.get((section, court_index)),
            referee_assignment=None,
        )
        for section in range(1, horizon + 1)
        for court_index, court in enumerate(data.courts)
    )


def _generate_day2_schedule_at_fixed_horizon(
    data: Day2ScheduleRequest,
    horizon: int,
) -> Day2Schedule:
    """オフラインtemplate生成用に固定horizonの実行可能性を厳密探索する。

    通常APIの最適化経路とは分離し、審判条件を満たさない完全配置を安定順の
    no-goodで除外する。全候補を尽くした場合だけINFEASIBLEを返す。
    """

    path_model = _build_path_model(data.tournament_plan)
    witness_slots = _placement_template_witness_candidate(data, path_model, horizon)
    if witness_slots is not None:
        finalized = _finalize_fixed_horizon_candidate(
            data,
            path_model,
            horizon,
            witness_slots,
            0.0,
        )
        if finalized is not None:
            return finalized
    organizer_candidate = _organizer_section_candidate(data, path_model, horizon)
    if organizer_candidate is not None:
        organizer_slots, organizer_wall_time = organizer_candidate
        finalized = _finalize_fixed_horizon_candidate(
            data,
            path_model,
            horizon,
            organizer_slots,
            organizer_wall_time,
        )
        if finalized is not None:
            return finalized
    dense_candidate = _dense_template_candidate(data, path_model, horizon)
    if dense_candidate is not None:
        dense_slots, dense_wall_time = dense_candidate
        finalized = _finalize_fixed_horizon_candidate(
            data,
            path_model,
            horizon,
            dense_slots,
            dense_wall_time,
        )
        if finalized is not None:
            return finalized

    started = perf_counter()
    model, variables = _build_cp_model(
        data,
        path_model,
        horizon,
        exact_referee_constraints=True,
        feasibility_only=True,
    )
    model.add(variables.used_sections == horizon)
    total_wall_time = 0.0
    while True:
        remaining = data.solver.max_time_seconds - (perf_counter() - started)
        if remaining <= _MIN_SOLVER_SECONDS:
            return _failed_schedule(
                data,
                path_model.matches,
                SolverStatus.UNKNOWN,
                "TOURNAMENT_SCHEDULE_SEARCH_TIMEOUT",
                "制限時間内に2日目の日程を見つけられませんでした。条件を変えて再実行してください。",
                wall_time_seconds=total_wall_time,
                maximum_sections=horizon,
            )
        solver = _configured_solver(remaining, data.random_seed)
        status = _status(solver.solve(model))
        total_wall_time += solver.wall_time
        if status not in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}:
            code = (
                "TOURNAMENT_SCHEDULE_INFEASIBLE"
                if status is SolverStatus.INFEASIBLE
                else "TOURNAMENT_SCHEDULE_SEARCH_TIMEOUT"
            )
            message = (
                "指定された時間・休憩・審判条件では、2日目の日程を作成できません。"
                if status is SolverStatus.INFEASIBLE
                else (
                    "制限時間内に2日目の日程を見つけられませんでした。"
                    "条件を変えて再実行してください。"
                )
            )
            return _failed_schedule(
                data,
                path_model.matches,
                status,
                code,
                message,
                wall_time_seconds=total_wall_time,
                maximum_sections=horizon,
            )

        slots = _extract_slots(data, path_model, variables, solver)
        candidate = _finalize_fixed_horizon_candidate(
            data,
            path_model,
            horizon,
            slots,
            total_wall_time,
        )
        if candidate is not None:
            return candidate

        selected_variables = [
            variable
            for coordinate, variable in sorted(variables.placement.items())
            if solver.boolean_value(variable)
        ]
        model.add(sum(selected_variables) <= len(path_model.matches) - 1)


def _find_referee_ready_layout(
    model: cp_model.CpModel,
    variables: _ModelVariables,
    data: Day2ScheduleRequest,
    path_model: _PathModel,
    initial_layout: _SolvedLayout,
    started: float,
) -> tuple[
    _SolvedLayout,
    tuple[Slot, ...],
    dict[str, tuple[str, ...]],
    dict[int, int],
]:
    """上位目的を維持し、審判条件を満たす別配置を制限時間内で探す。"""

    layout = initial_layout
    total_wall_time = layout.wall_time_seconds
    current_used_sections = layout.solver.value(variables.used_sections)
    model.add(variables.used_sections <= current_used_sections)
    best_valid: (
        tuple[
            _SolvedLayout,
            tuple[Slot, ...],
            dict[str, tuple[str, ...]],
            dict[int, int],
        ]
        | None
    ) = None
    while True:
        slots = _extract_slots(data, path_model, variables, layout.solver)
        assignments, invalid_reasons = _assign_referees(data, path_model, slots)
        slots = tuple(
            slot.model_copy(update={"referee_assignment": assignments.get(slot.match_id)})
            if slot.match_id is not None
            else slot
            for slot in slots
        )
        organizer_by_section = Counter(
            slot.section_no
            for slot in slots
            if slot.match_id is not None
            and slot.referee_assignment is not None
            and slot.referee_assignment.kind is RefereeKind.ORGANIZER
        )
        capacity_overruns = {
            section: count
            for section, count in organizer_by_section.items()
            if count > data.referees.organizer_capacity
        }
        strict_invalid = bool(invalid_reasons) and (
            data.referees.day2_fallback is Day2Fallback.STRICT
        )
        if not strict_invalid and not capacity_overruns:
            best_valid = (layout, slots, invalid_reasons, capacity_overruns)
            break

        remaining = data.solver.max_time_seconds - (perf_counter() - started)
        if remaining <= _MIN_SOLVER_SECONDS:
            break

        selected_variables = [
            variable
            for variable in variables.placement.values()
            if layout.solver.boolean_value(variable)
        ]
        model.add(sum(selected_variables) <= len(path_model.matches) - 1)
        retry_solver = _configured_solver(remaining, data.random_seed)
        retry_status = _status(retry_solver.solve(model))
        total_wall_time += retry_solver.wall_time
        if retry_status not in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}:
            break
        layout = _SolvedLayout(
            solver=retry_solver,
            status=layout.status,
            wall_time_seconds=total_wall_time,
            optimized_objectives=layout.optimized_objectives,
            primary_bound=layout.primary_bound,
        )

    selected_result = best_valid or (layout, slots, invalid_reasons, capacity_overruns)
    selected_layout, selected_slots, selected_invalid, selected_capacity = selected_result
    return (
        _SolvedLayout(
            solver=selected_layout.solver,
            status=selected_layout.status,
            wall_time_seconds=total_wall_time,
            optimized_objectives=selected_layout.optimized_objectives,
            primary_bound=selected_layout.primary_bound,
        ),
        selected_slots,
        selected_invalid,
        selected_capacity,
    )


def _build_path_model(plan: TournamentPlan) -> _PathModel:
    raw_matches = tuple(match for pool in plan.pools for match in pool.matches)
    by_id = {match.id: match for match in raw_matches}
    if len(by_id) != len(raw_matches):
        raise Day2ScheduleError(
            "TOURNAMENT_MATCH_DUPLICATED",
            "2日目トーナメントに重複した試合IDがあります。トーナメント表を再作成してください。",
        )
    rank_teams: dict[_RankKey, str] = {}
    team_ranks: dict[str, _RankKey] = {}
    known_ranks: set[_RankKey] = set()
    for pool in plan.pools:
        for seed in pool.seeds:
            key = (seed.block_id, seed.block_rank)
            if key in known_ranks:
                raise Day2ScheduleError(
                    "TOURNAMENT_SOURCE_INVALID",
                    "トーナメントの順位枠が重複しています。トーナメント表を再作成してください。",
                )
            known_ranks.add(key)
            if seed.team_id is not None:
                if seed.team_id in team_ranks:
                    raise Day2ScheduleError(
                        "TOURNAMENT_SOURCE_INVALID",
                        "トーナメントのチーム注記が重複しています。順位を再確定してください。",
                    )
                rank_teams[key] = seed.team_id
                team_ranks[seed.team_id] = key

    paths_by_match: dict[str, Mapping[_RankKey, frozenset[frozenset[str]]]] = {}
    visiting: set[str] = set()

    def entry_paths(entry: TournamentEntry) -> dict[_RankKey, frozenset[frozenset[str]]]:
        if isinstance(entry, ConcreteTeamRef):
            rank_key = team_ranks.get(entry.team_id)
            if rank_key is None:
                raise _invalid_reference("unknown_team", team_id=entry.team_id)
            return {rank_key: frozenset({frozenset()})}
        if isinstance(entry, LeagueRankRef):
            rank_key = (entry.block_id, entry.rank)
            if rank_key not in known_ranks:
                raise _invalid_reference(
                    "unknown_league_rank", block_id=entry.block_id, rank=entry.rank
                )
            return {rank_key: frozenset({frozenset()})}
        if isinstance(entry, (WinnerOfRef, LoserOfRef)):
            source = match_paths(entry.match_id)
            outcome = "W" if isinstance(entry, WinnerOfRef) else "L"
            return {
                rank_key: frozenset(
                    condition | {f"{outcome}:{entry.match_id}"} for condition in conditions
                )
                for rank_key, conditions in source.items()
            }
        raise _invalid_reference("unsupported_reference")

    def match_paths(match_id: str) -> Mapping[_RankKey, frozenset[frozenset[str]]]:
        cached = paths_by_match.get(match_id)
        if cached is not None:
            return cached
        if match_id in visiting:
            raise _invalid_reference("dependency_cycle", match_id=match_id)
        match = by_id.get(match_id)
        if match is None:
            raise _invalid_reference("unknown_match", match_id=match_id)
        visiting.add(match_id)
        home = entry_paths(match.home)
        away = entry_paths(match.away)
        for rank_key in set(home) & set(away):
            if any(
                _conditions_compatible(left, right)
                for left in home[rank_key]
                for right in away[rank_key]
            ):
                raise _invalid_reference(
                    "rank_can_fill_both_sides",
                    match_id=match_id,
                    block_id=rank_key[0],
                    rank=rank_key[1],
                )
        merged: dict[_RankKey, frozenset[frozenset[str]]] = {}
        for rank_key in sorted(set(home) | set(away)):
            merged[rank_key] = frozenset((*home.get(rank_key, ()), *away.get(rank_key, ())))
        visiting.remove(match_id)
        paths_by_match[match_id] = merged
        return merged

    for match in raw_matches:
        match_paths(match.id)

    dependencies: dict[str, frozenset[str]] = {}
    for match in raw_matches:
        dependency_ids = filter(
            None,
            (_entry_dependency(match.home), _entry_dependency(match.away)),
        )
        dependencies[match.id] = frozenset(dependency_ids)
    scheduled_matches = tuple(
        ScheduledTournamentMatch(
            id=match.id,
            phase=match.phase,
            pool_id=match.pool_id,
            round=match.round,
            round_no=match.round_no,
            home=match.home,
            away=match.away,
            rank_range=match.rank_range,
            possible_rank_refs=tuple(
                LeagueRankRef(block_id=block_id, rank=rank)
                for block_id, rank in sorted(paths_by_match[match.id])
            ),
            possible_team_ids=(
                tuple(rank_teams[rank_key] for rank_key in sorted(paths_by_match[match.id]))
                if plan.participant_resolution is ParticipantResolution.RESOLVED
                else ()
            ),
            prerequisite_match_ids=tuple(sorted(dependencies[match.id])),
            final=any(
                match.pool_id == pool.pool_id
                and match.rank_range == (pool.overall_rank_range[0], pool.overall_rank_range[0] + 1)
                for pool in plan.pools
            ),
        )
        for match in raw_matches
    )
    final_index_by_pool: dict[str, int] = {}
    for pool in plan.pools:
        indexes = [
            index
            for index, match in enumerate(scheduled_matches)
            if match.pool_id == pool.pool_id and match.final
        ]
        if len(indexes) != 1:
            raise _invalid_reference(
                "tournament_final_definition_invalid",
                pool_id=pool.pool_id,
                expected=1,
                actual=len(indexes),
            )
        final_index_by_pool[pool.pool_id] = indexes[0]
    conflict_pairs = frozenset(
        (left, right)
        for left in range(len(scheduled_matches))
        for right in range(left + 1, len(scheduled_matches))
        if _matches_can_share_team(
            paths_by_match[scheduled_matches[left].id],
            paths_by_match[scheduled_matches[right].id],
        )
    )
    return _PathModel(
        matches=scheduled_matches,
        paths_by_match=paths_by_match,
        dependencies=dependencies,
        conflict_pairs=conflict_pairs,
        team_by_rank=rank_teams,
        final_indexes=tuple(final_index_by_pool[pool.pool_id] for pool in plan.pools),
        final_index_by_pool=final_index_by_pool,
        primary_final_index=final_index_by_pool[plan.pools[0].pool_id],
    )


def _build_cp_model(
    data: Day2ScheduleRequest,
    path_model: _PathModel,
    horizon: int,
    *,
    exact_referee_constraints: bool = False,
    feasibility_only: bool = False,
) -> tuple[cp_model.CpModel, _ModelVariables]:
    model = cp_model.CpModel()
    match_count, court_count = len(path_model.matches), len(data.courts)
    sections, courts = range(horizon), range(court_count)
    placement: dict[tuple[int, int, int], cp_model.IntVar] = {}
    match_in_section: dict[tuple[int, int], cp_model.IntVar] = {}
    match_on_court: dict[tuple[int, int], cp_model.IntVar] = {}
    index_by_id = {match.id: index for index, match in enumerate(path_model.matches)}
    for match_index in range(match_count):
        for section in sections:
            section_var = model.new_bool_var(f"m{match_index}_s{section}")
            match_in_section[match_index, section] = section_var
            court_vars = []
            for court in courts:
                slot = model.new_bool_var(f"m{match_index}_s{section}_c{court}")
                placement[match_index, section, court] = slot
                court_vars.append(slot)
            model.add(sum(court_vars) == section_var)
        model.add(sum(match_in_section[match_index, section] for section in sections) == 1)
        if not feasibility_only:
            for court in courts:
                court_var = model.new_bool_var(f"m{match_index}_c{court}")
                match_on_court[match_index, court] = court_var
                model.add(
                    court_var == sum(placement[match_index, section, court] for section in sections)
                )

    for section in sections:
        for court in courts:
            model.add(sum(placement[index, section, court] for index in range(match_count)) <= 1)

    active = tuple(model.new_bool_var(f"active_{section}") for section in sections)
    for section in sections:
        section_count = sum(match_in_section[index, section] for index in range(match_count))
        model.add(section_count <= court_count * active[section])
        model.add(section_count >= active[section])
        if section + 1 < horizon:
            model.add(active[section] >= active[section + 1])
    used_sections = model.new_int_var(1, horizon, "used_sections")
    model.add(used_sections == sum(active))

    dependency_ancestors: dict[str, frozenset[str]] = {}

    def ancestors(match_id: str) -> frozenset[str]:
        cached = dependency_ancestors.get(match_id)
        if cached is not None:
            return cached
        values: set[str] = set()
        for dependency_id in sorted(path_model.dependencies.get(match_id, ())):
            values.add(dependency_id)
            values.update(ancestors(dependency_id))
        result = frozenset(values)
        dependency_ancestors[match_id] = result
        return result

    ordered_dependency_pairs = {
        tuple(sorted((index_by_id[match.id], index_by_id[ancestor_id])))
        for match in path_model.matches
        for ancestor_id in ancestors(match.id)
    }
    for left, right in sorted(path_model.conflict_pairs):
        # 祖先・子孫は下の依存制約により2section以上離れるため、同じ
        # conflict制約をsectionごとに重ねない。
        if (left, right) in ordered_dependency_pairs:
            continue
        for section in sections:
            model.add(match_in_section[left, section] + match_in_section[right, section] <= 1)
        for section in range(horizon - 1):
            model.add(match_in_section[left, section] + match_in_section[right, section + 1] <= 1)
            model.add(match_in_section[right, section] + match_in_section[left, section + 1] <= 1)

    if exact_referee_constraints:
        referee_constraint_builder = (
            _add_strict_referee_constraints
            if data.referees.day2_fallback is Day2Fallback.STRICT
            else _add_organizer_referee_constraints
        )
        referee_constraint_builder(model, placement, match_in_section, data, path_model, horizon)

    section_number: dict[int, cp_model.IntVar] = {}
    for match_index in range(match_count):
        value = model.new_int_var(1, horizon, f"section_number_{match_index}")
        section_number[match_index] = value
        model.add(
            value
            == sum((section + 1) * match_in_section[match_index, section] for section in sections)
        )
    for match_id, dependency_ids in sorted(path_model.dependencies.items()):
        target = index_by_id[match_id]
        for dependency_id in sorted(dependency_ids):
            model.add(section_number[target] >= section_number[index_by_id[dependency_id]] + 2)

    for earlier, later in zip(
        path_model.final_indexes[1:-1],
        path_model.final_indexes[2:],
        strict=True,
    ):
        model.add(section_number[earlier] <= section_number[later])

    model.add(section_number[path_model.primary_final_index] == used_sections)
    if feasibility_only:
        non_primary_final_max_gap = model.new_constant(0)
        non_primary_final_sum_gap = model.new_constant(0)
    else:
        non_primary_final_gaps: list[cp_model.IntVar] = []
        for final_index in path_model.final_indexes[1:]:
            gap = model.new_int_var(0, horizon, f"final_gap_{final_index}")
            model.add(gap == used_sections - section_number[final_index])
            non_primary_final_gaps.append(gap)
        non_primary_final_max_gap = model.new_int_var(0, horizon, "non_primary_final_max_gap")
        non_primary_final_sum_gap = model.new_int_var(
            0,
            horizon * max(1, len(non_primary_final_gaps)),
            "non_primary_final_sum_gap",
        )
        if non_primary_final_gaps:
            model.add_max_equality(non_primary_final_max_gap, non_primary_final_gaps)
            model.add(non_primary_final_sum_gap == sum(non_primary_final_gaps))
        else:
            model.add(non_primary_final_max_gap == 0)
            model.add(non_primary_final_sum_gap == 0)

    # 第1セクションは全試合が主催者審判になる。
    model.add(
        sum(match_in_section[index, 0] for index in range(match_count))
        <= data.referees.organizer_capacity
    )
    final_indexes = [index for index, match in enumerate(path_model.matches) if match.final]
    for section in sections:
        model.add(
            sum(match_in_section[index, section] for index in final_indexes)
            <= data.referees.organizer_capacity
        )

    if feasibility_only:
        zero = model.new_constant(0)
        return model, _ModelVariables(
            placement=placement,
            match_in_section=match_in_section,
            match_on_court=match_on_court,
            section_number=section_number,
            active_sections=active,
            used_sections=used_sections,
            maximum_wait=zero,
            non_primary_final_max_gap=non_primary_final_max_gap,
            non_primary_final_sum_gap=non_primary_final_sum_gap,
            court_change_count=zero,
            court_usage_difference=zero,
        )

    wait_vars: list[cp_model.IntVar] = []
    for match_id, dependency_ids in sorted(path_model.dependencies.items()):
        target = index_by_id[match_id]
        for dependency_id in sorted(dependency_ids):
            wait = model.new_int_var(1, horizon, f"wait_{dependency_id}_{match_id}")
            model.add(
                wait == section_number[target] - section_number[index_by_id[dependency_id]] - 1
            )
            wait_vars.append(wait)
    maximum_wait = model.new_int_var(0, horizon, "maximum_wait")
    if wait_vars:
        model.add_max_equality(maximum_wait, wait_vars)
    else:
        model.add(maximum_wait == 0)

    court_moves: list[cp_model.IntVar] = []
    for match_id, dependency_ids in sorted(path_model.dependencies.items()):
        target = index_by_id[match_id]
        for dependency_id in sorted(dependency_ids):
            source = index_by_id[dependency_id]
            same_court_vars: list[cp_model.IntVar] = []
            for court in courts:
                same = model.new_bool_var(f"same_court_{source}_{target}_{court}")
                model.add(same <= match_on_court[source, court])
                model.add(same <= match_on_court[target, court])
                model.add(same >= match_on_court[source, court] + match_on_court[target, court] - 1)
                same_court_vars.append(same)
            moved = model.new_bool_var(f"court_move_{source}_{target}")
            model.add(moved + sum(same_court_vars) == 1)
            court_moves.append(moved)
    court_change_count = model.new_int_var(0, len(court_moves), "court_change_count")
    model.add(court_change_count == sum(court_moves))

    court_counts: list[cp_model.IntVar] = []
    for court in courts:
        count = model.new_int_var(0, match_count, f"court_count_{court}")
        model.add(count == sum(match_on_court[index, court] for index in range(match_count)))
        court_counts.append(count)
    court_min = model.new_int_var(0, match_count, "court_min")
    court_max = model.new_int_var(0, match_count, "court_max")
    model.add_min_equality(court_min, court_counts)
    model.add_max_equality(court_max, court_counts)
    court_usage_difference = model.new_int_var(0, match_count, "court_usage_difference")
    model.add(court_usage_difference == court_max - court_min)

    return model, _ModelVariables(
        placement=placement,
        match_in_section=match_in_section,
        match_on_court=match_on_court,
        section_number=section_number,
        active_sections=active,
        used_sections=used_sections,
        maximum_wait=maximum_wait,
        non_primary_final_max_gap=non_primary_final_max_gap,
        non_primary_final_sum_gap=non_primary_final_sum_gap,
        court_change_count=court_change_count,
        court_usage_difference=court_usage_difference,
    )


def _add_strict_referee_constraints(
    model: cp_model.CpModel,
    placement: Mapping[tuple[int, int, int], cp_model.IntVar],
    match_in_section: Mapping[tuple[int, int], cp_model.IntVar],
    data: Day2ScheduleRequest,
    path_model: _PathModel,
    horizon: int,
) -> None:
    """直前実試合の全勝敗経路を使い、strict審判条件を厳密に組み込む。"""

    non_final_indexes = tuple(
        index for index, match in enumerate(path_model.matches) if not match.final
    )
    winner_paths = tuple(
        _outcome_paths(path_model.paths_by_match[match.id], match.id, "W")
        for match in path_model.matches
    )
    match_indexes = range(len(path_model.matches))
    court_indexes = range(len(data.courts))
    final_indexes = tuple(index for index, match in enumerate(path_model.matches) if match.final)
    for section in range(horizon):
        # 第1sectionで開けるコートは主催者能力までで、それ以降に新規
        # コートを開けられるのは主催者審判となる決勝だけである。
        model.add(
            sum(match_in_section[index, section] for index in match_indexes)
            <= data.referees.organizer_capacity
            + sum(
                match_in_section[index, earlier_section]
                for index in final_indexes
                for earlier_section in range(section + 1)
            )
        )
    # strictでは入力コート間に規則上の差がない。最初に使用される順へ
    # canonical化して、同一配置のコート置換を探索しない。
    opened: dict[tuple[int, int], cp_model.IntVar] = {}
    for court_index in court_indexes:
        for section in range(horizon):
            occupied = sum(placement[index, section, court_index] for index in match_indexes)
            current = model.new_bool_var(f"strict_opened_s{section}_c{court_index}")
            opened[section, court_index] = current
            if section == 0:
                model.add(current == occupied)
            else:
                previous = opened[section - 1, court_index]
                model.add(current >= previous)
                model.add(current >= occupied)
                model.add(current <= previous + occupied)
            if court_index > 0:
                model.add(current <= opened[section, court_index - 1])

    last_match: dict[tuple[int, int, int], cp_model.IntVar] = {}
    for match_index in match_indexes:
        for court_index in court_indexes:
            if horizon > 1:
                last_match[match_index, 1, court_index] = placement[match_index, 0, court_index]
            for section in range(2, horizon):
                previous_last = last_match[match_index, section - 1, court_index]
                previous_placement = placement[match_index, section - 1, court_index]
                previous_occupied = sum(
                    placement[index, section - 1, court_index] for index in match_indexes
                )
                current_last = model.new_bool_var(
                    f"strict_last_{match_index}_s{section}_c{court_index}"
                )
                model.add(current_last >= previous_placement)
                model.add(current_last >= previous_last - previous_occupied)
                model.add(current_last <= previous_placement + previous_last)
                model.add(current_last <= previous_placement + 1 - previous_occupied)
                last_match[match_index, section, court_index] = current_last

    for section in range(1, horizon):
        source_used: dict[int, cp_model.IntVar] = {}
        for source_index in match_indexes:
            referee_sources: list[cp_model.IntVar] = []
            for court_index in court_indexes:
                current_non_final = sum(
                    placement[target_index, section, court_index]
                    for target_index in non_final_indexes
                )
                source = model.new_bool_var(
                    f"strict_source_{source_index}_s{section}_c{court_index}"
                )
                previous = last_match[source_index, section, court_index]
                model.add(source <= previous)
                model.add(source <= current_non_final)
                model.add(source >= previous + current_non_final - 1)
                referee_sources.append(source)
            used = model.new_bool_var(f"strict_source_{source_index}_s{section}")
            model.add(used == sum(referee_sources))
            source_used[source_index] = used

            for target_index, target in enumerate(path_model.matches):
                if _matches_can_share_team(
                    winner_paths[source_index],
                    path_model.paths_by_match[target.id],
                ):
                    model.add(used + match_in_section[target_index, section] <= 1)

        for court_index in court_indexes:
            current_non_final = sum(
                placement[target_index, section, court_index] for target_index in non_final_indexes
            )
            model.add(
                current_non_final
                <= sum(
                    last_match[source_index, section, court_index] for source_index in match_indexes
                )
            )

        for left in match_indexes:
            for right in range(left + 1, len(path_model.matches)):
                if _matches_can_share_team(winner_paths[left], winner_paths[right]):
                    model.add(source_used[left] + source_used[right] <= 1)


def _add_organizer_referee_constraints(
    model: cp_model.CpModel,
    placement: Mapping[tuple[int, int, int], cp_model.IntVar],
    match_in_section: Mapping[tuple[int, int], cp_model.IntVar],
    data: Day2ScheduleRequest,
    path_model: _PathModel,
    horizon: int,
) -> None:
    """コート順の直前勝者審判と主催者フォールバックを厳密に組み込む。"""

    non_final_indexes = tuple(
        index for index, match in enumerate(path_model.matches) if not match.final
    )
    final_indexes = tuple(index for index, match in enumerate(path_model.matches) if match.final)
    winner_paths = tuple(
        _outcome_paths(path_model.paths_by_match[match.id], match.id, "W")
        for match in path_model.matches
    )
    match_indexes = range(len(path_model.matches))
    court_indexes = range(len(data.courts))
    last_match: dict[tuple[int, int, int], cp_model.IntVar] = {}
    for match_index in match_indexes:
        for court_index in court_indexes:
            if horizon > 1:
                last_match[match_index, 1, court_index] = placement[match_index, 0, court_index]
            for section in range(2, horizon):
                previous_last = last_match[match_index, section - 1, court_index]
                previous_placement = placement[match_index, section - 1, court_index]
                previous_occupied = sum(
                    placement[index, section - 1, court_index] for index in match_indexes
                )
                current_last = model.new_bool_var(
                    f"referee_last_{match_index}_s{section}_c{court_index}"
                )
                model.add(current_last >= previous_placement)
                model.add(current_last >= previous_last - previous_occupied)
                model.add(current_last <= previous_placement + previous_last)
                model.add(current_last <= previous_placement + 1 - previous_occupied)
                last_match[match_index, section, court_index] = current_last

    for section in range(1, horizon):
        selected_by_court: list[dict[int, cp_model.IntVar]] = []
        selected_sources: list[cp_model.IntVar] = []
        for court_index in court_indexes:
            current_non_final = sum(
                placement[target_index, section, court_index] for target_index in non_final_indexes
            )
            current_selected: dict[int, cp_model.IntVar] = {}
            for source_index in match_indexes:
                previous = last_match[source_index, section, court_index]
                candidate = model.new_bool_var(
                    f"referee_candidate_{source_index}_s{section}_c{court_index}"
                )
                model.add(candidate <= previous)
                model.add(candidate <= current_non_final)
                model.add(candidate >= previous + current_non_final - 1)

                conflicting_matches = [
                    match_in_section[target_index, section]
                    for target_index, target in enumerate(path_model.matches)
                    if _matches_can_share_team(
                        winner_paths[source_index],
                        path_model.paths_by_match[target.id],
                    )
                ]
                intrinsic = model.new_bool_var(
                    f"referee_intrinsic_{source_index}_s{section}_c{court_index}"
                )
                model.add(intrinsic <= candidate)
                for conflict in conflicting_matches:
                    model.add(intrinsic + conflict <= 1)
                model.add(intrinsic >= candidate - sum(conflicting_matches))

                blockers = [
                    selected
                    for earlier in selected_by_court
                    for earlier_source, selected in earlier.items()
                    if _matches_can_share_team(
                        winner_paths[source_index],
                        winner_paths[earlier_source],
                    )
                ]
                selected = model.new_bool_var(
                    f"referee_selected_{source_index}_s{section}_c{court_index}"
                )
                model.add(selected <= intrinsic)
                for blocker in blockers:
                    model.add(selected + blocker <= 1)
                model.add(selected >= intrinsic - sum(blockers))
                current_selected[source_index] = selected
                selected_sources.append(selected)
            selected_by_court.append(current_selected)

        current_non_final_count = sum(
            match_in_section[index, section] for index in non_final_indexes
        )
        team_referee_count = sum(selected_sources)
        current_final_count = sum(match_in_section[index, section] for index in final_indexes)
        model.add(
            current_final_count + current_non_final_count - team_referee_count
            <= data.referees.organizer_capacity
        )


def _solve_lexicographically(
    model: cp_model.CpModel,
    variables: _ModelVariables,
    data: Day2ScheduleRequest,
    started: float,
) -> _SolvedLayout:
    stages: tuple[tuple[str, cp_model.IntVar], ...] = (
        ("used_sections", variables.used_sections),
        ("non_primary_final_max_gap", variables.non_primary_final_max_gap),
        ("non_primary_final_sum_gap", variables.non_primary_final_sum_gap),
        ("maximum_team_wait_sections", variables.maximum_wait),
        ("team_court_change_count", variables.court_change_count),
        ("court_usage_difference", variables.court_usage_difference),
    )
    budget_fractions = (0.45, 0.08, 0.07, 0.16, 0.12, 0.12)
    best_solver: cp_model.CpSolver | None = None
    optimized: list[str] = []
    primary_bound = 0.0
    total_wall = 0.0
    for stage_index, (name, objective) in enumerate(stages):
        elapsed = perf_counter() - started
        remaining = data.solver.max_time_seconds - elapsed
        if remaining <= _MIN_SOLVER_SECONDS:
            break
        stage_budget = min(
            remaining,
            max(
                _MIN_SOLVER_SECONDS,
                data.solver.max_time_seconds * budget_fractions[stage_index],
            ),
        )
        model.minimize(objective)
        solver = _configured_solver(
            remaining,
            data.random_seed,
            max_deterministic_time=stage_budget * 0.25,
        )
        status = _status(solver.solve(model))
        total_wall += solver.wall_time
        if status not in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}:
            if best_solver is None:
                return _SolvedLayout(
                    solver=solver,
                    status=status,
                    wall_time_seconds=total_wall,
                    optimized_objectives=tuple(optimized),
                    primary_bound=solver.best_objective_bound,
                )
            break
        if stage_index == 0:
            primary_bound = solver.best_objective_bound
        if status is not SolverStatus.OPTIMAL:
            if best_solver is None:
                best_solver = solver
            # 後段の未証明解へ差し替えず、直前まで証明済みの辞書式目的を維持する。
            break
        best_solver = solver
        optimum = solver.value(objective)
        model.add(objective == optimum)
        optimized.append(name)
    assert best_solver is not None
    all_stages_proven = len(optimized) == len(stages)
    return _SolvedLayout(
        solver=best_solver,
        status=SolverStatus.OPTIMAL if all_stages_proven else SolverStatus.FEASIBLE,
        wall_time_seconds=total_wall,
        optimized_objectives=tuple(optimized),
        primary_bound=primary_bound,
    )


def _extract_slots(
    data: Day2ScheduleRequest,
    path_model: _PathModel,
    variables: _ModelVariables,
    solver: cp_model.CpSolver,
) -> tuple[Slot, ...]:
    used = solver.value(variables.used_sections)
    slots: list[Slot] = []
    for section in range(used):
        for court_index, court in enumerate(data.courts):
            match_index = next(
                (
                    index
                    for index in range(len(path_model.matches))
                    if solver.boolean_value(variables.placement[index, section, court_index])
                ),
                None,
            )
            slots.append(
                Slot(
                    day_id=data.day.id,
                    section_no=section + 1,
                    court_id=court.id,
                    match_id=(None if match_index is None else path_model.matches[match_index].id),
                    referee_assignment=None,
                )
            )
    return tuple(slots)


def _assign_referees(
    data: Day2ScheduleRequest,
    path_model: _PathModel,
    slots: tuple[Slot, ...],
) -> tuple[dict[str | None, RefereeAssignment], dict[str, tuple[str, ...]]]:
    match_by_id = {match.id: match for match in path_model.matches}
    occupied = [slot for slot in slots if slot.match_id is not None]
    by_section: dict[int, list[Slot]] = defaultdict(list)
    by_court: dict[str, list[Slot]] = defaultdict(list)
    for slot in occupied:
        by_section[slot.section_no].append(slot)
        by_court[slot.court_id].append(slot)
    for court_slots in by_court.values():
        court_slots.sort(key=lambda item: item.section_no)

    assignments: dict[str | None, RefereeAssignment] = {}
    invalid: dict[str, tuple[str, ...]] = {}
    source_uses_by_section: defaultdict[tuple[int, str], list[str]] = defaultdict(list)
    referee_paths_by_section: defaultdict[
        int, list[Mapping[_RankKey, frozenset[frozenset[str]]]]
    ] = defaultdict(list)
    court_order = {court.id: index for index, court in enumerate(data.courts)}
    for slot in sorted(
        occupied,
        key=lambda item: (
            item.section_no,
            court_order.get(item.court_id, len(court_order)),
            item.court_id,
        ),
    ):
        assert slot.match_id is not None
        match = match_by_id[slot.match_id]
        if slot.section_no == 1:
            assignments[slot.match_id] = RefereeAssignment(
                kind=RefereeKind.ORGANIZER,
                organizer_reason="first_section",
            )
            continue
        if match.final:
            assignments[slot.match_id] = RefereeAssignment(
                kind=RefereeKind.ORGANIZER,
                organizer_reason="tournament_final",
            )
            continue

        previous = max(
            (
                candidate
                for candidate in by_court[slot.court_id]
                if candidate.section_no < slot.section_no
            ),
            key=lambda item: item.section_no,
            default=None,
        )
        reasons: list[str] = []
        if previous is None or previous.match_id is None:
            reasons.append("no_previous_match")
        else:
            source_paths = _outcome_paths(
                path_model.paths_by_match[previous.match_id], previous.match_id, "W"
            )
            target_paths = path_model.paths_by_match[slot.match_id]
            if _matches_can_share_team(source_paths, target_paths):
                reasons.append("source_may_play_target")
            other_paths = [
                path_model.paths_by_match[other.match_id]
                for other in by_section[slot.section_no]
                if other.match_id is not None and other.match_id != slot.match_id
            ]
            if any(_matches_can_share_team(source_paths, paths) for paths in other_paths):
                reasons.append("source_may_have_same_section_role")
            key = (slot.section_no, previous.match_id)
            if source_uses_by_section[key]:
                reasons.append("source_used_twice_in_section")
            if any(
                _matches_can_share_team(source_paths, assigned_paths)
                for assigned_paths in referee_paths_by_section[slot.section_no]
            ):
                reasons.append("source_may_referee_twice_in_section")
            if not reasons:
                source_uses_by_section[key].append(slot.match_id)
                referee_paths_by_section[slot.section_no].append(source_paths)
                assignments[slot.match_id] = RefereeAssignment(
                    kind=RefereeKind.TEAM,
                    source_match_id=previous.match_id,
                )
                continue

        invalid[slot.match_id] = tuple(reasons)
        assignments[slot.match_id] = RefereeAssignment(
            kind=RefereeKind.ORGANIZER,
            organizer_reason="fallback",
            fallback_reasons=tuple(reasons),
        )
    return assignments, invalid


def _team_routes(path_model: _PathModel, slots: tuple[Slot, ...]) -> tuple[TeamRouteEntry, ...]:
    routes: list[TeamRouteEntry] = []
    for slot in slots:
        if slot.match_id is None:
            continue
        for rank_key, conditions in sorted(path_model.paths_by_match[slot.match_id].items()):
            for condition in conditions:
                routes.append(
                    TeamRouteEntry(
                        rank_ref=LeagueRankRef(block_id=rank_key[0], rank=rank_key[1]),
                        team_id=path_model.team_by_rank.get(rank_key),
                        role="match",
                        match_id=slot.match_id,
                        section_no=slot.section_no,
                        court_id=slot.court_id,
                        conditions=tuple(sorted(condition)),
                    )
                )
        assignment = slot.referee_assignment
        if assignment is None or assignment.source_match_id is None:
            continue
        referee_paths = _outcome_paths(
            path_model.paths_by_match[assignment.source_match_id],
            assignment.source_match_id,
            "W",
        )
        for rank_key, conditions in sorted(referee_paths.items()):
            for condition in conditions:
                routes.append(
                    TeamRouteEntry(
                        rank_ref=LeagueRankRef(block_id=rank_key[0], rank=rank_key[1]),
                        team_id=path_model.team_by_rank.get(rank_key),
                        role="referee",
                        match_id=slot.match_id,
                        section_no=slot.section_no,
                        court_id=slot.court_id,
                        conditions=tuple(sorted(condition)),
                    )
                )
    return tuple(
        sorted(
            routes,
            key=lambda item: (
                item.rank_ref.block_id if item.rank_ref is not None else "",
                item.rank_ref.rank if item.rank_ref is not None else 0,
                item.section_no,
                item.court_id,
                item.role,
                item.match_id,
                item.conditions,
            ),
        )
    )


def _audit_metrics(
    data: Day2ScheduleRequest,
    path_model: _PathModel,
    slots: tuple[Slot, ...],
    routes: tuple[TeamRouteEntry, ...],
    layout: _SolvedLayout,
    variables: _ModelVariables,
) -> SolverMetrics:
    occupied = [slot for slot in slots if slot.match_id is not None]
    organizer_count = sum(
        slot.referee_assignment is not None
        and slot.referee_assignment.kind is RefereeKind.ORGANIZER
        for slot in occupied
    )
    team_referee_count = len(occupied) - organizer_count
    fallback_count = sum(
        slot.referee_assignment is not None
        and slot.referee_assignment.organizer_reason == "fallback"
        for slot in occupied
    )
    court_counts = Counter(slot.court_id for slot in occupied)
    counts = [court_counts[court.id] for court in data.courts]
    positions = {slot.match_id: slot.section_no for slot in occupied if slot.match_id is not None}
    used_section_count = layout.solver.value(variables.used_sections)
    final_metrics = tuple(
        PoolFinalMetric(
            pool_id=pool_id,
            section_no=positions[path_model.matches[index].id],
            final_section_gap=used_section_count - positions[path_model.matches[index].id],
        )
        for pool_id, index in sorted(path_model.final_index_by_pool.items())
    )
    referee_then_match_count, adjacent_move_count = _route_transition_counts(routes)
    league_counts, league_minimum, league_maximum, league_difference, previous_same_court = (
        _day1_league_audit(data)
    )
    stage_values = (
        ("used_sections", layout.solver.value(variables.used_sections)),
        (
            "non_primary_final_max_gap",
            layout.solver.value(variables.non_primary_final_max_gap),
        ),
        (
            "non_primary_final_sum_gap",
            layout.solver.value(variables.non_primary_final_sum_gap),
        ),
        ("league_team_referee_count_difference", league_difference),
        (
            "maximum_team_wait_sections",
            layout.solver.value(variables.maximum_wait),
        ),
        ("referee_then_match_count", referee_then_match_count),
        ("league_previous_same_court_referee_count", previous_same_court),
        (
            "adjacent_assignment_court_change_count",
            adjacent_move_count,
        ),
        (
            "team_court_change_count",
            layout.solver.value(variables.court_change_count),
        ),
        (
            "court_usage_difference",
            max(counts, default=0) - min(counts, default=0),
        ),
    )
    fixed_objectives = {
        "league_team_referee_count_difference",
        "league_previous_same_court_referee_count",
    }
    proven_objectives = set(layout.optimized_objectives) | fixed_objectives
    # 非負目的が0なら、別の配置を列挙しなくても下界到達を証明できる。
    proven_objectives.update(
        name
        for name, value in stage_values
        if name
        in {
            "non_primary_final_max_gap",
            "non_primary_final_sum_gap",
            "referee_then_match_count",
            "adjacent_assignment_court_change_count",
        }
        and value == 0
    )
    optimized_objectives = tuple(name for name, _value in stage_values if name in proven_objectives)
    all_objectives_proven = len(optimized_objectives) == len(stage_values)
    return SolverMetrics(
        random_seed=data.random_seed,
        max_time_seconds=data.solver.max_time_seconds,
        ortools_version=_ORTOOLS_VERSION,
        wall_time_seconds=layout.wall_time_seconds,
        used_sections=layout.solver.value(variables.used_sections),
        objective_value=float(layout.solver.value(variables.used_sections)),
        best_objective_bound=float(layout.primary_bound),
        league_team_referee_counts=league_counts,
        league_team_referee_count_min=league_minimum,
        league_team_referee_count_max=league_maximum,
        league_team_referee_count_difference=league_difference,
        maximum_team_wait_sections=layout.solver.value(variables.maximum_wait),
        referee_then_match_count=referee_then_match_count,
        league_previous_same_court_referee_count=previous_same_court,
        adjacent_assignment_court_change_count=adjacent_move_count,
        team_court_change_count=layout.solver.value(variables.court_change_count),
        court_usage_difference=max(counts, default=0) - min(counts, default=0),
        organizer_referee_count=organizer_count,
        tournament_team_referee_count=team_referee_count,
        tournament_referee_fallback_count=fallback_count,
        unused_slot_count=len(slots) - len(occupied),
        placement_tournament_finals=final_metrics,
        non_primary_final_max_gap=layout.solver.value(variables.non_primary_final_max_gap),
        non_primary_final_sum_gap=layout.solver.value(variables.non_primary_final_sum_gap),
        optimized_objectives=optimized_objectives,
        objective_stages=tuple(
            ObjectiveStageMetric(
                objective=name,
                value=value,
                optimality_proven=name in proven_objectives,
            )
            for name, value in stage_values
        ),
        optimality_proven=all_objectives_proven,
    )


def _audit_template_metrics(
    data: Day2ScheduleRequest,
    path_model: _PathModel,
    slots: tuple[Slot, ...],
    routes: tuple[TeamRouteEntry, ...],
    entry: PlacementTemplateEntry,
) -> SolverMetrics:
    """テンプレート配置から既存の10段階メトリクスを独立再計算する。"""

    occupied = [slot for slot in slots if slot.match_id is not None]
    positions = {slot.match_id: slot.section_no for slot in occupied if slot.match_id is not None}
    court_by_match = {
        slot.match_id: slot.court_id for slot in occupied if slot.match_id is not None
    }
    used_sections = max(positions.values(), default=0)
    final_metrics = tuple(
        PoolFinalMetric(
            pool_id=pool_id,
            section_no=positions[path_model.matches[index].id],
            final_section_gap=used_sections - positions[path_model.matches[index].id],
        )
        for pool_id, index in sorted(path_model.final_index_by_pool.items())
    )
    non_primary_gaps = [
        used_sections - positions[path_model.matches[index].id]
        for index in path_model.final_indexes[1:]
    ]
    waits = [
        positions[match_id] - positions[source_id] - 1
        for match_id, source_ids in path_model.dependencies.items()
        for source_id in source_ids
    ]
    court_changes = sum(
        court_by_match[match_id] != court_by_match[source_id]
        for match_id, source_ids in path_model.dependencies.items()
        for source_id in source_ids
    )
    court_counts = Counter(slot.court_id for slot in occupied)
    counts = [court_counts[court.id] for court in data.courts]
    six_values = {
        "used_sections": used_sections,
        "non_primary_final_max_gap": max(non_primary_gaps, default=0),
        "non_primary_final_sum_gap": sum(non_primary_gaps),
        "maximum_team_wait_sections": max(waits, default=0),
        "team_court_change_count": court_changes,
        "court_usage_difference": max(counts, default=0) - min(counts, default=0),
    }
    template_objectives = {objective.objective: objective for objective in entry.objectives}
    if tuple(template_objectives) != PLACEMENT_OBJECTIVES or any(
        template_objectives[name].value != value for name, value in six_values.items()
    ):
        raise _TemplateTopologyError("テンプレート目的値が実配置の監査値と一致しません")

    referee_then_match_count, adjacent_move_count = _route_transition_counts(routes)
    league_counts, league_minimum, league_maximum, league_difference, previous_same_court = (
        _day1_league_audit(data)
    )
    stage_values = (
        ("used_sections", six_values["used_sections"]),
        ("non_primary_final_max_gap", six_values["non_primary_final_max_gap"]),
        ("non_primary_final_sum_gap", six_values["non_primary_final_sum_gap"]),
        ("league_team_referee_count_difference", league_difference),
        ("maximum_team_wait_sections", six_values["maximum_team_wait_sections"]),
        ("referee_then_match_count", referee_then_match_count),
        ("league_previous_same_court_referee_count", previous_same_court),
        ("adjacent_assignment_court_change_count", adjacent_move_count),
        ("team_court_change_count", six_values["team_court_change_count"]),
        ("court_usage_difference", six_values["court_usage_difference"]),
    )
    proven_objectives = {
        name for name in PLACEMENT_OBJECTIVES if template_objectives[name].optimality_proven
    }
    proven_objectives.update(
        {"league_team_referee_count_difference", "league_previous_same_court_referee_count"}
    )
    proven_objectives.update(
        name
        for name, value in stage_values
        if name in {"referee_then_match_count", "adjacent_assignment_court_change_count"}
        and value == 0
    )
    optimized_objectives = tuple(name for name, _value in stage_values if name in proven_objectives)
    all_objectives_proven = len(optimized_objectives) == len(stage_values)
    organizer_count = sum(
        slot.referee_assignment is not None
        and slot.referee_assignment.kind is RefereeKind.ORGANIZER
        for slot in occupied
    )
    fallback_count = sum(
        slot.referee_assignment is not None
        and slot.referee_assignment.organizer_reason == "fallback"
        for slot in occupied
    )
    return SolverMetrics(
        random_seed=data.random_seed,
        max_time_seconds=data.solver.max_time_seconds,
        ortools_version=entry.provenance.ortools_version,
        wall_time_seconds=0,
        used_sections=used_sections,
        objective_value=float(used_sections),
        best_objective_bound=float(used_sections),
        league_team_referee_counts=league_counts,
        league_team_referee_count_min=league_minimum,
        league_team_referee_count_max=league_maximum,
        league_team_referee_count_difference=league_difference,
        maximum_team_wait_sections=six_values["maximum_team_wait_sections"],
        referee_then_match_count=referee_then_match_count,
        league_previous_same_court_referee_count=previous_same_court,
        adjacent_assignment_court_change_count=adjacent_move_count,
        team_court_change_count=six_values["team_court_change_count"],
        court_usage_difference=six_values["court_usage_difference"],
        organizer_referee_count=organizer_count,
        tournament_team_referee_count=len(occupied) - organizer_count,
        tournament_referee_fallback_count=fallback_count,
        unused_slot_count=len(slots) - len(occupied),
        placement_tournament_finals=final_metrics,
        non_primary_final_max_gap=six_values["non_primary_final_max_gap"],
        non_primary_final_sum_gap=six_values["non_primary_final_sum_gap"],
        optimized_objectives=optimized_objectives,
        objective_stages=tuple(
            ObjectiveStageMetric(
                objective=name,
                value=value,
                optimality_proven=name in proven_objectives,
            )
            for name, value in stage_values
        ),
        optimality_proven=all_objectives_proven,
    )


def _route_transition_counts(routes: tuple[TeamRouteEntry, ...]) -> tuple[int, int]:
    """勝敗条件が両立する隣接割当ての負担を集計する。"""

    by_team: defaultdict[_RankKey, list[TeamRouteEntry]] = defaultdict(list)
    for route in routes:
        if route.rank_ref is None:
            continue
        by_team[route.rank_ref.block_id, route.rank_ref.rank].append(route)
    referee_then_match: set[tuple[_RankKey, str, str]] = set()
    adjacent_moves: set[tuple[_RankKey, str, str]] = set()
    for rank_key, entries in sorted(by_team.items()):
        for left in entries:
            for right in entries:
                if right.section_no != left.section_no + 1:
                    continue
                if not _condition_strings_compatible(left.conditions, right.conditions):
                    continue
                if left.role == "referee" and right.role == "match":
                    referee_then_match.add((rank_key, left.match_id, right.match_id))
                if left.court_id != right.court_id:
                    adjacent_moves.add((rank_key, left.match_id, right.match_id))
    return len(referee_then_match), len(adjacent_moves)


def _day1_league_audit(
    data: Day2ScheduleRequest,
) -> tuple[tuple[TeamRefereeCount, ...], int, int, int, int]:
    """変更しない1日目の第2・第5目的を実スロットから独立集計する。"""

    league_matches = {match.id: match for match in data.league_plan.matches}
    counts = {team.id: 0 for team in data.teams}
    slots_by_position = {
        (slot.section_no, slot.court_id): slot for slot in data.day1_schedule.slots
    }
    previous_same_court = 0
    for slot in data.day1_schedule.slots:
        if slot.match_id not in league_matches:
            continue
        assignment = slot.referee_assignment
        if (
            assignment is None
            or assignment.kind is not RefereeKind.TEAM
            or assignment.team_id is None
        ):
            continue
        counts[assignment.team_id] += 1
        previous = slots_by_position.get((slot.section_no - 1, slot.court_id))
        if (
            previous is not None
            and previous.match_id in league_matches
            and assignment.team_id in league_matches[previous.match_id].possible_team_ids
        ):
            previous_same_court += 1
    ordered = tuple(
        TeamRefereeCount(team_id=team_id, count=counts[team_id]) for team_id in sorted(counts)
    )
    values = list(counts.values())
    minimum = min(values, default=0)
    maximum = max(values, default=0)
    return ordered, minimum, maximum, maximum - minimum, previous_same_court


def _empty_metrics(data: Day2ScheduleRequest) -> SolverMetrics:
    league_counts, league_minimum, league_maximum, league_difference, previous_same_court = (
        _day1_league_audit(data)
    )
    stage_values = (
        ("used_sections", 0),
        ("non_primary_final_max_gap", 0),
        ("non_primary_final_sum_gap", 0),
        ("league_team_referee_count_difference", league_difference),
        ("maximum_team_wait_sections", 0),
        ("referee_then_match_count", 0),
        ("league_previous_same_court_referee_count", previous_same_court),
        ("adjacent_assignment_court_change_count", 0),
        ("team_court_change_count", 0),
        ("court_usage_difference", 0),
    )
    return SolverMetrics(
        random_seed=data.random_seed,
        max_time_seconds=data.solver.max_time_seconds,
        ortools_version=_ORTOOLS_VERSION,
        wall_time_seconds=0,
        used_sections=0,
        objective_value=0,
        best_objective_bound=0,
        league_team_referee_counts=league_counts,
        league_team_referee_count_min=league_minimum,
        league_team_referee_count_max=league_maximum,
        league_team_referee_count_difference=league_difference,
        maximum_team_wait_sections=0,
        referee_then_match_count=0,
        league_previous_same_court_referee_count=previous_same_court,
        adjacent_assignment_court_change_count=0,
        team_court_change_count=0,
        court_usage_difference=0,
        organizer_referee_count=0,
        tournament_team_referee_count=0,
        tournament_referee_fallback_count=0,
        unused_slot_count=0,
        optimized_objectives=tuple(name for name, _value in stage_values),
        objective_stages=tuple(
            ObjectiveStageMetric(objective=name, value=value, optimality_proven=True)
            for name, value in stage_values
        ),
        optimality_proven=True,
    )


def _failed_schedule(
    data: Day2ScheduleRequest,
    matches: tuple[ScheduledTournamentMatch, ...],
    status: SolverStatus,
    code: str,
    message: str,
    *,
    wall_time_seconds: float = 0,
    **details: int | float | str | bool | list[str],
) -> Day2Schedule:
    metrics = SolverMetrics(
        random_seed=data.random_seed,
        max_time_seconds=data.solver.max_time_seconds,
        ortools_version=_ORTOOLS_VERSION,
        wall_time_seconds=max(0.0, wall_time_seconds),
        optimality_proven=status is SolverStatus.INFEASIBLE,
    )
    return Day2Schedule(
        participant_resolution=data.tournament_plan.participant_resolution,
        status=status,
        tournament_matches=matches,
        metrics=metrics,
        diagnostics=(Diagnostic(code=code, message=message, details=details),),
    )


def _invalid_reference(reason: str, **details: object) -> Day2ScheduleError:
    return Day2ScheduleError(
        "TOURNAMENT_REFERENCE_INVALID",
        "トーナメントの勝敗参照を確認できませんでした。トーナメント表を再作成してください。",
        reason=reason,
        **details,
    )


def _entry_dependency(entry: TournamentEntry) -> str | None:
    if isinstance(entry, (WinnerOfRef, LoserOfRef)):
        return entry.match_id
    return None


def _matches_can_share_team(
    left: Mapping[_RankKey, Iterable[frozenset[str]]],
    right: Mapping[_RankKey, Iterable[frozenset[str]]],
) -> bool:
    for rank_key in set(left) & set(right):
        if any(
            _conditions_compatible(left_condition, right_condition)
            for left_condition in left[rank_key]
            for right_condition in right[rank_key]
        ):
            return True
    return False


def _conditions_compatible(left: frozenset[str], right: frozenset[str]) -> bool:
    return _condition_strings_compatible(tuple(left), tuple(right))


def _condition_strings_compatible(left: tuple[str, ...], right: tuple[str, ...]) -> bool:
    outcomes: dict[str, str] = {}
    for literal in (*left, *right):
        outcome, separator, match_id = literal.partition(":")
        if separator == "" or outcome not in {"W", "L"}:
            continue
        previous = outcomes.get(match_id)
        if previous is not None and previous != outcome:
            return False
        outcomes[match_id] = outcome
    return True


def _outcome_paths(
    source: Mapping[_RankKey, frozenset[frozenset[str]]], match_id: str, outcome: str
) -> dict[_RankKey, frozenset[frozenset[str]]]:
    return {
        rank_key: frozenset(condition | {f"{outcome}:{match_id}"} for condition in conditions)
        for rank_key, conditions in sorted(source.items())
    }


def _configured_solver(
    max_time_seconds: float,
    random_seed: int,
    *,
    max_deterministic_time: float | None = None,
) -> cp_model.CpSolver:
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max(_MIN_SOLVER_SECONDS, max_time_seconds)
    # 壁時計だけで打ち切ると、同じseedでも負荷差により探索位置が変わり得る。
    # 決定論的時間を先に到達する値へ制限し、途中解も再現可能にする。
    solver.parameters.max_deterministic_time = max(
        _MIN_SOLVER_SECONDS,
        max_deterministic_time if max_deterministic_time is not None else max_time_seconds * 0.25,
    )
    solver.parameters.random_seed = random_seed
    solver.parameters.num_search_workers = 1
    solver.parameters.randomize_search = False
    solver.parameters.ignore_names = True
    return solver


def _status(status: cp_model.CpSolverStatus) -> SolverStatus:
    return {
        cp_model.OPTIMAL: SolverStatus.OPTIMAL,
        cp_model.FEASIBLE: SolverStatus.FEASIBLE,
        cp_model.INFEASIBLE: SolverStatus.INFEASIBLE,
        cp_model.UNKNOWN: SolverStatus.UNKNOWN,
    }.get(status, SolverStatus.UNKNOWN)


def as_schedule_result(schedule: Day2Schedule) -> ScheduleResult:
    """共通validatorへ渡せるScheduleResult表現を返す。"""

    return ScheduleResult(
        status=schedule.status,
        slots=schedule.slots,
        section_timings=schedule.section_timings,
        expected_end_time=schedule.expected_end_time,
        metrics=schedule.metrics,
        diagnostics=schedule.diagnostics,
    )
