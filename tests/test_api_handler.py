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
        "headers": headers or {"content-type": "application/json"},
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


@pytest.mark.parametrize(
    ("code", "expected_status"),
    [
        ("INPUT_SCHEMA_INVALID", 400),
        ("INVALID_BLOCK_COUNT", 400),
        ("TEAM_LIMIT_EXCEEDED", 413),
        ("SCHEDULE_SEARCH_TIMEOUT", 504),
        ("INSUFFICIENT_SLOTS", 422),
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
