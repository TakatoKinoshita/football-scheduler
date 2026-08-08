from __future__ import annotations

import hashlib
import json
from time import monotonic

import pytest
from pydantic import ValidationError

from football_scheduler.day2_schedule import (
    Day2Schedule,
    Day2ScheduleError,
    Day2ScheduleRequest,
    generate_day2_schedule,
)
from football_scheduler.league import LeaguePlan, generate_league_plan
from football_scheduler.league_results import LeagueStandings, Standing
from football_scheduler.models import (
    DayBreak,
    RefereeAssignment,
    RefereeKind,
    Slot,
    SolverStatus,
)
from football_scheduler.tournament import TournamentPlan, generate_tournament_plan
from football_scheduler.validator import validate_day2_schedule


def _source(
    block_sizes: tuple[int, ...],
    *,
    team_prefix: str = "T",
) -> tuple[list[dict[str, object]], LeaguePlan, LeagueStandings]:
    teams = [
        {"id": f"{team_prefix}{index}", "name": f"チーム{index}"}
        for index in range(1, sum(block_sizes) + 1)
    ]
    blocks: list[dict[str, object]] = []
    offset = 0
    for index, size in enumerate(block_sizes):
        blocks.append(
            {
                "id": chr(ord("A") + index),
                "team_ids": [team["id"] for team in teams[offset : offset + size]],
            }
        )
        offset += size
    league_plan = generate_league_plan(
        {
            "teams": teams,
            "block_count": len(block_sizes),
            "assignment_mode": "manual",
            "manual_blocks": blocks,
            "random_seed": 17,
        }
    )
    standings = LeagueStandings(
        standings=tuple(
            Standing(
                block_id=block.id,
                rank=rank,
                team_id=team_id,
                played=max(0, len(block.team_ids) - 1),
                wins=0,
                draws=0,
                losses=0,
                goals_for=0,
                goals_against=0,
                goal_difference=0,
                points=0,
                tie_break="テスト用確定順位",
            )
            for block in league_plan.blocks
            for rank, team_id in enumerate(block.team_ids, 1)
        ),
        draws=(),
    )
    return teams, league_plan, standings


def _request(
    block_sizes: tuple[int, ...],
    *,
    courts: int = 2,
    fallback: str = "organizer",
    max_sections: int | None = 40,
    organizer_capacity: int | None = None,
    odd_split_policy: str = "upper",
    resolved: bool = True,
    team_prefix: str = "T",
) -> tuple[Day2ScheduleRequest, TournamentPlan]:
    teams, league_plan, standings = _source(block_sizes, team_prefix=team_prefix)
    tournament = generate_tournament_plan(
        {
            "request_kind": "tournament_plan",
            "league_plan": league_plan.model_dump(mode="json"),
            **({"league_standings": standings.model_dump(mode="json")} if resolved else {}),
            "odd_split_policy": odd_split_policy,
            "random_seed": 17,
        }
    )
    request = Day2ScheduleRequest.model_validate(
        {
            "request_kind": "day2_schedule",
            "teams": teams,
            "courts": [
                {"id": f"court-{index}", "name": f"{index}コート"} for index in range(1, courts + 1)
            ],
            "league_plan": league_plan.model_dump(mode="json"),
            "day1_schedule": {
                "day": {
                    "id": "day1",
                    "start_time": "09:30",
                    "game_duration_minutes": 35,
                    "margin_minutes": 5,
                },
                "slots": [],
            },
            "tournament_plan": tournament.model_dump(mode="json"),
            "day": {
                "id": "day2",
                "start_time": "09:30",
                "game_duration_minutes": 35,
                "margin_minutes": 10,
                "max_sections": max_sections,
            },
            "referees": {
                "organizer_capacity": (
                    courts if organizer_capacity is None else organizer_capacity
                ),
                "tournament_fallback": fallback,
            },
            "random_seed": 17,
            "solver": {"max_time_seconds": 10},
        }
    )
    return request, tournament


