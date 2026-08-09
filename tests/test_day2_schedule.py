from __future__ import annotations

from typing import Any

import pytest

from football_scheduler.day2_schedule import (
    Day2ScheduleRequest,
    generate_day2_schedule,
)
from football_scheduler.league import LeaguePlan, generate_league_plan
from football_scheduler.league_results import LeagueStandings, Standing
from football_scheduler.models import RefereeKind, SolverStatus
from football_scheduler.tournament import TournamentPlan, generate_tournament_plan
from football_scheduler.validator import validate_day2_schedule


def _source(
    team_count: int, block_count: int
) -> tuple[list[dict[str, object]], LeaguePlan, LeagueStandings]:
    teams = [{"id": f"T{i}", "name": f"チーム{i}"} for i in range(1, team_count + 1)]
    block_size = team_count // block_count
    blocks = [
        {
            "id": f"B{block + 1}",
            "team_ids": [f"T{block * block_size + offset}" for offset in range(1, block_size + 1)],
        }
        for block in range(block_count)
    ]
    league = generate_league_plan(
        {
            "teams": teams,
            "block_count": block_count,
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
                played=block_size - 1,
                wins=0,
                draws=0,
                losses=0,
                goals_for=0,
                goals_against=0,
                goal_difference=0,
                points=0,
                tie_break="テスト用確定順位",
            )
            for block in league.blocks
            for rank, team_id in enumerate(block.team_ids, 1)
        ),
        draws=(),
    )
    return teams, league, standings


def _request(
    *,
    team_count: int = 8,
    block_count: int = 2,
    tournament_count: int = 2,
    court_count: int = 2,
    organizer_capacity: int | None = None,
    max_sections: int = 40,
    resolved: bool = False,
    fallback: str = "organizer",
    max_time_seconds: float = 10,
    random_seed: int = 17,
) -> tuple[Day2ScheduleRequest, TournamentPlan]:
    teams, league, standings = _source(team_count, block_count)
    tournament_request: dict[str, Any] = {
        "request_kind": "tournament_plan",
        "league_plan": league.model_dump(mode="json"),
        "final_stage": {
            "format": "placement_tournament",
            "tournament_count": tournament_count,
        },
        "random_seed": random_seed,
    }
    if resolved:
        tournament_request["league_standings"] = standings.model_dump(mode="json")
    plan = generate_tournament_plan(tournament_request)
    request = Day2ScheduleRequest.model_validate(
        {
            "request_kind": "day2_schedule",
            "teams": teams,
            "courts": [
                {"id": f"court-{index}", "name": f"{index}コート"}
                for index in range(1, court_count + 1)
            ],
            "league_plan": league.model_dump(mode="json"),
            "day1_schedule": {
                "day": {"id": "day1"},
                "slots": [],
            },
            "tournament_plan": plan.model_dump(mode="json"),
            "day": {"id": "day2", "max_sections": max_sections},
            "referees": {
                "organizer_capacity": organizer_capacity or court_count,
                "day2_fallback": fallback,
            },
            "random_seed": random_seed,
            "solver": {"max_time_seconds": max_time_seconds},
        }
    )
    return request, plan


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


def test_schedule_assigns_every_pool_match_once_and_validates() -> None:
    request, plan = _request()

    result = generate_day2_schedule(request)
    report = validate_day2_schedule(_validation_document(request, result))

    expected_ids = {match.id for pool in plan.pools for match in pool.matches}
    actual_ids = [slot.match_id for slot in result.slots if slot.match_id is not None]
    assert result.status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}
    assert set(actual_ids) == expected_ids
    assert len(actual_ids) == len(set(actual_ids))
    assert report["valid"] is True, report
    assert all(match.phase == "placement_tournament" for match in result.tournament_matches)
    assert all(not hasattr(match, "preliminary") for match in result.tournament_matches)


