from __future__ import annotations

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
