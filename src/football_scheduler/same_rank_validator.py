"""同順位リーグ2日目日程の独立制約検証。"""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Mapping
from itertools import pairwise
from typing import Annotated

from pydantic import Field, ValidationError

from football_scheduler.models import ContractModel, Diagnostic, RefereeKind
from football_scheduler.same_rank_schedule import (
    SameRankDay2Schedule,
    SameRankDay2ScheduleRequest,
    SameRankSlot,
)
from football_scheduler.timekeeping import (
    DayTimingError,
    expected_end_time,
    resolve_max_sections,
    section_timings,
)

_RankKey = tuple[str, int]
_OBJECTIVES = (
    "used_sections",
    "referee_count_difference",
    "maximum_team_wait_sections",
    "referee_then_match_count",
    "previous_same_court_referee_count",
    "gap_court_change_count",
    "court_usage_difference",
)


class SameRankValidationSummary(ContractModel):
    expected_match_count: Annotated[int, Field(ge=0)]
    scheduled_match_count: Annotated[int, Field(ge=0)]
    used_sections: Annotated[int, Field(ge=0)]
    organizer_referee_count: Annotated[int, Field(ge=0)]
    fallback_count: Annotated[int, Field(ge=0)]
    error_count: Annotated[int, Field(ge=0)]


class SameRankValidationReport(ContractModel):
    valid: bool
    diagnostics: tuple[Diagnostic, ...]
    summary: SameRankValidationSummary


