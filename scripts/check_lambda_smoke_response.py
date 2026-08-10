#!/usr/bin/env python3
"""本番Lambda aliasのsmoke応答でschemaと独立検証結果を確認する。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def main() -> int:
    parser = argparse.ArgumentParser(description="Lambda smoke応答を検証します。")
    parser.add_argument("response", type=Path)
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--maximum-day2", action="store_true")
    args = parser.parse_args()
    envelope: Any = json.loads(args.response.read_text(encoding="utf-8"))
    if not isinstance(envelope, dict) or envelope.get("statusCode") != 200:
        print(f"Lambda adapterが正常応答を返しませんでした: {envelope}", file=sys.stderr)
        return 1
    headers = envelope.get("headers")
    if not isinstance(headers, dict) or headers.get("X-Release-Id") != args.release_id:
        print("Lambdaのrelease IDがデプロイ対象と一致しません。", file=sys.stderr)
        return 1
    body = json.loads(envelope.get("body", "null"))
    if not isinstance(body, dict) or body.get("schema_version") != "0.2.0":
        print("Lambda応答のschema versionが一致しません。", file=sys.stderr)
        return 1
    if args.maximum_day2:
        tournament_result = body.get("tournament_result")
        day2 = (
            tournament_result.get("day2_schedule") if isinstance(tournament_result, dict) else None
        )
        matches = day2.get("tournament_matches") if isinstance(day2, dict) else None
        slots = day2.get("slots") if isinstance(day2, dict) else None
        occupied_count = (
            sum(isinstance(slot, dict) and slot.get("match_id") is not None for slot in slots)
            if isinstance(slots, list)
            else -1
        )
        validation = day2.get("validation") if isinstance(day2, dict) else None
        integrated = day2.get("integrated_validation") if isinstance(day2, dict) else None
        if (
            body.get("status") not in {"OPTIMAL", "FEASIBLE"}
            or not isinstance(matches, list)
            or len(matches) != 64
            or occupied_count != 64
            or not isinstance(validation, dict)
            or validation.get("valid") is not True
            or not isinstance(integrated, dict)
            or integrated.get("valid") is not True
        ):
            print("32チーム・2トーナメントの検証結果が不正です。", file=sys.stderr)
            return 1
        if len(envelope.get("body", "").encode()) > 1_000_000:
            print("32チーム経路のLambda応答が1 MBを超えました。", file=sys.stderr)
            return 1
        print("Lambda aliasの32チーム・2トーナメント生成と独立制約検証に合格しました。")
    else:
        validation = body.get("validation")
        if not isinstance(validation, dict) or validation.get("valid") is not True:
            print(f"デプロイ後の独立制約検証に失敗しました: {validation}", file=sys.stderr)
            return 1
        print("Lambda aliasの疎通、schema version、独立制約検証に合格しました。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
