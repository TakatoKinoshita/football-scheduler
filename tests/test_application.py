from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from time import monotonic
from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

from football_scheduler import application


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


def test_direct_request_is_solved_and_independently_validated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    received: list[dict[str, Any]] = []

    def fake_solve(request: dict[str, Any]) -> _ModelLike:
        received.append(request)
        return _ModelLike(_result())

    monkeypatch.setattr(application, "solve_schedule", fake_solve)

    result = application.handle_request(_request())

    assert result["status"] == "optimal"
    assert result["validation"]["valid"] is True
    assert received[0]["solver"]["max_time_seconds"] == 5


def test_day1_league_request_generates_match_and_passes_independent_validation() -> None:
    result = application.handle_request(_day1_league_request())

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


def test_day1_league_request_adds_block_ids_before_solving(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    received: list[dict[str, Any]] = []
    monkeypatch.setattr(
        application,
        "solve_schedule",
        lambda request: received.append(request) or _ModelLike(_result()),
    )

    result = application.handle_request(
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

    result = application.handle_request(
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
    result = application.handle_request(
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
    result = application.handle_request(
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
    result = application.handle_request(
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
    result = application.handle_request(
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
    result = application.handle_request(
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
    generated = application.handle_request(_day1_league_request(team_count=4, block_count=2))

    result = application.handle_request(
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
    generated = application.handle_request(_day1_league_request(team_count=4, block_count=2))

    result = application.handle_request(
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
    generated = application.handle_request(generated_request)
    standings = application.handle_request(
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

    result = application.handle_request(
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
    generated = application.handle_request(generated_request)
    standings = application.handle_request(
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
    tournament = application.handle_request(
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

    outcome = application.handle_request(
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


def test_tournament_plan_request_returns_provisional_table_without_standings() -> None:
    generated_request = _day1_league_request(team_count=8, block_count=2)
    generated = application.handle_request(generated_request)

    result = application.handle_request(
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
    generated = application.handle_request(generated_request)
    standings = application.handle_request(
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

    result = application.handle_request(
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
    result = application.handle_request(
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
    result = application.handle_request(
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

    result = application.handle_request(_day1_league_request())

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

    result = application.handle_request(_day1_league_request(team_count=8, block_count=9))

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

    result = application.handle_request(
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

    result = application.handle_request(request)

    diagnostic = result["diagnostics"][0]
    assert diagnostic["code"] == "INPUT_SCHEMA_INVALID"
    assert diagnostic["details"]["errors"][0]["field"] == "day"
    assert "表示された項目を確認" not in diagnostic["message"]


def test_day1_league_reports_insufficient_organizer_capacity() -> None:
    request = _day1_league_request()
    request["referees"] = {
        "organizer_capacity": 0,
        "team_referees_required_after_first": False,
    }

    result = application.handle_request(request)

    assert result["status"] == "INFEASIBLE"
    assert result["diagnostics"][0]["code"] == "SCHEDULE_INFEASIBLE"


def test_day1_league_reports_insufficient_slots() -> None:
    request = _day1_league_request(team_count=4)
    request["day"]["max_sections"] = 1

    result = application.handle_request(request)

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

    application.handle_request({"fixture": "smoke", "solver_options": {"max_time_seconds": 2}})

    assert received[0]["solver"]["max_time_seconds"] == 2


def test_mvp_maximum_fixture_is_available(monkeypatch: pytest.MonkeyPatch) -> None:
    received: list[dict[str, Any]] = []
    monkeypatch.setattr(
        application,
        "solve_schedule",
        lambda request: received.append(request) or _ModelLike(_result()),
    )

    result = application.handle_request({"fixture": "mvp_maximum"})

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

    application.handle_request(_request())

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

    result = application.handle_request(request)

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "TEAM_LIMIT_EXCEEDED"


def test_unknown_fixture_returns_japanese_diagnostic() -> None:
    result = application.handle_request({"fixture": "large"})

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

    result = application.handle_request(_request())

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "INPUT_SCHEMA_INVALID"
    assert result["diagnostics"][0]["details"]["errors"][0]["field"] == "value"


def test_unexpected_exception_is_not_exposed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        application,
        "solve_schedule",
        lambda _: (_ for _ in ()).throw(RuntimeError("secret implementation detail")),
    )

    result = application.handle_request(_request())

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "SCHEDULE_GENERATION_FAILED"
    assert "secret" not in str(result)


def test_day2_schedule_request_keeps_day1_and_returns_integrated_validation() -> None:
    day1_request = _day1_league_request(team_count=8, block_count=2, court_count=2)
    day1 = application.handle_request(day1_request)
    assert day1["status"] in {"OPTIMAL", "FEASIBLE"}
    standings = application.handle_request(
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
    tournament = application.handle_request(
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
    result = application.handle_request(day2_request)

    assert result["status"] in {"OPTIMAL", "FEASIBLE"}
    assert result["schedule_scope"] == "day2_tournament"
    assert result["validation"]["valid"] is True
    assert result["integrated_validation"]["valid"] is True
    assert any(slot["match_id"] is not None for slot in result["slots"])
    assert len(result["metrics"]["placement_tournament_finals"]) == 2
    assert result["metrics"]["placement_tournament_finals"][0]["final_section_gap"] == 0
    assert result["metrics"]["non_primary_final_max_gap"] is not None

    invalid_day1 = application.handle_request(
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
    day1 = application.handle_request(day1_request)
    assert day1["status"] in {"OPTIMAL", "FEASIBLE"}
    standings = None
    if resolved:
        standings = application.handle_request(
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
    combined = application.handle_request(creation_request)
    assert combined["status"] in {"OPTIMAL", "FEASIBLE"}, combined

    tournament_request = {
        "request_kind": "tournament_plan",
        "league_plan": day1["league_plan"],
        "final_stage": day1_request["final_stage"],
        "random_seed": 20260803,
    }
    if standings is not None:
        tournament_request["league_standings"] = standings
    tournament = application.handle_request(tournament_request)
    schedule_request = {
        key: value
        for key, value in creation_request.items()
        if key not in {"league_standings", "final_stage"}
    }
    schedule = application.handle_request(
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


def test_day2_creation_reports_tournament_failure_without_partial_result() -> None:
    day1_request = _day1_league_request(team_count=8, block_count=2, court_count=2)
    day1 = application.handle_request(day1_request)
    standings = application.handle_request(
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

    result = application.handle_request(
        _day2_creation_request(day1_request, day1, standings=standings)
    )

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "TOURNAMENT_SOURCE_INVALID"
    assert result["diagnostics"][0]["details"]["operation_stage"] == "tournament_plan"
    assert "tournament_plan" not in result
    assert "day2_schedule" not in result


def test_day2_creation_reports_schedule_failure_without_partial_result() -> None:
    day1_request = _day1_league_request(team_count=8, block_count=2, court_count=2)
    day1 = application.handle_request(day1_request)
    request = _day2_creation_request(day1_request, day1)
    request["day"] = {**request["day"], "max_sections": 1}
    request["referees"] = {**request["referees"], "organizer_capacity": 1}

    result = application.handle_request(request)

    assert result["status"] == "error"
    assert result["diagnostics"][0]["details"]["operation_stage"] == "day2_schedule"
    assert "tournament_plan" not in result
    assert "day2_schedule" not in result


def test_day2_creation_rejects_failed_independent_validation_without_partial_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    day1_request = _day1_league_request(team_count=8, block_count=2, court_count=2)
    day1 = application.handle_request(day1_request)
    monkeypatch.setattr(
        application,
        "validate_day2_schedule",
        lambda _: {"valid": False, "diagnostics": []},
    )

    result = application.handle_request(_day2_creation_request(day1_request, day1))

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
    day1 = application.handle_request(day1_request)
    assert day1["status"] in {"OPTIMAL", "FEASIBLE"}, day1
    request = _day2_creation_request(day1_request, day1)
    request["solver"] = {"max_time_seconds": 30}
    monkeypatch.setenv("SOLVER_MAX_TIME_SECONDS", "20")
    request_bytes = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode()
    assert len(request_bytes) <= application.MAX_REQUEST_BYTES

    hashes: list[str] = []
    for _attempt in range(2):
        started = monotonic()
        result = application.handle_request(request)
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
    day1 = application.handle_request(day1_request)
    assert day1["status"] in {"OPTIMAL", "FEASIBLE"}
    tournament = application.handle_request(
        {
            "request_kind": "tournament_plan",
            "league_plan": day1["league_plan"],
            "final_stage": day1_request["final_stage"],
            "random_seed": 20260803,
        }
    )
    assert tournament["participant_resolution"] == "provisional"

    result = application.handle_request(
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
    day1 = application.handle_request(day1_request)
    assert day1["status"] in {"OPTIMAL", "FEASIBLE"}
    tournament = application.handle_request(
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

    result = application.handle_request(
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
    result = application.handle_request(
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
