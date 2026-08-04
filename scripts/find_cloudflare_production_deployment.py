#!/usr/bin/env python3
"""Cloudflare Pages API応答からrollback対象のproduction deployment IDを選ぶ。"""

from __future__ import annotations

import argparse
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any


def find_deployment_id(document: Mapping[str, Any]) -> str:
    deployments = document.get("result")
    if not isinstance(deployments, list):
        raise ValueError("Cloudflare Pages API応答にresult配列がありません。")
    candidates: list[tuple[str, str]] = []
    for deployment in deployments:
        if not isinstance(deployment, Mapping) or deployment.get("environment") != "production":
            continue
        stage = deployment.get("latest_stage")
        if isinstance(stage, Mapping) and stage.get("status") == "success":
            identifier = deployment.get("id")
            if isinstance(identifier, str) and identifier:
                created_on = deployment.get("created_on")
                candidates.append((created_on if isinstance(created_on, str) else "", identifier))
    return max(candidates, default=("", ""))[1]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("response", type=Path)
    args = parser.parse_args()
    document = json.loads(args.response.read_text(encoding="utf-8"))
    if not isinstance(document, Mapping):
        raise ValueError("Cloudflare Pages API応答がJSONオブジェクトではありません。")
    print(find_deployment_id(document))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
