import json
from pathlib import Path

import pytest

from football_scheduler.api_handler import lambda_handler
from football_scheduler.schedule_creation import ScheduleCreationRequest
from scripts.find_cloudflare_production_deployment import find_deployment_id
from scripts.write_cloudflare_release_headers import write_release_id
from scripts.write_lambda_smoke_event import build_maximum_day2_event, build_smoke_event


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


def test_lambda_smoke_event_includes_matching_turnstile_action() -> None:
    event = build_smoke_event()
    headers = event["headers"]

    assert isinstance(headers, dict)
    assert headers["x-turnstile-action"] == "generate_schedule"

    response = lambda_handler(event, None)
    body = json.loads(response["body"])
    assert response["statusCode"] == 200
    assert body["status"] in {"OPTIMAL", "FEASIBLE"}
    assert body["validation"]["valid"] is True


def test_maximum_day2_event_uses_exact_template_release_case() -> None:
    event = build_maximum_day2_event()
    headers = event["headers"]

    assert isinstance(headers, dict)
    assert headers["x-turnstile-action"] == "create_schedule"
    request = ScheduleCreationRequest.model_validate_json(str(event["body"]))
    assert len(request.teams) == 32
    assert len(request.courts) == 4
    assert request.league.block_count == 8
    assert request.final_stage.format.value == "placement_tournament"
    assert request.final_stage.tournament_count == 2  # type: ignore[union-attr]
    assert request.referees.organizer_capacity == 4
