"""API Gateway REST API向けの、本番HTTPトランスポートアダプター。"""

from __future__ import annotations

import base64
import binascii
import json
import os
from collections.abc import Mapping
from typing import Any

from football_scheduler import application

MAX_HTTP_BODY_BYTES = 1_000_000
_HEADERS = {
    "Cache-Control": "no-store, max-age=0",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
}
_CLIENT_ERROR_CODES = {
    "INVALID_REQUEST",
    "INPUT_SCHEMA_INVALID",
    "INVALID_FIXTURE_REQUEST",
    "UNKNOWN_FIXTURE",
    "INVALID_SOLVER_OPTIONS",
    "INVALID_SOLVER_TIMEOUT",
    "INVALID_BLOCK_COUNT",
    "DUPLICATE_TEAM_ID",
    "LEAGUE_INPUT_INVALID",
    "DUPLICATE_LEAGUE_RESULT",
    "UNKNOWN_LEAGUE_MATCH",
    "LEAGUE_RESULTS_INCOMPLETE",
    "LEAGUE_PLAN_INVALID",
}
_LIMIT_ERROR_CODES = {
    "INPUT_TOO_LARGE",
    "TEAM_LIMIT_EXCEEDED",
    "COURT_LIMIT_EXCEEDED",
    "MATCH_LIMIT_EXCEEDED",
    "SECTION_LIMIT_EXCEEDED",
}


class _TransportError(ValueError):
    def __init__(self, code: str, message: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _headers(event: Mapping[str, Any]) -> dict[str, str]:
    raw_headers = event.get("headers")
    if not isinstance(raw_headers, Mapping):
        return {}
    return {str(key).lower(): str(value) for key, value in raw_headers.items() if value is not None}


def _decode_body(event: Mapping[str, Any]) -> dict[str, Any]:
    raw_body = event.get("body")
    if raw_body is None or raw_body == "":
        raise _TransportError(
            "INVALID_REQUEST",
            "リクエスト本文が空です。大会設定を送信してください。",
            400,
        )
    if not isinstance(raw_body, (str, bytes)):
        raise _TransportError(
            "INVALID_REQUEST", "リクエスト本文はJSONオブジェクトで送信してください。", 400
        )

    try:
        body = raw_body.encode("utf-8") if isinstance(raw_body, str) else raw_body
        if event.get("isBase64Encoded") is True:
            body = base64.b64decode(body, validate=True)
    except (UnicodeEncodeError, binascii.Error, ValueError) as exc:
        raise _TransportError(
            "INVALID_REQUEST",
            "リクエスト本文を読み取れませんでした。入力内容を確認してください。",
            400,
        ) from exc

    if len(body) > MAX_HTTP_BODY_BYTES:
        raise _TransportError(
            "INPUT_TOO_LARGE",
            "入力データが上限の1 MBを超えています。不要な内容を減らしてください。",
            413,
        )
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _TransportError(
            "INVALID_REQUEST",
            "リクエスト本文のJSONを読み取れませんでした。入力内容を確認してください。",
            400,
        ) from exc
    if not isinstance(payload, dict):
        raise _TransportError(
            "INVALID_REQUEST", "リクエスト本文はJSONオブジェクトで送信してください。", 400
        )
    return payload


def _error(code: str, message: str) -> dict[str, Any]:
    return {"status": "error", "diagnostics": [{"code": code, "message": message}]}


def _status_for_result(result: Mapping[str, Any]) -> int:
    status = result.get("status")
    if status in {"OPTIMAL", "FEASIBLE", "COMPLETE"}:
        return 200
    diagnostics = result.get("diagnostics")
    first = diagnostics[0] if isinstance(diagnostics, list) and diagnostics else None
    code = first.get("code") if isinstance(first, Mapping) else None
    if status == "INFEASIBLE":
        return 422
    if status == "UNKNOWN":
        return 504 if code == "SCHEDULE_SEARCH_TIMEOUT" else 503
    if status != "error":
        return 500
    if code in _CLIENT_ERROR_CODES:
        return 400
    if code in _LIMIT_ERROR_CODES:
        return 413
    if code == "SCHEDULE_SEARCH_TIMEOUT":
        return 504
    if code in {
        "INSUFFICIENT_SLOTS",
        "TOURNAMENT_DEPENDENCY_CYCLE",
        "SCHEDULE_INFEASIBLE",
    }:
        return 422
    return 500


def _response(status_code: int, body: Mapping[str, Any]) -> dict[str, Any]:
    encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_HTTP_BODY_BYTES:
        status_code = 500
        encoded = json.dumps(
            _error(
                "RESPONSE_TOO_LARGE",
                "生成結果が上限の1 MBを超えたため返却できませんでした。"
                "入力を保存して管理者へ連絡してください。",
            ),
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    headers = dict(_HEADERS)
    release_id = os.getenv("RELEASE_ID")
    if release_id:
        headers["X-Release-Id"] = release_id
    return {
        "statusCode": status_code,
        "headers": headers,
        "body": encoded.decode("utf-8"),
        "isBase64Encoded": False,
    }


def lambda_handler(event: Any, context: Any) -> dict[str, Any]:
    """REST APIイベントを検証してアプリケーション境界へ渡す。"""

    del context
    if not isinstance(event, Mapping):
        return _response(400, _error("INVALID_REQUEST", "リクエスト形式を読み取れませんでした。"))

    method = event.get("httpMethod")
    if method != "POST":
        return _response(
            405,
            _error("METHOD_NOT_ALLOWED", "この操作ではPOSTリクエストだけを受け付けます。"),
        )
    content_length = _headers(event).get("content-length")
    if content_length is not None:
        try:
            if int(content_length) > MAX_HTTP_BODY_BYTES:
                return _response(
                    413,
                    _error(
                        "INPUT_TOO_LARGE",
                        "入力データが上限の1 MBを超えています。不要な内容を減らしてください。",
                    ),
                )
        except ValueError:
            return _response(
                400,
                _error("INVALID_REQUEST", "リクエストのサイズ情報を読み取れませんでした。"),
            )

    try:
        payload = _decode_body(event)
    except _TransportError as exc:
        return _response(exc.status_code, _error(exc.code, exc.message))

    if "fixture" in payload:
        return _response(
            400,
            _error(
                "TEST_FIXTURE_NOT_ALLOWED",
                "公開APIでは検証用入力を指定できません。大会設定を送信してください。",
            ),
        )

    result = application.handle_request(payload)
    return _response(_status_for_result(result), result)