def _validation_document(request: Day2ScheduleRequest, result: object) -> dict[str, object]:
    dumped = result.model_dump(mode="json")  # type: ignore[attr-defined]
    return {
        "config": {
            "teams": [team.model_dump(mode="json") for team in request.teams],
            "courts": [court.model_dump(mode="json") for court in request.courts],
            "days": {"day2": request.day.model_dump(mode="json")},
            "referees": request.referees.model_dump(mode="json"),
        },
        "league_plan": request.league_plan.model_dump(mode="json"),
        "day1_schedule": request.day1_schedule.model_dump(mode="json"),
        "tournament_plan": request.tournament_plan.model_dump(mode="json"),
        "participant_resolution": dumped["participant_resolution"],
        "matches": dumped["tournament_matches"],
        "schedule": {
            "participant_resolution": dumped["participant_resolution"],
            "slots": dumped["slots"],
            "section_timings": dumped["section_timings"],
            "expected_end_time": dumped["expected_end_time"],
            "metrics": dumped["metrics"],
        },
        "metrics": dumped["metrics"],
    }


def test_two_team_event_has_no_real_day2_matches() -> None:
    request, _tournament = _request((2,), resolved=False)

    result = generate_day2_schedule(request)

    assert result.status is SolverStatus.OPTIMAL
    assert result.participant_resolution == "provisional"
    assert result.slots == ()
    assert result.metrics.used_sections == 0
    assert result.metrics.upper_tournament_final_section is None
    assert result.metrics.lower_tournament_final_section is None


def _final_sections(result: Day2Schedule) -> tuple[int | None, int | None, int]:
    sections = {
        slot.match_id: slot.section_no for slot in result.slots if slot.match_id is not None
    }
    upper_id = next(
        (
            match.id
            for match in result.tournament_matches
            if match.phase == "upper_tournament" and match.rank_range == (1, 2)
        ),
        None,
    )
    lower_id = next(
        (
            match.id
            for match in result.tournament_matches
            if match.phase == "lower_tournament" and match.rank_range == (1, 2)
        ),
        None,
    )
    return (
        sections.get(upper_id),
        sections.get(lower_id),
        max(sections.values(), default=0),
    )


def test_both_tournament_finals_share_last_section_when_capacity_allows() -> None:
    request, _tournament = _request((4, 4), courts=4, organizer_capacity=4)

    result = generate_day2_schedule(request)

    upper, lower, last = _final_sections(result)
    assert result.status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}
    assert upper == lower == last
    assert result.metrics.upper_tournament_final_section == last
    assert result.metrics.lower_tournament_final_section == last
    assert result.metrics.lower_tournament_final_section_gap == 0
    assert "lower_tournament_final_section_gap" in result.metrics.optimized_objectives
    assert not any(
        diagnostic.code.startswith("LOWER_TOURNAMENT_FINAL_") for diagnostic in result.diagnostics
    )


@pytest.mark.parametrize(
    ("courts", "organizer_capacity", "reason"),
    [(1, 1, "court_capacity"), (2, 1, "organizer_capacity")],
)
def test_lower_final_is_latest_feasible_when_finals_cannot_share_last_section(
    courts: int, organizer_capacity: int, reason: str
) -> None:
    request, _tournament = _request(
        (4, 4),
        courts=courts,
        organizer_capacity=organizer_capacity,
    )

    result = generate_day2_schedule(request)

    upper, lower, last = _final_sections(result)
    assert result.status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}
    assert upper == last
    assert lower is not None and lower < last
    assert result.metrics.lower_tournament_final_section_gap == last - lower
    warning = next(
        diagnostic
        for diagnostic in result.diagnostics
        if diagnostic.code
        in {
            "LOWER_TOURNAMENT_FINAL_NOT_LAST_SECTION",
            "LOWER_TOURNAMENT_FINAL_PLACEMENT_NOT_PROVEN",
        }
    )
    assert reason in warning.details["reason_codes"]
    expected_reason_text = "コート数" if reason == "court_capacity" else "主催者審判能力"
    assert expected_reason_text in warning.message


