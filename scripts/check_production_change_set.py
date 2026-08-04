#!/usr/bin/env python3
"""本番CloudFormation change setを検証し、安全な要約だけを書き出す。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def _require_text(document: dict[str, Any], key: str) -> str:
    value = document.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"change setの{key}がありません。")
    return value


def _release_id(document: dict[str, Any]) -> str | None:
    parameters = document.get("Parameters")
    if not isinstance(parameters, list):
        return None
    for parameter in parameters:
        if not isinstance(parameter, dict) or parameter.get("ParameterKey") != "ReleaseId":
            continue
        value = parameter.get("ParameterValue")
        return value if isinstance(value, str) else None
    return None


def validate_change_set(
    document: dict[str, Any],
    *,
    stack_name: str,
    release_id: str,
    region: str,
    require_add_only: bool = False,
) -> list[dict[str, str]]:
    """実行対象との対応と状態を検証し、表示可能なresource変更だけを返す。"""

    change_set_id = _require_text(document, "ChangeSetId")
    arn_parts = change_set_id.split(":", 5)
    if len(arn_parts) != 6 or arn_parts[2] != "cloudformation" or arn_parts[3] != region:
        raise ValueError(f"change setが検証region {region}に属していません。")
    if document.get("StackName") != stack_name:
        raise ValueError(f"change setが本番stack {stack_name}に属していません。")
    if document.get("Status") != "CREATE_COMPLETE":
        raise ValueError("change setの作成が完了していません。")
    if document.get("ExecutionStatus") != "AVAILABLE":
        raise ValueError("change setは実行可能な状態ではありません。")
    if _release_id(document) != release_id:
        raise ValueError("change setのReleaseIdが実行対象commit SHAと一致しません。")

    raw_changes = document.get("Changes")
    if not isinstance(raw_changes, list) or not raw_changes:
        raise ValueError("change setにresource変更がありません。")

    safe_changes: list[dict[str, str]] = []
    for item in raw_changes:
        resource = item.get("ResourceChange") if isinstance(item, dict) else None
        if not isinstance(resource, dict):
            raise ValueError("change setのresource変更形式が不正です。")
        action = resource.get("Action")
        logical_id = resource.get("LogicalResourceId")
        resource_type = resource.get("ResourceType")
        replacement = resource.get("Replacement")
        required_values = (action, logical_id, resource_type)
        if not all(isinstance(value, str) and value for value in required_values):
            raise ValueError("change setのresource変更に必須項目がありません。")
        replacement_text = replacement if isinstance(replacement, str) else "-"
        if require_add_only and action != "Add":
            raise ValueError("初回change setにAdd以外の変更が含まれています。")
        if require_add_only and replacement_text not in {"-", "False", "NotApplicable"}:
            raise ValueError("初回change setにresource置換が含まれています。")
        safe_changes.append(
            {
                "Action": action,
                "LogicalId": logical_id,
                "Type": resource_type,
                "Replacement": replacement_text,
            }
        )
    return safe_changes


def render_summary(change_set_id: str, release_id: str, changes: list[dict[str, str]]) -> str:
    """秘密parameterを含まないGitHub Actions向けMarkdownを返す。"""

    lines = [
        "## CloudFormation change set",
        "",
        f"- Change set ARN: `{change_set_id}`",
        f"- Release SHA: `{release_id}`",
        "",
        "| Action | Logical ID | Resource type | Replacement |",
        "| --- | --- | --- | --- |",
    ]
    lines.extend(
        f"| {item['Action']} | {item['LogicalId']} | {item['Type']} | {item['Replacement']} |"
        for item in changes
    )
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("response", type=Path, help="aws cloudformation describe-change-setのJSON")
    parser.add_argument("--stack-name", required=True)
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--summary-output", required=True, type=Path)
    parser.add_argument(
        "--require-add-only",
        action="store_true",
        help="初回作成としてAdd以外とresource置換を拒否します。",
    )
    args = parser.parse_args()

    try:
        document = json.loads(args.response.read_text(encoding="utf-8"))
        if not isinstance(document, dict):
            raise ValueError("change setの応答がJSONオブジェクトではありません。")
        changes = validate_change_set(
            document,
            stack_name=args.stack_name,
            release_id=args.release_id,
            region=args.region,
            require_add_only=args.require_add_only,
        )
        change_set_id = _require_text(document, "ChangeSetId")
        args.summary_output.write_text(
            render_summary(change_set_id, args.release_id, changes), encoding="utf-8"
        )
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        parser.error(str(exc))

    print(change_set_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
