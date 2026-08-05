#!/usr/bin/env python3
"""本番release切替の状態を検証し、秘密を含まないplanを作成する。"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

_SHA_PATTERN = re.compile(r"[0-9a-f]{40}")
_PLAN_ID_PATTERN = re.compile(r"[0-9a-f]{64}")
_STABLE_STACK_STATUSES = {
    "CREATE_COMPLETE",
    "UPDATE_COMPLETE",
    "UPDATE_ROLLBACK_COMPLETE",
}


def _mapping(value: object, message: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(message)
    return value


def _sequence(value: object, message: str) -> Sequence[object]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise ValueError(message)
    return value


def _text(value: object, message: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(message)
    return value


def _release_parameter(stack: Mapping[str, Any]) -> str:
    parameters = _sequence(stack.get("Parameters"), "本番stackのParametersを確認できません。")
    for parameter_value in parameters:
        parameter = _mapping(parameter_value, "本番stackのparameter形式が不正です。")
        if parameter.get("ParameterKey") == "ReleaseId":
            return _text(parameter.get("ParameterValue"), "本番stackのReleaseIdを確認できません。")
    raise ValueError("本番stackにReleaseIdがありません。")


def _solver_function_name(stack: Mapping[str, Any]) -> str:
    outputs = _sequence(stack.get("Outputs"), "本番stackのOutputsを確認できません。")
    for output_value in outputs:
        output = _mapping(output_value, "本番stackのoutput形式が不正です。")
        if output.get("OutputKey") == "SolverFunctionName":
            return _text(output.get("OutputValue"), "本番stackのsolver関数名を確認できません。")
    raise ValueError("本番stackにSolverFunctionName outputがありません。")


def _stack_state(document: Mapping[str, Any], expected_stack_name: str) -> tuple[str, str, str]:
    stacks = _sequence(document.get("Stacks"), "本番stackの応答にStacks配列がありません。")
    if len(stacks) != 1:
        raise ValueError("本番stackを一意に確認できません。")
    stack = _mapping(stacks[0], "本番stackの応答形式が不正です。")
    if stack.get("StackName") != expected_stack_name:
        raise ValueError("確認したstack名が本番stackと一致しません。")
    status = _text(stack.get("StackStatus"), "本番stackの状態を確認できません。")
    if status not in _STABLE_STACK_STATUSES:
        raise ValueError(f"本番stackが安定状態ではありません: {status}")
    return _release_parameter(stack), _solver_function_name(stack), status


def _deployment_release(deployment: Mapping[str, Any]) -> str | None:
    trigger = deployment.get("deployment_trigger")
    if not isinstance(trigger, Mapping):
        return None
    metadata = trigger.get("metadata")
    if not isinstance(metadata, Mapping):
        return None
    release = metadata.get("commit_hash")
    return release if isinstance(release, str) else None


def _select_deployment(document: Mapping[str, Any], *, release_id: str, project_name: str) -> str:
    deployments = _sequence(
        document.get("result"), "Cloudflare Pages API応答にresult配列がありません。"
    )
    candidates: list[tuple[str, str]] = []
    for value in deployments:
        if not isinstance(value, Mapping):
            continue
        if value.get("environment") != "production":
            continue
        if value.get("project_name") not in {None, project_name}:
            continue
        stage = value.get("latest_stage")
        if not isinstance(stage, Mapping) or stage.get("status") != "success":
            continue
        if _deployment_release(value) != release_id:
            continue
        identifier = value.get("id")
        if isinstance(identifier, str) and identifier:
            created_on = value.get("created_on")
            candidates.append((created_on if isinstance(created_on, str) else "", identifier))
    if not candidates:
        raise ValueError(f"release {release_id}の成功済みproduction deploymentがありません。")
    return max(candidates)[1]


def _canonical_deployment(
    document: Mapping[str, Any], *, release_id: str, project_name: str
) -> str:
    project = _mapping(document.get("result"), "Cloudflare Pages project情報がありません。")
    if project.get("name") != project_name:
        raise ValueError("Cloudflare Pages project名が指定値と一致しません。")
    deployment = _mapping(
        project.get("canonical_deployment"),
        "現在のCloudflare Pages production deploymentがありません。",
    )
    if deployment.get("environment") != "production":
        raise ValueError("現在のCloudflare Pages deploymentがproductionではありません。")
    stage = _mapping(
        deployment.get("latest_stage"),
        "現在のCloudflare Pages deployment状態を確認できません。",
    )
    if stage.get("status") != "success":
        raise ValueError("現在のCloudflare Pages deploymentが成功状態ではありません。")
    if _deployment_release(deployment) != release_id:
        raise ValueError("現在のCloudflare Pages deploymentが指定releaseと一致しません。")
    return _text(deployment.get("id"), "現在のCloudflare Pages deployment IDがありません。")


def _version_release(version: Mapping[str, Any]) -> str | None:
    environment = version.get("Environment")
    if not isinstance(environment, Mapping):
        return None
    variables = environment.get("Variables")
    if not isinstance(variables, Mapping):
        return None
    release = variables.get("RELEASE_ID")
    return release if isinstance(release, str) else None


def _select_version(document: Mapping[str, Any], release_id: str) -> str:
    versions = _sequence(document.get("Versions"), "Lambda version一覧を確認できません。")
    candidates: list[int] = []
    for value in versions:
        if not isinstance(value, Mapping) or _version_release(value) != release_id:
            continue
        version = value.get("Version")
        if isinstance(version, str) and version.isdigit() and int(version) > 0:
            candidates.append(int(version))
    if not candidates:
        raise ValueError(f"release {release_id}のsolver Lambda versionがありません。")
    return str(max(candidates))


def _public_release(headers: str) -> str:
    releases = []
    for line in headers.splitlines():
        name, separator, value = line.partition(":")
        if separator and name.strip().lower() == "x-release-id":
            releases.append(value.strip())
    if len(releases) != 1 or not _SHA_PATTERN.fullmatch(releases[0]):
        raise ValueError("公開URLのX-Release-Idを一意に確認できません。")
    return releases[0]


def _plan_id(plan: Mapping[str, str]) -> str:
    canonical = json.dumps(plan, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def build_switch_plan(
    *,
    project: Mapping[str, Any],
    deployments: Mapping[str, Any],
    versions: Mapping[str, Any],
    alias: Mapping[str, Any],
    stacks: Mapping[str, Any],
    public_headers: str,
    direction: str,
    expected_current_release: str,
    target_release: str,
    stack_name: str,
    region: str,
    project_name: str,
    public_url: str,
) -> dict[str, str]:
    """切替元と切替先を検証し、plan IDの材料になる安全な値だけを返す。"""

    if direction not in {"rollback", "restore"}:
        raise ValueError("directionはrollbackまたはrestoreで指定してください。")
    if not _SHA_PATTERN.fullmatch(expected_current_release):
        raise ValueError("現在release SHAは40文字の小文字16進数で指定してください。")
    if not _SHA_PATTERN.fullmatch(target_release):
        raise ValueError("対象release SHAは40文字の小文字16進数で指定してください。")
    if expected_current_release == target_release:
        raise ValueError("現在releaseと対象releaseが同じです。")

    stack_release, solver_function, stack_status = _stack_state(stacks, stack_name)
    public_release = _public_release(public_headers)
    if public_release != expected_current_release:
        raise ValueError("公開URLのreleaseが指定した現在releaseと一致しません。")

    current_version = _text(
        alias.get("FunctionVersion"), "solver live aliasのversionを確認できません。"
    )
    current_revision = _text(
        alias.get("RevisionId"), "solver live aliasのrevisionを確認できません。"
    )
    selected_current_version = _select_version(versions, expected_current_release)
    if current_version != selected_current_version:
        raise ValueError("solver live aliasが指定した現在releaseを参照していません。")

    if direction == "rollback" and stack_release != expected_current_release:
        raise ValueError("rollback開始時のstack ReleaseIdが現在releaseと一致しません。")
    if direction == "restore" and stack_release != target_release:
        raise ValueError("restore対象がCloudFormation管理中のreleaseと一致しません。")

    plan = {
        "format_version": "1",
        "direction": direction,
        "stack_name": stack_name,
        "stack_status": stack_status,
        "stack_release": stack_release,
        "region": region,
        "project_name": project_name,
        "public_url": public_url,
        "solver_function": solver_function,
        "current_release": expected_current_release,
        "current_pages_id": _canonical_deployment(
            project, release_id=expected_current_release, project_name=project_name
        ),
        "current_solver_version": current_version,
        "current_alias_revision": current_revision,
        "target_release": target_release,
        "target_pages_id": _select_deployment(
            deployments, release_id=target_release, project_name=project_name
        ),
        "target_solver_version": _select_version(versions, target_release),
    }
    plan["plan_id"] = _plan_id(plan)
    return plan


def render_summary(plan: Mapping[str, str]) -> str:
    label = "rollback" if plan["direction"] == "rollback" else "restore"
    return "\n".join(
        [
            "## 本番release切替plan",
            "",
            f"- 操作: `{label}`",
            f"- Plan ID: `{plan['plan_id']}`",
            f"- Stack / region: `{plan['stack_name']}` / `{plan['region']}`",
            f"- 現在release: `{plan['current_release']}`",
            f"- 対象release: `{plan['target_release']}`",
            f"- 現在Pages deployment: `{plan['current_pages_id']}`",
            f"- 対象Pages deployment: `{plan['target_pages_id']}`",
            f"- 現在solver version: `{plan['current_solver_version']}`",
            f"- 対象solver version: `{plan['target_solver_version']}`",
            "",
            "大会入力、応答本文、secretはこの要約へ含めていません。",
            "",
        ]
    )


def validate_cloudflare_rollback_response(
    document: Mapping[str, Any], expected_deployment_id: str
) -> None:
    if document.get("success") is not True:
        raise ValueError("Cloudflare Pagesのrelease切替APIが成功を返しませんでした。")
    result = _mapping(document.get("result"), "Cloudflare Pagesの切替結果がありません。")
    if result.get("id") != expected_deployment_id:
        raise ValueError("Cloudflare Pagesの切替先deploymentが指定値と一致しません。")


def _load_mapping(path: Path, message: str) -> Mapping[str, Any]:
    document = json.loads(path.read_text(encoding="utf-8"))
    return _mapping(document, message)


def _write_github_output(path: Path, plan: Mapping[str, str]) -> None:
    keys = (
        "plan_id",
        "solver_function",
        "current_pages_id",
        "current_solver_version",
        "current_alias_revision",
        "target_pages_id",
        "target_solver_version",
    )
    with path.open("a", encoding="utf-8") as output:
        output.write("".join(f"{key}={plan[key]}\n" for key in keys))


def _plan_command(args: argparse.Namespace) -> int:
    plan = build_switch_plan(
        project=_load_mapping(args.project, "Cloudflare Pages project API応答が不正です。"),
        deployments=_load_mapping(args.deployments, "Cloudflare Pages API応答が不正です。"),
        versions=_load_mapping(args.versions, "Lambda version一覧の応答が不正です。"),
        alias=_load_mapping(args.alias, "Lambda alias応答が不正です。"),
        stacks=_load_mapping(args.stacks, "CloudFormation stack応答が不正です。"),
        public_headers=args.public_headers.read_text(encoding="utf-8"),
        direction=args.direction,
        expected_current_release=args.expected_current_release,
        target_release=args.target_release,
        stack_name=args.stack_name,
        region=args.region,
        project_name=args.project_name,
        public_url=args.public_url,
    )
    args.plan_output.write_text(
        json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    args.summary_output.write_text(render_summary(plan), encoding="utf-8")
    if args.github_output is not None:
        _write_github_output(args.github_output, plan)
    print(plan["plan_id"])
    return 0


def _response_command(args: argparse.Namespace) -> int:
    document = _load_mapping(args.response, "Cloudflare Pagesの切替応答が不正です。")
    validate_cloudflare_rollback_response(document, args.deployment_id)
    print("Cloudflare Pagesのrelease切替を確認しました。")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    plan_parser = subparsers.add_parser("plan", help="現在状態と対象releaseを検証します。")
    plan_parser.add_argument("--project", type=Path, required=True)
    plan_parser.add_argument("--deployments", type=Path, required=True)
    plan_parser.add_argument("--versions", type=Path, required=True)
    plan_parser.add_argument("--alias", type=Path, required=True)
    plan_parser.add_argument("--stacks", type=Path, required=True)
    plan_parser.add_argument("--public-headers", type=Path, required=True)
    plan_parser.add_argument("--direction", choices=("rollback", "restore"), required=True)
    plan_parser.add_argument("--expected-current-release", required=True)
    plan_parser.add_argument("--target-release", required=True)
    plan_parser.add_argument("--stack-name", required=True)
    plan_parser.add_argument("--region", default="us-east-1")
    plan_parser.add_argument("--project-name", required=True)
    plan_parser.add_argument("--public-url", required=True)
    plan_parser.add_argument("--plan-output", type=Path, required=True)
    plan_parser.add_argument("--summary-output", type=Path, required=True)
    plan_parser.add_argument("--github-output", type=Path)
    plan_parser.set_defaults(handler=_plan_command)

    response_parser = subparsers.add_parser(
        "check-cloudflare-response", help="Pages rollback APIの応答を検証します。"
    )
    response_parser.add_argument("response", type=Path)
    response_parser.add_argument("--deployment-id", required=True)
    response_parser.set_defaults(handler=_response_command)

    args = parser.parse_args()
    try:
        return int(args.handler(args))
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    raise SystemExit(main())
