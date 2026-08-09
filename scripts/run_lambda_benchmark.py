"""AWS Lambdaを直接呼び出し、実サービスの計測値をJSONへ保存する。"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import statistics
import subprocess
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def parse_report_log(log: str) -> dict[str, int | float | str | None]:
    """LambdaのREPORT行から公式の実行メトリクスを抽出する。"""

    report = re.search(
        r"^REPORT RequestId:.*?Duration: ([0-9.]+) ms\s+"
        r"Billed Duration: ([0-9]+) ms\s+Memory Size: ([0-9]+) MB\s+"
        r"Max Memory Used: ([0-9]+) MB(?:\s+Init Duration: ([0-9.]+) ms)?",
        log,
        re.MULTILINE,
    )
    init_report = re.search(
        r"^INIT_REPORT Init Duration: ([0-9.]+) ms"
        r"(?:\s+Phase: ([^\s]+))?(?:\s+Status: ([^\s]+))?",
        log,
        re.MULTILINE,
    )
    if report is None:
        raise ValueError("LambdaログにREPORT行がありません。")
    return {
        "duration_ms": float(report.group(1)),
        "billed_duration_ms": int(report.group(2)),
        "memory_size_mb": int(report.group(3)),
        "max_memory_used_mb": int(report.group(4)),
        "init_duration_ms": (
            float(init_report.group(1))
            if init_report is not None
            else (None if report.group(5) is None else float(report.group(5)))
        ),
        "init_phase": None if init_report is None else init_report.group(2),
        "init_status": None if init_report is None else init_report.group(3),
    }


def _percentile_95(values: list[float]) -> float:
    if len(values) == 1:
        return values[0]
    return statistics.quantiles(values, n=100, method="inclusive")[94]


def _stable_result(value: Any) -> Any:
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


def _determinism_hash(response: dict[str, Any]) -> str:
    encoded = json.dumps(
        _stable_result(response),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def run_benchmark(
    function_name: str,
    event_path: Path,
    repeat: int,
    region: str,
) -> dict[str, Any]:
    if repeat < 1:
        raise ValueError("repeatは1以上で指定してください。")

    event_bytes = event_path.read_bytes()
    runs: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="football-scheduler-lambda-") as temp_dir:
        for run_no in range(1, repeat + 1):
            response_path = Path(temp_dir) / f"response-{run_no}.json"
            command = [
                "aws",
                "lambda",
                "invoke",
                "--function-name",
                function_name,
                "--region",
                region,
                "--payload",
                f"fileb://{event_path.resolve()}",
                "--cli-binary-format",
                "raw-in-base64-out",
                "--log-type",
                "Tail",
                str(response_path),
                "--output",
                "json",
            ]
            started = time.perf_counter()
            completed = subprocess.run(command, check=True, capture_output=True, text=True)
            client_duration = time.perf_counter() - started
            metadata = json.loads(completed.stdout)
            response = json.loads(response_path.read_text(encoding="utf-8"))
            log = base64.b64decode(metadata["LogResult"]).decode("utf-8")
            runs.append(
                {
                    "run_no": run_no,
                    "measured_at": datetime.now(UTC).isoformat(),
                    "client_duration_seconds": client_duration,
                    "status_code": metadata["StatusCode"],
                    "executed_version": metadata.get("ExecutedVersion"),
                    "function_error": metadata.get("FunctionError"),
                    "report": parse_report_log(log),
                    "determinism_hash": _determinism_hash(response),
                    "log": log,
                    "response": response,
                }
            )

    durations = [float(run["report"]["duration_ms"]) for run in runs]
    billed = [int(run["report"]["billed_duration_ms"]) for run in runs]
    hashes = [str(run["determinism_hash"]) for run in runs]
    return {
        "benchmark_schema_version": "0.2.0",
        "measured_service": "AWS Lambda",
        "region": region,
        "function_name": function_name,
        "repeat": repeat,
        "input": {
            "path": str(event_path),
            "bytes": len(event_bytes),
            "sha256": hashlib.sha256(event_bytes).hexdigest(),
        },
        "summary": {
            "median_duration_ms": statistics.median(durations),
            "p95_duration_ms": _percentile_95(durations),
            "median_billed_duration_ms": statistics.median(billed),
            "maximum_memory_used_mb": max(int(run["report"]["max_memory_used_mb"]) for run in runs),
            "cold_start_count": sum(run["report"]["init_duration_ms"] is not None for run in runs),
            "determinism_hash": hashes[0],
            "deterministic": len(set(hashes)) == 1,
            "successful_count": sum(
                run["status_code"] == 200
                and run["function_error"] is None
                and run["response"].get("validation", {}).get("valid") is True
                for run in runs
            ),
        },
        "runs": runs,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AWS Lambdaの実行時間とメモリを測定します。")
    parser.add_argument("--function-name", required=True, help="計測対象のLambda関数名")
    parser.add_argument("--event", required=True, type=Path, help="呼び出しイベントJSON")
    parser.add_argument("--repeat", type=int, default=1, help="反復回数 (既定: 1)")
    parser.add_argument("--region", default="us-east-1", help="AWSリージョン")
    parser.add_argument("--json-output", required=True, type=Path, help="測定結果の保存先")
    return parser


def main() -> None:
    args = _parser().parse_args()
    report = run_benchmark(args.function_name, args.event, args.repeat, args.region)
    args.json_output.parent.mkdir(parents=True, exist_ok=True)
    args.json_output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
