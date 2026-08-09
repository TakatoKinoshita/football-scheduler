from __future__ import annotations

from copy import deepcopy
from itertools import pairwise

import pytest

from football_scheduler.league import LeaguePlan, generate_league_plan
from football_scheduler.league_results import LeagueStandings, Standing
from football_scheduler.models import RefereeKind, SolverStatus
from football_scheduler.same_rank_league import (
    SameRankLeaguePlan,
    generate_same_rank_league_plan,
)
from football_scheduler.same_rank_schedule import (
    SameRankDay2ScheduleRequest,
    generate_same_rank_day2_schedule,
)
from football_scheduler.same_rank_validator import validate_same_rank_day2_schedule


def _source(team_count: int, block_count: int) -> tuple[list[dict[str, str]], LeaguePlan]:
    teams = [
        {"id": f"T{index:02d}", "name": f"チーム{index}"} for index in range(1, team_count + 1)
    ]
    return teams, generate_league_plan(
        {
            "teams": teams,
            "block_count": block_count,
            "assignment_mode": "seeded_snake",
            "random_seed": 17,
        }
    )


def _standings(plan: LeaguePlan) -> LeagueStandings:
    return LeagueStandings(
        standings=tuple(
            Standing(
                block_id=block.id,
                rank=rank,
                team_id=team_id,
                played=0,
                wins=0,
                draws=0,
                losses=0,
                goals_for=0,
                goals_against=0,
                goal_difference=0,
                points=0,
                tie_break="fixture",
            )
            for block in plan.blocks
            for rank, team_id in enumerate(block.team_ids, 1)
        ),
        draws=(),
    )


def _request(
    *,
    team_count: int = 4,
    block_count: int = 2,
    court_count: int = 1,
    resolved: bool = False,
    policy: str = "strict_same_rank",
    fallback: str = "strict",
    max_sections: int = 20,
    max_time_seconds: float = 5,
) -> tuple[SameRankDay2ScheduleRequest, SameRankLeaguePlan]:
    teams, league = _source(team_count, block_count)
    plan_request: dict[str, object] = {
        "request_kind": "same_rank_league_plan",
        "league_plan": league.model_dump(mode="json"),
        "final_stage": {"format": "same_rank_league", "uneven_policy": policy},
        "random_seed": 17,
    }
    if resolved:
        plan_request["league_standings"] = _standings(league).model_dump(mode="json")
    plan = generate_same_rank_league_plan(plan_request)
    request = SameRankDay2ScheduleRequest.model_validate(
        {
            "request_kind": "same_rank_day2_schedule",
            "teams": teams,
            "courts": [
                {"id": f"court-{index}", "name": f"{index}コート"}
                for index in range(1, court_count + 1)
            ],
            "league_plan": league.model_dump(mode="json"),
            "day1_schedule": {"day": {"id": "day1"}, "slots": []},
            "same_rank_plan": plan.model_dump(mode="json"),
            "day": {"id": "day2", "max_sections": max_sections},
            "referees": {
                "organizer_capacity": court_count,
                "day2_fallback": fallback,
            },
            "random_seed": 17,
            "solver": {"max_time_seconds": max_time_seconds},
        }
    )
    return request, plan


def _signature(result: object) -> list[tuple[object, ...]]:
    slots = result.slots  # type: ignore[attr-defined]
    return [
        (
            slot.match_id,
            slot.section_no,
            slot.court_id,
            slot.referee_assignment.kind if slot.referee_assignment else None,
            (
                slot.referee_assignment.rank_ref.block_id,
                slot.referee_assignment.rank_ref.rank,
            )
            if slot.referee_assignment and slot.referee_assignment.rank_ref
            else None,
        )
        for slot in slots
    ]


def test_schedule_assigns_all_matches_once_and_independently_validates() -> None:
    request, plan = _request(team_count=8, block_count=4, court_count=2, max_time_seconds=1)

    result = generate_same_rank_day2_schedule(request)
    report = validate_same_rank_day2_schedule(request, result)

    expected_ids = {match.id for group in plan.groups for match in group.matches}
    actual_ids = [slot.match_id for slot in result.slots if slot.match_id]
    assert result.status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}
    assert set(actual_ids) == expected_ids
    assert len(actual_ids) == len(set(actual_ids))
    assert report.valid is True, report
    assert all(
        slot.referee_assignment is not None
        and slot.referee_assignment.kind is RefereeKind.ORGANIZER
        for slot in result.slots
        if slot.section_no == 1 and slot.match_id
    )
    assert result.metrics.optimized_objectives == (
        "used_sections",
        "referee_count_difference",
        "maximum_team_wait_sections",
        "referee_then_match_count",
        "previous_same_court_referee_count",
        "gap_court_change_count",
        "court_usage_difference",
    )


