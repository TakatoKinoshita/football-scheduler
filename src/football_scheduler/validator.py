"""生成済みスケジュールをソルバーから独立して検証する。

検証器は Pydantic に依存しない。入力は JSON 互換の辞書、または
``model_dump()`` を持つオブジェクトとして受け付ける。正規形は次の通り。

.. code-block:: python

    {
        "config": {
            "days": {"day1": {"max_sections": 8}},
            "referees": {"organizer_capacity": 3},
        },
        "matches": [{"id": "LG-A-01", "home": ..., "away": ...}],
        "schedule": {
            "slots": [{
                "day_id": "day1",
                "section_no": 1,
                "court_id": "court-a",
                "match_id": "LG-A-01",
                "referee_assignment": {"type": "organizer"},
            }],
        },
        "results": [{"match_id": "LG-A-01", ...}],
    }

未確定参照を含む試合では、参照または試合に ``possible_team_ids`` を
持たせることで、起こり得る全チームを考慮した衝突検査を行える。
``winner_of`` / ``loser_of`` は参照元試合の候補集合からも推論する。
"""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

JsonObject = dict[str, Any]


def validate_schedule(document: Any) -> JsonObject:
    """スケジュールを検証し、JSON互換の検証結果を返す。

    戻り値の ``valid`` は、診断が1件もない場合だけ ``True`` になる。
    診断は安定した機械可読コード、日本語メッセージ、関連情報を持つ。
    """

    data = _to_plain_data(document)
    if not isinstance(data, Mapping):
        return _report(
            [_diagnostic("INVALID_DOCUMENT", "検証対象はオブジェクトである必要があります。")],
            match_count=0,
            slot_count=0,
        )

    matches = _extract_matches(data)
    slots = _extract_slots(data)
    diagnostics: list[JsonObject] = []

    match_ids = [str(match.get("id", "")) for match in matches]
    missing_id_indexes = [index for index, match_id in enumerate(match_ids) if not match_id]
    for index in missing_id_indexes:
        diagnostics.append(
            _diagnostic(
                "MATCH_ID_MISSING",
                "試合にmatch IDがありません。",
                path=f"matches[{index}].id",
            )
        )

    duplicate_definition_ids = sorted(
        match_id for match_id, count in Counter(match_ids).items() if match_id and count > 1
    )
    for match_id in duplicate_definition_ids:
        diagnostics.append(
            _diagnostic(
                "MATCH_ID_DUPLICATED",
                f"match ID「{match_id}」が試合定義内で重複しています。",
                match_id=match_id,
            )
        )

    matches_by_id = {
        str(match["id"]): match
        for match in matches
        if match.get("id") and str(match["id"]) not in duplicate_definition_ids
    }
    candidate_cache: dict[str, frozenset[str]] = {}

    normalized_slots: list[JsonObject] = []
    for index, slot in enumerate(slots):
        normalized = _normalize_slot(slot, index, diagnostics)
        if normalized is not None:
            normalized_slots.append(normalized)

    _validate_match_assignments(
        matches_by_id,
        normalized_slots,
        duplicate_definition_ids,
        diagnostics,
    )
    _validate_slot_uniqueness(normalized_slots, diagnostics)
    _validate_match_conflicts(
        normalized_slots,
        matches_by_id,
        candidate_cache,
        diagnostics,
    )
    _validate_dependencies(
        normalized_slots,
        matches_by_id,
        _day_order(data),
        diagnostics,
    )
    _validate_referees(
        normalized_slots,
        matches_by_id,
        candidate_cache,
        _organizer_capacity(data),
        diagnostics,
    )
    _validate_max_sections(normalized_slots, _max_sections(data), diagnostics)
    _validate_result_match_ids(data, set(matches_by_id), diagnostics)

    return _report(
        diagnostics,
        match_count=len(matches),
        slot_count=len(normalized_slots),
        summary_details=_league_team_referee_summary(data, matches_by_id, normalized_slots),
    )


def validate_day2_schedule(document: Any) -> JsonObject:
    """2日目トーナメント日程を勝敗経路と審判規則を含めて独立検証する。"""

    data = _to_plain_data(document)
    if not isinstance(data, Mapping):
        return _report(
            [_diagnostic("INVALID_DOCUMENT", "検証対象はオブジェクトである必要があります。")],
            match_count=0,
            slot_count=0,
        )
    matches = _extract_matches(data)
    slots = _extract_slots(data)
    diagnostics: list[JsonObject] = []
    match_ids = [str(match.get("id", "")) for match in matches]
    duplicates = sorted(
        match_id for match_id, count in Counter(match_ids).items() if match_id and count > 1
    )
    for index, match_id in enumerate(match_ids):
        if not match_id:
            diagnostics.append(
                _diagnostic(
                    "MATCH_ID_MISSING",
                    "試合にmatch IDがありません。",
                    path=f"matches[{index}].id",
                )
            )
    for match_id in duplicates:
        diagnostics.append(
            _diagnostic(
                "MATCH_ID_DUPLICATED",
                f"match ID「{match_id}」が試合定義内で重複しています。",
                match_id=match_id,
            )
        )
    matches_by_id = {
        str(match["id"]): match
        for match in matches
        if match.get("id") and str(match["id"]) not in duplicates
    }
    normalized_slots: list[JsonObject] = []
    for index, slot in enumerate(slots):
        normalized = _normalize_slot(slot, index, diagnostics)
        if normalized is not None:
            normalized_slots.append(normalized)
    _validate_match_assignments(matches_by_id, normalized_slots, duplicates, diagnostics)
    _validate_slot_uniqueness(normalized_slots, diagnostics)

    try:
        paths = _independent_tournament_paths(data, matches_by_id)
    except ValueError as exc:
        diagnostics.append(
            _diagnostic(
                "TOURNAMENT_REFERENCE_INVALID",
                "トーナメントの勝敗参照を独立検証できませんでした。",
                reason=str(exc)[:200],
            )
        )
        paths = {}
    if paths:
        _validate_path_aware_match_conflicts(normalized_slots, matches_by_id, paths, diagnostics)
        _validate_day2_dependencies(normalized_slots, matches_by_id, diagnostics)
        _validate_day2_referees(data, normalized_slots, matches_by_id, paths, diagnostics)
    _validate_day2_timing(data, normalized_slots, diagnostics)
    _validate_max_sections(normalized_slots, _max_sections(data), diagnostics)
    summary = _day2_summary(data, matches_by_id, normalized_slots)
    _validate_day2_metrics(data, summary, diagnostics)
    return _report(
        diagnostics,
        match_count=len(matches),
        slot_count=len(normalized_slots),
        summary_details=summary,
    )


