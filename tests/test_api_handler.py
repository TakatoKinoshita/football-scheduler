from __future__ import annotations

import base64
import json
from typing import Any

import pytest

from football_scheduler import api_handler


def _event(
    body: str,
    *,
    method: str = "POST",
    headers: dict[str, str] | None = None,
    base64_encoded: bool = False,
) -> dict[str, Any]:
    return {
        "httpMethod": method,
        "headers": {
            "content-type": "application/json",
            "x-turnstile-action": "generate_schedule",
            **(headers or {}),
        },
        "body": body,
        "isBase64Encoded": base64_encoded,
        "requestContext": {"requestId": "not-logged"},
    }


def test_rest_api_event_is_forwarded_without_caching(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = {"schema_version": "0.1.0", "teams": []}
    expected = {"status": "OPTIMAL", "slots": []}
    received: list[dict[str, Any]] = []
    monkeypatch.setattr(
        api_handler.application,
        "handle_request",
        lambda request: received.append(request) or expected,
    )
    monkeypatch.setenv("RELEASE_ID", "release-20260805")

    response = api_handler.lambda_handler(_event(json.dumps(payload)), object())

    assert response["statusCode"] == 200
    assert response["headers"]["Cache-Control"] == "no-store, max-age=0"
    assert response["headers"]["X-Release-Id"] == "release-20260805"
    assert json.loads(response["body"]) == expected
    assert received == [payload]


def test_base64_body_is_supported(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = {"schema_version": "0.1.0"}
    encoded = base64.b64encode(json.dumps(payload).encode()).decode()
    received: list[dict[str, Any]] = []
    monkeypatch.setattr(
        api_handler.application,
        "handle_request",
        lambda request: received.append(request) or {"status": "OPTIMAL"},
    )

    response = api_handler.lambda_handler(_event(encoded, base64_encoded=True), object())

    assert response["statusCode"] == 200
    assert received == [payload]


def test_completed_league_standings_return_http_200(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        api_handler.application,
        "handle_request",
        lambda _: {"status": "COMPLETE", "standings": []},
    )

    response = api_handler.lambda_handler(_event("{}"), object())

    assert response["statusCode"] == 200


def test_completed_tournament_plan_returns_http_200(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        api_handler.application,
        "handle_request",
        lambda _: {"status": "COMPLETE", "upper": {}, "lower": {}},
    )

    response = api_handler.lambda_handler(_event("{}"), object())

    assert response["statusCode"] == 200


def test_day2_schedule_success_returns_http_200(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        api_handler.application,
        "handle_request",
        lambda _: {
            "status": "OPTIMAL",
            "schedule_scope": "day2_tournament",
            "participant_resolution": "provisional",
        },
    )

    response = api_handler.lambda_handler(
        _event(
            '{"request_kind":"day2_schedule"}',
            headers={"x-turnstile-action": "generate_day2_schedule"},
        ),
        object(),
    )

    assert response["statusCode"] == 200
    assert json.loads(response["body"])["participant_resolution"] == "provisional"


def test_tournament_results_action_returns_http_200(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        api_handler.application,
        "handle_request",
        lambda _: {"status": "COMPLETE", "match_results": [], "standings": []},
    )

    response = api_handler.lambda_handler(
        _event(
            '{"request_kind":"tournament_results"}',
            headers={"x-turnstile-action": "calculate_tournament_results"},
        ),
        object(),
    )

    assert response["statusCode"] == 200


def test_day1_schedule_response_includes_referee_audit_metrics() -> None:
    payload = {
        "schema_version": "0.1.0",
        "request_kind": "day1_league",
        "teams": [{"id": f"team-{index}", "name": f"チーム{index}"} for index in range(1, 5)],
        "courts": [
            {"id": "court-a", "name": "Aコート"},
            {"id": "court-b", "name": "Bコート"},
        ],
        "league": {"block_count": 1, "assignment_mode": "random"},
        "day": {
            "id": "day1",
            "start_time": "09:30",
            "game_duration_minutes": 35,
            "margin_minutes": 5,
            "max_sections": 12,
        },
        "referees": {
            "organizer_capacity": 2,
            "team_referees_required_after_first": True,
        },
        "random_seed": 20260803,
        "solver": {"max_time_seconds": 10},
    }

    response = api_handler.lambda_handler(_event(json.dumps(payload)), object())
    result = json.loads(response["body"])

    assert response["statusCode"] == 200
    assert (
        result["metrics"]["league_team_referee_counts"]
        == result["validation"]["summary"]["league_team_referee_counts"]
    )
    assert (
        result["metrics"]["league_team_referee_count_difference"]
        == result["validation"]["summary"]["league_team_referee_count_difference"]
    )


def test_manual_block_validation_error_returns_http_400() -> None:
    payload = {
        "schema_version": "0.1.0",
        "request_kind": "day1_league",
        "teams": [{"id": f"team-{index}", "name": f"チーム{index}"} for index in range(1, 6)],
        "courts": [{"id": "court-a", "name": "Aコート"}],
        "league": {
            "block_count": 2,
            "assignment_mode": "manual",
            "manual_blocks": [
                {"id": "A", "team_ids": ["team-1", "team-2", "team-3", "team-4"]},
                {"id": "B", "team_ids": ["team-5"]},
            ],
        },
        "day": {
            "id": "day1",
            "start_time": "09:30",
            "game_duration_minutes": 35,
            "margin_minutes": 5,
        },
        "referees": {
            "organizer_capacity": 1,
            "team_referees_required_after_first": True,
        },
    }

    response = api_handler.lambda_handler(_event(json.dumps(payload)), object())
    result = json.loads(response["body"])

    assert response["statusCode"] == 400
    assert result["diagnostics"][0]["code"] == "MANUAL_BLOCK_SIZE_IMBALANCE"


def test_content_length_over_one_megabyte_is_rejected_before_application(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        api_handler.application,
        "handle_request",
        lambda _: pytest.fail("application must not run"),
    )
    response = api_handler.lambda_handler(
        _event("{}", headers={"Content-Length": "1000001"}), object()
    )
    assert response["statusCode"] == 413
    assert json.loads(response["body"])["diagnostics"][0]["code"] == "INPUT_TOO_LARGE"


def test_non_post_method_is_rejected() -> None:
    response = api_handler.lambda_handler(_event("{}", method="GET"), object())
    assert response["statusCode"] == 405
    assert json.loads(response["body"])["diagnostics"][0]["code"] == "METHOD_NOT_ALLOWED"


def test_technical_fixture_is_not_exposed_by_public_api(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        api_handler.application,
        "handle_request",
        lambda _: pytest.fail("application must not run"),
    )
    response = api_handler.lambda_handler(_event('{"fixture":"mvp_maximum"}'), object())
    assert response["statusCode"] == 400
    assert json.loads(response["body"])["diagnostics"][0]["code"] == "TEST_FIXTURE_NOT_ALLOWED"


def test_turnstile_action_must_match_request_kind(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        api_handler.application,
        "handle_request",
        lambda _: pytest.fail("application must not run"),
    )
    response = api_handler.lambda_handler(
        _event(
            '{"request_kind":"day2_schedule"}',
            headers={"x-turnstile-action": "generate_tournament"},
        ),
        object(),
    )

    assert response["statusCode"] == 400
    assert json.loads(response["body"])["diagnostics"][0]["code"] == ("BOT_CHECK_ACTION_MISMATCH")


@pytest.mark.parametrize(
    ("code", "expected_status"),
    [
        ("INPUT_SCHEMA_INVALID", 400),
        ("INVALID_BLOCK_COUNT", 400),
        ("TOURNAMENT_SOURCE_INVALID", 400),
        ("TOURNAMENT_RESULT_INVALID", 400),
        ("DAY_END_TIME_INVALID", 400),
        ("DAY1_SCHEDULE_INVALID", 400),
        ("TEAM_LIMIT_EXCEEDED", 413),
        ("SCHEDULE_SEARCH_TIMEOUT", 504),
        ("INSUFFICIENT_SLOTS", 422),
        ("TOURNAMENT_REFEREE_UNAVAILABLE", 422),
        ("SCHEDULE_GENERATION_FAILED", 500),
    ],
)
def test_domain_errors_have_distinct_http_statuses(
    monkeypatch: pytest.MonkeyPatch, code: str, expected_status: int
) -> None:
    monkeypatch.setattr(
        api_handler.application,
        "handle_request",
        lambda _: {
            "status": "error",
            "diagnostics": [{"code": code, "message": "利用者向け説明"}],
        },
    )
    response = api_handler.lambda_handler(_event("{}"), object())
    assert response["statusCode"] == expected_status


@pytest.mark.parametrize(
    ("solver_status", "diagnostic_code", "expected_status"),
    [
        ("INFEASIBLE", "INSUFFICIENT_SLOTS", 422),
        ("UNKNOWN", "SCHEDULE_SEARCH_TIMEOUT", 504),
        ("UNKNOWN", "SOLVER_STOPPED", 503),
    ],
)
def test_solver_statuses_have_distinct_http_statuses(
    monkeypatch: pytest.MonkeyPatch,
    solver_status: str,
    diagnostic_code: str,
    expected_status: int,
) -> None:
    monkeypatch.setattr(
        api_handler.application,
        "handle_request",
        lambda _: {
            "status": solver_status,
            "diagnostics": [{"code": diagnostic_code, "message": "利用者向け説明"}],
        },
    )
    response = api_handler.lambda_handler(_event("{}"), object())
    assert response["statusCode"] == expected_status


def test_response_over_one_megabyte_is_replaced_without_leaking_content(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        api_handler.application,
        "handle_request",
        lambda _: {"status": "OPTIMAL", "private": "x" * 1_000_000},
    )
    response = api_handler.lambda_handler(_event("{}"), object())
    body = json.loads(response["body"])
    assert response["statusCode"] == 500
    assert body["diagnostics"][0]["code"] == "RESPONSE_TOO_LARGE"
    assert "private" not in response["body"]
