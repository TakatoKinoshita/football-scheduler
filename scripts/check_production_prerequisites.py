#!/usr/bin/env python3
"""本番デプロイ前のAWS account状態を読み取り専用APIで確認する。"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections.abc import Sequence
from typing import Any

from football_scheduler.production_checks import evaluate

REGION = "us-east-1"


def _aws_json(arguments: Sequence[str]) -> dict[str, Any]:
    completed = subprocess.run(
        ["aws", *arguments, "--region", REGION, "--output", "json", "--no-cli-pager"],
        check=True,
        capture_output=True,
        text=True,
    )
    result = json.loads(completed.stdout)
    if not isinstance(result, dict):
        raise ValueError("AWS CLIの応答がJSONオブジェクトではありません。")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--hosting",
        choices=("cloudflare-pages", "cloudfront"),
        default="cloudflare-pages",
        help="静的配信方式。既定値はcloudflare-pagesです。",
    )
    args = parser.parse_args()
    try:
        free_tier = _aws_json(["freetier", "get-account-plan-state"])
        subscriptions = (
            _aws_json(["pricing-plan-manager", "list-subscriptions"])
            if args.hosting == "cloudfront"
            else {}
        )
        lambda_settings = _aws_json(["lambda", "get-account-settings"])
    except (
        FileNotFoundError,
        ValueError,
        json.JSONDecodeError,
        subprocess.CalledProcessError,
    ) as exc:
        print(
            "AWSの読み取り確認を完了できませんでした。認証を更新し、権限と通信状態を確認してください。",
            file=sys.stderr,
        )
        if isinstance(exc, subprocess.CalledProcessError) and exc.stderr:
            print(exc.stderr.strip(), file=sys.stderr)
        return 2

    checks = evaluate(free_tier, subscriptions, lambda_settings, hosting=args.hosting)
    for check in checks:
        print(f"[{check.level}] {check.message}")
    return 1 if any(check.level == "不合格" for check in checks) else 0


if __name__ == "__main__":
    raise SystemExit(main())