def _validate_day2_timing(
    data: Mapping[str, Any],
    slots: Sequence[Mapping[str, Any]],
    diagnostics: list[JsonObject],
) -> None:
    config = _config(data)
    days = config.get("days")
    day = days.get("day2") if isinstance(days, Mapping) else None
    schedule = data.get("schedule")
    if not isinstance(day, Mapping) or not isinstance(schedule, Mapping):
        return
    start = _clock_minutes(day.get("start_time"))
    duration = day.get("game_duration_minutes")
    margin = day.get("margin_minutes")
    if (
        start is None
        or not isinstance(duration, int)
        or isinstance(duration, bool)
        or duration <= 0
        or not isinstance(margin, int)
        or isinstance(margin, bool)
        or margin < 0
    ):
        diagnostics.append(
            _diagnostic(
                "SCHEDULE_TIMING_MISMATCH",
                "2日目の時刻設定を独立検証できませんでした。",
            )
        )
        return
    breaks: dict[int, int] = {}
    raw_breaks = day.get("breaks")
    if isinstance(raw_breaks, Sequence) and not isinstance(raw_breaks, (str, bytes, bytearray)):
        for item in raw_breaks:
            if not isinstance(item, Mapping):
                continue
            section = item.get("after_section")
            minutes = item.get("duration_minutes")
            if isinstance(section, int) and isinstance(minutes, int):
                breaks[section] = minutes
    used = max((int(slot["section_no"]) for slot in slots if slot.get("match_id")), default=0)
    timings = _as_mapping_list(schedule.get("section_timings"))
    by_section = {
        int(item["section_no"]): item for item in timings if isinstance(item.get("section_no"), int)
    }
    if len(timings) != used or len(by_section) != used:
        diagnostics.append(
            _diagnostic(
                "SCHEDULE_TIMING_MISMATCH",
                "使用セクション数と2日目の時刻一覧が一致しません。",
                used_sections=used,
                timing_count=len(timings),
            )
        )
        return
    for section in range(1, used + 1):
        expected_start = (
            start
            + (section - 1) * (duration + margin)
            + sum(minutes for after, minutes in breaks.items() if after < section)
        )
        timing = by_section.get(section)
        if (
            timing is None
            or timing.get("day_id") != "day2"
            or _clock_minutes(timing.get("start_time")) != expected_start
            or _clock_minutes(timing.get("match_end_time")) != expected_start + duration
            or timing.get("break_after_minutes", 0) != breaks.get(section, 0)
        ):
            diagnostics.append(
                _diagnostic(
                    "SCHEDULE_TIMING_MISMATCH",
                    f"2日目の第{section}セクションの時刻が設定と一致しません。",
                    section_no=section,
                )
            )
    expected_end = None if used == 0 else _clock_minutes(by_section[used].get("match_end_time"))
    supplied_end = schedule.get("expected_end_time")
    if (supplied_end is None) != (expected_end is None) or (
        supplied_end is not None and _clock_minutes(supplied_end) != expected_end
    ):
        diagnostics.append(
            _diagnostic(
                "SCHEDULE_TIMING_MISMATCH",
                "2日目の終了予定時刻が最終セクションと一致しません。",
            )
        )
    configured_end = _clock_minutes(day.get("end_time"))
    if configured_end is not None and expected_end is not None and expected_end > configured_end:
        diagnostics.append(
            _diagnostic(
                "DAY_END_TIME_EXCEEDED",
                "2日目の日程が設定した終了時刻を超えています。",
            )
        )


def _clock_minutes(value: Any) -> int | None:
    if hasattr(value, "hour") and hasattr(value, "minute"):
        return int(value.hour) * 60 + int(value.minute)
    if not isinstance(value, str):
        return None
    parts = value.split(":")
    if len(parts) < 2:
        return None
    try:
        hour, minute = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    return hour * 60 + minute if 0 <= hour <= 23 and 0 <= minute <= 59 else None


def _independent_tournament_paths(
    data: Mapping[str, Any], matches_by_id: Mapping[str, Mapping[str, Any]]
) -> dict[str, dict[str, frozenset[frozenset[str]]]]:
    plan = data.get("tournament_plan")
    if not isinstance(plan, Mapping):
        config = _config(data)
        plan = config.get("tournament_plan")
    ranks: dict[tuple[str, int], str] = {}
    known_teams: set[str] = set()
    if isinstance(plan, Mapping):
        for pool_name in ("upper", "lower"):
            pool = plan.get(pool_name)
            if not isinstance(pool, Mapping):
                continue
            for seed in _as_mapping_list(pool.get("seeds")):
                block_id, rank, team_id = (
                    seed.get("block_id"),
                    seed.get("block_rank"),
                    seed.get("team_id"),
                )
                if (
                    block_id not in (None, "")
                    and isinstance(rank, int)
                    and team_id
                    not in (
                        None,
                        "",
                    )
                ):
                    ranks[str(block_id), rank] = str(team_id)
                    known_teams.add(str(team_id))
    for team in _as_mapping_list(_config(data).get("teams")):
        if team.get("id") not in (None, ""):
            known_teams.add(str(team["id"]))

    cache: dict[str, dict[str, frozenset[frozenset[str]]]] = {}
    visiting: set[str] = set()

    def entry_paths(entry: Any) -> dict[str, frozenset[frozenset[str]]]:
        if not isinstance(entry, Mapping):
            raise ValueError("entryがオブジェクトではありません")
        kind = str(entry.get("type", "")).lower().replace("-", "_")
        if kind in {"concrete_team", "concrete", "team"}:
            team_id = entry.get("team_id", entry.get("id"))
            if team_id in (None, "") or str(team_id) not in known_teams:
                raise ValueError("未登録チーム参照があります")
            return {str(team_id): frozenset({frozenset()})}
        if kind == "league_rank":
            block_id, rank = entry.get("block_id"), entry.get("rank")
            team_id = ranks.get((str(block_id), rank)) if isinstance(rank, int) else None
            if team_id is None:
                raise ValueError("存在しないリーグ順位参照があります")
            return {team_id: frozenset({frozenset()})}
        if kind in {"winner_of", "loser_of"}:
            source_id = entry.get("match_id", entry.get("source_match_id"))
            if source_id in (None, ""):
                raise ValueError("勝敗参照にmatch IDがありません")
            outcome = "W" if kind == "winner_of" else "L"
            source = match_paths(str(source_id))
            return {
                team_id: frozenset(
                    condition | {f"{outcome}:{source_id}"} for condition in conditions
                )
                for team_id, conditions in source.items()
            }
        raise ValueError("未対応のentry種別です")

    def match_paths(match_id: str) -> dict[str, frozenset[frozenset[str]]]:
        if match_id in cache:
            return cache[match_id]
        if match_id in visiting:
            raise ValueError("試合依存関係が循環しています")
        match = matches_by_id.get(match_id)
        if match is None:
            raise ValueError("未定義の試合参照があります")
        visiting.add(match_id)
        home, away = entry_paths(match.get("home")), entry_paths(match.get("away"))
        for team_id in set(home) & set(away):
            if any(
                _independent_conditions_compatible(left, right)
                for left in home[team_id]
                for right in away[team_id]
            ):
                raise ValueError("同じチームが対戦の両側へ入る経路があります")
        merged = {
            team_id: frozenset((*home.get(team_id, ()), *away.get(team_id, ())))
            for team_id in set(home) | set(away)
        }
        visiting.remove(match_id)
        cache[match_id] = merged
        return merged

    for match_id in matches_by_id:
        match_paths(match_id)
    return cache


