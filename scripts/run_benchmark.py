"""技術検証ワークロードを反復実行し、生の測定結果をJSONへ保存する。"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import os
import platform
import statistics
import subprocess
import sys
import time
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

from football_scheduler.application import handle_request
from football_scheduler.fixtures import make_representative_request, make_smoke_request


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="OR-Toolsスケジュール生成のローカル計測を実行します。"
    )
    parser.add_argument(
        "--fixture",
        choices=("smoke", "representative"),
        default="smoke",
        help="使用する検証用入力 (既定: smoke)",
    )
    parser.add_argument("--repeat", type=int, default=1, help="反復回数 (既定: 1)")
    parser.add_argument(
        "--timeout",
        type=float,
        default=None,
        help="各実行のソルバー時間上限 (秒)",
    )
    parser.add_argument(
        "--json-output",
        type=Path,
        default=None,
        help="生の測定結果JSONの保存先。未指定時は標準出力へ出力します。",
    )
    return parser


def _rss_bytes() -> int | None:
    try:
        psutil = importlib.import_module("psutil")
        return int(psutil.Process(os.getpid()).memory_info().rss)
    except ImportError, OSError, RuntimeError:
        pass

    # Lambdaを含むLinuxではprocfsから現在のresident set sizeを取得できる。
    try:
        resident_pages = int(Path("/proc/self/statm").read_text().split()[1])
        sysconf = os.sysconf  # type: ignore[attr-defined]
        return resident_pages * int(sysconf("SC_PAGE_SIZE"))
    except AttributeError, IndexError, OSError, ValueError:
        pass

    # 開発用Windowsでも追加依存なしで同じ指標を記録する。
    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes

            class ProcessMemoryCounters(ctypes.Structure):
                _fields_ = [
                    ("cb", wintypes.DWORD),
                    ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                ]

            counters = ProcessMemoryCounters()
            counters.cb = ctypes.sizeof(counters)
            get_current_process = ctypes.windll.kernel32.GetCurrentProcess
            get_current_process.restype = wintypes.HANDLE
            get_process_memory_info = ctypes.windll.psapi.GetProcessMemoryInfo
            get_process_memory_info.argtypes = (
                wintypes.HANDLE,
                ctypes.POINTER(ProcessMemoryCounters),
                wintypes.DWORD,
            )
            get_process_memory_info.restype = wintypes.BOOL
            success = get_process_memory_info(
                get_current_process(),
                ctypes.byref(counters),
                counters.cb,
            )
            return int(counters.WorkingSetSize) if success else None
        except AttributeError, OSError, ValueError:
            pass

    return None


def _stable_result(value: Any) -> Any:
    """計測時間などを除き、決定性を比較するための値を作る。"""

    volatile_keys = {
        "wall_time_seconds",
        "elapsed_seconds",
        "solve_time_seconds",
        "user_time_seconds",
        "system_time_seconds",
    }
    if isinstance(value, dict):
        return {
            key: _stable_result(item)
            for key, item in sorted(value.items())
            if key not in volatile_keys
        }
    if isinstance(value, list):
        return [_stable_result(item) for item in value]
    return value


def _determinism_hash(result: dict[str, Any]) -> str:
    encoded = json.dumps(
        _stable_result(result),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _encoded_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _fixture_metadata(fixture: str) -> dict[str, Any]:
    factories = {
        "smoke": make_smoke_request,
        "representative": make_representative_request,
    }
    effective_input = factories[fixture]().model_dump(mode="json")
    invocation = {"fixture": fixture}
    effective_bytes = _encoded_json(effective_input)
    invocation_bytes = _encoded_json(invocation)
    return {
        "invocation_bytes": len(invocation_bytes),
        "invocation_sha256": hashlib.sha256(invocation_bytes).hexdigest(),
        "effective_input_bytes": len(effective_bytes),
        "effective_input_sha256": hashlib.sha256(effective_bytes).hexdigest(),
        "random_seed": effective_input["random_seed"],
    }


def _git_metadata() -> dict[str, Any]:
    try:
        revision = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
        status = subprocess.run(
            ["git", "status", "--porcelain"],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except OSError, subprocess.TimeoutExpired:
        return {"commit": None, "worktree_dirty": None}
    return {
        "commit": revision.stdout.strip() if revision.returncode == 0 else None,
        "worktree_dirty": bool(status.stdout.strip()) if status.returncode == 0 else None,
    }


def _package_version(package: str) -> str | None:
    try:
        return version(package)
    except PackageNotFoundError:
        return None


def _percentile_95(values: list[float]) -> float:
    if len(values) == 1:
        return values[0]
    return statistics.quantiles(values, n=100, method="inclusive")[94]


def run_benchmark(fixture: str, repeat: int, timeout: float | None) -> dict[str, Any]:
    if repeat < 1:
        raise ValueError("repeatは1以上で指定してください。")
    if timeout is not None and timeout <= 0:
        raise ValueError("timeoutは0秒より大きくしてください。")

    request: dict[str, Any] = {"fixture": fixture}
    if timeout is not None:
        request["solver_options"] = {"max_time_seconds": timeout}

    runs: list[dict[str, Any]] = []
    for run_no in range(1, repeat + 1):
        rss_before = _rss_bytes()
        started = time.perf_counter()
        result = handle_request(request)
        wall_time = time.perf_counter() - started
        rss_after = _rss_bytes()
        encoded_result = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        runs.append(
            {
                "run_no": run_no,
                "wall_time_seconds": wall_time,
                "rss_before_bytes": rss_before,
                "rss_after_bytes": rss_after,
                "rss_delta_bytes": (
                    None if rss_before is None or rss_after is None else rss_after - rss_before
                ),
                "result_bytes": len(encoded_result),
                "determinism_hash": _determinism_hash(result),
                "result": result,
            }
        )

    durations = [run["wall_time_seconds"] for run in runs]
    solver_durations = [
        float(run["result"]["metrics"]["wall_time_seconds"])
        for run in runs
        if isinstance(run["result"].get("metrics"), dict)
    ]
    hashes = [run["determinism_hash"] for run in runs]
    result_sizes = [run["result_bytes"] for run in runs]
    rss_values = [int(run["rss_after_bytes"]) for run in runs if run["rss_after_bytes"] is not None]
    return {
        "benchmark_schema_version": "0.1.0",
        "fixture": fixture,
        "repeat": repeat,
        "requested_timeout_seconds": timeout,
        "input": _fixture_metadata(fixture),
        "source": _git_metadata(),
        "environment": {
            "python_version": platform.python_version(),
            "ortools_version": _package_version("ortools"),
            "platform": platform.platform(),
            "architecture": platform.machine(),
        },
        "summary": {
            "minimum_wall_time_seconds": min(durations),
            "median_wall_time_seconds": statistics.median(durations),
            "p95_wall_time_seconds": _percentile_95(durations),
            "maximum_wall_time_seconds": max(durations),
            "mean_wall_time_seconds": statistics.fmean(durations),
            "minimum_solver_wall_time_seconds": min(solver_durations),
            "median_solver_wall_time_seconds": statistics.median(solver_durations),
            "p95_solver_wall_time_seconds": _percentile_95(solver_durations),
            "maximum_solver_wall_time_seconds": max(solver_durations),
            "minimum_result_bytes": min(result_sizes),
            "maximum_result_bytes": max(result_sizes),
            "maximum_observed_rss_bytes": max(rss_values) if rss_values else None,
            "determinism_hash": hashes[0],
            "deterministic": len(set(hashes)) == 1,
            "rss_available": all(run["rss_after_bytes"] is not None for run in runs),
        },
        "runs": runs,
    }


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        report = run_benchmark(args.fixture, args.repeat, args.timeout)
    except ValueError as exc:
        _parser().error(str(exc))

    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.json_output is None:
        sys.stdout.write(rendered)
    else:
        args.json_output.parent.mkdir(parents=True, exist_ok=True)
        args.json_output.write_text(rendered, encoding="utf-8")
        sys.stdout.write(f"測定結果を{args.json_output}へ保存しました。\n")

    return 0 if all(run["result"].get("status") != "error" for run in report["runs"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
