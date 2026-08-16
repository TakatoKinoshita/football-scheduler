from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from football_scheduler.application import handle_request
from football_scheduler.league import generate_league_plan
from football_scheduler.league_results import LeagueStandings, Standing
from football_scheduler.same_rank_league import generate_same_rank_league_plan

_FIXTURE_PATH = (
    Path(__file__).parents[1] / "web" / "src" / "test-fixtures" / "local-standings-parity.json"
)


def _fixture() -> dict[str, Any]:
    fixture = json.loads(_FIXTURE_PATH.read_text(encoding="utf-8"))
    assert fixture["fixture_version"] == 1
    return fixture


def _league_request(results: list[dict[str, object]], *, seed: int = 99) -> dict[str, object]:
    plan = generate_league_plan(
        {
            "teams": [{"id": team, "name": team} for team in ("A", "B", "C", "D")],
            "block_count": 1,
            "assignment_mode": "seeded_snake",
            "random_seed": seed,
        }
    )
    return {
        "schema_version": "0.2.0",
        "request_kind": "league_standings",
        "league_plan": plan.model_dump(mode="json"),
        "results": results,
        "random_seed": seed,
    }


def _same_rank_request(*, penalty: bool = False) -> dict[str, object]:
    league = generate_league_plan(
        {
            "teams": [{"id": f"T{number}", "name": f"T{number}"} for number in range(1, 5)],
            "block_count": 2,
            "assignment_mode": "seeded_snake",
            "random_seed": 41,
        }
    )
    league_standings = LeagueStandings(
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
            for block in league.blocks
            for rank, team_id in enumerate(block.team_ids, 1)
        ),
        draws=(),
    )
    plan = generate_same_rank_league_plan(
        {
            "request_kind": "same_rank_league_plan",
            "league_plan": league.model_dump(mode="json"),
            "league_standings": league_standings.model_dump(mode="json"),
            "final_stage": {
                "format": "same_rank_league",
                "uneven_policy": "strict_same_rank",
            },
            "random_seed": 41,
        }
    )
    results: list[dict[str, object]] = [
        {
            "match_id": match.id,
            "home_team_id": match.home_team.team_id if match.home_team else "",
            "away_team_id": match.away_team.team_id if match.away_team else "",
            "regular_score_home": 1,
            "regular_score_away": 1,
        }
        for group in plan.groups
        for match in group.matches
    ]
    if penalty:
        results[0]["penalty_score_home"] = 4
        results[0]["penalty_score_away"] = 3
    return {
        "schema_version": "0.2.0",
        "request_kind": "same_rank_league_results",
        "same_rank_plan": plan.model_dump(mode="json"),
        "results": results,
    }


def _first_diagnostic(response: dict[str, object]) -> dict[str, object]:
    diagnostics = response["diagnostics"]
    assert isinstance(diagnostics, list)
    diagnostic = diagnostics[0]
    assert isinstance(diagnostic, dict)
    return diagnostic


def test_league_golden_response_matches_public_python_boundary() -> None:
    fixture = _fixture()["league_all_draws"]
    scores = fixture["scores"]
    request = _league_request(
        [
            {"match_id": f"LG-A-M{index}", "home_score": score[0], "away_score": score[1]}
            for index, score in enumerate(scores, 1)
        ],
        seed=fixture["random_seed"],
    )
    assert handle_request(request) == fixture["expected"]


def test_league_error_golden_matches_public_python_boundary() -> None:
    response = handle_request(_league_request([]))
    assert _first_diagnostic(response) == _fixture()["league_missing_error"]["expected"]


def test_same_rank_golden_response_matches_public_python_boundary() -> None:
    assert handle_request(_same_rank_request()) == _fixture()["same_rank_all_draws"]["expected"]


def test_same_rank_error_golden_matches_public_python_boundary() -> None:
    response = handle_request(_same_rank_request(penalty=True))
    assert _first_diagnostic(response) == _fixture()["same_rank_penalty_error"]["expected"]
