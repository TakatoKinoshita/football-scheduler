from pathlib import Path

import pytest

from scripts.find_cloudflare_production_deployment import find_deployment_id
from scripts.write_cloudflare_release_headers import write_release_id


def test_write_release_id_replaces_exact_placeholder(tmp_path: Path) -> None:
    headers = tmp_path / "_headers"
    headers.write_text("/*\n  X-Release-Id: __RELEASE_ID__\n", encoding="utf-8")

    write_release_id(headers, "release-123")

    assert headers.read_text(encoding="utf-8").endswith("X-Release-Id: release-123\n")


def test_write_release_id_rejects_missing_placeholder(tmp_path: Path) -> None:
    headers = tmp_path / "_headers"
    headers.write_text("/*\n", encoding="utf-8")

    with pytest.raises(ValueError, match="置換位置"):
        write_release_id(headers, "release-123")


def test_find_latest_successful_production_deployment() -> None:
    document = {
        "result": [
            {"id": "preview", "environment": "preview", "latest_stage": {"status": "success"}},
            {"id": "failed", "environment": "production", "latest_stage": {"status": "failure"}},
            {
                "id": "previous",
                "environment": "production",
                "created_on": "2026-08-04T10:00:00Z",
                "latest_stage": {"status": "success"},
            },
            {
                "id": "latest",
                "environment": "production",
                "created_on": "2026-08-05T10:00:00Z",
                "latest_stage": {"status": "success"},
            },
        ]
    }

    assert find_deployment_id(document) == "latest"
