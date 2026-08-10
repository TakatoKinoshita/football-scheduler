#!/usr/bin/env python3
"""順位決定トーナメント用テンプレートのcurrent/legacy baselineを生成・比較する。"""

from __future__ import annotations

import argparse
import platform
import sys
from importlib.metadata import version
from pathlib import Path

from football_scheduler.placement_template_ab import (
    BASELINE_RANDOM_SEED,
    LARGE_TARGET_TOPOLOGIES,
    LEGACY_SOLVER_COMMIT,
    BaselineSource,
    PlacementABError,
    PlacementBaselineEnvironment,
    PlacementBaselineFixture,
    current_baseline_record,
    merge_baseline_fixtures,
    read_deterministic_gzip,
    render_comparison_markdown,
    run_legacy_records,
    with_fixture_digest,
    write_deterministic_gzip,
)
from football_scheduler.placement_template_contract import SUPPORTED_PLACEMENT_TOPOLOGIES
from football_scheduler.placement_template_generator import load_shard, shard_file

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CATALOG_DIRECTORY = PROJECT_ROOT / "src" / "football_scheduler" / "placement_templates"
TOPOLOGY_NAMES = {
    f"{pool_count}x{pool_size}": (pool_count, pool_size)
    for pool_count, pool_size in SUPPORTED_PLACEMENT_TOPOLOGIES
}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("current", "legacy"):
        child = subparsers.add_parser(command)
        child.add_argument("--output", type=Path, required=True)
        child.add_argument("--catalog", type=Path, default=CATALOG_DIRECTORY)
        child.add_argument(
            "--topology", action="append", choices=tuple(TOPOLOGY_NAMES), required=True
        )
        if command == "legacy":
            child.add_argument("--legacy-root", type=Path, required=True)
            child.add_argument("--checkpoint-directory", type=Path, required=True)
            child.add_argument("--workers", type=int, default=1)
            child.add_argument("--max-seconds", type=float, default=30)
            child.add_argument("--resume", action="store_true")
            child.add_argument("--python", default=sys.executable)

    report = subparsers.add_parser("report")
    report.add_argument("--baseline", type=Path, required=True)
    report.add_argument("--candidate", type=Path, required=True)
    report.add_argument("--output", type=Path, required=True)
    merge = subparsers.add_parser("merge")
    merge.add_argument("--partial", type=Path, action="append", required=True)
    merge.add_argument("--output", type=Path, required=True)
    merge.add_argument("--topology", action="append", choices=tuple(TOPOLOGY_NAMES))
    return parser


def _topologies(values: list[str]) -> tuple[tuple[int, int], ...]:
    requested = {TOPOLOGY_NAMES[value] for value in values}
    return tuple(item for item in SUPPORTED_PLACEMENT_TOPOLOGIES if item in requested)


def _entries(catalog: Path, topologies: tuple[tuple[int, int], ...]) -> tuple[object, ...]:
    return tuple(
        entry
        for topology in topologies
        for entry in load_shard(shard_file(catalog, topology)).entries
    )


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "report":
            baseline = read_deterministic_gzip(args.baseline)
            candidate = read_deterministic_gzip(args.candidate)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(
                render_comparison_markdown(baseline, candidate), encoding="utf-8"
            )
            print(f"A/B reportを書き出しました: {args.output}")
            return 0

        if args.command == "merge":
            expected = _topologies(args.topology) if args.topology else LARGE_TARGET_TOPOLOGIES
            fixture = merge_baseline_fixtures(
                tuple(read_deterministic_gzip(path) for path in args.partial), expected
            )
            write_deterministic_gzip(args.output, fixture)
            print(f"baselineを統合しました: {args.output}")
            print(f"Records: {len(fixture.records)}")
            print(f"SHA-256: {fixture.sha256}")
            return 0

        topologies = _topologies(args.topology)
        entries = _entries(args.catalog.resolve(), topologies)
        if args.command == "current":
            records = tuple(current_baseline_record(entry) for entry in entries)  # type: ignore[arg-type]
            fixture = PlacementBaselineFixture(
                source=BaselineSource.CURRENT,
                topologies=topologies,
                environment=PlacementBaselineEnvironment(
                    commit_sha=_git_commit(PROJECT_ROOT),
                    python_version=platform.python_version(),
                    ortools_version=version("ortools"),
                ),
                complete=True,
                records=tuple(sorted(records, key=lambda item: item.key.catalog_id)),
            )
        else:
            records, metadata = run_legacy_records(
                entries,  # type: ignore[arg-type]
                args.legacy_root,
                args.checkpoint_directory,
                max_time_seconds=args.max_seconds,
                workers=args.workers,
                resume=args.resume,
                python_executable=args.python,
            )
            fixture = PlacementBaselineFixture(
                source=BaselineSource.LEGACY,
                topologies=topologies,
                environment=PlacementBaselineEnvironment(
                    commit_sha=LEGACY_SOLVER_COMMIT,
                    python_version=metadata.python_version,
                    ortools_version=metadata.ortools_version,
                    random_seed=BASELINE_RANDOM_SEED,
                    max_time_seconds=args.max_seconds,
                ),
                complete=True,
                records=records,
            )
        checked = with_fixture_digest(fixture)
        write_deterministic_gzip(args.output, checked)
        print(f"baselineを書き出しました: {args.output}")
        print(f"SHA-256: {checked.sha256}")
        return 0
    except (OSError, ValueError, PlacementABError) as exc:
        print(f"A/B baseline処理に失敗しました: {exc}", file=sys.stderr)
        return 1


def _git_commit(root: Path) -> str:
    import subprocess

    return subprocess.run(
        ("git", "rev-parse", "HEAD"),
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


if __name__ == "__main__":
    raise SystemExit(main())
