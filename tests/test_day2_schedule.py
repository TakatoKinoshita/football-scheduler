from __future__ import annotations

import hashlib
import json
from time import monotonic

import pytest

from football_scheduler.day2_schedule import (
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
) -> tuple[list[dict[str, object]], LeaguePlan, LeagueStandings]:
    teams = [
        {"id": f"T{index}", "name": f"チーム{index}"} for index in range(1, sum(block_sizes) + 1)
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
) -> tuple[Day2ScheduleRequest, TournamentPlan]:
    teams, league_plan, standings = _source(block_sizes)
    tournament = generate_tournament_plan(
        {
            "request_kind": "tournament_plan",
            "league_plan": league_plan.model_dump(mode="json"),
            "league_standings": standings.model_dump(mode="json"),
            "odd_split_policy": "upper",
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
                "organizer_capacity": courts,
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
        "matches": dumped["tournament_matches"],
        "schedule": {
            "slots": dumped["slots"],
            "section_timings": dumped["section_timings"],
            "expected_end_time": dumped["expected_end_time"],
            "metrics": dumped["metrics"],
        },
        "metrics": dumped["metrics"],
    }


def test_two_team_event_has_no_real_day2_matches() -> None:
    request, _tournament = _request((2,))

    result = generate_day2_schedule(request)

    assert result.status is SolverStatus.OPTIMAL
    assert result.slots == ()
    assert result.metrics.used_sections == 0


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
    request, _tournament = _request((8,), courts=2)

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


@pytest.mark.parametrize("participant_count", [3, 5, 6, 7, 8, 9, 10])
def test_arbitrary_participant_counts_schedule_without_bye_slots(participant_count: int) -> None:
    request, tournament = _request((participant_count * 2,), courts=3)

    result = generate_day2_schedule(request)

    expected = len(tournament.upper.matches) + len(tournament.lower.matches)
    assert result.status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}
    assert len([slot for slot in result.slots if slot.match_id is not None]) == expected


def test_representative_two_tournaments_finish_within_thirty_seconds() -> None:
    request, tournament = _request((4, 4, 4, 4), courts=3)
    started = monotonic()

    result = generate_day2_schedule(request)

    assert monotonic() - started < 30
    assert len(tournament.upper.matches) + len(tournament.lower.matches) == 24
    assert result.status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}, result.diagnostics
    assert validate_day2_schedule(_validation_document(request, result))["valid"] is True


def test_strict_mode_reschedules_to_keep_previous_winner_referees() -> None:
    request, _tournament = _request((8,), courts=2, fallback="strict")

    result = generate_day2_schedule(request)

    assert result.status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}, result.diagnostics
    assert result.metrics.tournament_referee_fallback_count == 0
    assert validate_day2_schedule(_validation_document(request, result))["valid"] is True


def test_strict_mode_reports_when_no_legal_winner_referee_layout_exists() -> None:
    request, _tournament = _request((6,), courts=2, fallback="strict")
    request = request.model_copy(
        update={"solver": request.solver.model_copy(update={"max_time_seconds": 3})}
    )

    result = generate_day2_schedule(request)

    assert result.status is SolverStatus.INFEASIBLE
    assert result.diagnostics[0].code == "TOURNAMENT_REFEREE_UNAVAILABLE"
    assert "厳格な審判条件" in result.diagnostics[0].message


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
    request, _tournament = _request((4, 4, 4, 4, 4, 4, 4, 4), courts=4)
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