def test_provisional_and_resolved_keep_match_and_referee_rank_signature() -> None:
    provisional_request, _ = _request(resolved=False)
    resolved_request, _ = _request(resolved=True)

    provisional = generate_same_rank_day2_schedule(provisional_request)
    resolved = generate_same_rank_day2_schedule(resolved_request)

    assert _signature(provisional) == _signature(resolved)
    assert any(
        slot.referee_assignment is not None
        and slot.referee_assignment.kind is RefereeKind.TEAM
        and slot.referee_assignment.rank_ref is not None
        for slot in provisional.slots
    )
    assert all(
        slot.referee_assignment is None or slot.referee_assignment.team_id is None
        for slot in provisional.slots
    )
    assert all(
        slot.referee_assignment is None
        or slot.referee_assignment.kind is RefereeKind.ORGANIZER
        or slot.referee_assignment.team_id is not None
        for slot in resolved.slots
    )
    assert validate_same_rank_day2_schedule(provisional_request, provisional).valid is True
    assert validate_same_rank_day2_schedule(resolved_request, resolved).valid is True


def test_strict_uses_team_referees_after_first_section() -> None:
    request, _ = _request(fallback="strict")

    result = generate_same_rank_day2_schedule(request)

    assert result.status is SolverStatus.OPTIMAL
    assert result.metrics.fallback_count == 0
    assert all(
        slot.referee_assignment is not None
        and slot.referee_assignment.kind is RefereeKind.TEAM
        and slot.referee_assignment.rank_ref is not None
        for slot in result.slots
        if slot.section_no > 1 and slot.match_id
    )


def test_all_adjacent_match_and_referee_roles_stay_on_same_court() -> None:
    request, _ = _request(team_count=8, block_count=4, court_count=2, max_time_seconds=1)
    result = generate_same_rank_day2_schedule(request)
    roles: dict[tuple[str, int], list[tuple[int, str]]] = {}
    for route in result.team_schedules:
        key = route.rank_ref.block_id, route.rank_ref.rank
        roles.setdefault(key, []).append((route.section_no, route.court_id))

    for entries in roles.values():
        ordered = sorted(entries)
        for left, right in pairwise(ordered):
            if right[0] == left[0] + 1:
                assert right[1] == left[1]


def test_validator_detects_duplicate_match() -> None:
    request, _ = _request(team_count=8, block_count=4, court_count=2, max_time_seconds=1)
    result = generate_same_rank_day2_schedule(request)
    dumped = result.model_dump(mode="json")
    occupied = [slot for slot in dumped["slots"] if slot["match_id"]]
    occupied[1]["match_id"] = occupied[0]["match_id"]

    report = validate_same_rank_day2_schedule(request, dumped)

    assert report.valid is False
    assert "SAME_RANK_MATCH_ASSIGNMENT_INVALID" in {
        diagnostic.code for diagnostic in report.diagnostics
    }


def test_validator_detects_adjacent_court_change() -> None:
    request, _ = _request(team_count=8, block_count=4, court_count=2, max_time_seconds=1)
    result = generate_same_rank_day2_schedule(request)
    dumped = result.model_dump(mode="json")
    referee_route = next(
        route
        for route in dumped["team_schedules"]
        if route["role"] == "referee"
        and any(
            other["role"] == "match"
            and other["rank_ref"] == route["rank_ref"]
            and abs(other["section_no"] - route["section_no"]) == 1
            for other in dumped["team_schedules"]
        )
    )
    referee_route["court_id"] = next(
        court.id for court in request.courts if court.id != referee_route["court_id"]
    )

    report = validate_same_rank_day2_schedule(request, dumped)

    assert report.valid is False
    assert "SAME_RANK_TEAM_SCHEDULE_INVALID" in {
        diagnostic.code for diagnostic in report.diagnostics
    }


def test_singleton_group_consumes_no_match_slot() -> None:
    request, plan = _request(
        team_count=17,
        block_count=4,
        court_count=4,
        fallback="organizer",
        max_time_seconds=5,
    )

    result = generate_same_rank_day2_schedule(request)

    assert plan.groups[-1].matches == ()
    assert plan.automatic_standings[0].overall_rank == 17
    assert len([slot for slot in result.slots if slot.match_id]) == sum(
        len(group.matches) for group in plan.groups
    )


