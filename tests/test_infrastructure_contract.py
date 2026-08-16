from __future__ import annotations

from pathlib import Path

_ROOT = Path(__file__).parents[1]


def test_sam_probe_has_no_public_http_entrypoint() -> None:
    template = (_ROOT / "template.yaml").read_text(encoding="utf-8")

    assert "AWS::Serverless::Function" in template
    assert "PackageType: Image" in template
    assert "AWS::Serverless::Api" not in template
    assert "FunctionUrlConfig" not in template
    assert "RetentionInDays: 1" in template
    assert "DeletionPolicy: Delete" in template
    assert "Purpose: faas-ortools-spike" in template
    assert "ReservedConcurrentExecutions" not in template


def test_lambda_image_installs_locked_dependencies_with_hashes() -> None:
    dockerfile = (_ROOT / "Dockerfile").read_text(encoding="utf-8")
    requirements = (_ROOT / "requirements-lambda.txt").read_text(encoding="utf-8")

    assert "requirements-lambda.txt" in dockerfile
    assert "--require-hashes" in dockerfile
    assert "--only-binary=:all:" in dockerfile
    assert "COPY src/football_scheduler /asset/football_scheduler" in dockerfile
    assert "load_placement_template_catalog" in dockerfile
    assert "entries_by_id) == 160" in dockerfile
    assert "chmod -R a+rX /asset" in dockerfile
    assert "pip install" in dockerfile
    assert "pip install ." not in dockerfile
    assert "ortools==9.15.6755" in requirements
    assert "pydantic==2.13.4" in requirements
    assert "--hash=sha256:" in requirements
