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
