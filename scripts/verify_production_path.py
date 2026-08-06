#!/usr/bin/env python3
"""MVP上限入力を本番HTTP adapter経由で反復検証する。"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from copy import deepcopy
from typing import Any

from football_scheduler.api_handler import MAX_HTTP_BODY_BYTES, lambda_handler
from football_scheduler.fixtures import make_maximum_mvp_request


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="32チームの本番経路を30秒要件で検証します。")
    parser.add_argument("--repeat", type=int, default=2, help="再現性確認の実行回数。既定は2回")
    parser.add_argument(
        "--maximum-seconds", type=float, default=30.0, help="1回あたりの許容時間。既定は30秒"
    )
    return parser


def _normalized_hash(result: dict[str, Any]) -> str:
    normalized = deepcopy(result)
    metrics = normalized.get("metrics")
    if isinstance(metrics, dict):
        metrics.pop("wall_time_seconds", None)
    validation = normalized.get("validation")
    if isinstance(validation, dict):
        validation_metrics = validation.get("metrics")
        if isinstance(validation_metrics, dict):
            validation_metrics.pop("wall_time_seconds", None)
    encoded = json.dumps(
        normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def main() -> int:
    args = _parser().parse_args()
    if args.repeat < 2:
        print("再現性確認のため、--repeatは2以上にしてください。", file=sys.stderr)
        return 2
    if args.maximum_seconds <= 0:
        print("--maximum-secondsは0より大きくしてください。", file=sys.stderr)
        return 2

    request = make_maximum_mvp_request().model_dump(mode="json")
    body = json.dumps(request, ensure_ascii=False, separators=(",", ":"))
    event = {
        "httpMethod": "POST",
        "headers": {
            "content-type": "application/json",
            "content-length": str(len(body.encode("utf-8"))),
            "x-turnstile-action": "generate_schedule",
        },
        "body": body,
        "isBase64Encoded": False,
    }
    hashes: list[str] = []
    for attempt in range(1, args.repeat + 1):
        started = time.perf_counter()
        response = lambda_handler(event, None)
        elapsed = time.perf_counter() - started
        response_bytes = len(response["body"].encode("utf-8"))
        result = json.loads(response["body"])
        if response["statusCode"] != 200:
            print(
                f"{attempt}回目: APIが{response['statusCode']}を返しました: {result}",
                file=sys.stderr,
            )
            return 1
        if result.get("status") not in {"OPTIMAL", "FEASIBLE"}:
            print(f"{attempt}回目: 実行可能な日程を得られませんでした: {result}", file=sys.stderr)
            return 1
        validation = result.get("validation")
        if not isinstance(validation, dict) or validation.get("valid") is not True:
            print(f"{attempt}回目: 独立制約検証に失敗しました: {validation}", file=sys.stderr)
            return 1
        if elapsed > args.maximum_seconds:
            print(
                f"{attempt}回目: {elapsed:.3f}秒で上限{args.maximum_seconds:.3f}秒を超えました。",
                file=sys.stderr,
            )
            return 1
        if response_bytes > MAX_HTTP_BODY_BYTES:
            print(f"{attempt}回目: 応答が1 MBを超えました。", file=sys.stderr)
            return 1
        result_hash = _normalized_hash(result)
        hashes.append(result_hash)
        print(
            f"{attempt}回目: {result['status']}、{elapsed:.3f}秒、"
            f"{response_bytes:,}バイト、独立制約検証=合格"
        )

    if len(set(hashes)) != 1:
        print("同じ入力とrandom_seedから異なる結果が生成されました。", file=sys.stderr)
        return 1
    print(f"再現性=合格、結果SHA-256={hashes[0]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