@pytest.mark.parametrize(
    ("odd_split_policy", "expected_phase"),
    [("upper", "upper_tournament"), ("lower", "lower_tournament")],
)
def test_only_existing_tournament_final_is_last(odd_split_policy: str, expected_phase: str) -> None:
    request, _tournament = _request(
        (3,),
        courts=1,
        odd_split_policy=odd_split_policy,
    )

    result = generate_day2_schedule(request)

    upper, lower, last = _final_sections(result)
    assert result.status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}
    assert (upper if expected_phase == "upper_tournament" else lower) == last
    assert (lower if expected_phase == "upper_tournament" else upper) is None


def test_invalid_tournament_final_definition_is_rejected() -> None:
    request, _tournament = _request((4, 4))
    payload = request.model_dump(mode="json")
    payload["tournament_plan"]["upper"]["logical_layout"] = None
    upper_matches = payload["tournament_plan"]["upper"]["matches"]
    final = next(match for match in upper_matches if match["rank_range"] == [1, 2])
    final["rank_range"] = [1, 3]

    with pytest.raises(Day2ScheduleError) as captured:
        generate_day2_schedule(payload)

    assert captured.value.code == "TOURNAMENT_REFERENCE_INVALID"
    assert captured.value.details["reason"] == "tournament_final_definition_invalid"


def test_day2_metrics_keep_fixed_day1_league_referee_objectives() -> None:
    request, _tournament = _request((4,), courts=2)
    first, second = request.league_plan.matches[:2]
    referee_team_id = next(iter(first.possible_team_ids))
    request = request.model_copy(
        update={
            "day1_schedule": request.day1_schedule.model_copy(
                update={
                    "slots": (
                        Slot(
                            day_id="day1",
                            section_no=1,
                            court_id="court-1",
                            match_id=first.id,
                            referee_assignment=RefereeAssignment(kind=RefereeKind.ORGANIZER),
                        ),
                        Slot(
                            day_id="day1",
                            section_no=2,
                            court_id="court-1",
                            match_id=second.id,
                            referee_assignment=RefereeAssignment(
                                kind=RefereeKind.TEAM,
                                team_id=referee_team_id,
                            ),
                        ),
                    )
                }
            )
        }
    )

    result = generate_day2_schedule(request)

    counts = {item.team_id: item.count for item in result.metrics.league_team_referee_counts}
    assert counts[referee_team_id] == 1
    assert result.metrics.league_team_referee_count_difference == 1
    assert result.metrics.league_previous_same_court_referee_count == 1
    validation = validate_day2_schedule(_validation_document(request, result))
    assert validation["valid"] is True
    assert validation["summary"]["league_team_referee_counts"] == [
        {"team_id": team_id, "count": counts[team_id]} for team_id in sorted(counts)
    ]


def test_day2_schedule_assigns_every_tournament_match_once_and_validates() -> None:
    request, tournament = _request((8,), courts=2)

    result = generate_day2_schedule(request)

    assert result.status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}, result.diagnostics
    occupied = [slot for slot in result.slots if slot.match_id is not None]
    expected_ids = {
        match.id for pool in (tournament.upper, tournament.lower) for match in pool.matches
    }
    assert {slot.match_id for slot in occupied} == expected_ids
    assert len(occupied) == len(expected_ids)
    assert validate_day2_schedule(_validation_document(request, result))["valid"] is True


def test_first_section_and_both_finals_use_organizer_referees() -> None:
    request, _tournament = _request((8,), courts=2, resolved=False)

    result = generate_day2_schedule(request)

    matches = {match.id: match for match in result.tournament_matches}
    for slot in result.slots:
        if slot.match_id is None:
            continue
        if slot.section_no == 1 or matches[slot.match_id].final:
            assert slot.referee_assignment is not None
            assert slot.referee_assignment.kind is RefereeKind.ORGANIZER
        elif (
            slot.referee_assignment is not None and slot.referee_assignment.kind is RefereeKind.TEAM
        ):
            assert slot.referee_assignment.source_match_id is not None


def test_breaks_are_reflected_in_section_times() -> None:
    request, _tournament = _request((8,), courts=2)
    request = request.model_copy(
        update={
            "day": request.day.model_copy(
                update={"breaks": (DayBreak(after_section=2, duration_minutes=30),)}
            )
        }
    )

    result = generate_day2_schedule(request)

    assert result.section_timings[2].start_time.isoformat(timespec="minutes") == "11:30"


