#!/usr/bin/env python3
"""本番Lambda aliasのデプロイ後確認用API Gatewayイベントを作る。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from football_scheduler.fixtures import (
    make_maximum_schedule_creation_request,
    make_smoke_request,
)


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


def build_maximum_day2_event() -> dict[str, object]:
    """テンプレート同梱を確認する32チーム両日生成eventを返す。"""

    request_body = json.dumps(
        make_maximum_schedule_creation_request(),
        ensure_ascii=False,
        separators=(",", ":"),
    )
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


def main() -> int:
    parser = argparse.ArgumentParser(description="本番Lambda用の小規模smoke eventを作成します。")
    parser.add_argument("output", type=Path)
    parser.add_argument("--maximum-day2", action="store_true")
    args = parser.parse_args()
    event = build_maximum_day2_event() if args.maximum_day2 else build_smoke_event()
    args.output.write_text(json.dumps(event, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
