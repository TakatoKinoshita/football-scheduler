from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from pathlib import Path
from time import monotonic
from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

from football_scheduler import application

_ISSUE_75_FIXTURE = (
    Path(__file__).resolve().parents[1] / "scripts/fixtures/tournament-results-8.json"
)


def _handle_request(payload: dict[str, Any]) -> dict[str, Any]:
    """通常APIテストでは明示的な現行schemaを送る。"""

    request = dict(payload)
    if "fixture" not in request:
        request.setdefault("schema_version", "0.2.0")
    return application.handle_request(request)


class _ModelLike:
    def __init__(self, value: dict[str, Any]) -> None:
        self.value = value

    def model_dump(self, *, mode: str) -> dict[str, Any]:
        assert mode == "json"
        return self.value


def _request() -> dict[str, Any]:
    return {
        "schema_version": "0.2.0",
        "day": {
            "id": "day1",
            "start_time": "09:30",
            "game_duration_minutes": 35,
            "margin_minutes": 5,
            "max_sections": 2,
        },
        "teams": [{"id": "A"}, {"id": "B"}],
        "courts": [{"id": "court-a"}],
        "matches": [{"id": "M1", "home_team_id": "A", "away_team_id": "B"}],
        "referees": {
            "organizer_capacity": 1,
            "team_referees_required_after_first": False,
        },
        "random_seed": 1,
        "solver": {"max_time_seconds": 5},
    }


def _result() -> dict[str, Any]:
    return {
        "schema_version": "0.2.0",
        "status": "optimal",
        "slots": [
            {
                "day_id": "day1",
                "section_no": 1,
                "court_id": "court-a",
                "match_id": "M1",
                "referee_assignment": {"type": "organizer"},
            }
        ],
    }


def _day1_league_request(
    *,
    team_count: int = 8,
    block_count: int = 2,
    assignment_mode: str = "random",
    court_count: int = 1,
    manual_blocks: list[dict[str, object]] | None = None,
) -> dict[str, Any]:
    request: dict[str, Any] = {
        "schema_version": "0.2.0",
        "request_kind": "day1_league",
        "teams": [
            {"id": f"team-{index + 1}", "name": f"チーム{index + 1}"} for index in range(team_count)
        ],
        "courts": [
            {"id": f"court-{index + 1}", "name": f"{index + 1}コート"}
            for index in range(court_count)
        ],
        "league": {
            "block_count": block_count,
            "assignment_mode": assignment_mode,
        },
        "final_stage": _final_stage_config(team_count, block_count),
        "day": {
            "id": "day1",
            "start_time": "09:30",
            "game_duration_minutes": 35,
            "margin_minutes": 5,
        },
        "referees": {
            "organizer_capacity": court_count,
            "team_referees_required_after_first": False,
        },
        "random_seed": 20260803,
        "solver": {"max_time_seconds": 30},
    }
    if manual_blocks is not None:
        request["league"]["manual_blocks"] = manual_blocks
    return request


def _final_stage_config(team_count: int, block_count: int) -> dict[str, object]:
    placement_counts = {8: 2, 16: 2, 24: 3, 32: 2}
    allowed_blocks = {
        (8, 2): {2, 4},
        (16, 2): {2, 4, 8},
        (24, 3): {2, 4, 8},
        (32, 2): {2, 4, 8, 16},
    }
    tournament_count = placement_counts.get(team_count)
    if (
        tournament_count is not None
        and block_count in allowed_blocks[(team_count, tournament_count)]
    ):
        return {"format": "placement_tournament", "tournament_count": tournament_count}
    if 4 <= team_count <= 32 and 2 <= block_count <= team_count // 2:
        return {
            "format": "same_rank_league",
            "uneven_policy": (
                "strict_same_rank" if team_count % block_count == 0 else "merge_bottom"
            ),
        }
    return {"format": "placement_tournament", "tournament_count": 2}


