from __future__ import annotations

import base64
import json
from typing import Any

import pytest

from football_scheduler import lambda_handler


def _function_url_event(body: Any, *, base64_encoded: bool = False) -> dict[str, Any]:
    return {
        "version": "2.0",
        "requestContext": {"http": {"method": "POST"}},
        "body": body,
        "isBase64Encoded": base64_encoded,
    }


def test_direct_event_is_forwarded_without_transport_wrapping(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = {"schema_version": "0.1.0", "random_seed": 20260803}
    expected = {"status": "success", "schedule": []}
    received: list[dict[str, Any]] = []

    def fake_handle_request(request: dict[str, Any]) -> dict[str, Any]:
        received.append(request)
        return expected

    monkeypatch.setattr(lambda_handler.application, "handle_request", fake_handle_request)

    assert lambda_handler.lambda_handler(payload, object()) == expected
    assert received == [payload]


def test_function_url_json_body_is_decoded_and_response_is_wrapped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = {"schema_version": "0.1.0", "teams": [{"id": "team-01"}]}
    expected = {"status": "success", "message": "生成しました。"}
    received: list[dict[str, Any]] = []

    def fake_handle_request(request: dict[str, Any]) -> dict[str, Any]:
        received.append(request)
        return expected

    monkeypatch.setattr(lambda_handler.application, "handle_request", fake_handle_request)

    response = lambda_handler.lambda_handler(
        _function_url_event(json.dumps(payload, ensure_ascii=False)), object()
    )

    assert response["statusCode"] == 200
    assert response["headers"]["content-type"] == "application/json; charset=utf-8"
    assert "access-control-allow-origin" not in response["headers"]
    assert json.loads(response["body"]) == expected
    assert received == [payload]


def test_function_url_base64_json_body_is_decoded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = {"random_seed": 20260803}
    encoded = base64.b64encode(json.dumps(payload).encode()).decode()
    received: list[dict[str, Any]] = []

    def fake_handle_request(request: dict[str, Any]) -> dict[str, Any]:
        received.append(request)
        return {"status": "success"}

    monkeypatch.setattr(lambda_handler.application, "handle_request", fake_handle_request)

    response = lambda_handler.lambda_handler(
        _function_url_event(encoded, base64_encoded=True), object()
    )

    assert response["statusCode"] == 200
    assert received == [payload]


@pytest.mark.parametrize(
    ("body", "message"),
    [
        (None, "リクエスト本文が空です。大会設定を送信してください。"),
        ("not-json", "リクエスト本文のJSONを読み取れませんでした。入力内容を確認してください。"),
        ("[]", "リクエスト本文はJSONオブジェクトで送信してください。"),
    ],
)
def test_invalid_function_url_body_returns_japanese_400(
    monkeypatch: pytest.MonkeyPatch,
    body: Any,
    message: str,
) -> None:
    def must_not_run(_: dict[str, Any]) -> dict[str, Any]:
        raise AssertionError("application must not be called")

    monkeypatch.setattr(lambda_handler.application, "handle_request", must_not_run)

    response = lambda_handler.lambda_handler(_function_url_event(body), object())
    result = json.loads(response["body"])

    assert response["statusCode"] == 400
    assert result == {
        "status": "error",
        "diagnostics": [{"code": "INVALID_REQUEST", "message": message}],
    }


def test_non_mapping_direct_event_returns_japanese_validation_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def must_not_run(_: dict[str, Any]) -> dict[str, Any]:
        raise AssertionError("application must not be called")

    monkeypatch.setattr(lambda_handler.application, "handle_request", must_not_run)

    result = lambda_handler.lambda_handler([], object())

    assert result["status"] == "error"
    assert result["diagnostics"] == [
        {
            "code": "INVALID_REQUEST",
            "message": "リクエストはJSONオブジェクトで送信してください。",
        }
    ]


def test_domain_payload_with_body_key_is_not_misclassified_as_http(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = {"body": {"note": "domain data"}, "random_seed": 1}

    monkeypatch.setattr(
        lambda_handler.application,
        "handle_request",
        lambda request: {"received": request},
    )

    assert lambda_handler.lambda_handler(payload, object()) == {"received": payload}


def test_direct_smoke_event_runs_the_full_solver_and_validator() -> None:
    result = lambda_handler.lambda_handler({"fixture": "smoke"}, object())

    assert result["status"] == "OPTIMAL"
    assert result["validation"]["valid"] is True
    assert len([slot for slot in result["slots"] if slot["match_id"] is not None]) == 2
