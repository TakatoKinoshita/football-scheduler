"""Python生成器とWeb取込検証の層間契約fixtureを書き出す。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from football_scheduler.application import handle_request

PROJECT_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_PATH = PROJECT_ROOT / "web" / "src" / "fixtures" / "python-same-rank-document.json"


def _request() -> dict[str, Any]:
    return {
        "schema_version": "0.2.0",
        "request_kind": "schedule_creation",
        "generation_scope": "all",
        "teams": [{"id": f"team-{index}", "name": f"チーム{index}"} for index in range(1, 5)],
        "courts": [
            {"id": "court-a", "name": "Aコート"},
            {"id": "court-b", "name": "Bコート"},
        ],
        "league": {"block_count": 2, "assignment_mode": "seeded_snake"},
        "final_stage": {
            "format": "same_rank_league",
            "uneven_policy": "strict_same_rank",
        },
        "day": {
            "id": "day1",
            "start_time": "09:30",
            "game_duration_minutes": 35,
            "margin_minutes": 5,
            "max_sections": 2,
        },
        "day2": {
            "id": "day2",
            "start_time": "09:30",
            "game_duration_minutes": 35,
            "margin_minutes": 10,
            "max_sections": 2,
        },
        "referees": {
            "organizer_capacity": 2,
            "team_referees_required_after_first": True,
            "day2_fallback": "organizer",
        },
        "random_seed": 20260803,
        "solver": {"max_time_seconds": 5},
    }


def _without_runtime_measurements(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: 0 if key == "wall_time_seconds" else _without_runtime_measurements(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_without_runtime_measurements(item) for item in value]
    return value


def fixture() -> dict[str, Any]:
    request = _request()
    response = handle_request(request)
    if response.get("status") not in {"OPTIMAL", "FEASIBLE"}:
        raise RuntimeError(f"同順位リーグfixtureを生成できませんでした: {response}")
    result = response.get("tournament_result")
    if not isinstance(result, dict):
        raise RuntimeError("同順位リーグfixtureの大会結果を取得できませんでした。")

    document_input = dict(request)
    document_input["request_kind"] = "day1_league"
    document_input.pop("generation_scope")
    normalized = _without_runtime_measurements(
        {
            "documentType": "football-scheduler-tournament",
            "schemaVersion": "0.2.0",
            "updatedAt": "2026-08-14T00:00:00.000Z",
            "tournament": {
                "name": "Python生成同順位リーグ契約fixture",
                "input": document_input,
                "result": result,
            },
        }
    )
    if not isinstance(normalized, dict):  # pragma: no cover - 固定documentへの防御的検査
        raise RuntimeError("同順位リーグfixtureをJSON objectへ正規化できませんでした。")
    return normalized


def serialized_fixture() -> str:
    return json.dumps(fixture(), ensure_ascii=False, indent=2) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="fixtureを書き換えず、Python生成結果と一致するか確認する",
    )
    args = parser.parse_args()
    content = serialized_fixture()
    if args.check:
        if not OUTPUT_PATH.exists() or OUTPUT_PATH.read_text(encoding="utf-8") != content:
            print(f"fixtureが最新ではありません: {OUTPUT_PATH.relative_to(PROJECT_ROOT)}")
            return 1
        return 0
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(content, encoding="utf-8")
    print(OUTPUT_PATH.relative_to(PROJECT_ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
