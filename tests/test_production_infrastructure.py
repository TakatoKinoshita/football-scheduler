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


def test_production_roles_have_names_within_execution_role_scope() -> None:
    template = (_ROOT / "infra/production/template.yaml").read_text(encoding="utf-8")
    workflow = (_ROOT / ".github/workflows/production.yml").read_text(encoding="utf-8")

    assert 'RoleName: !Sub "${AWS::StackName}-authorizer-role"' in template
    assert 'RoleName: !Sub "${AWS::StackName}-solver-role"' in template
    assert 'RoleName: !Sub "${AWS::StackName}-apigateway-cloudwatch-role"' in template
    assert "Role: !GetAtt ApiAuthorizerFunctionRole.Arn" in template
    assert "Role: !GetAtt SolverFunctionRole.Arn" in template
    assert "--capabilities CAPABILITY_NAMED_IAM" in workflow
    assert "--capabilities CAPABILITY_IAM" not in workflow


def test_budget_notification_email_is_masked_by_cloudformation() -> None:
    template = (_ROOT / "infra/production/template.yaml").read_text(encoding="utf-8")

    parameter = template.split("  BudgetNotificationEmail:\n", maxsplit=1)[1].split(
        "  MonthlyBudgetUsd:\n", maxsplit=1
    )[0]
    assert "    NoEcho: true\n" in parameter


def test_bootstrap_uses_immutable_github_oidc_subject() -> None:
    template = (_ROOT / "infra/production/bootstrap.yaml").read_text(encoding="utf-8")

    assert "GitHubOwnerId:" in template
    assert "GitHubRepositoryId:" in template
    assert (
        "repo:${GitHubOwner}@${GitHubOwnerId}/"
        "${GitHubRepository}@${GitHubRepositoryId}:environment:production"
    ) in template
    assert "repo:${GitHubOwner}/${GitHubRepository}:environment:production" not in template


def test_bootstrap_service_role_can_expand_sam_and_manage_alarms() -> None:
    template = (_ROOT / "infra/production/bootstrap.yaml").read_text(encoding="utf-8")

    assert "- cloudwatch:*" in template
    assert "Sid: ExpandServerlessTransform" in template
    assert "Action: cloudformation:CreateChangeSet" in template
    assert (
        "arn:${AWS::Partition}:cloudformation:us-east-1:aws:transform/Serverless-2016-10-31"
    ) in template


def test_bootstrap_scopes_apigateway_service_linked_role_creation() -> None:
    template = (_ROOT / "infra/production/bootstrap.yaml").read_text(encoding="utf-8")
    statement = template.split(
        "              - Sid: CreateApiGatewayServiceLinkedRole\n", maxsplit=1
    )[1].split("\n\n  GitHubDeployRole:", maxsplit=1)[0]

    assert "Action: iam:CreateServiceLinkedRole" in statement
    assert (
        "arn:${AWS::Partition}:iam::${AWS::AccountId}:role/aws-service-role/"
        "ops.apigateway.amazonaws.com/AWSServiceRoleForAPIGateway"
    ) in statement
    assert "iam:AWSServiceName: ops.apigateway.amazonaws.com" in statement
    assert "role/aws-service-role/*" not in statement


def test_bootstrap_allows_production_lambda_to_retrieve_solver_image() -> None:
    template = (_ROOT / "infra/production/bootstrap.yaml").read_text(encoding="utf-8")
    repository_policy = template.split("      RepositoryPolicyText:\n", maxsplit=1)[1].split(
        "      Tags:\n", maxsplit=1
    )[0]

    assert "Sid: LambdaECRImageRetrievalPolicy" in repository_policy
    assert "Service: lambda.amazonaws.com" in repository_policy
    assert "- ecr:BatchGetImage" in repository_policy
    assert "- ecr:GetDownloadUrlForLayer" in repository_policy
    assert "aws:SourceArn: !Sub" in repository_policy
    assert (
        "arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:"
        "function:${ProductionStackName}-*"
    ) in repository_policy
    assert "Sid: DenyNonTLS" in repository_policy