def _validate_path_aware_match_conflicts(
    slots: Sequence[Mapping[str, Any]],
    matches_by_id: Mapping[str, Mapping[str, Any]],
    paths: Mapping[str, Mapping[str, frozenset[frozenset[str]]]],
    diagnostics: list[JsonObject],
) -> None:
    by_section: defaultdict[tuple[str, int], list[Mapping[str, Any]]] = defaultdict(list)
    for slot in slots:
        if slot.get("match_id") in matches_by_id:
            by_section[str(slot["day_id"]), int(slot["section_no"])].append(slot)
    for (day_id, section), section_slots in sorted(by_section.items()):
        for left_index, left in enumerate(section_slots):
            for right in section_slots[left_index + 1 :]:
                left_id, right_id = str(left["match_id"]), str(right["match_id"])
                conflict = _independent_paths_overlap(paths[left_id], paths[right_id])
                if conflict:
                    diagnostics.append(
                        _diagnostic(
                            "TEAM_SAME_SECTION_CONFLICT",
                            f"{day_id}の第{section}セクションで、同じチームが複数試合へ進む勝敗経路があります。",
                            match_ids=[left_id, right_id],
                            possible_team_ids=sorted(conflict),
                        )
                    )
    for (day_id, section), earlier_slots in sorted(by_section.items()):
        for earlier in earlier_slots:
            for later in by_section.get((day_id, section + 1), []):
                earlier_id, later_id = str(earlier["match_id"]), str(later["match_id"])
                conflict = _independent_paths_overlap(paths[earlier_id], paths[later_id])
                if conflict:
                    diagnostics.append(
                        _diagnostic(
                            "TEAM_CONSECUTIVE_SECTION_CONFLICT",
                            f"{day_id}の連続セクションで同じチームが試合をする勝敗経路があります。",
                            section_nos=[section, section + 1],
                            match_ids=[earlier_id, later_id],
                            possible_team_ids=sorted(conflict),
                        )
                    )


def _validate_day2_dependencies(
    slots: Sequence[Mapping[str, Any]],
    matches_by_id: Mapping[str, Mapping[str, Any]],
    diagnostics: list[JsonObject],
) -> None:
    positions = {
        str(slot["match_id"]): slot for slot in slots if slot.get("match_id") in matches_by_id
    }
    preliminary_positions = [
        positions[match_id]
        for match_id, match in matches_by_id.items()
        if bool(match.get("preliminary")) and match_id in positions
    ]
    for match_id, match in matches_by_id.items():
        target = positions.get(match_id)
        if target is None:
            continue
        dependencies = _string_set(match.get("prerequisite_match_ids")) | _dependency_ids(match)
        for dependency_id in dependencies:
            source = positions.get(dependency_id)
            if source is None:
                continue
            gap = int(target["section_no"]) - int(source["section_no"])
            if gap < 2:
                diagnostics.append(
                    _diagnostic(
                        "DEPENDENCY_REST_VIOLATION",
                        f"試合「{dependency_id}」と後続試合「{match_id}」の間に完全な休憩セクションがありません。",
                        match_id=match_id,
                        dependency_match_id=dependency_id,
                        section_gap=gap,
                    )
                )
        if not bool(match.get("preliminary")):
            for preliminary in preliminary_positions:
                if int(target["section_no"]) <= int(preliminary["section_no"]):
                    diagnostics.append(
                        _diagnostic(
                            "PRELIMINARY_BARRIER_VIOLATION",
                            "全予備戦が終わる前に本戦が開始されています。",
                            match_id=match_id,
                        )
                    )
                    break


def _validate_day2_referees(
    data: Mapping[str, Any],
    slots: Sequence[Mapping[str, Any]],
    matches_by_id: Mapping[str, Mapping[str, Any]],
    paths: Mapping[str, Mapping[str, frozenset[frozenset[str]]]],
    diagnostics: list[JsonObject],
) -> None:
    occupied = [slot for slot in slots if slot.get("match_id") in matches_by_id]
    by_section: defaultdict[int, list[Mapping[str, Any]]] = defaultdict(list)
    by_court: defaultdict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for slot in occupied:
        by_section[int(slot["section_no"])].append(slot)
        by_court[str(slot["court_id"])].append(slot)
    for court_slots in by_court.values():
        court_slots.sort(key=lambda item: int(item["section_no"]))
    capacity = _organizer_capacity(data)
    fallback = _tournament_fallback(data)
    for section, section_slots in sorted(by_section.items()):
        organizer_count = sum(
            _referee_with_source(slot)[0] == "organizer" for slot in section_slots
        )
        if capacity is not None and organizer_count > capacity:
            diagnostics.append(
                _diagnostic(
                    "ORGANIZER_CAPACITY_EXCEEDED",
                    f"day2の第{section}セクションで主催者審判が{organizer_count}件必要ですが、上限は{capacity}件です。",
                    section_no=section,
                    required=organizer_count,
                    capacity=capacity,
                )
            )

    source_use: Counter[tuple[int, str]] = Counter()
    referee_paths_by_section: defaultdict[int, list[Mapping[str, frozenset[frozenset[str]]]]] = (
        defaultdict(list)
    )
    for slot in sorted(occupied, key=lambda item: (int(item["section_no"]), str(item["court_id"]))):
        match_id = str(slot["match_id"])
        match = matches_by_id[match_id]
        section = int(slot["section_no"])
        kind, source_id, reason, supplied_reasons = _referee_with_source(slot)
        required_reason = (
            "first_section"
            if section == 1
            else "tournament_final"
            if bool(match.get("final"))
            else None
        )
        if required_reason is not None:
            if kind != "organizer" or reason not in {None, required_reason}:
                diagnostics.append(
                    _diagnostic(
                        "TOURNAMENT_ORGANIZER_REFEREE_REQUIRED",
                        "第1セクションと各トーナメント決勝は主催者審判にしてください。",
                        match_id=match_id,
                        required_reason=required_reason,
                    )
                )
            continue
        previous = max(
            (item for item in by_court[str(slot["court_id"])] if int(item["section_no"]) < section),
            key=lambda item: int(item["section_no"]),
            default=None,
        )
        expected_source = None if previous is None else str(previous["match_id"])
        expected_reasons: list[str] = []
        if expected_source is None:
            expected_reasons.append("no_previous_match")
        else:
            source_paths = _independent_add_outcome(paths[expected_source], expected_source, "W")
            if _independent_paths_overlap(source_paths, paths[match_id]):
                expected_reasons.append("source_may_play_target")
            if any(
                _independent_paths_overlap(source_paths, paths[str(other["match_id"])])
                for other in by_section[section]
                if other is not slot
            ):
                expected_reasons.append("source_may_have_same_section_role")
            if source_use[section, expected_source] > 0:
                expected_reasons.append("source_used_twice_in_section")
            if any(
                _independent_paths_overlap(source_paths, assigned_paths)
                for assigned_paths in referee_paths_by_section[section]
            ):
                expected_reasons.append("source_may_referee_twice_in_section")
        if expected_reasons:
            if kind != "organizer" or reason != "fallback":
                diagnostics.append(
                    _diagnostic(
                        "TOURNAMENT_REFEREE_SOURCE_CONFLICT",
                        "直前試合の勝者を安全に審判へ割り当てられません。",
                        match_id=match_id,
                        expected_reasons=expected_reasons,
                    )
                )
            elif set(supplied_reasons) != set(expected_reasons):
                diagnostics.append(
                    _diagnostic(
                        "TOURNAMENT_REFEREE_FALLBACK_REASON_MISMATCH",
                        "主催者へ切り替えた理由が独立集計と一致しません。",
                        match_id=match_id,
                        expected_reasons=expected_reasons,
                        actual_reasons=list(supplied_reasons),
                    )
                )
            if fallback == "strict":
                diagnostics.append(
                    _diagnostic(
                        "TOURNAMENT_STRICT_FALLBACK_FORBIDDEN",
                        "厳格モードでは主催者へのフォールバックを利用できません。",
                        match_id=match_id,
                    )
                )
            continue
        if kind != "team" or source_id != expected_source:
            diagnostics.append(
                _diagnostic(
                    "TOURNAMENT_PREVIOUS_WINNER_REFEREE_REQUIRED",
                    "同じコートの直前の実試合の勝者を審判へ割り当ててください。",
                    match_id=match_id,
                    expected_source_match_id=expected_source,
                )
            )
        elif source_id is not None:
            source_use[section, source_id] += 1
            referee_paths_by_section[section].append(
                _independent_add_outcome(paths[source_id], source_id, "W")
            )


