"""AWS Lambda向けの薄いトランスポートアダプター。

大会規則やスケジュール生成はこのモジュールへ実装せず、FaaS非依存の
``application.handle_request`` に委譲する。
"""

from __future__ import annotations

import base64
import binascii
import json
from collections.abc import Mapping
from typing import Any

from football_scheduler import application

_JSON_HEADERS = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
}


class _InvalidTransportRequest(ValueError):
    """リクエストの転送形式を解釈できない場合に送出する。"""


def _is_function_url_event(event: Mapping[str, Any]) -> bool:
    """Lambda Function URL / HTTP API v2形式かを判定する。

    ドメイン入力にも ``body`` というキーがあり得るため、キーの存在だけでは
    HTTPイベントと判定しない。
    """

    request_context = event.get("requestContext")
    return (
        event.get("version") == "2.0"
        and isinstance(request_context, Mapping)
        and isinstance(request_context.get("http"), Mapping)
    )


def _decode_http_body(event: Mapping[str, Any]) -> dict[str, Any]:
    body = event.get("body")
    if body is None or body == "":
        raise _InvalidTransportRequest("リクエスト本文が空です。大会設定を送信してください。")

    if isinstance(body, Mapping):
        return dict(body)

    if not isinstance(body, (str, bytes)):
        raise _InvalidTransportRequest("リクエスト本文はJSONオブジェクトで送信してください。")

    if event.get("isBase64Encoded") is True:
        try:
            encoded = body.encode("ascii") if isinstance(body, str) else body
            body = base64.b64decode(encoded, validate=True).decode("utf-8")
        except (UnicodeDecodeError, UnicodeEncodeError, binascii.Error, ValueError) as exc:
            raise _InvalidTransportRequest(
                "リクエスト本文のBase64エンコードを読み取れませんでした。"
            ) from exc

    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise _InvalidTransportRequest(
            "リクエスト本文のJSONを読み取れませんでした。入力内容を確認してください。"
        ) from exc

    if not isinstance(payload, dict):
        raise _InvalidTransportRequest("リクエスト本文はJSONオブジェクトで送信してください。")

    return payload


def _validation_error(message: str) -> dict[str, Any]:
    return {
        "status": "error",
        "diagnostics": [
            {
                "code": "INVALID_REQUEST",
                "message": message,
            }
        ],
    }


def _http_response(status_code: int, body: Mapping[str, Any]) -> dict[str, Any]:
    # CORSヘッダーは認証や濫用対策にはならない。公開HTTP入口を追加する際は、
    # 許可オリジンの設定とは別に認証・レート制限等を設計すること。
    return {
        "statusCode": status_code,
        "headers": dict(_JSON_HEADERS),
        "body": json.dumps(body, ensure_ascii=False, separators=(",", ":")),
        "isBase64Encoded": False,
    }


def lambda_handler(event: Any, context: Any) -> dict[str, Any]:
    """直接呼出しまたはFunction URL形式のイベントを処理する。"""

    del context  # アプリケーション層をLambdaの実行コンテキストへ依存させない。

    if not isinstance(event, Mapping):
        return _validation_error("リクエストはJSONオブジェクトで送信してください。")

    is_http = _is_function_url_event(event)
    try:
        payload = _decode_http_body(event) if is_http else dict(event)
    except _InvalidTransportRequest as exc:
        error = _validation_error(str(exc))
        return _http_response(400, error) if is_http else error

    result = application.handle_request(payload)
    return _http_response(200, result) if is_http else result
