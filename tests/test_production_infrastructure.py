import json
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]


def test_production_template_contains_only_aws_api_backend() -> None:
    template = (_ROOT / "infra/production/template.yaml").read_text(encoding="utf-8")

    assert "AWS::ApiGateway::RestApi" in template
    assert template.count("ReservedConcurrentExecutions: 3") == 2
    assert "ApiBaseUrl:" in template
    assert "AWS::CloudFront" not in template
    assert "AWS::WAFv2" not in template
    assert "AWS::S3::Bucket" not in template


def test_pages_function_is_only_invoked_for_api_routes() -> None:
    routes = json.loads((_ROOT / "web/public/_routes.json").read_text(encoding="utf-8"))

    assert routes == {"version": 1, "include": ["/api/*"], "exclude": []}


def test_release_uses_pages_without_exposing_usage_key_to_vite() -> None:
    workflow = (_ROOT / ".github/workflows/production.yml").read_text(encoding="utf-8")
    browser_api = (_ROOT / "web/src/api.ts").read_text(encoding="utf-8")

    assert "wrangler pages deploy" in workflow
    assert "pricing-plan-manager" not in workflow
    assert "VITE_API_USAGE_KEY" not in workflow
    assert "VITE_API_USAGE_KEY" not in browser_api


def test_production_workflow_separates_plan_from_apply() -> None:
    workflow = (_ROOT / ".github/workflows/production.yml").read_text(encoding="utf-8")

    assert "operation:" in workflow
    assert "- plan" in workflow
    assert "- apply" in workflow
    assert "if: ${{ inputs.operation == 'plan' }}" in workflow
    execute_step = workflow.index("- name: Execute approved infrastructure change")
    execute_command = workflow.index("aws cloudformation execute-change-set")
    assert "if: ${{ inputs.operation == 'apply' }}" in workflow[execute_step:execute_command]
    assert workflow.index("--no-execute-changeset") < execute_step


def test_apply_requires_main_release_sha_and_validated_change_set() -> None:
    workflow = (_ROOT / ".github/workflows/production.yml").read_text(encoding="utf-8")

    assert '"refs/heads/main"' in workflow
    assert "^[0-9a-f]{40}$" in workflow
    assert "      release_id:" not in workflow
    release_expression = (
        "RELEASE_ID: ${{ inputs.operation == 'plan' && github.sha || inputs.release_sha }}"
    )
    assert release_expression in workflow
    assert 'git merge-base --is-ancestor "$RELEASE_ID" origin/main' in workflow
    assert "release_sha:" in workflow
    assert "change_set_arn:" in workflow
    assert "scripts/check_production_change_set.py" in workflow
    assert '--release-id "$RELEASE_ID"' in workflow
    assert '--stack-name "$STACK_NAME"' in workflow
    assert '--region "$AWS_REGION"' in workflow


def test_release_checks_all_required_environment_configuration() -> None:
    workflow = (_ROOT / ".github/workflows/production.yml").read_text(encoding="utf-8")

    required_names = {
        "AWS_DEPLOY_ROLE_ARN",
        "AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN",
        "BUDGET_NOTIFICATION_EMAIL",
        "CLOUDFLARE_API_TOKEN",
        "TURNSTILE_SITE_KEY",
        "TURNSTILE_SECRET_KEY",
    }
    assert all(name in workflow for name in required_names)
    assert 'echo "TURNSTILE_EXPECTED_HOSTNAME=$public_application_hostname"' in workflow
    assert workflow.count('TurnstileExpectedHostname="$TURNSTILE_EXPECTED_HOSTNAME"') == 2


def test_production_authorizer_receives_expected_frontend_hostname() -> None:
    template = (_ROOT / "infra/production/template.yaml").read_text(encoding="utf-8")

    assert "TurnstileExpectedHostname:" in template
    assert "TURNSTILE_EXPECTED_HOSTNAME: !Ref TurnstileExpectedHostname" in template
