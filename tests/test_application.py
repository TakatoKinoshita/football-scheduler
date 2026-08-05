from __future__ import annotations

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
        "schema_version": "0.1.0",
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
        "schema_version": "0.1.0",
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
    team_count: int = 2,
    block_count: int = 1,
    assignment_mode: str = "random",
    court_count: int = 1,
) -> dict[str, Any]:
    return {
        "schema_version": "0.1.0",
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
    assert len(result["league_plan"]["blocks"]) == 1
    assert len(result["league_plan"]["logical_rounds"]) == 1
    assert len(result["league_plan"]["matches"]) == 1
    assert result["slots"][0]["match_id"] == result["league_plan"]["matches"][0]["id"]


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
    assert received[0]["day"]["max_sections"] == 2
    assert received[1]["day"]["max_sections"] is None


def test_day1_league_request_rejects_block_count_above_team_count(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        application,
        "solve_schedule",
        lambda _: pytest.fail("solver must not run"),
    )

    result = application.handle_request(_day1_league_request(team_count=2, block_count=3))

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "INVALID_BLOCK_COUNT"
    assert result["diagnostics"][0]["details"] == {
        "block_count": 3,
        "team_count": 2,
    }


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