def test_insufficient_sections_is_reported_without_relaxing_constraints() -> None:
    request, _ = _request(team_count=8, block_count=4, max_sections=1)

    result = generate_same_rank_day2_schedule(request)

    assert result.status is SolverStatus.INFEASIBLE
    assert result.diagnostics[0].code == "INSUFFICIENT_SLOTS"
    assert result.diagnostics[0].details["required_match_count"] == 12
    assert result.diagnostics[0].details["available_slot_count"] == 1
    assert result.diagnostics[0].details["theoretical_minimum_sections"] == 12


def test_strict_referee_failure_is_infeasible_not_timeout() -> None:
    request, _ = _request(max_sections=2, max_time_seconds=2, fallback="strict")
    dumped = request.model_dump(mode="json")
    dumped["referees"]["organizer_capacity"] = 0

    result = generate_same_rank_day2_schedule(SameRankDay2ScheduleRequest.model_validate(dumped))

    assert result.status is SolverStatus.INFEASIBLE
    assert result.diagnostics[0].code == "SAME_RANK_REFEREE_UNAVAILABLE"


def test_search_timeout_is_unknown_and_reports_capacity_evidence() -> None:
    request, _ = _request(
        team_count=17,
        block_count=4,
        court_count=4,
        max_time_seconds=0.001,
    )

    result = generate_same_rank_day2_schedule(request)

    assert result.status is SolverStatus.UNKNOWN
    assert result.diagnostics[0].code == "SAME_RANK_SCHEDULE_SEARCH_TIMEOUT"
    assert {
        "required_match_count",
        "available_slot_count",
        "theoretical_minimum_sections",
    } <= result.diagnostics[0].details.keys()


def test_organizer_fallback_can_complete_when_strict_search_cannot() -> None:
    request, _ = _request(
        team_count=17,
        block_count=4,
        court_count=4,
        fallback="organizer",
        max_time_seconds=5,
    )

    result = generate_same_rank_day2_schedule(request)

    assert result.status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}
    assert result.metrics.fallback_count is not None
    assert result.metrics.fallback_count > 0
    assert validate_same_rank_day2_schedule(request, result).valid is True


@pytest.mark.parametrize(
    ("policy", "group_sizes", "match_count"),
    [
        ("strict_same_rank", [4, 4, 4, 4, 2], 25),
        ("merge_bottom", [4, 4, 4, 6], 33),
    ],
)
def test_18_team_uneven_plans_are_fully_scheduled(
    policy: str,
    group_sizes: list[int],
    match_count: int,
) -> None:
    request, plan = _request(
        team_count=18,
        block_count=4,
        court_count=4,
        policy=policy,
        fallback="organizer",
        max_time_seconds=10,
    )

    result = generate_same_rank_day2_schedule(request)

    assert [len(group.participants) for group in plan.groups] == group_sizes
    assert len([slot for slot in result.slots if slot.match_id]) == match_count
    assert validate_same_rank_day2_schedule(request, result).valid is True


def test_metrics_tampering_is_detected() -> None:
    request, _ = _request()
    result = generate_same_rank_day2_schedule(request)
    dumped = deepcopy(result.model_dump(mode="json"))
    dumped["metrics"]["referee_count_difference"] += 1

    report = validate_same_rank_day2_schedule(request, dumped)

    assert report.valid is False
    assert "SAME_RANK_METRICS_INVALID" in {item.code for item in report.diagnostics}


@pytest.mark.parametrize(
    "mutation",
    [
        "slot_grid",
        "section_limit",
        "referee_counts",
        "objective_stage",
        "duplicate_route",
    ],
)
def test_validator_detects_audit_and_completeness_tampering(mutation: str) -> None:
    request, _ = _request()
    result = generate_same_rank_day2_schedule(request)
    dumped = deepcopy(result.model_dump(mode="json"))
    expected_code = "SAME_RANK_METRICS_INVALID"
    if mutation == "slot_grid":
        dumped["slots"].pop()
        expected_code = "SAME_RANK_SLOT_GRID_INVALID"
    elif mutation == "section_limit":
        assert request.day.max_sections is not None
        dumped["metrics"]["used_sections"] = request.day.max_sections + 1
        expected_code = "SAME_RANK_SECTION_LIMIT_EXCEEDED"
    elif mutation == "referee_counts":
        dumped["metrics"]["referee_counts"][0]["count"] += 1
    elif mutation == "objective_stage":
        dumped["metrics"]["objective_stages"][0]["value"] += 1
    else:
        dumped["team_schedules"].append(deepcopy(dumped["team_schedules"][0]))
        expected_code = "SAME_RANK_TEAM_SCHEDULE_INVALID"

    report = validate_same_rank_day2_schedule(request, dumped)

    assert report.valid is False
    assert expected_code in {item.code for item in report.diagnostics}
