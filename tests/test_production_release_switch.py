import copy
from pathlib import Path

import pytest

from scripts.production_release_switch import (
    build_switch_plan,
    render_summary,
    validate_cloudflare_rollback_response,
)

_CURRENT = "a" * 40
_TARGET = "9" * 40


def _project(release: str = _CURRENT, deployment_id: str = "current-pages") -> dict[str, object]:
    return {
        "result": {
            "name": "football-scheduler-jp",
            "canonical_deployment": {
                "id": deployment_id,
                "environment": "production",
                "deployment_trigger": {"metadata": {"commit_hash": release}},
                "latest_stage": {"status": "success"},
            },
        },
        "success": True,
    }


def _deployments() -> dict[str, object]:
    return {
        "result": [
            {
                "id": "preview",
                "environment": "preview",
                "deployment_trigger": {"metadata": {"commit_hash": _TARGET}},
                "latest_stage": {"status": "success"},
            },
            {
                "id": "failed-target",
                "environment": "production",
                "deployment_trigger": {"metadata": {"commit_hash": _TARGET}},
                "latest_stage": {"status": "failure"},
            },
            {
                "id": "target-pages",
                "project_name": "football-scheduler-jp",
                "environment": "production",
                "created_on": "2026-08-05T17:52:00Z",
                "deployment_trigger": {"metadata": {"commit_hash": _TARGET}},
                "latest_stage": {"status": "success"},
            },
            {
                "id": "current-pages",
                "project_name": "football-scheduler-jp",
                "environment": "production",
                "created_on": "2026-08-05T18:23:00Z",
                "deployment_trigger": {"metadata": {"commit_hash": _CURRENT}},
                "latest_stage": {"status": "success"},
            },
        ],
        "success": True,
    }


def _versions() -> dict[str, object]:
    return {
        "Versions": [
            {"Version": "$LATEST"},
            {"Version": "7", "Environment": {"Variables": {"RELEASE_ID": _TARGET}}},
            {"Version": "8", "Environment": {"Variables": {"RELEASE_ID": _CURRENT}}},
        ]
    }


def _alias(version: str = "8") -> dict[str, object]:
    return {"FunctionVersion": version, "RevisionId": "alias-revision"}


def _stacks(release: str = _CURRENT) -> dict[str, object]:
    return {
        "Stacks": [
            {
                "StackName": "football-scheduler-production",
                "StackStatus": "UPDATE_COMPLETE",
                "Parameters": [{"ParameterKey": "ReleaseId", "ParameterValue": release}],
                "Outputs": [
                    {
                        "OutputKey": "SolverFunctionName",
                        "OutputValue": "football-scheduler-production-solver",
                    }
                ],
            }
        ]
    }


def _build(**overrides: object) -> dict[str, str]:
    values: dict[str, object] = {
        "project": _project(),
        "deployments": _deployments(),
        "versions": _versions(),
        "alias": _alias(),
        "stacks": _stacks(),
        "public_headers": f"HTTP/2 200\r\nX-Release-Id: {_CURRENT}\r\n",
        "direction": "rollback",
        "expected_current_release": _CURRENT,
        "target_release": _TARGET,
        "stack_name": "football-scheduler-production",
        "region": "us-east-1",
        "project_name": "football-scheduler-jp",
        "public_url": "https://football-scheduler-jp.pages.dev",
    }
    values.update(overrides)
    return build_switch_plan(**values)  # type: ignore[arg-type]


def test_builds_deterministic_rollback_plan() -> None:
    first = _build()
    second = _build()

    assert first == second
    assert first["current_pages_id"] == "current-pages"
    assert first["target_pages_id"] == "target-pages"
    assert first["current_solver_version"] == "8"
    assert first["target_solver_version"] == "7"
    assert len(first["plan_id"]) == 64