def _day2_summary(
    data: Mapping[str, Any],
    matches_by_id: Mapping[str, Mapping[str, Any]],
    slots: Sequence[Mapping[str, Any]],
) -> JsonObject:
    occupied = [slot for slot in slots if slot.get("match_id") in matches_by_id]
    used_sections = max((int(slot["section_no"]) for slot in occupied), default=0)
    organizer = 0
    fallback = 0
    for slot in occupied:
        kind, _source, reason, _reasons = _referee_with_source(slot)
        organizer += kind == "organizer"
        fallback += reason == "fallback"
    court_ids = [
        str(court["id"])
        for court in _as_mapping_list(_config(data).get("courts"))
        if court.get("id") not in (None, "")
    ]
    court_counts = Counter(str(slot["court_id"]) for slot in occupied)
    counts = [court_counts[court_id] for court_id in court_ids]
    positions = {str(slot["match_id"]): slot for slot in occupied}
    waits: list[int] = []
    for match_id, match in matches_by_id.items():
        target = positions.get(match_id)
        if target is None:
            continue
        for dependency in _string_set(match.get("prerequisite_match_ids")) | _dependency_ids(match):
            source = positions.get(dependency)
            if source is not None:
                waits.append(int(target["section_no"]) - int(source["section_no"]) - 1)
    dependency_court_changes = 0
    for match_id, match in matches_by_id.items():
        target = positions.get(match_id)
        if target is None:
            continue
        dependencies = _string_set(match.get("prerequisite_match_ids")) | _dependency_ids(match)
        dependency_court_changes += sum(
            positions.get(dependency) is not None
            and str(positions[dependency]["court_id"]) != str(target["court_id"])
            for dependency in dependencies
        )

    routes: defaultdict[str, list[tuple[str, int, str, str, frozenset[str]]]] = defaultdict(list)
    try:
        paths = _independent_tournament_paths(data, matches_by_id)
    except ValueError:
        paths = {}
    for slot in occupied:
        match_id = str(slot["match_id"])
        for team_id, conditions in paths.get(match_id, {}).items():
            for condition in conditions:
                routes[team_id].append(
                    (
                        "match",
                        int(slot["section_no"]),
                        str(slot["court_id"]),
                        match_id,
                        condition,
                    )
                )
        kind, source_id, _reason, _reasons = _referee_with_source(slot)
        if kind != "team" or source_id is None or source_id not in paths:
            continue
        for team_id, conditions in _independent_add_outcome(
            paths[source_id], source_id, "W"
        ).items():
            for condition in conditions:
                routes[team_id].append(
                    (
                        "referee",
                        int(slot["section_no"]),
                        str(slot["court_id"]),
                        match_id,
                        condition,
                    )
                )
    referee_then_match: set[tuple[str, str, str]] = set()
    adjacent_moves: set[tuple[str, str, str]] = set()
    for team_id, entries in routes.items():
        for left in entries:
            for right in entries:
                if right[1] != left[1] + 1:
                    continue
                if not _independent_conditions_compatible(left[4], right[4]):
                    continue
                if left[0] == "referee" and right[0] == "match":
                    referee_then_match.add((team_id, left[3], right[3]))
                if left[2] != right[2]:
                    adjacent_moves.add((team_id, left[3], right[3]))
    return {
        **_day1_fixed_objective_summary(data),
        "used_sections": used_sections,
        "maximum_team_wait_sections": max(waits, default=0),
        "organizer_referee_count": organizer,
        "tournament_team_referee_count": len(occupied) - organizer,
        "tournament_referee_fallback_count": fallback,
        "referee_then_match_count": len(referee_then_match),
        "adjacent_assignment_court_change_count": len(adjacent_moves),
        "team_court_change_count": dependency_court_changes,
        "court_usage_difference": max(counts, default=0) - min(counts, default=0),
        "unused_slot_count": len(slots) - len(occupied),
    }


