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
    profile = parser.add_mutually_exclusive_group()
    profile.add_argument("--sixteen-day2", action="store_true")
    profile.add_argument("--twenty-four-day2", action="store_true")
    profile.add_argument("--maximum-day2", action="store_true")
    profile.add_argument("--maximum-four-day2", action="store_true")
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
    day2_profile = next(
        (
            profile
            for enabled, profile in (
                (args.sixteen_day2, (16, 2, 24)),
                (args.twenty_four_day2, (24, 3, 36)),
                (args.maximum_day2, (32, 2, 64)),
                (args.maximum_four_day2, (32, 4, 48)),
            )
            if enabled
        ),
        None,
    )
    if day2_profile is not None:
        tournament_result = body.get("tournament_result")
        tournament_plan = (
            tournament_result.get("tournament_plan")
            if isinstance(tournament_result, dict)
            else None
        )
        pools = tournament_plan.get("pools") if isinstance(tournament_plan, dict) else None
        participant_count = (
            sum(int(pool.get("participant_count", 0)) for pool in pools if isinstance(pool, dict))
            if isinstance(pools, list)
            else -1
        )
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
        expected_team_count, expected_tournament_count, expected_match_count = day2_profile
        diagnostics = day2.get("diagnostics") if isinstance(day2, dict) else None
        template_fallback = any(
            isinstance(item, dict) and item.get("code") == "PLACEMENT_TEMPLATE_FALLBACK_USED"
            for item in diagnostics or ()
        )
        if (
            body.get("status") not in {"OPTIMAL", "FEASIBLE"}
            or not isinstance(pools, list)
            or any(not isinstance(pool, dict) for pool in pools)
            or len(pools) != expected_tournament_count
            or participant_count != expected_team_count
            or not isinstance(matches, list)
            or len(matches) != expected_match_count
            or occupied_count != expected_match_count
            or not isinstance(validation, dict)
            or validation.get("valid") is not True
            or not isinstance(integrated, dict)
            or integrated.get("valid") is not True
            or template_fallback
        ):
            print(
                f"{expected_team_count}チーム・{expected_tournament_count}トーナメントの"
                "検証結果が不正です。",
                file=sys.stderr,
            )
            return 1
        if len(envelope.get("body", "").encode()) > 1_000_000:
            print(
                f"{expected_team_count}チーム経路のLambda応答が1 MBを超えました。",
                file=sys.stderr,
            )
            return 1
        print(
            f"Lambda aliasの{expected_team_count}チーム・"
            f"{expected_tournament_count}トーナメント生成と独立制約検証に合格しました。"
        )
    else:
        validation = body.get("validation")
        if not isinstance(validation, dict) or validation.get("valid") is not True:
            print(f"デプロイ後の独立制約検証に失敗しました: {validation}", file=sys.stderr)
            return 1
        print("Lambda aliasの疎通、schema version、独立制約検証に合格しました。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
