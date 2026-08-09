"""信頼するproxy経由の確認とTurnstile検証を行うAPI Gateway authorizer。"""

from __future__ import annotations

import hmac
import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlparse

_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
_EXPECTED_ACTIONS = frozenset(
    {
        "create_schedule",
        "generate_schedule",
        "calculate_standings",
        "generate_tournament",
        "calculate_tournament_results",
        "generate_same_rank_league",
        "calculate_same_rank_results",
        "generate_same_rank_day2_schedule",
        "create_day2",
        "generate_day2_schedule",
    }
)
_MAX_TOKEN_LENGTH = 2_048
_LOGGER = logging.getLogger(__name__)
_LOGGER.setLevel(logging.INFO)


def _headers(event: Mapping[str, Any]) -> dict[str, str]:
    headers = event.get("headers")
    if not isinstance(headers, Mapping):
        return {}
    return {str(key).lower(): str(value) for key, value in headers.items() if value is not None}


def _policy(principal_id: str, effect: str, method_arn: str, code: str) -> dict[str, Any]:
    _LOGGER.info(
        json.dumps(
            {"event": "authorization", "result": effect.casefold(), "code": code},
            separators=(",", ":"),
        )
    )
    return {
        "principalId": principal_id,
        "policyDocument": {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Action": "execute-api:Invoke",
                    "Effect": effect,
                    "Resource": method_arn,
                }
            ],
        },
        "context": {"authorizationCode": code},
    }


def _verify_turnstile(token: str, remote_ip: str | None) -> Mapping[str, Any]:
    secret = os.environ["TURNSTILE_SECRET_KEY"]
    form: dict[str, str] = {"secret": secret, "response": token}
    if remote_ip:
        form["remoteip"] = remote_ip
    request = urllib.request.Request(
        _SITEVERIFY_URL,
        data=urllib.parse.urlencode(form).encode("ascii"),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=4) as response:
        result = json.loads(response.read(64_000))
    return result if isinstance(result, Mapping) else {}


def lambda_handler(event: Any, context: Any) -> dict[str, Any]:
    """secretやtokenをログへ残さず、許可または拒否policyだけを返す。"""

    del context
    if not isinstance(event, Mapping):
        return _policy("anonymous", "Deny", "*", "INVALID_EVENT")
    method_arn = str(event.get("methodArn", "*"))
    headers = _headers(event)

    configured_origin_value = os.getenv("ORIGIN_VERIFY_VALUE", "")
    received_origin_value = headers.get("x-origin-verify", "")
    if not configured_origin_value or not hmac.compare_digest(
        received_origin_value, configured_origin_value
    ):
        return _policy("anonymous", "Deny", method_arn, "ORIGIN_REJECTED")

    origin = headers.get("origin", "")
    parsed_origin = urlparse(origin)
    expected_hostname = os.getenv("TURNSTILE_EXPECTED_HOSTNAME", "").strip().casefold()
    if (
        parsed_origin.scheme != "https"
        or not parsed_origin.hostname
        or not expected_hostname
        or parsed_origin.hostname.casefold() != expected_hostname
    ):
        return _policy("anonymous", "Deny", method_arn, "BROWSER_ORIGIN_REJECTED")

    token = headers.get("x-turnstile-token", "")
    if not token or len(token) > _MAX_TOKEN_LENGTH:
        return _policy("anonymous", "Deny", method_arn, "BOT_CHECK_REQUIRED")
    requested_action = headers.get("x-turnstile-action", "")
    if requested_action not in _EXPECTED_ACTIONS:
        return _policy("anonymous", "Deny", method_arn, "BOT_CHECK_ACTION_REQUIRED")

    # Pages FunctionがCloudflareの接続元情報から付与した値だけを使う。
    # この時点ではproxy共有secretを検証済みなので、browserが偽装したheaderは届かない。
    remote_ip = headers.get("x-client-ip")
    try:
        result = _verify_turnstile(token, str(remote_ip) if remote_ip else None)
    except KeyError, OSError, ValueError, json.JSONDecodeError, urllib.error.URLError:
        return _policy("anonymous", "Deny", method_arn, "BOT_CHECK_UNAVAILABLE")

    hostname = result.get("hostname")
    action = result.get("action")
    if (
        result.get("success") is not True
        or not isinstance(hostname, str)
        or hostname.casefold() != expected_hostname
        or action != requested_action
    ):
        return _policy("anonymous", "Deny", method_arn, "BOT_CHECK_REJECTED")
    return _policy("turnstile-user", "Allow", method_arn, "AUTHORIZED")
