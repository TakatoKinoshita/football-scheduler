#!/usr/bin/env python3
"""固定した旧commitの2日目solverをpersistent JSONL processとして実行する。"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import subprocess
import sys
from pathlib import Path
from time import perf_counter
from typing import Any


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--legacy-root", type=Path, required=True)
    parser.add_argument("--expected-commit", required=True)
    return parser


def _commit(root: Path) -> str:
    return subprocess.run(
        ("git", "rev-parse", "HEAD"),
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def _configure_imports(root: Path) -> None:
    source = str((root / "src").resolve())
    sys.path.insert(0, source)
    for name in tuple(sys.modules):
        if name == "football_scheduler" or name.startswith("football_scheduler."):
            del sys.modules[name]


def _request(key: dict[str, Any], horizon: int, max_seconds: float, random_seed: int) -> Any:
    from football_scheduler.day2_schedule import Day2ScheduleRequest
    from football_scheduler.league import generate_league_plan
    from football_scheduler.tournament import generate_tournament_plan

    pool_count = int(key["pool_count"])
    pool_size = int(key["pool_size"])
    court_count = int(key["court_count"])
    organizer_capacity = int(key["organizer_capacity"])
    fallback = str(key["day2_fallback"])
    team_count = pool_count * pool_size
    teams = [
        {"id": f"T{index:02d}", "name": f"チーム{index:02d}"} for index in range(1, team_count + 1)
    ]
    blocks = [
        {
            "id": f"B{block_index:02d}",
            "team_ids": [
                f"T{block_index + offset * pool_size:02d}" for offset in range(pool_count)
            ],
        }
        for block_index in range(1, pool_size + 1)
    ]
    league_plan = generate_league_plan(
        {
            "teams": teams,
            "block_count": pool_size,
            "assignment_mode": "manual",
            "manual_blocks": blocks,
            "random_seed": random_seed,
        }
    )
    tournament_plan = generate_tournament_plan(
        {
            "request_kind": "tournament_plan",
            "league_plan": league_plan.model_dump(mode="json"),
            "final_stage": {
                "format": "placement_tournament",
                "tournament_count": pool_count,
            },
            "random_seed": random_seed,
        }
    )
    return Day2ScheduleRequest.model_validate(
        {
            "request_kind": "day2_schedule",
            "teams": teams,
            "courts": [
                {"id": f"court-{index:02d}", "name": f"第{index}コート"}
                for index in range(1, court_count + 1)
            ],
            "league_plan": league_plan.model_dump(mode="json"),
            "day1_schedule": {"day": {"id": "day1"}, "slots": []},
            "tournament_plan": tournament_plan.model_dump(mode="json"),
            "day": {
                "id": "day2",
                "start_time": "00:00",
                "game_duration_minutes": 1,
                "margin_minutes": 0,
                "max_sections": horizon,
            },
            "referees": {
                "organizer_capacity": organizer_capacity,
                "day2_fallback": fallback,
            },
            "random_seed": random_seed,
            "solver": {"max_time_seconds": max_seconds},
        }
    )


def _handle(command: dict[str, Any], commit: str) -> dict[str, Any]:
    request_id = command.get("request_id")
    if command.get("command") == "hello":
        return {
            "request_id": request_id,
            "type": "hello",
            "commit_sha": commit,
            "python_version": sys.version.split()[0],
            "ortools_version": importlib.metadata.version("ortools"),
        }
    if command.get("command") != "solve":
        raise ValueError("commandはhelloまたはsolveにしてください")
    from football_scheduler.day2_schedule import generate_day2_schedule

    request = _request(
        dict(command["key"]),
        int(command["horizon"]),
        float(command["max_time_seconds"]),
        int(command["random_seed"]),
    )
    started = perf_counter()
    result = generate_day2_schedule(request)
    elapsed = perf_counter() - started
    if result.metrics.num_search_workers != 1:
        raise RuntimeError("legacy solver num_search_workers must be 1")
    return {
        "request_id": request_id,
        "type": "result",
        "solver_status": result.status.value,
        "wall_time_seconds": elapsed,
        "diagnostics": [item.model_dump(mode="json") for item in result.diagnostics],
        "schedule": result.model_dump(mode="json"),
    }


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    root = args.legacy_root.resolve()
    commit = _commit(root)
    if commit != args.expected_commit:
        print("legacy checkout commit mismatch", file=sys.stderr)
        return 2
    _configure_imports(root)
    for line in sys.stdin:
        command: object = None
        try:
            command = json.loads(line)
            if not isinstance(command, dict):
                raise ValueError("JSONL commandはobjectにしてください")
            response = _handle(command, commit)
        except Exception as exc:
            request_id = command.get("request_id") if isinstance(command, dict) else None
            response = {
                "request_id": request_id,
                "type": "error",
                "error": f"{type(exc).__name__}: {exc}"[:500],
            }
        print(json.dumps(response, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
