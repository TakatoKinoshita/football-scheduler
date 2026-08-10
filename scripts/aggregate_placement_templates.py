#!/usr/bin/env python3
"""Issue #71のcurrent/legacy/new候補を最終catalogと品質レポートへ集約する。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from football_scheduler.placement_template_ab import PlacementABError, read_deterministic_gzip
from football_scheduler.placement_template_aggregator import (
    PlacementTemplateAggregationError,
    aggregate_catalog,
    load_optimizer_checkpoints,
    write_text_atomic,
)
from football_scheduler.placement_template_generator import PlacementTemplateGenerationError

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CATALOG_DIRECTORY = PROJECT_ROOT / "src" / "football_scheduler" / "placement_templates"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--current-baseline", type=Path, required=True)
    parser.add_argument("--legacy-baseline", type=Path, required=True)
    parser.add_argument(
        "--optimizer-directory",
        type=Path,
        required=True,
        help="再最適化済みplacement-p2-s4.jsonとplacement-p2-s8.jsonのdirectory",
    )
    parser.add_argument(
        "--optimizer-checkpoints",
        type=Path,
        help="既定値はoptimizer directory配下のversion付きcheckpoint root",
    )
    parser.add_argument(
        "--catalog-directory",
        type=Path,
        default=DEFAULT_CATALOG_DIRECTORY,
        help="対象2 shardとmanifestを更新するcatalog directory",
    )
    parser.add_argument("--report", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    optimizer_directory = args.optimizer_directory.resolve()
    checkpoint_directory = (
        args.optimizer_checkpoints.resolve()
        if args.optimizer_checkpoints is not None
        else optimizer_directory
        / ".optimization-checkpoints"
        / "placement-lower-objective-optimizer-v1"
    )
    try:
        current = read_deterministic_gzip(args.current_baseline.resolve())
        legacy = read_deterministic_gzip(args.legacy_baseline.resolve())
        checkpoints = load_optimizer_checkpoints(checkpoint_directory)
        result = aggregate_catalog(
            current_fixture=current,
            legacy_fixture=legacy,
            optimizer_directory=optimizer_directory,
            catalog_directory=args.catalog_directory.resolve(),
            optimizer_checkpoints=checkpoints,
        )
        write_text_atomic(args.report.resolve(), result.report_markdown)
    except (
        OSError,
        ValueError,
        PlacementABError,
        PlacementTemplateAggregationError,
        PlacementTemplateGenerationError,
    ) as exc:
        print(f"テンプレート集約に失敗しました: {exc}", file=sys.stderr)
        return 1
    print(f"544 entriesを集約しました: {result.manifest.catalog_sha256}")
    print(f"品質レポートを生成しました: {args.report.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