@pytest.mark.parametrize("participant_count", [2, 3, 5, 6, 7, 8, 9, 10])
def test_arbitrary_participant_counts_schedule_without_bye_slots(participant_count: int) -> None:
    request, tournament = _request((participant_count * 2,), courts=3, resolved=False)

    result = generate_day2_schedule(request)

    expected = len(tournament.upper.matches) + len(tournament.lower.matches)
    assert result.status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}
    assert result.participant_resolution == "provisional"
    assert len([slot for slot in result.slots if slot.match_id is not None]) == expected
    assert all(match.possible_rank_refs for match in result.tournament_matches)
    assert all(not match.possible_team_ids for match in result.tournament_matches)
    assert all(
        route.rank_ref is not None and route.team_id is None for route in result.team_schedules
    )
    upper_final, _lower_final, last_section = _final_sections(result)
    assert upper_final == last_section
    assert validate_day2_schedule(_validation_document(request, result))["valid"] is True


def test_representative_two_tournaments_finish_within_thirty_seconds() -> None:
    request, tournament = _request((4, 4, 4, 4), courts=3, resolved=False)
    started = monotonic()

    result = generate_day2_schedule(request)

    assert monotonic() - started < 30
    assert len(tournament.upper.matches) + len(tournament.lower.matches) == 24
    assert result.status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}, result.diagnostics
    assert validate_day2_schedule(_validation_document(request, result))["valid"] is True


def test_resolving_rank_slots_only_adds_team_annotations() -> None:
    provisional_request, _ = _request((4, 4, 4, 4), courts=3, resolved=False)
    resolved_request, _ = _request((4, 4, 4, 4), courts=3, resolved=True)

    provisional = generate_day2_schedule(provisional_request)
    resolved = generate_day2_schedule(resolved_request)

    assert resolved.slots == provisional.slots
    assert resolved.section_timings == provisional.section_timings
    assert resolved.expected_end_time == provisional.expected_end_time
    assert [
        (match.id, match.home, match.away, match.possible_rank_refs)
        for match in resolved.tournament_matches
    ] == [
        (match.id, match.home, match.away, match.possible_rank_refs)
        for match in provisional.tournament_matches
    ]
    assert all(match.possible_team_ids for match in resolved.tournament_matches)
    assert all(
        route.rank_ref is not None and route.team_id is not None
        for route in resolved.team_schedules
    )
    assert [
        (
            route.rank_ref,
            route.role,
            route.match_id,
            route.section_no,
            route.court_id,
            route.conditions,
        )
        for route in resolved.team_schedules
    ] == [
        (
            route.rank_ref,
            route.role,
            route.match_id,
            route.section_no,
            route.court_id,
            route.conditions,
        )
        for route in provisional.team_schedules
    ]


def test_provisional_placement_does_not_depend_on_team_ids() -> None:
    first_request, _ = _request((4, 4, 4, 4), courts=3, resolved=False, team_prefix="T")
    second_request, _ = _request((4, 4, 4, 4), courts=3, resolved=False, team_prefix="X")

    first = generate_day2_schedule(first_request)
    second = generate_day2_schedule(second_request)

    assert second.slots == first.slots
    assert second.section_timings == first.section_timings
    assert [(match.id, match.possible_rank_refs) for match in second.tournament_matches] == [
        (match.id, match.possible_rank_refs) for match in first.tournament_matches
    ]
    assert second.team_schedules == first.team_schedules


