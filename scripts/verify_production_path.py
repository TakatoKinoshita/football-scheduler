#!/usr/bin/env python3
"""順位決定トーナメントの両日生成をhash seedの異なる本番HTTP adapterで検証する。"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from football_scheduler.api_handler import MAX_HTTP_BODY_BYTES, lambda_handler
from football_scheduler.fixtures import (
    make_maximum_four_tournament_schedule_creation_request,
    make_maximum_schedule_creation_request,
    make_sixteen_team_schedule_creation_request,
    make_twenty_four_team_schedule_creation_request,
)

_HASH_SEEDS = ("1", "987654321")
_PROFILE_FACTORIES = {
    "sixteen": make_sixteen_team_schedule_creation_request,
    "twenty-four": make_twenty_four_team_schedule_creation_request,
    "maximum": make_maximum_schedule_creation_request,
    "maximum-four": make_maximum_four_tournament_schedule_creation_request,
}
_PROFILE_MATCH_COUNTS = {
    "sixteen": 24,
    "twenty-four": 36,
    "maximum": 64,
    "maximum-four": 48,
}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="順位決定トーナメントの本番経路を別プロセスで検証します。"
    )
    parser.add_argument(
        "--profile",
        choices=tuple(_PROFILE_FACTORIES),
        default="maximum",
        help="検証構成。既定は32チームのmaximum",
    )
    parser.add_argument("--repeat", type=int, default=2, help="再現性確認の実行回数。既定は2回")
    parser.add_argument(
        "--maximum-seconds", type=float, default=30.0, help="1回あたりの許容時間。既定は30秒"
    )
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    return parser


def _remove_wall_times(value: object) -> object:
    if isinstance(value, dict):
        return {
            key: _remove_wall_times(item)
            for key, item in value.items()
            if key != "wall_time_seconds"
        }
    if isinstance(value, list):
        return [_remove_wall_times(item) for item in value]
    return value


def _normalized_hash(result: dict[str, Any]) -> str:
    encoded = json.dumps(
        _remove_wall_times(result),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def _event(profile: str) -> dict[str, object]:
    request = _PROFILE_FACTORIES[profile]()
    body = json.dumps(
        request,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return {
        "httpMethod": "POST",
        "headers": {
            "content-type": "application/json",
            "content-length": str(len(body.encode())),
            "x-turnstile-action": "create_schedule",
        },
        "body": body,
        "isBase64Encoded": False,
    }


def _worker(profile: str, maximum_seconds: float) -> int:
    started = time.perf_counter()
    response = lambda_handler(_event(profile), None)
    elapsed = time.perf_counter() - started
    response_bytes = len(response["body"].encode())
    result: Any = json.loads(response["body"])
    if response["statusCode"] != 200 or not isinstance(result, dict):
        print(json.dumps({"error": "HTTP_ERROR", "response": response}, ensure_ascii=False))
        return 1
    tournament_result = result.get("tournament_result")
    day2 = tournament_result.get("day2_schedule") if isinstance(tournament_result, dict) else None
    matches = day2.get("tournament_matches") if isinstance(day2, dict) else None
    slots = day2.get("slots") if isinstance(day2, dict) else None
    occupied_count = (
        sum(isinstance(slot, dict) and slot.get("match_id") is not None for slot in slots)
        if isinstance(slots, list)
        else -1
    )
    validation = day2.get("validation") if isinstance(day2, dict) else None
    integrated = day2.get("integrated_validation") if isinstance(day2, dict) else None
    diagnostics = day2.get("diagnostics") if isinstance(day2, dict) else None
    template_fallback = any(
        isinstance(item, dict) and item.get("code") == "PLACEMENT_TEMPLATE_FALLBACK_USED"
        for item in diagnostics or ()
    )
    expected_match_count = _PROFILE_MATCH_COUNTS[profile]
    errors: list[str] = []
    if result.get("status") not in {"OPTIMAL", "FEASIBLE"}:
        errors.append("STATUS")
    if (
        not isinstance(matches, list)
        or len(matches) != expected_match_count
        or occupied_count != expected_match_count
    ):
        errors.append("MATCH_COUNT")
    if not isinstance(validation, dict) or validation.get("valid") is not True:
        errors.append("VALIDATION")
    if not isinstance(integrated, dict) or integrated.get("valid") is not True:
        errors.append("INTEGRATED_VALIDATION")
    if template_fallback:
        errors.append("TEMPLATE_FALLBACK")
    if elapsed > maximum_seconds:
        errors.append("TIME_LIMIT")
    if response_bytes > MAX_HTTP_BODY_BYTES:
        errors.append("RESPONSE_LIMIT")
    payload = {
        "status": result.get("status"),
        "profile": profile,
        "elapsed_seconds": elapsed,
        "response_bytes": response_bytes,
        "match_count": len(matches) if isinstance(matches, list) else -1,
        "occupied_match_count": occupied_count,
        "result_sha256": _normalized_hash(result),
        "errors": errors,
    }
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    return int(bool(errors))


def _run_worker(profile: str, hash_seed: str, maximum_seconds: float) -> dict[str, Any]:
    environment = os.environ.copy()
    environment["PYTHONHASHSEED"] = hash_seed
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--worker",
        "--profile",
        profile,
        "--maximum-seconds",
        str(maximum_seconds),
    ]
    result = subprocess.run(
        command,
        cwd=Path(__file__).parents[1],
        env=environment,
        capture_output=True,
        text=True,
        timeout=max(60.0, maximum_seconds + 15.0),
    )
    try:
        payload: Any = json.loads(result.stdout)
    except json.JSONDecodeError:
        payload = None
    if result.returncode != 0 or not isinstance(payload, dict):
        raise RuntimeError(
            f"hash seed {hash_seed}のworkerが失敗しました: "
            f"stdout={result.stdout[-2000:]!r} stderr={result.stderr[-2000:]!r}"
        )
    return payload


def main() -> int:
    args = _parser().parse_args()
    if args.maximum_seconds <= 0:
        print("--maximum-secondsは0より大きくしてください。", file=sys.stderr)
        return 2
    if args.worker:
        return _worker(args.profile, args.maximum_seconds)
    if args.repeat < 2:
        print("再現性確認のため、--repeatは2以上にしてください。", file=sys.stderr)
        return 2

    payloads: list[dict[str, Any]] = []
    try:
        for attempt in range(args.repeat):
            seed = _HASH_SEEDS[attempt % len(_HASH_SEEDS)]
            payload = _run_worker(args.profile, seed, args.maximum_seconds)
            payloads.append(payload)
            expected_match_count = _PROFILE_MATCH_COUNTS[args.profile]
            print(
                f"{attempt + 1}回目(hash seed={seed}): {payload['status']}、"
                f"{payload['elapsed_seconds']:.3f}秒、{payload['response_bytes']:,}バイト、"
                f"2日目{expected_match_count}試合・独立制約検証=合格"
            )
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    hashes = {str(payload["result_sha256"]) for payload in payloads}
    if len(hashes) != 1:
        print("異なるhash seedから異なる結果が生成されました。", file=sys.stderr)
        return 1
    digest = next(iter(hashes))
    print(f"プロセス間再現性=合格、結果SHA-256={digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