def _day1_fixed_objective_summary(data: Mapping[str, Any]) -> JsonObject:
    """2日目で変更しないリーグ審判目的を、1日目スロットから再集計する。"""

    team_ids = sorted(
        str(team["id"])
        for team in _as_mapping_list(_config(data).get("teams"))
        if team.get("id") not in (None, "")
    )
    counts = {team_id: 0 for team_id in team_ids}
    league_plan = data.get("league_plan")
    raw_matches = league_plan.get("matches") if isinstance(league_plan, Mapping) else None
    match_teams: dict[str, set[str]] = {}
    for match in _as_mapping_list(raw_matches):
        match_id = match.get("id")
        if match_id in (None, ""):
            continue
        match_teams[str(match_id)] = {
            *(_string_set(match.get("possible_home_team_ids"))),
            *(_string_set(match.get("possible_away_team_ids"))),
        }
    source = data.get("day1_schedule")
    source_slots = source.get("slots") if isinstance(source, Mapping) else None
    slots = _as_mapping_list(source_slots)
    by_position = {
        (slot.get("section_no"), str(slot.get("court_id"))): slot
        for slot in slots
        if isinstance(slot.get("section_no"), int) and slot.get("court_id") not in (None, "")
    }
    previous_same_court = 0
    for slot in slots:
        match_id = str(slot.get("match_id", ""))
        if match_id not in match_teams:
            continue
        assignment = slot.get("referee_assignment", slot.get("referee"))
        if not isinstance(assignment, Mapping):
            continue
        kind = assignment.get("kind", assignment.get("type"))
        team_id = assignment.get("team_id")
        if kind != "team" or team_id in (None, "") or str(team_id) not in counts:
            continue
        referee_team_id = str(team_id)
        counts[referee_team_id] += 1
        section = slot.get("section_no")
        court_id = str(slot.get("court_id"))
        if not isinstance(section, int):
            continue
        previous = by_position.get((section - 1, court_id))
        previous_match_id = (
            str(previous.get("match_id", "")) if isinstance(previous, Mapping) else ""
        )
        if referee_team_id in match_teams.get(previous_match_id, set()):
            previous_same_court += 1
    values = list(counts.values())
    minimum = min(values, default=0)
    maximum = max(values, default=0)
    return {
        "league_team_referee_counts": [
            {"team_id": team_id, "count": counts[team_id]} for team_id in team_ids
        ],
        "league_team_referee_count_min": minimum,
        "league_team_referee_count_max": maximum,
        "league_team_referee_count_difference": maximum - minimum,
        "league_previous_same_court_referee_count": previous_same_court,
    }


def _validate_day2_metrics(
    data: Mapping[str, Any], summary: Mapping[str, Any], diagnostics: list[JsonObject]
) -> None:
    metrics = data.get("metrics")
    if metrics is None:
        schedule = data.get("schedule")
        if isinstance(schedule, Mapping):
            metrics = schedule.get("metrics")
    if not isinstance(metrics, Mapping):
        return
    for key in (
        "league_team_referee_counts",
        "league_team_referee_count_min",
        "league_team_referee_count_max",
        "league_team_referee_count_difference",
        "league_previous_same_court_referee_count",
        "used_sections",
        "maximum_team_wait_sections",
        "organizer_referee_count",
        "tournament_team_referee_count",
        "tournament_referee_fallback_count",
        "referee_then_match_count",
        "adjacent_assignment_court_change_count",
        "team_court_change_count",
        "court_usage_difference",
        "unused_slot_count",
    ):
        if key in metrics and metrics[key] != summary[key]:
            diagnostics.append(
                _diagnostic(
                    "SCHEDULE_AUDIT_MISMATCH",
                    "ソルバーの監査値と独立集計が一致しません。",
                    field=key,
                    expected=summary[key],
                    actual=metrics[key],
                )
            )


def _independent_paths_overlap(
    left: Mapping[str, Iterable[frozenset[str]]],
    right: Mapping[str, Iterable[frozenset[str]]],
) -> set[str]:
    return {
        team_id
        for team_id in set(left) & set(right)
        if any(
            _independent_conditions_compatible(left_condition, right_condition)
            for left_condition in left[team_id]
            for right_condition in right[team_id]
        )
    }


def _independent_conditions_compatible(left: frozenset[str], right: frozenset[str]) -> bool:
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


def _independent_add_outcome(
    paths: Mapping[str, frozenset[frozenset[str]]], match_id: str, outcome: str
) -> dict[str, frozenset[frozenset[str]]]:
    return {
        team_id: frozenset(condition | {f"{outcome}:{match_id}"} for condition in conditions)
        for team_id, conditions in paths.items()
    }


def _referee_with_source(
    slot: Mapping[str, Any],
) -> tuple[str | None, str | None, str | None, tuple[str, ...]]:
    assignment = slot.get("referee_assignment", slot.get("referee"))
    if not isinstance(assignment, Mapping):
        return None, None, None, ()
    kind = assignment.get("kind", assignment.get("type"))
    source = assignment.get("source_match_id")
    reason = assignment.get("organizer_reason")
    raw_reasons = assignment.get("fallback_reasons")
    reasons = (
        tuple(str(item) for item in raw_reasons)
        if isinstance(raw_reasons, Sequence)
        and not isinstance(raw_reasons, (str, bytes, bytearray))
        else ()
    )
    return (
        None if kind in (None, "") else str(kind),
        None if source in (None, "") else str(source),
        None if reason in (None, "") else str(reason),
        reasons,
    )


def _tournament_fallback(data: Mapping[str, Any]) -> str:
    referees = _config(data).get("referees")
    if isinstance(referees, Mapping):
        return str(referees.get("tournament_fallback", "organizer"))
    return "organizer"


def _to_plain_data(value: Any) -> Any:
    if hasattr(value, "model_dump") and callable(value.model_dump):
        value = value.model_dump(mode="python")
    if isinstance(value, Mapping):
        return {str(key): _to_plain_data(item) for key, item in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_to_plain_data(item) for item in value]
    return value


def _as_mapping_list(value: Any) -> list[JsonObject]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    return [dict(item) for item in value if isinstance(item, Mapping)]


def _extract_matches(data: Mapping[str, Any]) -> list[JsonObject]:
    direct = _as_mapping_list(data.get("matches"))
    if direct:
        return direct
    for container_name in ("schedule", "result"):
        container = data.get(container_name)
        if isinstance(container, Mapping):
            nested = _as_mapping_list(container.get("matches"))
            if nested:
                return nested
    return []


def _extract_slots(data: Mapping[str, Any]) -> list[JsonObject]:
    direct = _as_mapping_list(data.get("slots"))
    if direct:
        return direct
    schedule = data.get("schedule")
    if isinstance(schedule, Mapping):
        return _as_mapping_list(schedule.get("slots"))
    return []


def _normalize_slot(
    slot: Mapping[str, Any], index: int, diagnostics: list[JsonObject]
) -> JsonObject | None:
    day_id = slot.get("day_id", slot.get("day"))
    section_no = slot.get("section_no", slot.get("section"))
    court_id = slot.get("court_id", slot.get("court"))

    if day_id in (None, "") or court_id in (None, "") or not isinstance(section_no, int):
        diagnostics.append(
            _diagnostic(
                "SCHEDULE_SLOT_INVALID",
                "スロットにはday_id、整数のsection_no、court_idが必要です。",
                path=f"schedule.slots[{index}]",
            )
        )
        return None
    if section_no < 1:
        diagnostics.append(
            _diagnostic(
                "SCHEDULE_SLOT_INVALID",
                "section_noは1以上である必要があります。",
                path=f"schedule.slots[{index}].section_no",
            )
        )
        return None

    return {
        **slot,
        "_index": index,
        "day_id": str(day_id),
        "section_no": section_no,
        "court_id": str(court_id),
        "match_id": None if slot.get("match_id") in (None, "") else str(slot["match_id"]),
    }


