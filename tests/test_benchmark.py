from __future__ import annotations

import runpy
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

_SCRIPT = Path(__file__).parents[1] / "scripts" / "run_benchmark.py"
run_benchmark = cast(
    Callable[[str, int, float | None], dict[str, Any]],
    runpy.run_path(str(_SCRIPT), run_name="benchmark_module")["run_benchmark"],
)


def test_benchmark_records_reproducibility_and_resource_metadata() -> None:
    report = run_benchmark("smoke", repeat=2, timeout=5)

    assert report["input"]["effective_input_bytes"] > report["input"]["invocation_bytes"]
    assert len(report["input"]["effective_input_sha256"]) == 64
    assert report["environment"]["ortools_version"]
    assert report["summary"]["deterministic"] is True
    assert report["summary"]["maximum_observed_rss_bytes"] > 0
    assert report["summary"]["p95_wall_time_seconds"] > 0
    assert all(run["result"]["validation"]["valid"] for run in report["runs"])
