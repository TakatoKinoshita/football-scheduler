#!/usr/bin/env python3
"""本番Lambda aliasのデプロイ後確認用API Gatewayイベントを作る。"""

from __future__ import annotations

import argparse
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

from football_scheduler.fixtures import (
    make_maximum_four_tournament_schedule_creation_request,
    make_maximum_schedule_creation_request,
    make_sixteen_team_schedule_creation_request,
    make_smoke_request,
    make_twenty_four_team_schedule_creation_request,
)

_TOURNAMENT_RESULTS_FIXTURE = Path(__file__).resolve().parent / "fixtures/tournament-results-8.json"


def build_smoke_event() -> dict[str, object]:
    """本番API adapterと同じaction照合を通る直接invoke eventを返す。"""

    request_body = json.dumps(
        make_smoke_request().model_dump(mode="json"),
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return {
        "httpMethod": "POST",
        "headers": {
            "content-type": "application/json",
            "content-length": str(len(request_body.encode("utf-8"))),
            "x-turnstile-action": "generate_schedule",
        },
        "body": request_body,
        "isBase64Encoded": False,
    }


def build_tournament_results_event() -> dict[str, object]:
    """8チームの全試合結果から最終順位を確定するeventを返す。"""

    request_body = json.dumps(
        json.loads(_TOURNAMENT_RESULTS_FIXTURE.read_text(encoding="utf-8")),
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return {
        "httpMethod": "POST",
        "headers": {
            "content-type": "application/json",
            "content-length": str(len(request_body.encode("utf-8"))),
            "x-turnstile-action": "calculate_tournament_results",
        },
        "body": request_body,
        "isBase64Encoded": False,
    }


def build_maximum_day2_event() -> dict[str, object]:
    """テンプレート同梱を確認する32チーム両日生成eventを返す。"""

    return _build_day2_event(make_maximum_schedule_creation_request)


def build_twenty_four_day2_event() -> dict[str, object]:
    """24チーム・3トーナメントのcatalogを確認する両日生成eventを返す。"""

    return _build_day2_event(make_twenty_four_team_schedule_creation_request)


def build_maximum_four_day2_event() -> dict[str, object]:
    """32チーム・4トーナメントのcatalogを確認する両日生成eventを返す。"""

    return _build_day2_event(make_maximum_four_tournament_schedule_creation_request)


def _build_day2_event(factory: Callable[[], dict[str, Any]]) -> dict[str, object]:
    request_body = json.dumps(factory(), ensure_ascii=False, separators=(",", ":"))
    return {
        "httpMethod": "POST",
        "headers": {
            "content-type": "application/json",
            "content-length": str(len(request_body.encode("utf-8"))),
            "x-turnstile-action": "create_schedule",
        },
        "body": request_body,
        "isBase64Encoded": False,
    }


def build_sixteen_day2_event() -> dict[str, object]:
    """再最適化対象の16チームcatalogを確認する両日生成eventを返す。"""

    return _build_day2_event(make_sixteen_team_schedule_creation_request)


def main() -> int:
    parser = argparse.ArgumentParser(description="本番Lambda用の小規模smoke eventを作成します。")
    parser.add_argument("output", type=Path)
    profile = parser.add_mutually_exclusive_group()
    profile.add_argument("--tournament-results", action="store_true")
    profile.add_argument("--sixteen-day2", action="store_true")
    profile.add_argument("--twenty-four-day2", action="store_true")
    profile.add_argument("--maximum-day2", action="store_true")
    profile.add_argument("--maximum-four-day2", action="store_true")
    args = parser.parse_args()
    event = (
        build_tournament_results_event()
        if args.tournament_results
        else build_sixteen_day2_event()
        if args.sixteen_day2
        else build_twenty_four_day2_event()
        if args.twenty_four_day2
        else build_maximum_day2_event()
        if args.maximum_day2
        else build_maximum_four_day2_event()
        if args.maximum_four_day2
        else build_smoke_event()
    )
    args.output.write_text(json.dumps(event, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