def validate_same_rank_day2_schedule(
    request: SameRankDay2ScheduleRequest | Mapping[str, object],
    schedule: SameRankDay2Schedule | Mapping[str, object],
) -> SameRankValidationReport:
    """生成器とは別に順位枠の全役割と監査値を再構築して検証する。"""

    try:
        data = (
            request
            if isinstance(request, SameRankDay2ScheduleRequest)
            else SameRankDay2ScheduleRequest.model_validate(request)
        )
        result = (
            schedule
            if isinstance(schedule, SameRankDay2Schedule)
            else SameRankDay2Schedule.model_validate(schedule)
        )
    except ValidationError as exc:
        diagnostic = Diagnostic(
            code="SAME_RANK_SCHEDULE_SCHEMA_INVALID",
            message="同順位リーグ日程の検証対象を読み取れませんでした。日程を再生成してください。",
            details={"error_count": len(exc.errors())},
        )
        return SameRankValidationReport(
            valid=False,
            diagnostics=(diagnostic,),
            summary=SameRankValidationSummary(
                expected_match_count=0,
                scheduled_match_count=0,
                used_sections=0,
                organizer_referee_count=0,
                fallback_count=0,
                error_count=1,
            ),
        )

    diagnostics: list[Diagnostic] = []
    expected_matches = tuple(
        match for group in data.same_rank_plan.groups for match in group.matches
    )
    expected_by_id = {match.id: match for match in expected_matches}
    actual_by_id = {match.id: match for match in result.same_rank_matches}
    if len(actual_by_id) != len(result.same_rank_matches) or actual_by_id != expected_by_id:
        diagnostics.append(
            _diagnostic(
                "SAME_RANK_MATCH_STRUCTURE_INVALID",
                "同順位リーグの対戦構造が生成計画と一致しません。",
            )
        )

    court_ids = {court.id for court in data.courts}
    used_sections = result.metrics.used_sections or 0
    positions: set[tuple[int, str]] = set()
    occupied_ids: list[str] = []
    slot_by_match: dict[str, SameRankSlot] = {}
    for slot in result.slots:
        position = (slot.section_no, slot.court_id)
        if position in positions:
            diagnostics.append(
                _diagnostic(
                    "SAME_RANK_SLOT_DUPLICATED",
                    "同じセクションとコートに複数のスロットがあります。",
                    section_no=slot.section_no,
                    court_id=slot.court_id,
                )
            )
        positions.add(position)
        if slot.court_id not in court_ids or not 1 <= slot.section_no <= used_sections:
            diagnostics.append(
                _diagnostic(
                    "SAME_RANK_SLOT_OUT_OF_RANGE",
                    "同順位リーグのスロットが利用可能範囲外です。",
                    section_no=slot.section_no,
                    court_id=slot.court_id,
                )
            )
        if slot.match_id is None:
            if slot.referee_assignment is not None:
                diagnostics.append(
                    _diagnostic(
                        "SAME_RANK_EMPTY_SLOT_HAS_REFEREE",
                        "未使用スロットに審判が割り当てられています。",
                    )
                )
            continue
        occupied_ids.append(slot.match_id)
        slot_by_match[slot.match_id] = slot
        if slot.match_id not in expected_by_id or slot.referee_assignment is None:
            diagnostics.append(
                _diagnostic(
                    "SAME_RANK_MATCH_ASSIGNMENT_INVALID",
                    "未定義の試合または審判なしの試合が配置されています。",
                    match_id=slot.match_id,
                )
            )
    expected_positions = {
        (section_no, court.id)
        for section_no in range(1, used_sections + 1)
        for court in data.courts
    }
    if positions != expected_positions or len(result.slots) != len(expected_positions):
        diagnostics.append(
            _diagnostic(
                "SAME_RANK_SLOT_GRID_INVALID",
                "使用セクションの全コートに、未使用枠を含むスロットを記録してください。",
            )
        )
    expected_ids = set(expected_by_id)
    if set(occupied_ids) != expected_ids or len(occupied_ids) != len(set(occupied_ids)):
        diagnostics.append(
            _diagnostic(
                "SAME_RANK_MATCH_ASSIGNMENT_INVALID",
                "同順位リーグの全試合がちょうど1回ずつ配置されていません。",
                expected_match_count=len(expected_ids),
                scheduled_match_count=len(occupied_ids),
            )
        )

    team_by_rank = {
        (participant.entry.block_id, participant.entry.rank): (
            participant.team.team_id if participant.team is not None else None
        )
        for group in data.same_rank_plan.groups
        for participant in group.participants
    }
    roles: dict[_RankKey, list[tuple[int, str, str, str]]] = defaultdict(list)
    match_sections: dict[_RankKey, list[int]] = defaultdict(list)
    organizer_by_section: Counter[int] = Counter()
    fallback_count = 0
    organizer_count = 0
    expected_routes: set[tuple[_RankKey, str, str, int, str]] = set()
    for match_id, raw_slot in slot_by_match.items():
        if match_id not in expected_by_id:
            continue
        slot = raw_slot
        match = expected_by_id[match_id]
        participant_keys = (
            (match.home.block_id, match.home.rank),
            (match.away.block_id, match.away.rank),
        )
        for rank_key in participant_keys:
            roles[rank_key].append((slot.section_no, slot.court_id, "match", match_id))
            match_sections[rank_key].append(slot.section_no)
            expected_routes.add((rank_key, "match", match_id, slot.section_no, slot.court_id))
        assignment = slot.referee_assignment
        if assignment is None:
            continue
        if assignment.kind is RefereeKind.ORGANIZER:
            organizer_count += 1
            organizer_by_section[slot.section_no] += 1
            if slot.section_no == 1 and assignment.organizer_reason != "first_section":
                diagnostics.append(
                    _diagnostic(
                        "SAME_RANK_FIRST_SECTION_REFEREE_INVALID",
                        "第1セクションの試合は主催者審判にしてください。",
                        match_id=match_id,
                    )
                )
            if slot.section_no > 1:
                fallback_count += 1
                if (
                    data.referees.day2_fallback.value == "strict"
                    or assignment.organizer_reason != "fallback"
                    or not assignment.fallback_reasons
                ):
                    diagnostics.append(
                        _diagnostic(
                            "SAME_RANK_FALLBACK_INVALID",
                            "主催者審判への切替方針または理由が正しくありません。",
                            match_id=match_id,
                        )
                    )
            continue
        if assignment.rank_ref is None:
            diagnostics.append(
                _diagnostic(
                    "SAME_RANK_REFEREE_SOURCE_MISSING",
                    "チーム審判の予選順位枠が記録されていません。",
                    match_id=match_id,
                )
            )
            continue
        rank_key = (assignment.rank_ref.block_id, assignment.rank_ref.rank)
        if rank_key not in team_by_rank or rank_key in participant_keys:
            diagnostics.append(
                _diagnostic(
                    "SAME_RANK_REFEREE_CONFLICT",
                    "対戦中または未定義の順位枠を審判へ割り当てています。",
                    match_id=match_id,
                )
            )
            continue
        if assignment.team_id != team_by_rank[rank_key]:
            diagnostics.append(
                _diagnostic(
                    "SAME_RANK_REFEREE_ANNOTATION_INVALID",
                    "審判順位枠と確定チーム注記が一致しません。",
                    match_id=match_id,
                )
            )
        roles[rank_key].append((slot.section_no, slot.court_id, "referee", match_id))
        expected_routes.add((rank_key, "referee", match_id, slot.section_no, slot.court_id))

    if any(count > data.referees.organizer_capacity for count in organizer_by_section.values()):
        diagnostics.append(
            _diagnostic(
                "ORGANIZER_CAPACITY_INSUFFICIENT",
                "同一セクションの主催者審判数が上限を超えています。",
            )
        )
    first_matches = [slot for slot in result.slots if slot.section_no == 1 and slot.match_id]
    if first_matches and any(
        slot.referee_assignment is None or slot.referee_assignment.kind is not RefereeKind.ORGANIZER
        for slot in first_matches
    ):
        diagnostics.append(
            _diagnostic(
                "SAME_RANK_FIRST_SECTION_REFEREE_INVALID",
                "第1セクションの全試合を主催者審判にしてください。",
            )
        )

    for rank_key, entries in roles.items():
        section_counts = Counter(section for section, _, _, _ in entries)
        if any(count > 1 for count in section_counts.values()):
            diagnostics.append(
                _diagnostic(
                    "SAME_RANK_ROLE_CONFLICT",
                    "同じ順位枠が同一セクションで複数の役割を担当しています。",
                    rank_ref=f"{rank_key[0]}:{rank_key[1]}",
                )
            )
        ordered = sorted(entries)
        for left, right in pairwise(ordered):
            if right[0] == left[0] + 1 and right[1] != left[1]:
                diagnostics.append(
                    _diagnostic(
                        "SAME_RANK_ADJACENT_COURT_CHANGE",
                        "連続セクションの試合・審判は同じコートへ配置してください。",
                        rank_ref=f"{rank_key[0]}:{rank_key[1]}",
                    )
                )
        sections = sorted(match_sections[rank_key])
        if any(right == left + 1 for left, right in pairwise(sections)):
            diagnostics.append(
                _diagnostic(
                    "SAME_RANK_CONSECUTIVE_MATCH",
                    "同じ順位枠の試合が連続セクションに配置されています。",
                    rank_ref=f"{rank_key[0]}:{rank_key[1]}",
                )
            )

    actual_route_entries = [
        (
            (route.rank_ref.block_id, route.rank_ref.rank),
            route.role,
            route.match_id,
            route.section_no,
            route.court_id,
        )
        for route in result.team_schedules
    ]
    actual_routes = set(actual_route_entries)
    if actual_routes != expected_routes or len(actual_route_entries) != len(actual_routes):
        diagnostics.append(
            _diagnostic(
                "SAME_RANK_TEAM_SCHEDULE_INVALID",
                "順位枠別予定に不足、重複または矛盾があります。",
            )
        )
    for route in result.team_schedules:
        rank_key = (route.rank_ref.block_id, route.rank_ref.rank)
        if route.team_id != team_by_rank.get(rank_key):
            diagnostics.append(
                _diagnostic(
                    "SAME_RANK_TEAM_ANNOTATION_INVALID",
                    "順位枠別予定の確定チーム注記が一致しません。",
                )
            )

    try:
        maximum_sections = resolve_max_sections(data.day, min(128, max(1, len(expected_matches))))
        if used_sections > maximum_sections:
            diagnostics.append(
                _diagnostic(
                    "SAME_RANK_SECTION_LIMIT_EXCEEDED",
                    "同順位リーグの日程が指定された終了時刻または最大セクション数を超えています。",
                    used_sections=used_sections,
                    maximum_sections=maximum_sections,
                )
            )
        expected_timings = section_timings(data.day, used_sections)
        expected_end = expected_end_time(data.day, used_sections)
        if result.section_timings != expected_timings or result.expected_end_time != expected_end:
            diagnostics.append(
                _diagnostic(
                    "SAME_RANK_TIMING_INVALID",
                    "セクション時刻または終了予定時刻が設定と一致しません。",
                )
            )
    except DayTimingError:
        diagnostics.append(
            _diagnostic(
                "SAME_RANK_TIMING_INVALID",
                "セクション時刻を検証できませんでした。",
            )
        )

    _validate_metrics(
        data,
        result,
        roles,
        match_sections,
        organizer_count,
        fallback_count,
        diagnostics,
    )
    return SameRankValidationReport(
        valid=not diagnostics,
        diagnostics=tuple(diagnostics),
        summary=SameRankValidationSummary(
            expected_match_count=len(expected_ids),
            scheduled_match_count=len(occupied_ids),
            used_sections=used_sections,
            organizer_referee_count=organizer_count,
            fallback_count=fallback_count,
            error_count=len(diagnostics),
        ),
    )


