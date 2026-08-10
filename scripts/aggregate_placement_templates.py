#!/usr/bin/env python3
"""placement template最適化campaignを最終catalogと品質レポートへ集約する。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from football_scheduler.placement_template_ab import PlacementABError, read_deterministic_gzip
from football_scheduler.placement_template_aggregator import (
    PlacementTemplateAggregationError,
    aggregate_catalog,
    aggregate_issue73_catalog,
    build_issue73_target_manifest,
    load_issue73_optimizer_entries,
    load_optimizer_checkpoints,
    write_text_atomic,
)
from football_scheduler.placement_template_contract import (
    PlacementOptimizationStageCheckpoint,
    PlacementOptimizationTargetManifest,
)
from football_scheduler.placement_template_generator import (
    PlacementTemplateGenerationError,
    write_json_atomic,
)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CATALOG_DIRECTORY = PROJECT_ROOT / "src" / "football_scheduler" / "placement_templates"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--campaign", choices=("issue71", "issue73"), default="issue71")
    parser.add_argument("--current-baseline", type=Path, required=True)
    parser.add_argument("--legacy-baseline", type=Path, required=True)
    parser.add_argument(
        "--optimizer-directory",
        type=Path,
        help="optimizer candidateとcheckpointを持つcampaign directory",
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
    parser.add_argument("--report", type=Path, help="集約後の品質レポート出力先")
    parser.add_argument(
        "--target-manifest",
        type=Path,
        help="Issue #73の疎なtarget manifest。--prepare-targetsでは出力先",
    )
    parser.add_argument(
        "--prepare-targets",
        action="store_true",
        help="current/legacyからIssue #73 target manifestを生成して終了する",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        current = read_deterministic_gzip(args.current_baseline.resolve())
        legacy = read_deterministic_gzip(args.legacy_baseline.resolve())
        if args.campaign == "issue73":
            if args.target_manifest is None:
                raise PlacementTemplateAggregationError("Issue #73には--target-manifestが必要です")
            if args.prepare_targets:
                target_manifest = build_issue73_target_manifest(current, legacy)
                write_json_atomic(
                    args.target_manifest.resolve(), target_manifest.model_dump(mode="json")
                )
                print(f"Issue #73 target manifestを生成しました: {args.target_manifest.resolve()}")
                print(f"targets: {len(target_manifest.targets)}")
                return 0
            target_manifest = PlacementOptimizationTargetManifest.model_validate_json(
                args.target_manifest.read_text(encoding="utf-8")
            )
            optimizer_entries = None
            checkpoints: tuple[PlacementOptimizationStageCheckpoint, ...] = ()
            if args.optimizer_directory is not None:
                optimizer_directory = args.optimizer_directory.resolve()
                optimizer_entries = load_issue73_optimizer_entries(
                    optimizer_directory, target_manifest
                )
                checkpoint_directory = (
                    args.optimizer_checkpoints.resolve()
                    if args.optimizer_checkpoints is not None
                    else optimizer_directory
                    / ".optimization-checkpoints"
                    / "placement-lower-objective-optimizer-v2"
                )
                checkpoints = load_optimizer_checkpoints(checkpoint_directory)
            result = aggregate_issue73_catalog(
                current_fixture=current,
                legacy_fixture=legacy,
                target_manifest=target_manifest,
                catalog_directory=args.catalog_directory.resolve(),
                optimizer_entries=optimizer_entries,
                optimizer_checkpoints=checkpoints,
            )
        else:
            if args.prepare_targets or args.target_manifest is not None:
                raise PlacementTemplateAggregationError(
                    "--prepare-targets/--target-manifestはIssue #73専用です"
                )
            if args.optimizer_directory is None:
                raise PlacementTemplateAggregationError(
                    "Issue #71には--optimizer-directoryが必要です"
                )
            optimizer_directory = args.optimizer_directory.resolve()
            checkpoint_directory = (
                args.optimizer_checkpoints.resolve()
                if args.optimizer_checkpoints is not None
                else optimizer_directory
                / ".optimization-checkpoints"
                / "placement-lower-objective-optimizer-v1"
            )
            checkpoints = load_optimizer_checkpoints(checkpoint_directory)
            result = aggregate_catalog(
                current_fixture=current,
                legacy_fixture=legacy,
                optimizer_directory=optimizer_directory,
                catalog_directory=args.catalog_directory.resolve(),
                optimizer_checkpoints=checkpoints,
            )
        if args.report is None:
            raise PlacementTemplateAggregationError("集約時は--reportが必要です")
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
    print(f"{len(result.entries)} entriesを集約しました: {result.manifest.catalog_sha256}")
    assert args.report is not None
    print(f"品質レポートを生成しました: {args.report.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