def _validate_match_assignments(
    matches_by_id: Mapping[str, Mapping[str, Any]],
    slots: Sequence[Mapping[str, Any]],
    duplicate_definition_ids: Sequence[str],
    diagnostics: list[JsonObject],
) -> None:
    assignments = Counter(
        str(slot["match_id"]) for slot in slots if slot.get("match_id") is not None
    )
    known_ids = set(matches_by_id) | set(duplicate_definition_ids)

    for match_id in sorted(known_ids):
        count = assignments[match_id]
        if count == 0:
            diagnostics.append(
                _diagnostic(
                    "MATCH_NOT_ASSIGNED",
                    f"試合「{match_id}」がスケジュールに配置されていません。",
                    match_id=match_id,
                )
            )
        elif count > 1:
            diagnostics.append(
                _diagnostic(
                    "MATCH_ASSIGNED_MULTIPLE_TIMES",
                    f"試合「{match_id}」が{count}回配置されています。",
                    match_id=match_id,
                    assignment_count=count,
                )
            )

    for match_id in sorted(set(assignments) - known_ids):
        diagnostics.append(
            _diagnostic(
                "UNKNOWN_MATCH_ID",
                f"スケジュールが未定義の試合「{match_id}」を参照しています。",
                match_id=match_id,
            )
        )


def _validate_slot_uniqueness(
    slots: Sequence[Mapping[str, Any]], diagnostics: list[JsonObject]
) -> None:
    by_position: defaultdict[tuple[str, int, str], list[Mapping[str, Any]]] = defaultdict(list)
    for slot in slots:
        by_position[_slot_position(slot)].append(slot)

    for position, occupied in sorted(by_position.items()):
        if len(occupied) <= 1:
            continue
        day_id, section_no, court_id = position
        diagnostics.append(
            _diagnostic(
                "SLOT_OCCUPIED_MULTIPLE_TIMES",
                f"{day_id}の第{section_no}セクション・{court_id}に複数のスロットがあります。",
                day_id=day_id,
                section_no=section_no,
                court_id=court_id,
                match_ids=[slot.get("match_id") for slot in occupied],
            )
        )


def _validate_match_conflicts(
    slots: Sequence[Mapping[str, Any]],
    matches_by_id: Mapping[str, Mapping[str, Any]],
    candidate_cache: dict[str, frozenset[str]],
    diagnostics: list[JsonObject],
) -> None:
    by_section: defaultdict[tuple[str, int], list[Mapping[str, Any]]] = defaultdict(list)
    for slot in slots:
        if slot.get("match_id") in matches_by_id:
            by_section[(str(slot["day_id"]), int(slot["section_no"]))].append(slot)

    for (day_id, section_no), section_slots in sorted(by_section.items()):
        for left_index, left in enumerate(section_slots):
            for right in section_slots[left_index + 1 :]:
                overlap = _slot_candidates(left, matches_by_id, candidate_cache) & _slot_candidates(
                    right, matches_by_id, candidate_cache
                )
                if overlap:
                    diagnostics.append(
                        _diagnostic(
                            "TEAM_SAME_SECTION_CONFLICT",
                            f"{day_id}の第{section_no}セクションで、同じチームが複数試合に出場する可能性があります。",
                            day_id=day_id,
                            section_no=section_no,
                            match_ids=[left["match_id"], right["match_id"]],
                            possible_team_ids=sorted(overlap),
                        )
                    )

    section_keys = set(by_section)
    for day_id, section_no in sorted(section_keys):
        next_key = (day_id, section_no + 1)
        if next_key not in by_section:
            continue
        for earlier in by_section[(day_id, section_no)]:
            for later in by_section[next_key]:
                overlap = _slot_candidates(
                    earlier, matches_by_id, candidate_cache
                ) & _slot_candidates(later, matches_by_id, candidate_cache)
                if overlap:
                    diagnostics.append(
                        _diagnostic(
                            "TEAM_CONSECUTIVE_SECTION_CONFLICT",
                            (
                                f"{day_id}の連続する第{section_no}・"
                                f"第{section_no + 1}セクションで、同じチームが"
                                "試合をする可能性があります。"
                            ),
                            day_id=day_id,
                            section_nos=[section_no, section_no + 1],
                            match_ids=[earlier["match_id"], later["match_id"]],
                            possible_team_ids=sorted(overlap),
                        )
                    )


def _validate_dependencies(
    slots: Sequence[Mapping[str, Any]],
    matches_by_id: Mapping[str, Mapping[str, Any]],
    day_order: Mapping[str, int],
    diagnostics: list[JsonObject],
) -> None:
    positions: dict[str, Mapping[str, Any]] = {}
    for slot in slots:
        match_id = slot.get("match_id")
        if match_id in matches_by_id and match_id not in positions:
            positions[str(match_id)] = slot

    for match_id, match in sorted(matches_by_id.items()):
        consumer = positions.get(match_id)
        if consumer is None:
            continue
        for dependency_id in sorted(_dependency_ids(match)):
            predecessor = positions.get(dependency_id)
            if predecessor is None:
                continue
            same_day = predecessor["day_id"] == consumer["day_id"]
            if same_day:
                gap = int(consumer["section_no"]) - int(predecessor["section_no"])
                if gap <= 0:
                    diagnostics.append(
                        _diagnostic(
                            "DEPENDENCY_ORDER_VIOLATION",
                            f"試合「{match_id}」が前提試合「{dependency_id}」より後に配置されていません。",
                            match_id=match_id,
                            dependency_match_id=dependency_id,
                        )
                    )
                if gap < 2:
                    diagnostics.append(
                        _diagnostic(
                            "DEPENDENCY_REST_VIOLATION",
                            f"試合「{dependency_id}」と後続試合「{match_id}」の間に完全な休憩セクションがありません。",
                            match_id=match_id,
                            dependency_match_id=dependency_id,
                            section_gap=gap,
                        )
                    )
                continue

            predecessor_day = day_order.get(str(predecessor["day_id"]))
            consumer_day = day_order.get(str(consumer["day_id"]))
            if (
                predecessor_day is not None
                and consumer_day is not None
                and predecessor_day >= consumer_day
            ):
                diagnostics.append(
                    _diagnostic(
                        "DEPENDENCY_ORDER_VIOLATION",
                        f"試合「{match_id}」が前提試合「{dependency_id}」より後の日に配置されていません。",
                        match_id=match_id,
                        dependency_match_id=dependency_id,
                    )
                )


