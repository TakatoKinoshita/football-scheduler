from __future__ import annotations

from copy import deepcopy
from typing import Any

import pytest

from football_scheduler import application
from football_scheduler.day2_schedule import Day2ScheduleError, generate_day2_schedule
from football_scheduler.league import LeaguePlan, generate_league_plan
from football_scheduler.same_rank_league import generate_same_rank_league_plan
from football_scheduler.same_rank_schedule import (
    SameRankScheduleError,
    generate_same_rank_day2_schedule,
)
from football_scheduler.tournament import generate_tournament_plan


def _league(team_count: int, block_count: int) -> LeaguePlan:
    return generate_league_plan(
        {
            "teams": [
                {"id": f"T{index:02d}", "name": f"チーム{index}"}
                for index in range(1, team_count + 1)
            ],
            "block_count": block_count,
            "assignment_mode": "seeded_snake",
            "random_seed": 41,
        }
    )


def _same_rank_plan(policy: str = "strict_same_rank") -> dict[str, Any]:
    league = _league(18, 4)
    return generate_same_rank_league_plan(
        {
            "request_kind": "same_rank_league_plan",
            "league_plan": league.model_dump(mode="json"),
            "final_stage": {"format": "same_rank_league", "uneven_policy": policy},
            "random_seed": 41,
        }
    ).model_dump(mode="json")


def _placement_plan() -> dict[str, Any]:
    league = _league(8, 2)
    return generate_tournament_plan(
        {
            "request_kind": "tournament_plan",
            "league_plan": league.model_dump(mode="json"),
            "final_stage": {"format": "placement_tournament", "tournament_count": 2},
            "random_seed": 41,
        }
    ).model_dump(mode="json")


@pytest.mark.parametrize(
    "request_kind",
    [
        "day1_league",
        "league_standings",
        "tournament_plan",
        "tournament_results",
        "same_rank_league_plan",
        "same_rank_league_results",
        "day2_schedule",
        "same_rank_day2_schedule",
        "day2_creation",
        "schedule_creation",
    ],
)
def test_generation_api_requires_explicit_schema_0_2_0(request_kind: str) -> None:
    result = application.handle_request({"request_kind": request_kind})

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "SCHEMA_VERSION_UNSUPPORTED"
    assert result["diagnostics"][0]["details"]["received_schema_version"] == "missing"


def test_generic_schedule_api_also_rejects_missing_schema() -> None:
    result = application.handle_request({})

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "SCHEMA_VERSION_UNSUPPORTED"


def test_fixture_envelope_remains_the_only_schema_less_exception() -> None:
    result = application.handle_request(
        {"fixture": "smoke", "solver_options": {"max_time_seconds": 1}}
    )

    assert not (
        result.get("status") == "error"
        and result.get("diagnostics")
        and result["diagnostics"][0]["code"] == "SCHEMA_VERSION_UNSUPPORTED"
    )


@pytest.mark.parametrize("mutation", ["policy", "warnings", "rank_ref", "match_graph"])
def test_same_rank_results_boundary_rejects_derived_plan_tampering(mutation: str) -> None:
    plan = deepcopy(_same_rank_plan())
    if mutation == "policy":
        plan["uneven_policy"] = "merge_bottom"
    elif mutation == "warnings":
        plan["warnings"] = []
    elif mutation == "rank_ref":
        group = plan["groups"][0]
        participant = group["participants"][0]
        old_block_id = participant["entry"]["block_id"]
        participant["entry"]["block_id"] = "forged-block"
        for match in group["matches"]:
            for side in ("home", "away"):
                if match[side]["block_id"] == old_block_id and match[side]["rank"] == 1:
                    match[side]["block_id"] = "forged-block"
    else:
        group = plan["groups"][0]
        old_match_id = group["matches"][0]["id"]
        group["matches"][0]["id"] = "SR-FORGED-M1"
        for logical_round in group["logical_rounds"]:
            logical_round["match_ids"] = [
                "SR-FORGED-M1" if match_id == old_match_id else match_id
                for match_id in logical_round["match_ids"]
            ]

    result = application.handle_request(
        {
            "schema_version": "0.2.0",
            "request_kind": "same_rank_league_results",
            "same_rank_plan": plan,
            "results": [],
        }
    )

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "SAME_RANK_SOURCE_INVALID"