def test_schedule_resolution_rejects_mixed_or_incomplete_annotations() -> None:
    provisional_request, _ = _request((8,), resolved=False)
    provisional = generate_day2_schedule(provisional_request).model_dump(mode="json")
    provisional["tournament_matches"][0]["possible_team_ids"] = ["T1"]
    with pytest.raises(ValidationError, match="チーム注記"):
        Day2Schedule.model_validate(provisional)

    provisional = generate_day2_schedule(provisional_request).model_dump(mode="json")
    rank_refs = provisional["tournament_matches"][0]["possible_rank_refs"]
    rank_refs.append(rank_refs[0])
    with pytest.raises(ValidationError, match="重複した順位枠"):
        Day2Schedule.model_validate(provisional)

    provisional = generate_day2_schedule(provisional_request).model_dump(mode="json")
    provisional["team_schedules"] = []
    with pytest.raises(ValidationError, match="チーム別経路の順位枠注記"):
        Day2Schedule.model_validate(provisional)

    resolved_request, _ = _request((8,), resolved=True)
    resolved = generate_day2_schedule(resolved_request).model_dump(mode="json")
    resolved["tournament_matches"][0]["possible_rank_refs"] = []
    with pytest.raises(ValidationError, match="確定済みの2日目日程"):
        Day2Schedule.model_validate(resolved)

    resolved = generate_day2_schedule(resolved_request).model_dump(mode="json")
    resolved["tournament_matches"][0]["possible_team_ids"] = ["T1"]
    with pytest.raises(ValidationError, match="件数が一致しません"):
        Day2Schedule.model_validate(resolved)

    resolved = generate_day2_schedule(resolved_request).model_dump(mode="json")
    resolved["team_schedules"][0]["team_id"] = "T999"
    with pytest.raises(ValidationError, match="チーム別経路"):
        Day2Schedule.model_validate(resolved)

    resolved = generate_day2_schedule(resolved_request).model_dump(mode="json")
    resolved["team_schedules"][0]["match_id"] = "UT-UNKNOWN"
    with pytest.raises(ValidationError, match="未定義の試合参照"):
        Day2Schedule.model_validate(resolved)


def test_legacy_resolved_schedule_without_rank_audit_fields_remains_readable() -> None:
    request, _ = _request((8,), resolved=True)
    legacy = generate_day2_schedule(request).model_dump(mode="json")
    legacy.pop("participant_resolution")
    for match in legacy["tournament_matches"]:
        match.pop("possible_rank_refs")
    for route in legacy["team_schedules"]:
        route.pop("rank_ref")

    restored = Day2Schedule.model_validate(legacy)
    round_tripped = restored.model_dump(mode="json")

    assert restored.participant_resolution == "resolved"
    assert all(route.team_id is not None for route in restored.team_schedules)
    assert "participant_resolution" not in round_tripped
    assert all("possible_rank_refs" not in match for match in round_tripped["tournament_matches"])
    assert all("rank_ref" not in route for route in round_tripped["team_schedules"])
    assert Day2Schedule.model_validate(round_tripped) == restored


def test_strict_mode_reschedules_to_keep_previous_winner_referees() -> None:
    request, _tournament = _request((8,), courts=2, fallback="strict", resolved=False)

    result = generate_day2_schedule(request)

    assert result.status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}, result.diagnostics
    assert result.metrics.tournament_referee_fallback_count == 0
    assert validate_day2_schedule(_validation_document(request, result))["valid"] is True


def test_provisional_schedule_records_organizer_fallback_after_unused_court() -> None:
    request, _tournament = _request((6,), courts=2, resolved=False)

    result = generate_day2_schedule(request)

    fallback_slots = [
        slot
        for slot in result.slots
        if slot.referee_assignment is not None
        and slot.referee_assignment.organizer_reason == "fallback"
    ]
    assert result.status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}
    assert result.metrics.tournament_referee_fallback_count == len(fallback_slots) == 1
    assert fallback_slots[0].referee_assignment is not None
    assert fallback_slots[0].referee_assignment.fallback_reasons == ("no_previous_match",)
    assert validate_day2_schedule(_validation_document(request, result))["valid"] is True


def test_strict_mode_reports_when_no_legal_winner_referee_layout_exists() -> None:
    request, _tournament = _request((6,), courts=2, fallback="strict", resolved=False)
    request = request.model_copy(
        update={"solver": request.solver.model_copy(update={"max_time_seconds": 3})}
    )

    result = generate_day2_schedule(request)

    assert result.status is SolverStatus.INFEASIBLE
    assert result.participant_resolution == "provisional"
    assert all(match.possible_rank_refs for match in result.tournament_matches)
    assert all(not match.possible_team_ids for match in result.tournament_matches)
    assert result.diagnostics[0].code == "TOURNAMENT_REFEREE_UNAVAILABLE"
    assert "厳格な審判条件" in result.diagnostics[0].message