def _day2_creation_request(
    day1_request: dict[str, Any],
    day1_result: dict[str, Any],
    *,
    standings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    request: dict[str, Any] = {
        "schema_version": "0.2.0",
        "request_kind": "day2_creation",
        "teams": day1_request["teams"],
        "courts": day1_request["courts"],
        "league_plan": day1_result["league_plan"],
        "final_stage": day1_request["final_stage"],
        "day1_schedule": {
            "day": day1_request["day"],
            "slots": day1_result["slots"],
        },
        "day": {
            "id": "day2",
            "start_time": "09:30",
            "game_duration_minutes": 35,
            "margin_minutes": 10,
        },
        "referees": {
            "organizer_capacity": len(day1_request["courts"]),
            "day2_fallback": "organizer",
        },
        "random_seed": 20260803,
        "solver": {"max_time_seconds": 5},
    }
    if standings is not None:
        request["league_standings"] = standings
    return request


def _schedule_creation_request(
    day1_request: dict[str, Any],
    *,
    generation_scope: str = "all",
    existing_result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    request = {
        **day1_request,
        "request_kind": "schedule_creation",
        "generation_scope": generation_scope,
        "day2": {
            "id": "day2",
            "start_time": "09:30",
            "game_duration_minutes": 35,
            "margin_minutes": 10,
        },
    }
    if existing_result is not None:
        request["existing_result"] = existing_result
    return request


def test_direct_request_is_solved_and_independently_validated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    received: list[dict[str, Any]] = []

    def fake_solve(request: dict[str, Any]) -> _ModelLike:
        received.append(request)
        return _ModelLike(_result())

    monkeypatch.setattr(application, "solve_schedule", fake_solve)

    result = _handle_request(_request())

    assert result["status"] == "optimal"
    assert result["validation"]["valid"] is True
    assert received[0]["solver"]["max_time_seconds"] == 5


def test_public_generation_normalizes_excess_organizer_capacity_to_court_count(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    received: list[dict[str, Any]] = []
    request = _request()
    request["referees"] = {**request["referees"], "organizer_capacity": 16}
    monkeypatch.setattr(
        application,
        "solve_schedule",
        lambda value: received.append(value) or _ModelLike(_result()),
    )

    result = _handle_request(request)

    assert result["status"] == "optimal"
    assert received[0]["referees"]["organizer_capacity"] == 1


def test_day1_league_request_generates_match_and_passes_independent_validation() -> None:
    result = _handle_request(_day1_league_request())

    assert result["status"] in {"OPTIMAL", "FEASIBLE"}, result
    assert result["schedule_scope"] == "day1_league"
    assert result["validation"]["valid"] is True
    assert len(result["league_plan"]["blocks"]) == 2
    assert len(result["league_plan"]["logical_rounds"]) == 6
    assert len(result["league_plan"]["matches"]) == 12
    assert {slot["match_id"] for slot in result["slots"] if slot["match_id"] is not None} == {
        match["id"] for match in result["league_plan"]["matches"]
    }
    metrics = result["metrics"]
    validation_summary = result["validation"]["summary"]
    assert metrics["league_team_referee_counts"] == validation_summary["league_team_referee_counts"]
    assert (
        metrics["league_team_referee_count_difference"]
        == validation_summary["league_team_referee_count_difference"]
    )


def test_day1_league_request_keeps_arrival_preference_soft_and_auditable() -> None:
    request = _day1_league_request(team_count=4, block_count=2, court_count=2)
    request["day1_arrival_preferences"] = [{"team_id": "team-1", "earliest_section": 128}]

    result = _handle_request(request)

    assert result["status"] in {"OPTIMAL", "FEASIBLE"}, result
    assert result["validation"]["valid"] is True
    assert result["metrics"]["day1_arrival_early_match_count"] == 1
    assert result["validation"]["summary"]["day1_arrival_early_match_count"] == 1
    assert "DAY1_ARRIVAL_PREFERENCE_UNMET" in {item["code"] for item in result["diagnostics"]}


def test_compact_day1_league_prioritizes_arrival_before_quality_objectives() -> None:
    request = _day1_league_request(team_count=8, block_count=2, court_count=2)
    request["referees"]["team_referees_required_after_first"] = True
    request["day1_arrival_preferences"] = [{"team_id": "team-1", "earliest_section": 3}]

    result = _handle_request(request)

    assert result["status"] in {"OPTIMAL", "FEASIBLE"}, result
    assert result["metrics"]["model_variant"] == "compact_day1_league"
    assert result["validation"]["valid"] is True
    assert [stage["objective"] for stage in result["metrics"]["objective_stages"]][:4] == [
        "used_sections",
        "day1_arrival_early_match_count",
        "day1_arrival_total_section_shortfall",
        "league_team_referee_count_difference",
    ]


def test_day1_arrival_preference_count_is_limited_before_validation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = _day1_league_request(team_count=4, block_count=2, court_count=2)
    request["day1_arrival_preferences"] = [
        {"team_id": "team-1", "earliest_section": 2} for _ in range(application.MAX_TEAMS + 1)
    ]
    monkeypatch.setattr(
        application,
        "solve_schedule",
        lambda _: pytest.fail("solver must not run"),
    )

    result = _handle_request(request)

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "TEAM_LIMIT_EXCEEDED"


def test_day1_league_request_adds_block_ids_before_solving(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    received: list[dict[str, Any]] = []
    monkeypatch.setattr(
        application,
        "solve_schedule",
        lambda request: received.append(request) or _ModelLike(_result()),
    )

    result = _handle_request(
        _day1_league_request(team_count=8, block_count=2, assignment_mode="seeded_snake")
    )

    assert result["status"] == "optimal"
    assert {team["block_id"] for team in received[0]["teams"]} == {"A", "B"}
    assert len(received[0]["matches"]) == 12
    assert result["league_plan"]["blocks"] == [
        {"id": "A", "team_ids": ["team-1", "team-4", "team-5", "team-8"]},
        {"id": "B", "team_ids": ["team-2", "team-3", "team-6", "team-7"]},
    ]


def test_day1_league_request_preserves_manual_blocks() -> None:
    manual_blocks: list[dict[str, object]] = [
        {"id": "A", "team_ids": ["team-1", "team-3"]},
        {"id": "B", "team_ids": ["team-2", "team-4"]},
    ]

    result = _handle_request(
        _day1_league_request(
            team_count=4,
            block_count=2,
            assignment_mode="manual",
            court_count=2,
            manual_blocks=manual_blocks,
        )
    )

    assert result["status"] in {"OPTIMAL", "FEASIBLE"}, result
    assert result["league_plan"]["assignment_mode"] == "manual"
    assert result["league_plan"]["blocks"] == manual_blocks
    assert result["league_plan"]["manual_completion"] == {"automatic_assignments": []}
    assert len(result["league_plan"]["matches"]) == 2


def test_day1_league_request_completes_partial_manual_blocks() -> None:
    result = _handle_request(
        _day1_league_request(
            team_count=5,
            block_count=2,
            assignment_mode="manual",
            court_count=2,
            manual_blocks=[
                {"id": "A", "team_ids": ["team-1"]},
                {"id": "B", "team_ids": ["team-2"]},
            ],
        )
    )

    assert result["status"] in {"OPTIMAL", "FEASIBLE"}, result
    blocks = result["league_plan"]["blocks"]
    assert blocks[0]["team_ids"][0] == "team-1"
    assert blocks[1]["team_ids"][0] == "team-2"
    assert sorted(team_id for block in blocks for team_id in block["team_ids"]) == [
        "team-1",
        "team-2",
        "team-3",
        "team-4",
        "team-5",
    ]
    assert len(result["league_plan"]["manual_completion"]["automatic_assignments"]) == 3


def test_day1_league_request_rejects_manual_imbalance_before_solver(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        application,
        "solve_schedule",
        lambda _: pytest.fail("solver must not run"),
    )
    result = _handle_request(
        _day1_league_request(
            team_count=5,
            block_count=2,
            assignment_mode="manual",
            manual_blocks=[
                {"id": "A", "team_ids": ["team-1", "team-2", "team-3", "team-4"]},
                {"id": "B", "team_ids": ["team-5"]},
            ],
        )
    )

    assert result["status"] == "error"
    diagnostic = result["diagnostics"][0]
    assert diagnostic["code"] == "MANUAL_BLOCK_SIZE_IMBALANCE"
    assert diagnostic["details"]["block_sizes"] == {"A": 4, "B": 1}


def test_day1_league_request_rejects_unknown_manual_block_before_solver(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        application,
        "solve_schedule",
        lambda _: pytest.fail("solver must not run"),
    )
    result = _handle_request(
        _day1_league_request(
            team_count=4,
            block_count=2,
            assignment_mode="manual",
            manual_blocks=[
                {"id": "A", "team_ids": ["team-1", "team-2"]},
                {"id": "C", "team_ids": ["team-3", "team-4"]},
            ],
        )
    )

    assert result["status"] == "error"
    diagnostic = result["diagnostics"][0]
    assert diagnostic["code"] == "MANUAL_BLOCK_REFERENCE_INVALID"
    assert diagnostic["details"] == {
        "expected_block_ids": ["A", "B"],
        "missing_block_ids": ["B"],
        "unknown_block_ids": ["C"],
    }


@pytest.mark.parametrize(
    ("manual_blocks", "code"),
    [
        (None, "MANUAL_BLOCKS_REQUIRED"),
        (
            [{"id": "A", "team_ids": ["team-1", "team-2", "team-3", "team-4"]}],
            "MANUAL_BLOCK_COUNT_MISMATCH",
        ),
        (
            [
                {"id": "A", "team_ids": ["team-1", "team-2"]},
                {"id": "A", "team_ids": ["team-3", "team-4"]},
            ],
            "DUPLICATE_BLOCK_ID",
        ),
        (
            [
                {"id": "A", "team_ids": ["team-1", "team-99"]},
                {"id": "B", "team_ids": ["team-3", "team-4"]},
            ],
            "UNKNOWN_TEAM_IN_MANUAL_BLOCKS",
        ),
        (
            [
                {"id": "A", "team_ids": ["team-1", "team-2"]},
                {"id": "B", "team_ids": ["team-2", "team-4"]},
            ],
            "DUPLICATE_TEAM_IN_MANUAL_BLOCKS",
        ),
    ],
)
def test_day1_public_manual_validation_rejects_invalid_membership_before_solver(
    monkeypatch: pytest.MonkeyPatch,
    manual_blocks: list[dict[str, object]] | None,
    code: str,
) -> None:
    monkeypatch.setattr(
        application,
        "solve_schedule",
        lambda _: pytest.fail("solver must not run"),
    )
    result = _handle_request(
        _day1_league_request(
            team_count=4,
            block_count=2,
            assignment_mode="manual",
            manual_blocks=manual_blocks,
        )
    )

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == code


def test_day1_public_automatic_mode_rejects_manual_blocks_before_solver(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        application,
        "solve_schedule",
        lambda _: pytest.fail("solver must not run"),
    )
    result = _handle_request(
        _day1_league_request(
            team_count=4,
            block_count=2,
            assignment_mode="random",
            manual_blocks=[
                {"id": "A", "team_ids": ["team-1", "team-2"]},
                {"id": "B", "team_ids": ["team-3", "team-4"]},
            ],
        )
    )

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "MANUAL_BLOCKS_NOT_ALLOWED"


def test_league_standings_request_returns_rankings_after_all_results_are_entered() -> None:
    generated = _handle_request(_day1_league_request(team_count=4, block_count=2))

    result = _handle_request(
        {
            "request_kind": "league_standings",
            "league_plan": generated["league_plan"],
            "results": [
                {"match_id": match["id"], "home_score": 2, "away_score": 1}
                for match in generated["league_plan"]["matches"]
            ],
            "random_seed": 20260803,
        }
    )

    assert result["status"] == "COMPLETE"
    assert [standing["rank"] for standing in result["standings"]] == [1, 2, 1, 2]


def test_league_standings_request_reports_missing_results() -> None:
    generated = _handle_request(_day1_league_request(team_count=4, block_count=2))

    result = _handle_request(
        {
            "request_kind": "league_standings",
            "league_plan": generated["league_plan"],
            "results": [],
        }
    )

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "LEAGUE_RESULTS_INCOMPLETE"


def test_tournament_plan_request_returns_complete_ordered_pools() -> None:
    generated_request = _day1_league_request(team_count=8, block_count=2)
    generated = _handle_request(generated_request)
    standings = _handle_request(
        {
            "request_kind": "league_standings",
            "league_plan": generated["league_plan"],
            "results": [
                {"match_id": match["id"], "home_score": 0, "away_score": 0}
                for match in generated["league_plan"]["matches"]
            ],
            "random_seed": 20260803,
        }
    )

    result = _handle_request(
        {
            "request_kind": "tournament_plan",
            "league_plan": generated["league_plan"],
            "league_standings": standings,
            "final_stage": generated_request["final_stage"],
            "random_seed": 20260803,
        }
    )

    assert result["status"] == "COMPLETE"
    assert [pool["pool_id"] for pool in result["pools"]] == ["placement-1", "placement-2"]
    assert all(pool["participant_count"] == 4 for pool in result["pools"])
    assert all(len(pool["matches"]) == 4 for pool in result["pools"])


def test_tournament_results_request_returns_overall_final_standings() -> None:
    generated_request = _day1_league_request(team_count=8, block_count=2)
    generated = _handle_request(generated_request)
    standings = _handle_request(
        {
            "request_kind": "league_standings",
            "league_plan": generated["league_plan"],
            "results": [
                {"match_id": match["id"], "home_score": 0, "away_score": 0}
                for match in generated["league_plan"]["matches"]
            ],
            "random_seed": 20260803,
        }
    )
    tournament = _handle_request(
        {
            "request_kind": "tournament_plan",
            "league_plan": generated["league_plan"],
            "league_standings": standings,
            "final_stage": generated_request["final_stage"],
            "random_seed": 20260803,
        }
    )
    team_by_rank = {
        (seed["block_id"], seed["block_rank"]): seed["team_id"]
        for pool in tournament["pools"]
        for seed in pool["seeds"]
    }
    results = []
    winners: dict[str, str] = {}
    losers: dict[str, str] = {}

    def resolved_team(entry: dict[str, Any]) -> str:
        if entry["type"] == "league_rank":
            return team_by_rank[(entry["block_id"], entry["rank"])]
        if entry["type"] == "winner_of":
            return winners[entry["match_id"]]
        return losers[entry["match_id"]]

    for pool in tournament["pools"]:
        for match in pool["matches"]:
            home = match["home"]
            away = match["away"]
            home_team = resolved_team(home)
            away_team = resolved_team(away)
            results.append(
                {
                    "match_id": match["id"],
                    "home_team_id": home_team,
                    "away_team_id": away_team,
                    "regular_score_home": 1,
                    "regular_score_away": 0,
                }
            )
            winners[match["id"]] = home_team
            losers[match["id"]] = away_team

    outcome = _handle_request(
        {
            "request_kind": "tournament_results",
            "tournament_plan": tournament,
            "results": results,
        }
    )

    assert outcome["status"] == "COMPLETE"
    assert [row["rank"] for row in outcome["standings"]] == list(range(1, 9))
    assert [row["pool_id"] for row in outcome["standings"]] == [
        "placement-1",
        "placement-1",
        "placement-1",
        "placement-1",
        "placement-2",
        "placement-2",
        "placement-2",
        "placement-2",
    ]


def test_issue_75_fixture_returns_all_eight_final_standings() -> None:
    request = json.loads(_ISSUE_75_FIXTURE.read_text(encoding="utf-8"))

    outcome = _handle_request(request)

    assert outcome["status"] == "COMPLETE"
    assert [row["rank"] for row in outcome["standings"]] == list(range(1, 9))
    assert len({row["team_id"] for row in outcome["standings"]}) == 8


def test_tournament_score_schema_error_points_to_editable_score() -> None:
    request = json.loads(_ISSUE_75_FIXTURE.read_text(encoding="utf-8"))
    request["results"][0]["regular_score_home"] = -1

    outcome = _handle_request(request)

    diagnostic = outcome["diagnostics"][0]
    assert diagnostic["code"] == "INPUT_SCHEMA_INVALID"
    assert diagnostic["details"]["scope"] == "tournament_scores"
    assert diagnostic["details"]["errors"] == [
        {
            "field": "results.0.regular_score_home",
            "message": "得点は0以上の整数で入力してください。",
            "type": "greater_than_equal",
            "match_id": "PT-1-RANK-1-4-M1",
            "score_field": "regular_score_home",
        }
    ]
    assert "項目別の説明" not in diagnostic["message"]


def test_tournament_contract_or_plan_schema_error_is_internal_data_problem() -> None:
    request = json.loads(_ISSUE_75_FIXTURE.read_text(encoding="utf-8"))
    request["final_stage"] = {"format": "placement_tournament", "tournament_count": 2}

    outcome = _handle_request(request)

    diagnostic = outcome["diagnostics"][0]
    assert diagnostic == {
        "code": "INPUT_SCHEMA_INVALID",
        "message": (
            "保存された2日目の計画と結果の整合性を確認できませんでした。"
            "入力した結果は保持されています。ページを再読み込みして、もう一度お試しください。"
        ),
        "details": {"scope": "tournament_data"},
    }


def test_tournament_plan_request_returns_provisional_table_without_standings() -> None:
    generated_request = _day1_league_request(team_count=8, block_count=2)
    generated = _handle_request(generated_request)

    result = _handle_request(
        {
            "request_kind": "tournament_plan",
            "league_plan": generated["league_plan"],
            "final_stage": generated_request["final_stage"],
            "random_seed": 20260803,
        }
    )

    assert result["status"] == "COMPLETE"
    assert result["participant_resolution"] == "provisional"
    assert all(
        seed["team_id"] is None and seed["team"] is None
        for pool in result["pools"]
        for seed in pool["seeds"]
    )


def test_tournament_plan_request_reports_inconsistent_standings_in_japanese() -> None:
    generated_request = _day1_league_request(team_count=8, block_count=2)
    generated = _handle_request(generated_request)
    standings = _handle_request(
        {
            "request_kind": "league_standings",
            "league_plan": generated["league_plan"],
            "results": [
                {"match_id": match["id"], "home_score": 1, "away_score": 0}
                for match in generated["league_plan"]["matches"]
            ],
        }
    )
    standings["standings"].pop()

    result = _handle_request(
        {
            "request_kind": "tournament_plan",
            "league_plan": generated["league_plan"],
            "league_standings": standings,
            "final_stage": generated_request["final_stage"],
        }
    )

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "TOURNAMENT_SOURCE_INVALID"
    assert "順位を再確定" in result["diagnostics"][0]["message"]


def test_tournament_plan_request_rejects_team_limit() -> None:
    result = _handle_request(
        {
            "request_kind": "tournament_plan",
            "final_stage": {"format": "placement_tournament", "tournament_count": 2},
            "league_plan": {
                "blocks": [
                    {"id": f"B{index}", "team_ids": [f"T{index}"]}
                    for index in range(application.MAX_TEAMS + 1)
                ],
                "matches": [],
            },
            "league_standings": {"standings": []},
        }
    )

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "TEAM_LIMIT_EXCEEDED"


def test_league_standings_request_rejects_result_limit() -> None:
    result = _handle_request(
        {
            "request_kind": "league_standings",
            "league_plan": {"matches": []},
            "results": [
                {"match_id": f"M{index}", "home_score": 0, "away_score": 0}
                for index in range(application.MAX_MATCHES + 1)
            ],
        }
    )

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "MATCH_LIMIT_EXCEEDED"


def test_inferred_horizon_does_not_become_a_silent_hard_constraint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    received: list[dict[str, Any]] = []

    def fake_solve(request: dict[str, Any]) -> _ModelLike:
        received.append(request)
        if len(received) == 1:
            return _ModelLike({**_result(), "status": "INFEASIBLE", "slots": []})
        return _ModelLike(_result())

    monkeypatch.setattr(application, "solve_schedule", fake_solve)

    result = _handle_request(_day1_league_request())

    assert result["status"] == "optimal"
    assert received[0]["day"]["max_sections"] == len(received[0]["matches"]) * 2
    assert received[1]["day"]["max_sections"] is None


def test_day1_league_request_rejects_block_count_above_team_count(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        application,
        "solve_schedule",
        lambda _: pytest.fail("solver must not run"),
    )

    result = _handle_request(_day1_league_request(team_count=8, block_count=9))

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "PLACEMENT_TOURNAMENT_BLOCK_COUNT_INVALID"
    assert result["diagnostics"][0]["details"]["block_count"] == 9


@pytest.mark.parametrize(
    ("team_count", "block_count", "court_count"),
    [(8, 2, 2), (16, 4, 3), (32, 8, 4)],
)
def test_day1_league_mvp_sizes_finish_within_thirty_seconds(
    team_count: int,
    block_count: int,
    court_count: int,
) -> None:
    started = monotonic()

    result = _handle_request(
        _day1_league_request(
            team_count=team_count,
            block_count=block_count,
            court_count=court_count,
        )
    )

    assert monotonic() - started < 30
    assert result["status"] in {"OPTIMAL", "FEASIBLE"}, result
    assert result["validation"]["valid"] is True
    assert len(result["league_plan"]["blocks"]) == block_count
    assert len(result["league_plan"]["matches"]) == block_count * 6


def test_day1_league_missing_day_returns_field_detail_without_running_solver(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = _day1_league_request()
    request.pop("day")
    monkeypatch.setattr(
        application,
        "solve_schedule",
        lambda _: pytest.fail("solver must not run"),
    )

    result = _handle_request(request)

    diagnostic = result["diagnostics"][0]
    assert diagnostic["code"] == "INPUT_SCHEMA_INVALID"
    assert diagnostic["details"]["errors"][0]["field"] == "day"
    assert "表示された項目を確認" not in diagnostic["message"]


def test_public_generation_rejects_organizer_capacity_below_court_count_before_solver(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = _day1_league_request()
    request["referees"] = {
        "organizer_capacity": 0,
        "team_referees_required_after_first": False,
    }
    monkeypatch.setattr(
        application,
        "solve_schedule",
        lambda _: pytest.fail("solver must not run"),
    )

    result = _handle_request(request)

    assert result["status"] == "error"
    diagnostic = result["diagnostics"][0]
    assert diagnostic["code"] == "ORGANIZER_CAPACITY_BELOW_COURT_COUNT"
    assert diagnostic["details"] == {"organizer_capacity": 0, "court_count": 1}
    assert "使用コート数以上" in diagnostic["message"]


def test_day1_league_reports_insufficient_slots() -> None:
    request = _day1_league_request(team_count=4)
    request["day"]["max_sections"] = 1

    result = _handle_request(request)

    assert result["status"] == "INFEASIBLE"
    assert result["diagnostics"][0]["code"] == "INSUFFICIENT_SLOTS"


def test_fixture_and_solver_options_are_resolved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    received: list[dict[str, Any]] = []
    monkeypatch.setattr(application, "make_smoke_request", lambda: _ModelLike(_request()))
    monkeypatch.setattr(
        application,
        "solve_schedule",
        lambda request: received.append(request) or _ModelLike(_result()),
    )

    _handle_request({"fixture": "smoke", "solver_options": {"max_time_seconds": 2}})

    assert received[0]["solver"]["max_time_seconds"] == 2


def test_mvp_maximum_fixture_is_available(monkeypatch: pytest.MonkeyPatch) -> None:
    received: list[dict[str, Any]] = []
    monkeypatch.setattr(
        application,
        "solve_schedule",
        lambda request: received.append(request) or _ModelLike(_result()),
    )

    result = _handle_request({"fixture": "mvp_maximum"})

    assert result["status"] == "optimal"
    assert len(received[0]["teams"]) == 32
    assert len(received[0]["courts"]) == 4
    assert len(received[0]["matches"]) == 48
    assert received[0]["solver"]["max_time_seconds"] == 20


def test_environment_time_limit_caps_requested_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    received: list[dict[str, Any]] = []
    monkeypatch.setenv("SOLVER_MAX_TIME_SECONDS", "1.5")
    monkeypatch.setattr(
        application,
        "solve_schedule",
        lambda request: received.append(request) or _ModelLike(_result()),
    )

    _handle_request(_request())

    assert received[0]["solver"]["max_time_seconds"] == 1.5


def test_rejects_team_count_over_verification_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = _request()
    request["teams"] = [{"id": f"T{index}"} for index in range(application.MAX_TEAMS + 1)]
    monkeypatch.setattr(
        application,
        "solve_schedule",
        lambda _: pytest.fail("solver must not run"),
    )

    result = _handle_request(request)

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "TEAM_LIMIT_EXCEEDED"


def test_unknown_fixture_returns_japanese_diagnostic() -> None:
    result = _handle_request({"fixture": "large"})

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "UNKNOWN_FIXTURE"
    assert "smoke" in result["diagnostics"][0]["message"]


def test_pydantic_validation_error_does_not_escape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class RequiredValue(BaseModel):
        value: int

    try:
        RequiredValue.model_validate({})
    except ValidationError as validation_error:
        captured = validation_error

    def fail_validation(_: dict[str, Any]) -> Any:
        raise captured

    monkeypatch.setattr(application, "solve_schedule", fail_validation)

    result = _handle_request(_request())

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "INPUT_SCHEMA_INVALID"
    assert result["diagnostics"][0]["details"]["errors"][0]["field"] == "value"


def test_unexpected_exception_is_not_exposed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        application,
        "solve_schedule",
        lambda _: (_ for _ in ()).throw(RuntimeError("secret implementation detail")),
    )

    result = _handle_request(_request())

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "SCHEDULE_GENERATION_FAILED"
    assert "secret" not in str(result)


def test_day2_schedule_request_keeps_day1_and_returns_integrated_validation() -> None:
    day1_request = _day1_league_request(team_count=8, block_count=2, court_count=2)
    day1 = _handle_request(day1_request)
    assert day1["status"] in {"OPTIMAL", "FEASIBLE"}
    standings = _handle_request(
        {
            "request_kind": "league_standings",
            "league_plan": day1["league_plan"],
            "results": [
                {"match_id": match["id"], "home_score": 1, "away_score": 0}
                for match in day1["league_plan"]["matches"]
            ],
            "random_seed": 20260803,
        }
    )
    tournament = _handle_request(
        {
            "request_kind": "tournament_plan",
            "league_plan": day1["league_plan"],
            "league_standings": standings,
            "final_stage": day1_request["final_stage"],
            "random_seed": 20260803,
        }
    )

    day2_request = {
        "request_kind": "day2_schedule",
        "teams": day1_request["teams"],
        "courts": day1_request["courts"],
        "league_plan": day1["league_plan"],
        "day1_schedule": {"day": day1_request["day"], "slots": day1["slots"]},
        "tournament_plan": tournament,
        "day": {
            "id": "day2",
            "start_time": "09:30",
            "game_duration_minutes": 35,
            "margin_minutes": 10,
        },
        "referees": {
            "organizer_capacity": 2,
            "day2_fallback": "organizer",
        },
        "random_seed": 20260803,
        "solver": {"max_time_seconds": 5},
    }
    result = _handle_request(day2_request)

    assert result["status"] in {"OPTIMAL", "FEASIBLE"}
    assert result["schedule_scope"] == "day2_tournament"
    assert result["validation"]["valid"] is True
    assert result["integrated_validation"]["valid"] is True
    assert any(slot["match_id"] is not None for slot in result["slots"])
    assert len(result["metrics"]["placement_tournament_finals"]) == 2
    assert result["metrics"]["placement_tournament_finals"][0]["final_section_gap"] == 0
    assert result["metrics"]["non_primary_final_max_gap"] is not None

    invalid_day1 = _handle_request(
        {
            **day2_request,
            "day1_schedule": {"day": day1_request["day"], "slots": []},
        }
    )
    assert invalid_day1["status"] == "error"
    assert invalid_day1["diagnostics"][0]["code"] == "DAY1_SCHEDULE_INVALID"
    assert "1日目日程" in invalid_day1["diagnostics"][0]["message"]


@pytest.mark.parametrize("resolved", [False, True])
def test_day2_creation_matches_existing_two_step_generation(resolved: bool) -> None:
    team_count = 8
    day1_request = _day1_league_request(
        team_count=team_count,
        block_count=2,
        court_count=2,
    )
    day1 = _handle_request(day1_request)
    assert day1["status"] in {"OPTIMAL", "FEASIBLE"}
    standings = None
    if resolved:
        standings = _handle_request(
            {
                "request_kind": "league_standings",
                "league_plan": day1["league_plan"],
                "results": [
                    {"match_id": match["id"], "home_score": 1, "away_score": 0}
                    for match in day1["league_plan"]["matches"]
                ],
                "random_seed": 20260803,
            }
        )

    creation_request = _day2_creation_request(day1_request, day1, standings=standings)
    combined = _handle_request(creation_request)
    assert combined["status"] in {"OPTIMAL", "FEASIBLE"}, combined

    tournament_request = {
        "request_kind": "tournament_plan",
        "league_plan": day1["league_plan"],
        "final_stage": day1_request["final_stage"],
        "random_seed": 20260803,
    }
    if standings is not None:
        tournament_request["league_standings"] = standings
    tournament = _handle_request(tournament_request)
    schedule_request = {
        key: value
        for key, value in creation_request.items()
        if key not in {"league_standings", "final_stage"}
    }
    schedule = _handle_request(
        {
            **schedule_request,
            "request_kind": "day2_schedule",
            "tournament_plan": tournament,
        }
    )

    assert combined["tournament_plan"] == tournament
    for field in (
        "participant_resolution",
        "slots",
        "section_timings",
        "tournament_matches",
        "team_schedules",
        "validation",
        "integrated_validation",
    ):
        assert combined["day2_schedule"][field] == schedule[field]
    assert combined["day2_schedule"]["validation"]["valid"] is True
    assert combined["day2_schedule"]["integrated_validation"]["valid"] is True


def test_same_rank_day2_creation_and_results_complete_end_to_end() -> None:
    day1_request = _day1_league_request(team_count=4, block_count=2, court_count=1)
    day1_request["final_stage"] = {
        "format": "same_rank_league",
        "uneven_policy": "strict_same_rank",
    }
    day1 = _handle_request(day1_request)
    assert day1["status"] in {"OPTIMAL", "FEASIBLE"}, day1
    standings = _handle_request(
        {
            "request_kind": "league_standings",
            "league_plan": day1["league_plan"],
            "results": [
                {"match_id": match["id"], "home_score": 1, "away_score": 0}
                for match in day1["league_plan"]["matches"]
            ],
            "random_seed": 20260803,
        }
    )

    combined = _handle_request(_day2_creation_request(day1_request, day1, standings=standings))

    assert combined["status"] in {"OPTIMAL", "FEASIBLE"}, combined
    assert "same_rank_plan" in combined
    assert "tournament_plan" not in combined
    assert combined["day2_schedule"]["schedule_scope"] == "day2_same_rank_league"
    assert combined["day2_schedule"]["validation"]["valid"] is True
    assert combined["day2_schedule"]["integrated_validation"]["valid"] is True

    plan = combined["same_rank_plan"]
    team_by_rank = {
        (participant["entry"]["block_id"], participant["entry"]["rank"]): participant["team"][
            "team_id"
        ]
        for group in plan["groups"]
        for participant in group["participants"]
    }
    result = _handle_request(
        {
            "request_kind": "same_rank_league_results",
            "same_rank_plan": plan,
            "results": [
                {
                    "match_id": match["id"],
                    "home_team_id": team_by_rank[
                        (match["home"]["block_id"], match["home"]["rank"])
                    ],
                    "away_team_id": team_by_rank[
                        (match["away"]["block_id"], match["away"]["rank"])
                    ],
                    "regular_score_home": 1,
                    "regular_score_away": 0,
                }
                for group in plan["groups"]
                for match in group["matches"]
            ],
        }
    )

    assert result["status"] == "COMPLETE"
    assert [standing["rank"] for standing in result["standings"]] == [1, 2, 3, 4]


@pytest.mark.parametrize("final_format", ["placement_tournament", "same_rank_league"])
def test_schedule_creation_all_returns_atomic_canonical_result(final_format: str) -> None:
    team_count = 8 if final_format == "placement_tournament" else 4
    day1_request = _day1_league_request(
        team_count=team_count,
        block_count=2,
        court_count=2,
    )
    if final_format == "same_rank_league":
        day1_request["final_stage"] = {
            "format": "same_rank_league",
            "uneven_policy": "strict_same_rank",
        }

    combined = _handle_request(_schedule_creation_request(day1_request))

    assert combined["status"] in {"OPTIMAL", "FEASIBLE"}, combined
    assert combined["schema_version"] == "0.2.0"
    assert combined["generation_scope"] == "all"
    result = combined["tournament_result"]
    assert result["validation"]["valid"] is True
    assert result["day2_schedule"]["validation"]["valid"] is True
    assert result["integrated_validation"]["valid"] is True
    expected_plan = "same_rank_plan" if final_format == "same_rank_league" else "tournament_plan"
    unexpected_plan = "tournament_plan" if final_format == "same_rank_league" else "same_rank_plan"
    assert expected_plan in result
    assert unexpected_plan not in result


def test_schedule_creation_day2_only_preserves_day1_and_removes_stale_day2_results() -> None:
    day1_request = _day1_league_request(team_count=8, block_count=2, court_count=2)
    day1 = _handle_request(day1_request)
    assert day1["status"] in {"OPTIMAL", "FEASIBLE"}, day1
    league_results = [
        {"match_id": match["id"], "home_score": 1, "away_score": 0}
        for match in day1["league_plan"]["matches"]
    ]
    standings = _handle_request(
        {
            "schema_version": "0.2.0",
            "request_kind": "league_standings",
            "league_plan": day1["league_plan"],
            "results": league_results,
            "random_seed": 20260803,
        }
    )
    existing = {
        **day1,
        "league_results": league_results,
        "league_standings": standings,
        "same_rank_plan": {"stale": True},
        "same_rank_league_results": [{"stale": True}],
        "final_standings": {"stale": True},
    }

    combined = _handle_request(
        _schedule_creation_request(
            day1_request,
            generation_scope="day2_only",
            existing_result=existing,
        )
    )

    assert combined["status"] in {"OPTIMAL", "FEASIBLE"}, combined
    assert combined["generation_scope"] == "day2_only"
    result = combined["tournament_result"]
    assert result["slots"] == day1["slots"]
    assert result["league_results"] == league_results
    assert result["league_standings"] == standings
    assert "tournament_plan" in result
    assert "same_rank_plan" not in result
    assert "same_rank_league_results" not in result
    assert "final_standings" not in result
    assert result["integrated_validation"]["valid"] is True


def test_maximum_team_count_schedule_creation_day2_only_uses_production_limits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    day1_request = _day1_league_request(team_count=32, block_count=8, court_count=4)
    day1_request["final_stage"] = {
        "format": "placement_tournament",
        "tournament_count": 4,
    }
    day1 = _handle_request(day1_request)
    assert day1["status"] in {"OPTIMAL", "FEASIBLE"}, day1
    request = _schedule_creation_request(
        day1_request,
        generation_scope="day2_only",
        existing_result=day1,
    )
    request["solver"] = {"max_time_seconds": 30}
    monkeypatch.setenv("SOLVER_MAX_TIME_SECONDS", "20")
    assert len(json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode()) <= (
        application.MAX_REQUEST_BYTES
    )

    started = monotonic()
    result = _handle_request(request)

    assert monotonic() - started < 28
    assert result["status"] in {"OPTIMAL", "FEASIBLE"}, result
    assert result["generation_scope"] == "day2_only"
    tournament_result = result["tournament_result"]
    assert len(tournament_result["tournament_plan"]["pools"]) == 4
    assert tournament_result["integrated_validation"]["valid"] is True


def test_schedule_creation_failure_never_returns_partial_tournament_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    day1_request = _day1_league_request(team_count=8, block_count=2, court_count=2)
    monkeypatch.setattr(
        application,
        "_generate_day2_creation_response",
        lambda _: {
            "status": "error",
            "diagnostics": [
                {
                    "code": "SCHEDULE_GENERATION_FAILED",
                    "message": "2日目を作成できませんでした。",
                    "details": {"operation_stage": "day2_schedule"},
                }
            ],
        },
    )

    result = _handle_request(_schedule_creation_request(day1_request))

    assert result["status"] == "error"
    assert result["diagnostics"][0]["details"]["operation_stage"] == "day2_schedule"
    assert "tournament_result" not in result


@pytest.mark.parametrize(
    ("legacy_stage", "public_stage"),
    [
        ("tournament_plan", "final_stage_plan"),
        ("same_rank_league_plan", "final_stage_plan"),
        ("same_rank_day2_schedule", "day2_schedule"),
        ("day2_schedule", "day2_schedule"),
        ("integrated_validation", "integrated_validation"),
    ],
)
def test_schedule_creation_normalizes_public_operation_stages(
    legacy_stage: str,
    public_stage: str,
) -> None:
    normalized = application._normalize_schedule_creation_failure(
        {
            "status": "error",
            "diagnostics": [
                {
                    "code": "SCHEDULE_GENERATION_FAILED",
                    "message": "生成できませんでした。",
                    "details": {"operation_stage": legacy_stage},
                }
            ],
        }
    )

    assert normalized["diagnostics"][0]["details"]["operation_stage"] == public_stage


def test_schedule_creation_shares_solver_budget_between_both_days(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    times = iter([107.5])
    monkeypatch.setattr(application, "monotonic", lambda: next(times))

    adjusted = application._apply_schedule_creation_remaining_budget(
        {"solver": {"max_time_seconds": 30}},
        operation_started=100.0,
    )

    assert adjusted["solver"]["max_time_seconds"] == 17.5


def test_schedule_creation_reports_public_solver_budget_in_day2_metrics() -> None:
    response = {
        "status": "FEASIBLE",
        "day2_schedule": {"metrics": {"max_time_seconds": 4.25}},
    }

    restored = application._restore_schedule_creation_public_solver_metrics(
        response,
        max_time_seconds=25.0,
    )

    assert restored["day2_schedule"]["metrics"]["max_time_seconds"] == 25.0
    assert response["day2_schedule"]["metrics"]["max_time_seconds"] == 4.25


def test_schedule_creation_caps_first_solver_to_transport_safe_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SOLVER_MAX_TIME_SECONDS", "30")
    prepared = application._prepare_schedule_creation(
        _schedule_creation_request(_day1_league_request(team_count=8, block_count=2, court_count=2))
    )

    assert prepared["request"]["solver"]["max_time_seconds"] == (
        application.SCHEDULE_CREATION_MAX_TIME_SECONDS
    )


def test_schedule_creation_rejects_failed_integrated_validation_atomically(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    day1_request = _day1_league_request(team_count=8, block_count=2, court_count=2)
    monkeypatch.setattr(
        application,
        "_generate_day1_schedule_response",
        lambda _: {
            "status": "OPTIMAL",
            "league_plan": {},
            "slots": [],
            "validation": {"valid": True},
        },
    )
    monkeypatch.setattr(
        application,
        "_generate_day2_creation_response",
        lambda _: {
            "status": "OPTIMAL",
            "tournament_plan": {},
            "day2_schedule": {"integrated_validation": {"valid": False}},
        },
    )

    result = _handle_request(_schedule_creation_request(day1_request))

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "DAY2_VALIDATION_FAILED"
    assert result["diagnostics"][0]["details"]["operation_stage"] == ("integrated_validation")
    assert "tournament_result" not in result


def test_schedule_creation_day2_only_requires_existing_result() -> None:
    request = _schedule_creation_request(
        _day1_league_request(team_count=8, block_count=2, court_count=2),
        generation_scope="day2_only",
    )

    result = _handle_request(request)

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "INPUT_SCHEMA_INVALID"
    assert result["diagnostics"][0]["details"]["operation_stage"] == "input"
    assert "tournament_result" not in result


@pytest.mark.parametrize(
    "request_kind",
    [
        "same_rank_league_plan",
        "same_rank_league_results",
        "same_rank_day2_schedule",
        "day2_creation",
        "schedule_creation",
    ],
)
def test_same_rank_generation_entry_points_reject_schema_0_1_0(request_kind: str) -> None:
    result = _handle_request({"schema_version": "0.1.0", "request_kind": request_kind})

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "SCHEMA_VERSION_UNSUPPORTED"


def test_day2_creation_reports_tournament_failure_without_partial_result() -> None:
    day1_request = _day1_league_request(team_count=8, block_count=2, court_count=2)
    day1 = _handle_request(day1_request)
    standings = _handle_request(
        {
            "request_kind": "league_standings",
            "league_plan": day1["league_plan"],
            "results": [
                {"match_id": match["id"], "home_score": 0, "away_score": 0}
                for match in day1["league_plan"]["matches"]
            ],
            "random_seed": 20260803,
        }
    )
    standings["standings"].pop()

    result = _handle_request(_day2_creation_request(day1_request, day1, standings=standings))

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "TOURNAMENT_SOURCE_INVALID"
    assert result["diagnostics"][0]["details"]["operation_stage"] == "tournament_plan"
    assert "tournament_plan" not in result
    assert "day2_schedule" not in result


def test_day2_creation_reports_schedule_failure_without_partial_result() -> None:
    day1_request = _day1_league_request(team_count=8, block_count=2, court_count=2)
    day1 = _handle_request(day1_request)
    request = _day2_creation_request(day1_request, day1)
    request["day"] = {**request["day"], "max_sections": 1}

    result = _handle_request(request)

    assert result["status"] == "INFEASIBLE"
    assert result["diagnostics"][0]["details"]["operation_stage"] == "day2_schedule"
    assert "tournament_plan" not in result
    assert "day2_schedule" not in result


def test_day2_creation_rejects_failed_independent_validation_without_partial_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    day1_request = _day1_league_request(team_count=8, block_count=2, court_count=2)
    day1 = _handle_request(day1_request)
    monkeypatch.setattr(
        application,
        "validate_day2_schedule",
        lambda _: {"valid": False, "diagnostics": []},
    )

    result = _handle_request(_day2_creation_request(day1_request, day1))

    assert result["status"] == "error"
    diagnostic = result["diagnostics"][0]
    assert diagnostic["code"] == "DAY2_VALIDATION_FAILED"
    assert diagnostic["details"]["operation_stage"] == "integrated_validation"
    assert "tournament_plan" not in result
    assert "day2_schedule" not in result


def test_maximum_day2_creation_is_reproducible_and_under_production_limits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    day1_request = _day1_league_request(team_count=32, block_count=8, court_count=4)
    day1 = _handle_request(day1_request)
    assert day1["status"] in {"OPTIMAL", "FEASIBLE"}, day1
    request = _day2_creation_request(day1_request, day1)
    request["solver"] = {"max_time_seconds": 30}
    monkeypatch.setenv("SOLVER_MAX_TIME_SECONDS", "20")
    request_bytes = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode()
    assert len(request_bytes) <= application.MAX_REQUEST_BYTES

    hashes: list[str] = []
    for _attempt in range(2):
        started = monotonic()
        result = _handle_request(request)
        assert monotonic() - started < 28
        assert result["status"] in {"OPTIMAL", "FEASIBLE"}, result
        assert result["day2_schedule"]["validation"]["valid"] is True
        assert result["day2_schedule"]["integrated_validation"]["valid"] is True
        stable = deepcopy(result)
        stable["day2_schedule"]["metrics"].pop("wall_time_seconds", None)
        encoded = json.dumps(
            stable,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        assert len(encoded) <= application.MAX_REQUEST_BYTES
        hashes.append(hashlib.sha256(encoded).hexdigest())

    assert len(set(hashes)) == 1


def test_provisional_day2_schedule_returns_rank_routes_and_passes_validation() -> None:
    day1_request = _day1_league_request(team_count=8, block_count=2, court_count=2)
    day1 = _handle_request(day1_request)
    assert day1["status"] in {"OPTIMAL", "FEASIBLE"}
    tournament = _handle_request(
        {
            "request_kind": "tournament_plan",
            "league_plan": day1["league_plan"],
            "final_stage": day1_request["final_stage"],
            "random_seed": 20260803,
        }
    )
    assert tournament["participant_resolution"] == "provisional"

    result = _handle_request(
        {
            "request_kind": "day2_schedule",
            "teams": day1_request["teams"],
            "courts": day1_request["courts"],
            "league_plan": day1["league_plan"],
            "day1_schedule": {"day": day1_request["day"], "slots": day1["slots"]},
            "tournament_plan": tournament,
            "day": {
                "id": "day2",
                "start_time": "09:30",
                "game_duration_minutes": 35,
                "margin_minutes": 10,
            },
            "referees": {
                "organizer_capacity": 2,
                "day2_fallback": "organizer",
            },
            "random_seed": 20260803,
            "solver": {"max_time_seconds": 5},
        }
    )

    assert result["status"] in {"OPTIMAL", "FEASIBLE"}, result
    assert result["participant_resolution"] == "provisional"
    assert result["validation"]["valid"] is True, result["validation"]
    assert result["integrated_validation"]["valid"] is True
    assert all(match["possible_rank_refs"] for match in result["tournament_matches"])
    assert all(not match["possible_team_ids"] for match in result["tournament_matches"])
    assert result["team_schedules"]
    assert all(
        route["rank_ref"] is not None and route["team_id"] is None
        for route in result["team_schedules"]
    )
    occupied_sections = [
        slot["section_no"] for slot in result["slots"] if slot["match_id"] is not None
    ]
    assert result["metrics"]["placement_tournament_finals"][0]["section_no"] == max(
        occupied_sections
    )
    assert len(result["metrics"]["placement_tournament_finals"]) == 2
    assert result["metrics"]["non_primary_final_max_gap"] >= 0


def test_day2_schedule_rejects_legacy_day1_adjacent_court_change() -> None:
    day1_request = _day1_league_request(team_count=8, block_count=2, court_count=2)
    day1 = _handle_request(day1_request)
    assert day1["status"] in {"OPTIMAL", "FEASIBLE"}
    tournament = _handle_request(
        {
            "request_kind": "tournament_plan",
            "league_plan": day1["league_plan"],
            "final_stage": day1_request["final_stage"],
            "random_seed": 20260803,
        }
    )

    legacy_slots = deepcopy(day1["slots"])
    occupied = [slot for slot in legacy_slots if slot["match_id"] is not None]
    occupied[0]["section_no"] = 1
    occupied[0]["court_id"] = "court-1"
    occupied[0]["referee_assignment"] = {"kind": "team", "team_id": "team-4"}
    occupied[1]["section_no"] = 2
    occupied[1]["court_id"] = "court-2"
    occupied[1]["referee_assignment"] = {"kind": "team", "team_id": "team-4"}

    result = _handle_request(
        {
            "request_kind": "day2_schedule",
            "teams": day1_request["teams"],
            "courts": day1_request["courts"],
            "league_plan": day1["league_plan"],
            "day1_schedule": {"day": day1_request["day"], "slots": legacy_slots},
            "tournament_plan": tournament,
            "day": {
                "id": "day2",
                "start_time": "09:30",
                "game_duration_minutes": 35,
                "margin_minutes": 10,
            },
            "referees": {
                "organizer_capacity": 2,
                "day2_fallback": "organizer",
            },
            "random_seed": 20260803,
            "solver": {"max_time_seconds": 5},
        }
    )

    assert result["status"] == "error"
    diagnostic = result["diagnostics"][0]
    assert diagnostic["code"] == "DAY1_SCHEDULE_INVALID"
    nested_codes = {item["code"] for item in diagnostic["details"]["diagnostics"]}
    assert "ADJACENT_ASSIGNMENT_COURT_CONFLICT" in nested_codes


def test_day2_schedule_rejects_section_limit_before_solver() -> None:
    result = _handle_request(
        {
            "request_kind": "day2_schedule",
            "teams": [],
            "courts": [],
            "league_plan": {},
            "day1_schedule": {},
            "tournament_plan": {},
            "day": {"max_sections": application.MAX_SECTIONS + 1},
        }
    )

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "SECTION_LIMIT_EXCEEDED"