def _validate_metrics(
    request: SameRankDay2ScheduleRequest,
    result: SameRankDay2Schedule,
    roles: Mapping[_RankKey, list[tuple[int, str, str, str]]],
    match_sections: Mapping[_RankKey, list[int]],
    organizer_count: int,
    fallback_count: int,
    diagnostics: list[Diagnostic],
) -> None:
    referee_counts = Counter(
        (route.rank_ref.block_id, route.rank_ref.rank)
        for route in result.team_schedules
        if route.role == "referee"
    )
    all_rank_keys = {
        (participant.entry.block_id, participant.entry.rank)
        for group in request.same_rank_plan.groups
        for participant in group.participants
    }
    count_values = [referee_counts[key] for key in all_rank_keys]
    recorded_referee_counts = {
        (item.rank_ref.block_id, item.rank_ref.rank): item for item in result.metrics.referee_counts
    }
    referee_count_records_valid = (
        len(recorded_referee_counts) == len(result.metrics.referee_counts)
        and set(recorded_referee_counts) == all_rank_keys
        and all(
            item.count == referee_counts[key]
            and item.team_id
            == next(
                (
                    participant.team.team_id if participant.team is not None else None
                    for group in request.same_rank_plan.groups
                    for participant in group.participants
                    if (participant.entry.block_id, participant.entry.rank) == key
                ),
                None,
            )
            for key, item in recorded_referee_counts.items()
        )
    )
    maximum_wait = max(
        (
            right - left - 1
            for sections in match_sections.values()
            for left, right in pairwise(sorted(sections))
        ),
        default=0,
    )
    referee_then_match = 0
    gap_moves = 0
    for entries in roles.values():
        for left, right in pairwise(sorted(entries)):
            if left[2] == "referee" and right[2] == "match" and right[0] == left[0] + 1:
                referee_then_match += 1
            if right[0] - left[0] > 1 and right[1] != left[1]:
                gap_moves += 1
    occupied = [slot for slot in result.slots if slot.match_id is not None]
    previous_same_court = 0
    for slot in occupied:
        assignment = slot.referee_assignment
        if assignment is None or assignment.kind is not RefereeKind.TEAM:
            continue
        previous = [
            candidate
            for candidate in occupied
            if candidate.court_id == slot.court_id and candidate.section_no < slot.section_no
        ]
        if not previous or assignment.rank_ref is None:
            continue
        source = max(previous, key=lambda item: item.section_no)
        source_match = next(
            match for match in result.same_rank_matches if match.id == source.match_id
        )
        rank_key = (assignment.rank_ref.block_id, assignment.rank_ref.rank)
        if rank_key in {
            (source_match.home.block_id, source_match.home.rank),
            (source_match.away.block_id, source_match.away.rank),
        }:
            previous_same_court += 1
    court_counts = Counter(slot.court_id for slot in occupied)
    court_values = [court_counts[court.id] for court in request.courts]
    expected = {
        "used_sections": max((slot.section_no for slot in occupied), default=0),
        "referee_count_min": min(count_values, default=0),
        "referee_count_max": max(count_values, default=0),
        "referee_count_difference": max(count_values, default=0) - min(count_values, default=0),
        "maximum_team_wait_sections": maximum_wait,
        "referee_then_match_count": referee_then_match,
        "previous_same_court_referee_count": previous_same_court,
        "gap_court_change_count": gap_moves,
        "court_usage_difference": max(court_values, default=0) - min(court_values, default=0),
        "organizer_referee_count": organizer_count,
        "fallback_count": fallback_count,
        "unused_slot_count": (result.metrics.used_sections or 0) * len(request.courts)
        - len(occupied),
    }
    actual = result.metrics.model_dump(mode="python")
    expected_stage_values = tuple(expected[objective] for objective in _OBJECTIVES)
    stage_values = tuple(stage.value for stage in result.metrics.objective_stages)
    proof_valid = result.metrics.optimality_proven == all(
        stage.optimality_proven for stage in result.metrics.objective_stages
    ) and ((result.status.value == "OPTIMAL") == result.metrics.optimality_proven)
    objective_audit_valid = (
        result.metrics.optimized_objectives == _OBJECTIVES
        and tuple(stage.objective for stage in result.metrics.objective_stages) == _OBJECTIVES
        and stage_values == expected_stage_values
        and proof_valid
    )
    if (
        any(actual.get(name) != value for name, value in expected.items())
        or not referee_count_records_valid
        or not objective_audit_valid
    ):
        diagnostics.append(
            _diagnostic(
                "SAME_RANK_METRICS_INVALID",
                "同順位リーグ日程の監査値が実際の配置と一致しません。",
            )
        )


def _diagnostic(code: str, message: str, **details: int | str) -> Diagnostic:
    normalized: dict[str, int | float | str | bool | list[str]] = dict(details)
    return Diagnostic(code=code, message=message, details=normalized)