def test_builds_restore_plan_against_managed_stack_release() -> None:
    plan = _build(
        direction="restore",
        expected_current_release=_TARGET,
        target_release=_CURRENT,
        alias=_alias("7"),
        project=_project(_TARGET, "target-pages"),
        public_headers=f"x-release-id: {_TARGET}\n",
        stacks=_stacks(_CURRENT),
    )

    assert plan["current_pages_id"] == "target-pages"
    assert plan["target_pages_id"] == "current-pages"
    assert plan["target_solver_version"] == "8"


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"public_headers": f"x-release-id: {'b' * 40}\n"}, "公開URL"),
        ({"alias": _alias("7")}, "live alias"),
        ({"stacks": _stacks(_TARGET)}, "stack ReleaseId"),
        ({"project": _project(_TARGET)}, "Pages deployment"),
        ({"target_release": _CURRENT}, "同じ"),
    ],
)
def test_rejects_changed_or_inconsistent_state(overrides: dict[str, object], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        _build(**overrides)


def test_rejects_failed_target_deployment() -> None:
    deployments = copy.deepcopy(_deployments())
    deployments["result"] = [
        item
        for item in deployments["result"]  # type: ignore[union-attr]
        if item.get("id") != "target-pages"  # type: ignore[union-attr]
    ]

    with pytest.raises(ValueError, match="成功済みproduction deployment"):
        _build(deployments=deployments)


def test_rejects_failed_current_pages_deployment() -> None:
    project = _project()
    project["result"]["canonical_deployment"]["latest_stage"]["status"] = "failure"  # type: ignore[index]

    with pytest.raises(ValueError, match="成功状態"):
        _build(project=project)


def test_rejects_missing_target_lambda_version() -> None:
    with pytest.raises(ValueError, match="solver Lambda version"):
        _build(versions={"Versions": _versions()["Versions"][-1:]})  # type: ignore[index]


def test_summary_excludes_unrelated_and_secret_values() -> None:
    plan = _build()
    summary = render_summary(plan)

    assert plan["plan_id"] in summary
    assert "current-pages" in summary
    assert "target-pages" in summary
    assert "do-not-log-this" not in summary
    assert "Environment" not in summary


def test_validates_cloudflare_rollback_response() -> None:
    validate_cloudflare_rollback_response(
        {"success": True, "result": {"id": "target-pages"}}, "target-pages"
    )


@pytest.mark.parametrize(
    "document",
    [
        {"success": False, "result": {"id": "target-pages"}},
        {"success": True, "result": {"id": "other-pages"}},
    ],
)
def test_rejects_failed_or_wrong_cloudflare_rollback_response(
    document: dict[str, object],
) -> None:
    with pytest.raises(ValueError, match="Cloudflare Pages"):
        validate_cloudflare_rollback_response(document, "target-pages")


def test_workflow_separates_plan_and_apply_and_requires_plan_id() -> None:
    root = Path(__file__).resolve().parents[1]
    workflow = (root / ".github/workflows/production-release-switch.yml").read_text(
        encoding="utf-8"
    )

    assert "- plan" in workflow
    assert "- apply" in workflow
    assert "- rollback" in workflow
    assert "- restore" in workflow
    assert '"refs/heads/main"' in workflow
    assert "environment: production" in workflow
    assert "64文字のPlan ID" in workflow
    assert '/deployments?env=production"' in workflow
    assert "per_page=100" not in workflow
    inspect_position = workflow.index("- name: Inspect current and target releases")
    apply_check = workflow.index('"$plan_id" != "$REQUESTED_PLAN_ID"')
    alias_update = workflow.index("aws lambda update-alias")
    pages_rollback = workflow.index('/rollback"')
    assert inspect_position < apply_check < alias_update < pages_rollback


def test_workflow_blocks_incompatible_release_pairs_and_compensates_failure() -> None:
    root = Path(__file__).resolve().parents[1]
    workflow = (root / ".github/workflows/production-release-switch.yml").read_text(
        encoding="utf-8"
    )

    assert "infra/production/template.yaml src/football_scheduler/authorizer.py" in workflow
    assert "IaCまたは未version化authorizerに差分" in workflow
    assert "Compensate failed release switch" in workflow
    compensation = workflow.split("- name: Compensate failed release switch", maxsplit=1)[1]
    assert "current_solver_version" in compensation
    assert "current_pages_id" in compensation
    assert "detect-stack-drift" in workflow
    assert "IN_SYNC" in workflow


def test_plan_path_does_not_reach_mutating_steps() -> None:
    root = Path(__file__).resolve().parents[1]
    workflow = (root / ".github/workflows/production-release-switch.yml").read_text(
        encoding="utf-8"
    )

    for step_name in (
        "Smoke-test target solver version before switching",
        "Switch solver live alias",
        "Switch Cloudflare Pages deployment",
        "Verify switched public and solver releases",
    ):
        step = workflow.split(f"- name: {step_name}", maxsplit=1)[1].split("\n      - name:", 1)[0]
        assert "if: ${{ inputs.operation == 'apply' }}" in step