def test_provisional_schedule_rejects_zero_organizer_capacity() -> None:
    request, _tournament = _request((8,), courts=2, resolved=False)
    request = request.model_copy(
        update={
            "referees": request.referees.model_copy(update={"organizer_capacity": 0}),
            "solver": request.solver.model_copy(update={"max_time_seconds": 3}),
        }
    )

    result = generate_day2_schedule(request)

    assert result.status is SolverStatus.INFEASIBLE
    assert result.participant_resolution == "provisional"
    assert result.diagnostics
    assert result.diagnostics[0].code == "TOURNAMENT_SCHEDULE_INFEASIBLE"
    assert "作成できません" in result.diagnostics[0].message
    assert result.diagnostics[0].details["required_final_match_id"]
    assert result.diagnostics[0].details["maximum_sections"] > 0
    assert result.diagnostics[0].details["court_count"] == 2
    assert result.diagnostics[0].details["organizer_capacity"] == 0


def test_same_seed_reproduces_slots_referees_and_audit_values() -> None:
    request, _tournament = _request((8,), courts=2)

    first = generate_day2_schedule(request)
    second = generate_day2_schedule(request)

    assert second.slots == first.slots
    assert second.team_schedules == first.team_schedules
    assert second.metrics.model_dump(exclude={"wall_time_seconds"}) == first.metrics.model_dump(
        exclude={"wall_time_seconds"}
    )


def test_independent_validator_detects_changed_referee_source() -> None:
    request, _tournament = _request((8,), courts=2)
    result = generate_day2_schedule(request)
    document = _validation_document(request, result)
    schedule = document["schedule"]
    assert isinstance(schedule, dict)
    slots = schedule["slots"]
    assert isinstance(slots, list)
    team_slot = next(
        slot
        for slot in slots
        if isinstance(slot, dict)
        and isinstance(slot.get("referee_assignment"), dict)
        and slot["referee_assignment"].get("kind") == "team"
    )
    assignment = team_slot["referee_assignment"]
    assert isinstance(assignment, dict)
    assignment["source_match_id"] = "UT-UNKNOWN"

    validation = validate_day2_schedule(document)

    assert validation["valid"] is False
    assert any(
        issue["code"] == "TOURNAMENT_PREVIOUS_WINNER_REFEREE_REQUIRED"
        for issue in validation["diagnostics"]
    )


def test_independent_validator_rejects_match_after_upper_final() -> None:
    request, _tournament = _request((4, 4), courts=2)
    result = generate_day2_schedule(request)
    document = _validation_document(request, result)
    matches = document["matches"]
    schedule = document["schedule"]
    assert isinstance(matches, list)
    assert isinstance(schedule, dict)
    slots = schedule["slots"]
    assert isinstance(slots, list)
    upper_final_id = next(
        match["id"]
        for match in matches
        if isinstance(match, dict)
        and match.get("phase") == "upper_tournament"
        and match.get("rank_range") == [1, 2]
    )
    upper_slot = next(
        slot for slot in slots if isinstance(slot, dict) and slot.get("match_id") == upper_final_id
    )
    earlier_slot = next(
        slot
        for slot in slots
        if isinstance(slot, dict)
        and slot.get("match_id") is not None
        and int(slot["section_no"]) < int(upper_slot["section_no"])
    )
    upper_position = (upper_slot["section_no"], upper_slot["court_id"])
    upper_slot["section_no"], upper_slot["court_id"] = (
        earlier_slot["section_no"],
        earlier_slot["court_id"],
    )
    earlier_slot["section_no"], earlier_slot["court_id"] = upper_position

    validation = validate_day2_schedule(document)

    assert validation["valid"] is False
    assert "UPPER_TOURNAMENT_FINAL_NOT_LAST_SECTION" in {
        issue["code"] for issue in validation["diagnostics"]
    }


def test_independent_validator_rejects_changed_final_definition() -> None:
    request, _tournament = _request((4, 4), courts=2)
    result = generate_day2_schedule(request)
    document = _validation_document(request, result)
    matches = document["matches"]
    assert isinstance(matches, list)
    upper_final = next(
        match
        for match in matches
        if isinstance(match, dict)
        and match.get("phase") == "upper_tournament"
        and match.get("rank_range") == [1, 2]
    )
    upper_final["rank_range"] = [1, 3]

    validation = validate_day2_schedule(document)

    assert validation["valid"] is False
    assert "TOURNAMENT_FINAL_DEFINITION_INVALID" in {
        issue["code"] for issue in validation["diagnostics"]
    }


