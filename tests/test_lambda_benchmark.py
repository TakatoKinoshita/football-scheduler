from __future__ import annotations

import runpy
from collections.abc import Callable
from pathlib import Path
from typing import cast

_SCRIPT = Path(__file__).parents[1] / "scripts" / "run_lambda_benchmark.py"
parse_report_log = cast(
    Callable[[str], dict[str, int | float | str | None]],
    runpy.run_path(str(_SCRIPT), run_name="lambda_benchmark_module")["parse_report_log"],
)
determinism_hash = cast(
    Callable[[dict[str, object]], str],
    runpy.run_path(str(_SCRIPT), run_name="lambda_benchmark_hash_module")["_determinism_hash"],
)


def test_parse_report_log_includes_cold_start_metrics() -> None:
    log = (
        "INIT_REPORT Init Duration: 9999.91 ms\tPhase: init\tStatus: timeout\n"
        "REPORT RequestId: test\tDuration: 17026.72 ms\tBilled Duration: 17027 ms\t"
        "Memory Size: 2048 MB\tMax Memory Used: 321 MB\n"
    )

    assert parse_report_log(log) == {
        "duration_ms": 17026.72,
        "billed_duration_ms": 17027,
        "memory_size_mb": 2048,
        "max_memory_used_mb": 321,
        "init_duration_ms": 9999.91,
        "init_phase": "init",
        "init_status": "timeout",
    }


def test_parse_report_log_marks_warm_start() -> None:
    metrics = parse_report_log(
        "REPORT RequestId: test\tDuration: 12.34 ms\tBilled Duration: 13 ms\t"
        "Memory Size: 2048 MB\tMax Memory Used: 300 MB\n"
    )

    assert metrics["init_duration_ms"] is None
    assert metrics["init_phase"] is None
    assert metrics["init_status"] is None


def test_parse_report_log_reads_successful_init_from_report_line() -> None:
    metrics = parse_report_log(
        "REPORT RequestId: test\tDuration: 2205.22 ms\tBilled Duration: 5230 ms\t"
        "Memory Size: 2048 MB\tMax Memory Used: 189 MB\tInit Duration: 3024.12 ms\n"
    )

    assert metrics["duration_ms"] == 2205.22
    assert metrics["init_duration_ms"] == 3024.12
    assert metrics["init_status"] is None


def test_determinism_hash_ignores_measurement_times() -> None:
    first = {"status": "OPTIMAL", "metrics": {"wall_time_seconds": 1.0}}
    second = {"status": "OPTIMAL", "metrics": {"wall_time_seconds": 2.0}}

    assert determinism_hash(first) == determinism_hash(second)
