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
    validation = body.get("validation")
    if not isinstance(validation, dict) or validation.get("valid") is not True:
        print(f"デプロイ後の独立制約検証に失敗しました: {validation}", file=sys.stderr)
        return 1
    print("Lambda aliasの疎通、schema version、独立制約検証に合格しました。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
