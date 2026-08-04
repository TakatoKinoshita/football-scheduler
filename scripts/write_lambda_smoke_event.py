#!/usr/bin/env python3
"""本番Lambda aliasのデプロイ後確認用API Gatewayイベントを作る。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from football_scheduler.fixtures import make_smoke_request


def main() -> int:
    parser = argparse.ArgumentParser(description="本番Lambda用の小規模smoke eventを作成します。")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    request_body = json.dumps(
        make_smoke_request().model_dump(mode="json"),
        ensure_ascii=False,
        separators=(",", ":"),
    )
    event = {
        "httpMethod": "POST",
        "headers": {
            "content-type": "application/json",
            "content-length": str(len(request_body.encode("utf-8"))),
        },
        "body": request_body,
        "isBase64Encoded": False,
    }
    args.output.write_text(json.dumps(event, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