def test_independent_validator_rejects_missing_final_in_schedule_and_plan() -> None:
    request, _tournament = _request((4, 4), courts=2)
    result = generate_day2_schedule(request)
    document = _validation_document(request, result)
    matches = document["matches"]
    plan = document["tournament_plan"]
    assert isinstance(matches, list)
    assert isinstance(plan, dict)
    upper = plan["upper"]
    assert isinstance(upper, dict)
    plan_matches = upper["matches"]
    assert isinstance(plan_matches, list)
    for collection in (matches, plan_matches):
        upper_final = next(
            match
            for match in collection
            if isinstance(match, dict)
            and match.get("phase") == "upper_tournament"
            and match.get("rank_range") == [1, 2]
        )
        upper_final["rank_range"] = [1, 3]

    validation = validate_day2_schedule(document)

    assert validation["valid"] is False
    assert "TOURNAMENT_FINAL_DEFINITION_INVALID" in {
        issue["code"] for issue in validation["diagnostics"]
    }


def test_independent_validator_detects_changed_final_audit() -> None:
    request, _tournament = _request((4, 4), courts=2)
    result = generate_day2_schedule(request)
    document = _validation_document(request, result)
    metrics = document["metrics"]
    assert isinstance(metrics, dict)
    metrics["lower_tournament_final_section_gap"] = (
        int(metrics["lower_tournament_final_section_gap"]) + 1
    )

    validation = validate_day2_schedule(document)

    assert validation["valid"] is False
    assert any(
        issue["code"] == "SCHEDULE_AUDIT_MISMATCH"
        and issue["details"].get("field") == "lower_tournament_final_section_gap"
        for issue in validation["diagnostics"]
    )


def test_independent_validator_detects_changed_section_time() -> None:
    request, _tournament = _request((8,), courts=2)
    result = generate_day2_schedule(request)
    document = _validation_document(request, result)
    schedule = document["schedule"]
    assert isinstance(schedule, dict)
    timings = schedule["section_timings"]
    assert isinstance(timings, list)
    first = timings[0]
    assert isinstance(first, dict)
    first["start_time"] = "09:31:00"

    validation = validate_day2_schedule(document)

    assert validation["valid"] is False
    assert any(issue["code"] == "SCHEDULE_TIMING_MISMATCH" for issue in validation["diagnostics"])


def test_independent_validator_detects_changed_fixed_day1_audit() -> None:
    request, _tournament = _request((8,), courts=2)
    result = generate_day2_schedule(request)
    document = _validation_document(request, result)
    metrics = document["metrics"]
    assert isinstance(metrics, dict)
    metrics["league_team_referee_count_difference"] = 1

    validation = validate_day2_schedule(document)

    assert validation["valid"] is False
    assert any(
        issue["code"] == "SCHEDULE_AUDIT_MISMATCH"
        and issue["details"].get("field") == "league_team_referee_count_difference"
        for issue in validation["diagnostics"]
    )


def test_maximum_event_is_reproducible_valid_and_under_production_limits() -> None:
    request, _tournament = _request((4, 4, 4, 4, 4, 4, 4, 4), courts=4, resolved=False)
    request = request.model_copy(
        update={"solver": request.solver.model_copy(update={"max_time_seconds": 30})}
    )
    hashes: list[str] = []
    for _attempt in range(2):
        started = monotonic()
        result = generate_day2_schedule(request)
        assert monotonic() - started < 30
        assert result.status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}
        assert validate_day2_schedule(_validation_document(request, result))["valid"] is True
        dumped = result.model_dump(mode="json")
        dumped["metrics"].pop("wall_time_seconds", None)
        encoded = json.dumps(
            dumped, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode()
        assert len(encoded) <= 1_000_000
        hashes.append(hashlib.sha256(encoded).hexdigest())

    assert len(set(hashes)) == 1