def test_bootstrap_allows_controlled_release_switch_checks() -> None:
    template = (_ROOT / "infra/production/bootstrap.yaml").read_text(encoding="utf-8")
    deploy_policy = template.split("        - PolicyName: DeployFootballScheduler\n", maxsplit=1)[
        1
    ].split("\n\nOutputs:", maxsplit=1)[0]

    deployment_statement = deploy_policy.split(
        "              - Sid: CloudFormationDeployment\n", maxsplit=1
    )[1].split("              - Sid: ReadProductionStackDriftStatus\n", maxsplit=1)[0]
    drift_status_statement = deploy_policy.split(
        "              - Sid: ReadProductionStackDriftStatus\n", maxsplit=1
    )[1].split("              - Sid: PassExecutionRole\n", maxsplit=1)[0]
    lambda_statement = deploy_policy.split(
        "              - Sid: LambdaReleaseChecksAndRollback\n", maxsplit=1
    )[1].split("              - Sid: ReadProductionAlarms\n", maxsplit=1)[0]
    alarm_statement = deploy_policy.split(
        "              - Sid: ReadProductionAlarms\n", maxsplit=1
    )[1].split("              - Sid: AccountPrerequisiteChecks\n", maxsplit=1)[0]

    assert "- cloudformation:DetectStackDrift" in deployment_statement
    assert "stack/${ProductionStackName}/*" in deployment_statement
    assert "Action: cloudformation:DescribeStackDriftDetectionStatus" in drift_status_statement
    assert 'Resource: "*"' in drift_status_statement
    assert "- lambda:ListVersionsByFunction" in lambda_statement
    assert "Action: cloudwatch:DescribeAlarms" in alarm_statement
    assert 'Resource: "*"' in alarm_statement


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


def test_public_pages_smoke_test_has_bounded_propagation_retry() -> None:
    workflow = (_ROOT / ".github/workflows/production.yml").read_text(encoding="utf-8")
    smoke_step = workflow.split("      - name: Smoke-test public application shell\n", maxsplit=1)[
        1
    ].split("\n      - name: Roll back Cloudflare Pages after failure", maxsplit=1)[0]

    assert "for attempt in {1..6}; do" in smoke_step
    assert 'if [[ "$attempt" -lt 6 ]]; then' in smoke_step
    assert "sleep 10" in smoke_step
    assert smoke_step.count("--max-time 20") == 2
    assert "while" not in smoke_step
    assert 'grep --ignore-case "x-release-id: $RELEASE_ID"' in smoke_step
    assert '"<title>地域サッカー大会スケジューラー</title>"' in smoke_step
    assert 'grep "大会日程スケジューラー"' not in smoke_step


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


def test_apply_chooses_waiter_from_stable_stack_state() -> None:
    workflow = (_ROOT / ".github/workflows/production.yml").read_text(encoding="utf-8")

    assert "--query ChangeSetType" not in workflow
    assert 'stack_status="$(aws cloudformation describe-stacks' in workflow
    assert "REVIEW_IN_PROGRESS)" in workflow
    assert 'change_set_type="CREATE"' in workflow
    assert "CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE)" in workflow
    assert 'change_set_type="UPDATE"' in workflow
    assert "本番stackがchange setを実行できる安定状態ではありません" in workflow


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
    assert "BUDGET_NOTIFICATION_EMAIL: ${{ secrets.BUDGET_NOTIFICATION_EMAIL }}" in workflow
    assert "${{ vars.BUDGET_NOTIFICATION_EMAIL }}" not in workflow
    assert workflow.count('BudgetNotificationEmail="$BUDGET_NOTIFICATION_EMAIL"') == 2
    assert 'echo "TURNSTILE_EXPECTED_HOSTNAME=$public_application_hostname"' in workflow
    assert workflow.count('TurnstileExpectedHostname="$TURNSTILE_EXPECTED_HOSTNAME"') == 2


def test_sam_deploy_uses_bootstrap_ecr_repository() -> None:
    workflow = (_ROOT / ".github/workflows/production.yml").read_text(encoding="utf-8")

    assert '--image-repository "$ECR_REPOSITORY_URI"' in workflow


def test_production_authorizer_receives_expected_frontend_hostname() -> None:
    template = (_ROOT / "infra/production/template.yaml").read_text(encoding="utf-8")

    assert "TurnstileExpectedHostname:" in template
    assert "TURNSTILE_EXPECTED_HOSTNAME: !Ref TurnstileExpectedHostname" in template