def _validate_referees(
    slots: Sequence[Mapping[str, Any]],
    matches_by_id: Mapping[str, Mapping[str, Any]],
    candidate_cache: dict[str, frozenset[str]],
    organizer_capacity: int | None,
    diagnostics: list[JsonObject],
) -> None:
    by_section: defaultdict[tuple[str, int], list[Mapping[str, Any]]] = defaultdict(list)
    for slot in slots:
        by_section[(str(slot["day_id"]), int(slot["section_no"]))].append(slot)

    for (day_id, section_no), section_slots in sorted(by_section.items()):
        organizer_count = sum(1 for slot in section_slots if _referee(slot)[0] == "organizer")
        if organizer_capacity is not None and organizer_count > organizer_capacity:
            diagnostics.append(
                _diagnostic(
                    "ORGANIZER_CAPACITY_EXCEEDED",
                    f"{day_id}の第{section_no}セクションで主催者審判が{organizer_count}件必要ですが、上限は{organizer_capacity}件です。",
                    day_id=day_id,
                    section_no=section_no,
                    required=organizer_count,
                    capacity=organizer_capacity,
                )
            )

        team_referees: defaultdict[str, list[Mapping[str, Any]]] = defaultdict(list)
        for slot in section_slots:
            referee_type, team_id = _referee(slot)
            if referee_type != "team" or team_id is None:
                continue
            team_referees[team_id].append(slot)
            own_candidates = _slot_candidates(slot, matches_by_id, candidate_cache)
            if team_id in own_candidates:
                diagnostics.append(
                    _diagnostic(
                        "REFEREE_TEAM_IS_PARTICIPANT",
                        f"審判チーム「{team_id}」が担当試合に出場する可能性があります。",
                        day_id=day_id,
                        section_no=section_no,
                        match_id=slot.get("match_id"),
                        team_id=team_id,
                    )
                )

            conflicting_matches = sorted(
                {
                    str(other["match_id"])
                    for other in section_slots
                    if other is not slot
                    and other.get("match_id") in matches_by_id
                    and team_id in _slot_candidates(other, matches_by_id, candidate_cache)
                }
            )
            if conflicting_matches:
                diagnostics.append(
                    _diagnostic(
                        "TEAM_ROLE_SAME_SECTION_CONFLICT",
                        f"チーム「{team_id}」が同一セクションで審判と試合の両方を担当する可能性があります。",
                        day_id=day_id,
                        section_no=section_no,
                        referee_match_id=slot.get("match_id"),
                        conflicting_match_ids=conflicting_matches,
                        team_id=team_id,
                    )
                )

        for team_id, assigned in sorted(team_referees.items()):
            if len(assigned) > 1:
                diagnostics.append(
                    _diagnostic(
                        "TEAM_ROLE_SAME_SECTION_CONFLICT",
                        f"チーム「{team_id}」が同一セクションで複数の審判を担当しています。",
                        day_id=day_id,
                        section_no=section_no,
                        referee_match_ids=[slot.get("match_id") for slot in assigned],
                        team_id=team_id,
                    )
                )


def _validate_max_sections(
    slots: Sequence[Mapping[str, Any]],
    max_sections_by_day: Mapping[str, int],
    diagnostics: list[JsonObject],
) -> None:
    for slot in slots:
        maximum = max_sections_by_day.get(str(slot["day_id"]))
        if maximum is None or int(slot["section_no"]) <= maximum:
            continue
        diagnostics.append(
            _diagnostic(
                "MAX_SECTIONS_EXCEEDED",
                f"{slot['day_id']}の第{slot['section_no']}セクションは上限{maximum}を超えています。",
                day_id=slot["day_id"],
                section_no=slot["section_no"],
                max_sections=maximum,
                match_id=slot.get("match_id"),
            )
        )


def _validate_result_match_ids(
    data: Mapping[str, Any], known_match_ids: set[str], diagnostics: list[JsonObject]
) -> None:
    raw_results = data.get("results", data.get("match_results"))
    if raw_results is None:
        return

    entries: list[tuple[str | None, Mapping[str, Any]]] = []
    if isinstance(raw_results, Mapping):
        entries = [
            (str(key), value if isinstance(value, Mapping) else {})
            for key, value in raw_results.items()
        ]
    elif isinstance(raw_results, Sequence) and not isinstance(raw_results, (str, bytes, bytearray)):
        entries = [(None, value if isinstance(value, Mapping) else {}) for value in raw_results]
    else:
        diagnostics.append(
            _diagnostic("RESULTS_INVALID", "resultsは配列またはオブジェクトである必要があります。")
        )
        return

    for index, (mapping_key, result) in enumerate(entries):
        embedded = result.get("match_id")
        if mapping_key is not None and embedded not in (None, "") and mapping_key != str(embedded):
            diagnostics.append(
                _diagnostic(
                    "RESULT_MATCH_ID_MISMATCH",
                    f"結果のキー「{mapping_key}」とmatch ID「{embedded}」が一致しません。",
                    path=f"results[{mapping_key!r}]",
                    key_match_id=mapping_key,
                    embedded_match_id=str(embedded),
                )
            )
        match_id = mapping_key if embedded in (None, "") else str(embedded)
        if match_id is None:
            diagnostics.append(
                _diagnostic(
                    "RESULT_MATCH_ID_MISSING",
                    "試合結果にmatch IDがありません。",
                    path=f"results[{index}]",
                )
            )
        elif match_id not in known_match_ids:
            diagnostics.append(
                _diagnostic(
                    "RESULT_UNKNOWN_MATCH_ID",
                    f"試合結果が未定義の試合「{match_id}」を参照しています。",
                    match_id=match_id,
                )
            )


def _match_candidates(
    match_id: str,
    matches_by_id: Mapping[str, Mapping[str, Any]],
    cache: dict[str, frozenset[str]],
    visiting: frozenset[str] = frozenset(),
) -> frozenset[str]:
    if match_id in cache:
        return cache[match_id]
    if match_id in visiting or match_id not in matches_by_id:
        return frozenset()

    match = matches_by_id[match_id]
    explicit = _string_set(match.get("possible_team_ids"))
    explicit |= _string_set(match.get("candidate_team_ids"))
    for key in ("possible_home_team_ids", "possible_away_team_ids"):
        explicit |= _string_set(match.get(key))

    nested_visiting = visiting | {match_id}
    inferred = set(explicit)
    for side in ("home", "away"):
        inferred.update(
            _reference_candidates(match.get(side), matches_by_id, cache, nested_visiting)
        )
    for key in ("home_team_id", "away_team_id"):
        if match.get(key) not in (None, ""):
            inferred.add(str(match[key]))

    result = frozenset(inferred)
    cache[match_id] = result
    return result


