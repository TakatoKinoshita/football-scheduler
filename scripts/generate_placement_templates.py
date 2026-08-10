#!/usr/bin/env python3
"""順位決定トーナメントの日程テンプレートcatalogを生成・検証する。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from football_scheduler.placement_template_ab import PlacementABError, read_deterministic_gzip
from football_scheduler.placement_template_contract import (
    SUPPORTED_PLACEMENT_TOPOLOGIES,
    PlacementOptimizationTargetManifest,
)
from football_scheduler.placement_template_generator import (
    DEFAULT_MAX_TIME_SECONDS,
    MANIFEST_FILE,
    PlacementTemplateGenerationError,
    check_catalog,
    generate_topology_shard,
    load_manifest,
    merge_shards,
    optimize_issue73_targets,
    optimize_topology_lower_objectives,
    validate_catalog_hydration,
)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIRECTORY = PROJECT_ROOT / "src" / "football_scheduler" / "placement_templates"
TOPOLOGY_NAMES = {
    f"{pool_count}x{pool_size}": (pool_count, pool_size)
    for pool_count, pool_size in SUPPORTED_PLACEMENT_TOPOLOGIES
}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--topology",
        action="append",
        choices=(*TOPOLOGY_NAMES, "all"),
        help="生成または検証するpool数xpool人数。複数指定可",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT_DIRECTORY,
        help="checkpoint、shard、manifestの出力directory",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="digest検証済みのkey checkpointを再利用する",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=1,
        help="同時に生成するkey数。各CP-SATは常にnum_search_workers=1",
    )
    parser.add_argument(
        "--max-seconds",
        type=float,
        default=DEFAULT_MAX_TIME_SECONDS,
        help="1 key・1 horizonあたりの探索上限秒数",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--merge",
        action="store_true",
        help="既存の全5 shardを単一プロセスでmanifestへ集約する",
    )
    mode.add_argument(
        "--check",
        action="store_true",
        help="既存JSONとcanonical parsed-JSON digestを検証する",
    )
    mode.add_argument(
        "--optimize-lower-objectives",
        action="store_true",
        help="2x4/2x8の証明済み最小horizonを固定して下位目的を再最適化する",
    )
    mode.add_argument(
        "--optimize-large-lower-objectives",
        action="store_true",
        help="Issue #73 target manifestの24/32-team entryだけをoptimizer-v2で処理する",
    )
    parser.add_argument("--target-manifest", type=Path)
    parser.add_argument("--current-baseline", type=Path)
    parser.add_argument("--legacy-baseline", type=Path)
    return parser


def _selected_topologies(values: list[str] | None) -> tuple[tuple[int, int], ...]:
    if not values or "all" in values:
        return SUPPORTED_PLACEMENT_TOPOLOGIES
    requested = {TOPOLOGY_NAMES[value] for value in values}
    return tuple(item for item in SUPPORTED_PLACEMENT_TOPOLOGIES if item in requested)


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    if args.workers < 1:
        parser.error("--workersは1以上にしてください")
    if not 0 < args.max_seconds <= 840:
        parser.error("--max-secondsは0より大きく840以下にしてください")
    if args.merge and args.topology:
        parser.error("--mergeは全5 shardを対象とするため--topologyを併用できません")
    if args.optimize_lower_objectives and not args.topology:
        parser.error("--optimize-lower-objectivesには--topology 2x4/2x8が必要です")
    if args.optimize_large_lower_objectives and args.topology:
        parser.error("--optimize-large-lower-objectivesは--topologyを併用できません")

    output = args.output.resolve()
    try:
        if args.merge:
            manifest = merge_shards(output)
            print(f"manifestを生成しました: {output / 'manifest.json'}")
            print(f"catalog SHA-256: {manifest.catalog_sha256}")
            return 0

        topologies = _selected_topologies(args.topology)
        if args.optimize_large_lower_objectives:
            if any(
                value is None
                for value in (
                    args.target_manifest,
                    args.current_baseline,
                    args.legacy_baseline,
                )
            ):
                parser.error(
                    "optimizer-v2には--target-manifest、--current-baseline、"
                    "--legacy-baselineが必要です"
                )
            assert args.target_manifest is not None
            assert args.current_baseline is not None
            assert args.legacy_baseline is not None
            target_manifest = PlacementOptimizationTargetManifest.model_validate_json(
                args.target_manifest.read_text(encoding="utf-8")
            )
            current_fixture = read_deterministic_gzip(args.current_baseline.resolve())
            legacy_fixture = read_deterministic_gzip(args.legacy_baseline.resolve())
            current_by_id = {record.key.catalog_id: record for record in current_fixture.records}
            legacy_by_id = {record.key.catalog_id: record for record in legacy_fixture.records}
            current_entries = {}
            legacy_entries = {}
            for target in target_manifest.targets:
                catalog_id = target.key.catalog_id
                current_candidate = current_by_id[catalog_id].candidate
                legacy_candidate = legacy_by_id[catalog_id].candidate
                if current_candidate is None or legacy_candidate is None:
                    raise PlacementTemplateGenerationError(
                        f"{catalog_id}: targetのcurrent/legacy candidateがありません"
                    )
                current_entries[catalog_id] = current_candidate
                legacy_entries[catalog_id] = legacy_candidate
            results = optimize_issue73_targets(
                target_manifest,
                current_entries,
                legacy_entries,
                output,
                resume=args.resume,
                workers=args.workers,
                max_time_per_stage=args.max_seconds,
            )
            print(f"optimizer-v2で{len(results)} target entriesを処理しました")
            return 0
        if args.optimize_lower_objectives:
            unsupported = set(topologies) - {(2, 4), (2, 8)}
            if unsupported:
                parser.error("下位目的の再最適化対象は--topology 2x4/2x8だけです")
            for topology in topologies:
                shard = optimize_topology_lower_objectives(
                    topology,
                    output,
                    resume=args.resume,
                    workers=args.workers,
                    max_time_per_stage=args.max_seconds,
                )
                print(
                    f"下位目的を再最適化しました: {topology[0]}x{topology[1]} "
                    f"({len(shard.entries)} entries, SHA-256={shard.sha256})"
                )
            return 0
        if args.check:
            selected = topologies if args.topology and "all" not in args.topology else None
            shards = check_catalog(output, topologies=selected)
            print(f"検証に合格しました: {len(shards)} shard")
            available_count = sum(
                entry.status.value == "available" for shard in shards for entry in shard.entries
            )
            infeasible_count = sum(
                entry.status.value == "proven_infeasible"
                for shard in shards
                for entry in shard.entries
            )
            manifest_path = output / MANIFEST_FILE
            catalog_sha256 = (
                load_manifest(manifest_path).catalog_sha256
                if manifest_path.exists()
                else "manifest未生成"
            )
            print(f"catalog SHA-256: {catalog_sha256}")
            print(f"available: {available_count}")
            print(f"proven_infeasible: {infeasible_count}")
            hydrated_count = validate_catalog_hydration(shards)
            print(f"hydrated and independently validated: {hydrated_count}")
            return 0

        if not args.topology:
            parser.error("生成時は--topology (例: 2x4、またはall) を指定してください")
        for topology in topologies:
            shard = generate_topology_shard(
                topology,
                output,
                resume=args.resume,
                workers=args.workers,
                max_time_seconds=args.max_seconds,
            )
            print(
                f"shardを生成しました: {topology[0]}x{topology[1]} "
                f"({len(shard.entries)} entries, SHA-256={shard.sha256})"
            )
        return 0
    except (OSError, ValueError, PlacementABError, PlacementTemplateGenerationError) as exc:
        print(f"テンプレート処理に失敗しました: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
