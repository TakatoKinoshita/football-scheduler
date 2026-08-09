from __future__ import annotations

import logging
from typing import Any

import pytest

from football_scheduler import authorizer

_METHOD_ARN = ":".join(
    ("arn:aws:execute-api:us-east-1:123456789012", "api/prod/POST/api/v1/schedules%3Agenerate")
)


def _event(**headers: str) -> dict[str, Any]:
    return {
        "type": "REQUEST",
        "methodArn": _METHOD_ARN,
        "headers": {"x-turnstile-action": "generate_schedule", **headers},
        "requestContext": {"identity": {"sourceIp": "203.0.113.10"}},
    }


def _effect(result: dict[str, Any]) -> str:
    return str(result["policyDocument"]["Statement"][0]["Effect"])


@pytest.fixture(autouse=True)
def _set_production_hostname(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TURNSTILE_EXPECTED_HOSTNAME", "schedule.example.jp")


def test_valid_proxy_header_and_turnstile_token_are_allowed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ORIGIN_VERIFY_VALUE", "origin-secret")
    monkeypatch.setattr(
        authorizer,
        "_verify_turnstile",
        lambda token, remote_ip: {
            "success": token == "single-use-token" and remote_ip == "203.0.113.10",
            "hostname": "schedule.example.jp",
            "action": "generate_schedule",
        },
    )

    result = authorizer.lambda_handler(
        _event(
            **{
                "X-Origin-Verify": "origin-secret",
                "Origin": "https://schedule.example.jp",
                "X-Turnstile-Token": "single-use-token",
                "X-Turnstile-Action": "generate_schedule",
                "X-Client-Ip": "203.0.113.10",
            }
        ),
        object(),
    )

    assert _effect(result) == "Allow"
    assert result["context"] == {"authorizationCode": "AUTHORIZED"}


@pytest.mark.parametrize(
    "action",
    [
        "calculate_standings",
        "generate_tournament",
        "calculate_tournament_results",
        "create_day2",
        "generate_day2_schedule",
    ],
)
def test_result_workflow_turnstile_actions_are_allowed(
    monkeypatch: pytest.MonkeyPatch, action: str
) -> None:
    monkeypatch.setenv("ORIGIN_VERIFY_VALUE", "origin-secret")
    monkeypatch.setattr(
        authorizer,
        "_verify_turnstile",
        lambda *_: {
            "success": True,
            "hostname": "schedule.example.jp",
            "action": action,
        },
    )

    result = authorizer.lambda_handler(
        _event(
            **{
                "X-Origin-Verify": "origin-secret",
                "Origin": "https://schedule.example.jp",
                "X-Turnstile-Token": "single-use-token",
                "X-Turnstile-Action": action,
            }
        ),
        object(),
    )

    assert _effect(result) == "Allow"


def test_turnstile_action_must_match_requested_action(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ORIGIN_VERIFY_VALUE", "origin-secret")
    monkeypatch.setattr(
        authorizer,
        "_verify_turnstile",
        lambda *_: {
            "success": True,
            "hostname": "schedule.example.jp",
            "action": "calculate_standings",
        },
    )

    result = authorizer.lambda_handler(
        _event(
            **{
                "X-Origin-Verify": "origin-secret",
                "Origin": "https://schedule.example.jp",
                "X-Turnstile-Token": "single-use-token",
                "X-Turnstile-Action": "generate_day2_schedule",
            }
        ),
        object(),
    )

    assert _effect(result) == "Deny"
    assert result["context"] == {"authorizationCode": "BOT_CHECK_REJECTED"}


def test_missing_proxy_header_is_denied_before_turnstile(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setenv("ORIGIN_VERIFY_VALUE", "origin-secret")
    monkeypatch.setattr(
        authorizer,
        "_verify_turnstile",
        lambda *_: pytest.fail("Turnstile must not be called"),
    )

    with caplog.at_level(logging.INFO):
        result = authorizer.lambda_handler(
            _event(
                Origin="https://schedule.example.jp",
                **{"X-Turnstile-Token": "sensitive-token"},
            ),
            object(),
        )

    assert _effect(result) == "Deny"
    assert result["context"] == {"authorizationCode": "ORIGIN_REJECTED"}
    assert "sensitive-token" not in caplog.text
    assert "origin-secret" not in caplog.text
    assert '"code":"ORIGIN_REJECTED"' in caplog.text


@pytest.mark.parametrize(
    ("verification", "code"),
    [
        (
            {"success": True, "hostname": "other.example.jp", "action": "generate_schedule"},
            "BOT_CHECK_REJECTED",
        ),
        (
            {"success": True, "hostname": "schedule.example.jp", "action": "other_action"},
            "BOT_CHECK_REJECTED",
        ),
        (
            {"success": False, "hostname": "schedule.example.jp", "action": "generate_schedule"},
            "BOT_CHECK_REJECTED",
        ),
    ],
)
def test_turnstile_hostname_action_and_success_are_required(
    monkeypatch: pytest.MonkeyPatch,
    verification: dict[str, Any],
    code: str,
) -> None:
    monkeypatch.setenv("ORIGIN_VERIFY_VALUE", "origin-secret")
    monkeypatch.setattr(authorizer, "_verify_turnstile", lambda *_: verification)
    result = authorizer.lambda_handler(
        _event(
            **{
                "X-Origin-Verify": "origin-secret",
                "Origin": "https://schedule.example.jp",
                "X-Turnstile-Token": "token",
            }
        ),
        object(),
    )
    assert _effect(result) == "Deny"
    assert result["context"] == {"authorizationCode": code}


def test_http_browser_origin_is_denied(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ORIGIN_VERIFY_VALUE", "origin-secret")
    result = authorizer.lambda_handler(
        _event(
            **{
                "X-Origin-Verify": "origin-secret",
                "Origin": "http://schedule.example.jp",
                "X-Turnstile-Token": "token",
            }
        ),
        object(),
    )
    assert _effect(result) == "Deny"
    assert result["context"] == {"authorizationCode": "BROWSER_ORIGIN_REJECTED"}


@pytest.mark.parametrize(
    "origin",
    ["https://localhost", "https://127.0.0.1", "https://other.example.jp"],
)
def test_non_production_origin_is_denied_before_turnstile(
    monkeypatch: pytest.MonkeyPatch,
    origin: str,
) -> None:
    monkeypatch.setenv("ORIGIN_VERIFY_VALUE", "origin-secret")
    monkeypatch.setattr(
        authorizer,
        "_verify_turnstile",
        lambda *_: pytest.fail("Turnstile must not be called"),
    )

    result = authorizer.lambda_handler(
        _event(
            **{
                "X-Origin-Verify": "origin-secret",
                "Origin": origin,
                "X-Turnstile-Token": "token",
            }
        ),
        object(),
    )

    assert _effect(result) == "Deny"
    assert result["context"] == {"authorizationCode": "BROWSER_ORIGIN_REJECTED"}


def test_missing_expected_hostname_is_denied_before_turnstile(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ORIGIN_VERIFY_VALUE", "origin-secret")
    monkeypatch.delenv("TURNSTILE_EXPECTED_HOSTNAME")
    monkeypatch.setattr(
        authorizer,
        "_verify_turnstile",
        lambda *_: pytest.fail("Turnstile must not be called"),
    )

    result = authorizer.lambda_handler(
        _event(
            **{
                "X-Origin-Verify": "origin-secret",
                "Origin": "https://schedule.example.jp",
                "X-Turnstile-Token": "token",
            }
        ),
        object(),
    )

    assert _effect(result) == "Deny"
    assert result["context"] == {"authorizationCode": "BROWSER_ORIGIN_REJECTED"}