def test_all_pool_finals_use_organizer_and_primary_final_is_last() -> None:
    request, plan = _request(
        team_count=24,
        block_count=8,
        tournament_count=3,
        court_count=3,
        organizer_capacity=3,
        max_time_seconds=20,
    )

    result = generate_day2_schedule(request)

    assert result.status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}
    final_ids = {match.id for match in result.tournament_matches if match.final}
    assert len(final_ids) == 3
    final_slots = [slot for slot in result.slots if slot.match_id in final_ids]
    assert all(
        slot.referee_assignment is not None
        and slot.referee_assignment.kind is RefereeKind.ORGANIZER
        and slot.referee_assignment.organizer_reason == "tournament_final"
        for slot in final_slots
    )
    used_sections = result.metrics.used_sections
    assert used_sections is not None
    metric_by_pool = {
        metric.pool_id: metric for metric in result.metrics.placement_tournament_finals
    }
    assert set(metric_by_pool) == {pool.pool_id for pool in plan.pools}
    assert metric_by_pool[plan.pools[0].pool_id].section_no == used_sections
    assert metric_by_pool[plan.pools[0].pool_id].final_section_gap == 0


def test_non_primary_final_max_then_sum_gap_are_audited() -> None:
    request, _plan = _request(court_count=1, organizer_capacity=1)

    result = generate_day2_schedule(request)

    gaps = [metric.final_section_gap for metric in result.metrics.placement_tournament_finals[1:]]
    assert result.status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}
    assert result.metrics.non_primary_final_max_gap == max(gaps, default=0)
    assert result.metrics.non_primary_final_sum_gap == sum(gaps)
    assert "non_primary_final_max_gap" in result.metrics.optimized_objectives
    assert "non_primary_final_sum_gap" in result.metrics.optimized_objectives


def test_first_section_uses_only_organizer_referees() -> None:
    request, _plan = _request()

    result = generate_day2_schedule(request)

    first = [slot for slot in result.slots if slot.section_no == 1 and slot.match_id is not None]
    assert first
    assert all(
        slot.referee_assignment is not None
        and slot.referee_assignment.kind is RefereeKind.ORGANIZER
        and slot.referee_assignment.organizer_reason == "first_section"
        for slot in first
    )


def test_provisional_and_resolved_plans_keep_match_placement_structure() -> None:
    provisional_request, _ = _request(resolved=False)
    resolved_request, _ = _request(resolved=True)

    provisional = generate_day2_schedule(provisional_request)
    resolved = generate_day2_schedule(resolved_request)

    assert [(slot.match_id, slot.section_no, slot.court_id) for slot in provisional.slots] == [
        (slot.match_id, slot.section_no, slot.court_id) for slot in resolved.slots
    ]
    assert all(not match.possible_team_ids for match in provisional.tournament_matches)
    assert all(match.possible_team_ids for match in resolved.tournament_matches)


def test_insufficient_sections_returns_diagnostic_instead_of_relaxing_constraints() -> None:
    request, _plan = _request(court_count=1, max_sections=2)

    result = generate_day2_schedule(request)

    assert result.status is SolverStatus.INFEASIBLE
    assert result.diagnostics[0].code == "INSUFFICIENT_SLOTS"


def test_validator_detects_primary_final_moved_before_last_section() -> None:
    request, _plan = _request()
    result = generate_day2_schedule(request)
    document = _validation_document(request, result)
    matches = document["matches"]
    assert isinstance(matches, list)
    primary_final = next(
        match for match in matches if match["pool_id"] == "placement-1" and match["final"]
    )
    slots = document["schedule"]["slots"]  # type: ignore[index]
    primary_slot = next(slot for slot in slots if slot["match_id"] == primary_final["id"])
    other_slot = next(
        slot
        for slot in slots
        if slot["match_id"] is not None and slot["section_no"] < primary_slot["section_no"]
    )
    primary_slot["section_no"], other_slot["section_no"] = (
        other_slot["section_no"],
        primary_slot["section_no"],
    )

    report = validate_day2_schedule(document)

    assert report["valid"] is False
    assert "PRIMARY_PLACEMENT_FINAL_NOT_LAST_SECTION" in {
        item["code"] for item in report["diagnostics"]
    }


@pytest.mark.parametrize("fallback", ["organizer", "strict"])
def test_day2_fallback_contract_is_preserved(fallback: str) -> None:
    request, _plan = _request(fallback=fallback)

    result = generate_day2_schedule(request)

    assert result.status in {
        SolverStatus.OPTIMAL,
        SolverStatus.FEASIBLE,
        SolverStatus.INFEASIBLE,
    }
    if fallback == "strict" and result.status is SolverStatus.INFEASIBLE:
        assert result.diagnostics[0].code in {
            "TOURNAMENT_REFEREE_UNAVAILABLE",
            "TOURNAMENT_SCHEDULE_INFEASIBLE",
        }