def _reference_candidates(
    reference: Any,
    matches_by_id: Mapping[str, Mapping[str, Any]],
    cache: dict[str, frozenset[str]],
    visiting: frozenset[str],
) -> frozenset[str]:
    if reference in (None, ""):
        return frozenset()
    if isinstance(reference, str):
        return frozenset({reference})
    if not isinstance(reference, Mapping):
        return frozenset()

    candidates = _string_set(reference.get("possible_team_ids"))
    candidates |= _string_set(reference.get("candidate_team_ids"))
    reference_type = str(reference.get("type", "")).lower().replace("-", "_")
    if reference_type in {"concrete_team", "concrete", "team"}:
        team_id = reference.get("team_id", reference.get("id"))
        if team_id not in (None, ""):
            candidates.add(str(team_id))
    elif reference_type in {"winner_of", "loser_of"}:
        source_id = reference.get("match_id", reference.get("source_match_id"))
        if source_id not in (None, ""):
            candidates.update(_match_candidates(str(source_id), matches_by_id, cache, visiting))
    return frozenset(candidates)


def _slot_candidates(
    slot: Mapping[str, Any],
    matches_by_id: Mapping[str, Mapping[str, Any]],
    cache: dict[str, frozenset[str]],
) -> frozenset[str]:
    match_id = slot.get("match_id")
    if match_id not in matches_by_id:
        return frozenset()
    return _match_candidates(str(match_id), matches_by_id, cache)


def _dependency_ids(match: Mapping[str, Any]) -> set[str]:
    dependencies = _string_set(match.get("dependencies"))
    for side in ("home", "away"):
        reference = match.get(side)
        if not isinstance(reference, Mapping):
            continue
        reference_type = str(reference.get("type", "")).lower().replace("-", "_")
        if reference_type not in {"winner_of", "loser_of"}:
            continue
        match_id = reference.get("match_id", reference.get("source_match_id"))
        if match_id not in (None, ""):
            dependencies.add(str(match_id))
    return dependencies


def _referee(slot: Mapping[str, Any]) -> tuple[str | None, str | None]:
    assignment = slot.get("referee_assignment", slot.get("referee"))
    if isinstance(assignment, str):
        if assignment.lower() == "organizer":
            return "organizer", None
        return "team", assignment
    if not isinstance(assignment, Mapping):
        return None, None
    referee_type = str(assignment.get("type", "")).lower().replace("-", "_")
    if referee_type == "organizer":
        return "organizer", None
    if referee_type in {"team", "concrete_team"}:
        team_id = assignment.get("team_id", assignment.get("id"))
        return "team", None if team_id in (None, "") else str(team_id)
    return referee_type or None, None


def _organizer_capacity(data: Mapping[str, Any]) -> int | None:
    config = _config(data)
    referees = config.get("referees")
    capacity = None
    if isinstance(referees, Mapping):
        capacity = referees.get("organizer_capacity")
    if capacity is None:
        capacity = config.get("organizer_capacity")
    if isinstance(capacity, int) and capacity >= 0:
        return capacity
    courts = config.get("courts")
    if isinstance(courts, Sequence) and not isinstance(courts, (str, bytes, bytearray)):
        return len(courts)
    return None


def _max_sections(data: Mapping[str, Any]) -> dict[str, int]:
    days = _config(data).get("days")
    result: dict[str, int] = {}
    if isinstance(days, Mapping):
        for day_id, settings in days.items():
            if isinstance(settings, Mapping) and isinstance(settings.get("max_sections"), int):
                result[str(day_id)] = int(settings["max_sections"])
    elif isinstance(days, Sequence) and not isinstance(days, (str, bytes, bytearray)):
        for settings in days:
            if not isinstance(settings, Mapping):
                continue
            day_id = settings.get("id", settings.get("day_id"))
            maximum = settings.get("max_sections")
            if day_id not in (None, "") and isinstance(maximum, int):
                result[str(day_id)] = maximum
    return result


def _day_order(data: Mapping[str, Any]) -> dict[str, int]:
    days = _config(data).get("days")
    if isinstance(days, Mapping):
        return {str(day_id): index for index, day_id in enumerate(days)}
    if isinstance(days, Sequence) and not isinstance(days, (str, bytes, bytearray)):
        return {
            str(settings.get("id", settings.get("day_id"))): index
            for index, settings in enumerate(days)
            if isinstance(settings, Mapping)
            and settings.get("id", settings.get("day_id")) not in (None, "")
        }
    return {}


def _config(data: Mapping[str, Any]) -> Mapping[str, Any]:
    for key in ("config", "input"):
        value = data.get(key)
        if isinstance(value, Mapping):
            return value
    return data


def _league_team_referee_summary(
    data: Mapping[str, Any],
    matches_by_id: Mapping[str, Mapping[str, Any]],
    slots: Sequence[Mapping[str, Any]],
) -> JsonObject:
    teams = _config(data).get("teams")
    team_ids = {
        str(team["id"]) for team in _as_mapping_list(teams) if team.get("id") not in (None, "")
    }
    league_match_ids = {
        match_id
        for match_id, match in matches_by_id.items()
        if str(match.get("phase", "league")) == "league"
    }
    assigned_counts: Counter[str] = Counter()
    for slot in slots:
        if slot.get("match_id") not in league_match_ids:
            continue
        referee_type, team_id = _referee(slot)
        if referee_type == "team" and team_id is not None:
            assigned_counts[team_id] += 1
            team_ids.add(team_id)

    ordered_team_ids = sorted(team_ids)
    ordered_counts = [
        {"team_id": team_id, "count": assigned_counts[team_id]} for team_id in ordered_team_ids
    ]
    counts = [assigned_counts[team_id] for team_id in ordered_team_ids]
    minimum = min(counts, default=0)
    maximum = max(counts, default=0)
    return {
        "league_team_referee_counts": ordered_counts,
        "league_team_referee_count_min": minimum,
        "league_team_referee_count_max": maximum,
        "league_team_referee_count_difference": maximum - minimum,
    }


def _string_set(value: Any) -> set[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return set()
    return {str(item) for item in value if item not in (None, "")}


def _slot_position(slot: Mapping[str, Any]) -> tuple[str, int, str]:
    return str(slot["day_id"]), int(slot["section_no"]), str(slot["court_id"])


def _diagnostic(code: str, message: str, **details: Any) -> JsonObject:
    diagnostic: JsonObject = {"code": code, "message": message}
    if details:
        diagnostic["details"] = details
    return diagnostic


def _report(
    diagnostics: list[JsonObject],
    *,
    match_count: int,
    slot_count: int,
    summary_details: Mapping[str, Any] | None = None,
) -> JsonObject:
    return {
        "valid": not diagnostics,
        "diagnostics": diagnostics,
        "summary": {
            "checked_match_count": match_count,
            "checked_slot_count": slot_count,
            "error_count": len(diagnostics),
            **({} if summary_details is None else dict(summary_details)),
        },
    }