def test_tournament_results_boundary_rejects_seed_rank_band_tampering() -> None:
    plan = deepcopy(_placement_plan())
    plan["seed_draws"] = []
    plan["pools"][0]["seeds"][0], plan["pools"][1]["seeds"][0] = (
        plan["pools"][1]["seeds"][0],
        plan["pools"][0]["seeds"][0],
    )

    result = application.handle_request(
        {
            "schema_version": "0.2.0",
            "request_kind": "tournament_results",
            "tournament_plan": plan,
            "results": [],
        }
    )

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "TOURNAMENT_SOURCE_INVALID"


@pytest.mark.parametrize("mutation", ["display_name", "entry_dependency"])
def test_tournament_results_boundary_rejects_pool_graph_tampering(mutation: str) -> None:
    plan = deepcopy(_placement_plan())
    pool = plan["pools"][0]
    if mutation == "display_name":
        pool["display_name"] = "改ざんされた順位帯"
    else:
        match = pool["matches"][0]
        match["home"], match["away"] = match["away"], match["home"]
        opening = pool["logical_layout"]["opening_entry_order"]
        opening[0], opening[1] = opening[1], opening[0]

    result = application.handle_request(
        {
            "schema_version": "0.2.0",
            "request_kind": "tournament_results",
            "tournament_plan": plan,
            "results": [],
        }
    )

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "TOURNAMENT_SOURCE_INVALID"


def test_same_rank_schedule_boundary_rejects_tampered_plan() -> None:
    league = _league(18, 4)
    plan = _same_rank_plan()
    plan["uneven_policy"] = "merge_bottom"

    with pytest.raises(SameRankScheduleError) as caught:
        generate_same_rank_day2_schedule(
            {
                "request_kind": "same_rank_day2_schedule",
                "teams": [
                    {"id": team_id, "name": team_id}
                    for block in league.blocks
                    for team_id in block.team_ids
                ],
                "courts": [{"id": "court-a", "name": "Aコート"}],
                "league_plan": league.model_dump(mode="json"),
                "day1_schedule": {"day": {"id": "day1"}, "slots": []},
                "same_rank_plan": plan,
                "day": {"id": "day2", "max_sections": 64},
                "referees": {"organizer_capacity": 1, "day2_fallback": "organizer"},
            }
        )

    assert caught.value.code == "SAME_RANK_SOURCE_INVALID"


def test_tournament_schedule_boundary_rejects_tampered_plan() -> None:
    league = _league(8, 2)
    plan = _placement_plan()
    plan["pools"][0]["display_name"] = "改ざんされた順位帯"

    with pytest.raises(Day2ScheduleError) as caught:
        generate_day2_schedule(
            {
                "request_kind": "day2_schedule",
                "teams": [
                    {"id": team_id, "name": team_id}
                    for block in league.blocks
                    for team_id in block.team_ids
                ],
                "courts": [{"id": "court-a", "name": "Aコート"}],
                "league_plan": league.model_dump(mode="json"),
                "day1_schedule": {"day": {"id": "day1"}, "slots": []},
                "tournament_plan": plan,
                "day": {"id": "day2", "max_sections": 64},
                "referees": {"organizer_capacity": 1, "day2_fallback": "organizer"},
            }
        )

    assert caught.value.code == "TOURNAMENT_SOURCE_INVALID"


def test_tournament_plan_rejects_unequal_league_blocks_with_source_diagnostic() -> None:
    league = _league(8, 2).model_dump(mode="json")
    moved = league["blocks"][1]["team_ids"].pop()
    league["blocks"][0]["team_ids"].append(moved)

    result = application.handle_request(
        {
            "schema_version": "0.2.0",
            "request_kind": "tournament_plan",
            "league_plan": league,
            "final_stage": {"format": "placement_tournament", "tournament_count": 2},
            "random_seed": 41,
        }
    )

    assert result["status"] == "error"
    diagnostic = result["diagnostics"][0]
    assert diagnostic["code"] == "TOURNAMENT_SOURCE_INVALID"
    assert diagnostic["details"] == {
        "reason": "unequal_block_sizes",
        "expected_block_size": 4,
        "actual_block_sizes": [5, 3],
    }
