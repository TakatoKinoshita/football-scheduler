"""Issue #71の最終catalog集約と決定的な品質レポート。"""

from __future__ import annotations

import os
from collections import Counter, defaultdict
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

from football_scheduler.models import Day2Fallback
from football_scheduler.placement_template_ab import (
    BaselineRecordStatus,
    BaselineSource,
    LexicographicResult,
    PlacementBaselineFixture,
    PlacementBaselineRecord,
    compare_objective_vectors,
)
from football_scheduler.placement_template_contract import (
    LOWER_OBJECTIVE_OPTIMIZER_VERSION,
    PLACEMENT_OBJECTIVES,
    PlacementOptimizationStageCheckpoint,
    PlacementTemplateEntry,
    PlacementTemplateManifest,
    PlacementTemplateObjective,
    PlacementTemplateShard,
    PlacementTemplateStatus,
    placement_entry_digest,
    placement_shard_digest,
)
from football_scheduler.placement_template_generator import (
    GENERATOR_VERSION,
    LOWER_OBJECTIVE_TARGET_TOPOLOGIES,
    PlacementTemplateIntegrityError,
    guard_untouched_shards,
    load_optimization_stage_checkpoint,
    load_shard,
    merge_shards,
    optimizer_provenance,
    reaudit_absolute_lower_bound_proofs,
    shard_file,
    topology_keys,
    write_json_atomic,
)

EntryAuditor = Callable[[PlacementTemplateEntry], PlacementTemplateEntry]


class PlacementTemplateAggregationError(RuntimeError):
    """候補、fixture、checkpointまたはcatalogを安全に集約できない。"""


@dataclass(frozen=True, slots=True)
class PlacementAggregationResult:
    entries: tuple[PlacementTemplateEntry, ...]
    manifest: PlacementTemplateManifest
    report_markdown: str


def aggregate_template_entry(
    current: PlacementBaselineRecord,
    legacy: PlacementBaselineRecord | None,
    optimizer_entry: PlacementTemplateEntry,
    *,
    auditor: EntryAuditor = reaudit_absolute_lower_bound_proofs,
) -> PlacementTemplateEntry:
    """1 keyのcurrent/legacy/newを監査して、辞書式最良の配置と証明を統合する。"""

    if (
        current.status is not BaselineRecordStatus.AVAILABLE
        or current.candidate is None
        or current.objective_values is None
    ):
        raise PlacementTemplateAggregationError("current baselineはavailableである必要があります")
    current_entry = current.candidate
    if current.input_entry_sha256 != current_entry.sha256:
        raise PlacementTemplateAggregationError(
            "current baselineの入力SHAがcandidateと一致しません"
        )
    if optimizer_entry.key != current_entry.key:
        raise PlacementTemplateAggregationError("optimizer entryのkeyがcurrentと一致しません")
    if (
        optimizer_entry.provenance.generator_version != GENERATOR_VERSION
        or optimizer_entry.provenance.optimization_version != LOWER_OBJECTIVE_OPTIMIZER_VERSION
    ):
        raise PlacementTemplateAggregationError("optimizer entryのoptimization versionが不正です")

    audited_current = _audit_entry(current_entry, auditor)
    audited_optimizer = _audit_entry(optimizer_entry, auditor)
    candidates: list[tuple[str, PlacementTemplateEntry]] = [
        (BaselineSource.CURRENT.value, audited_current),
        (BaselineSource.OPTIMIZER.value, audited_optimizer),
    ]
    if legacy is not None and legacy.status is BaselineRecordStatus.AVAILABLE:
        if legacy.candidate is None or legacy.objective_values is None:
            raise PlacementTemplateAggregationError(
                "available legacy recordにcandidateがありません"
            )
        if legacy.key != current.key or legacy.input_entry_sha256 != current_entry.sha256:
            raise PlacementTemplateAggregationError("legacy baselineのkeyまたは入力SHAが不正です")
        candidates.append((BaselineSource.LEGACY.value, _audit_entry(legacy.candidate, auditor)))

    current_vector = _entry_vector(audited_current)
    for _source, candidate in candidates[1:]:
        if candidate.objectives[0].value < current_vector[0]:
            raise PlacementTemplateAggregationError(
                f"{current.key.catalog_id}: 証明済み最小horizonより短い候補を検出しました"
            )
    best_vector = min(_entry_vector(candidate) for _source, candidate in candidates)
    tied = tuple(
        (source, candidate)
        for source, candidate in candidates
        if _entry_vector(candidate) == best_vector
    )
    by_source = {source: candidate for source, candidate in tied}
    if BaselineSource.CURRENT.value in by_source:
        selected = by_source[BaselineSource.CURRENT.value]
    elif BaselineSource.OPTIMIZER.value in by_source:
        selected = by_source[BaselineSource.OPTIMIZER.value]
    else:
        selected = by_source[BaselineSource.LEGACY.value]

    proof_prefix = True
    merged_objectives: list[PlacementTemplateObjective] = []
    for index, objective in enumerate(selected.objectives):
        proven = proof_prefix and any(
            candidate.objectives[index].optimality_proven for _source, candidate in tied
        )
        merged_objectives.append(objective.model_copy(update={"optimality_proven": proven}))
        proof_prefix = proven
    final = _with_entry_digest(
        selected.model_copy(
            update={
                "objectives": tuple(merged_objectives),
                "provenance": optimizer_provenance(),
                "sha256": "",
            }
        )
    )
    final = _audit_entry(final, auditor)
    if (
        final.provenance.generator_version != GENERATOR_VERSION
        or final.provenance.optimization_version != LOWER_OBJECTIVE_OPTIMIZER_VERSION
    ):
        raise PlacementTemplateAggregationError("最終entryのprovenanceが不正です")
    if _entry_vector(final) > current_vector:
        raise PlacementTemplateAggregationError("最終entryがcurrent baselineより悪化しました")
    if legacy is not None and legacy.status is BaselineRecordStatus.AVAILABLE:
        assert legacy.objective_values is not None
        if _entry_vector(final) > tuple(legacy.objective_values):
            raise PlacementTemplateAggregationError("最終entryがavailable legacyより悪化しました")
    return final


def aggregate_catalog(
    *,
    current_fixture: PlacementBaselineFixture,
    legacy_fixture: PlacementBaselineFixture,
    optimizer_directory: Path,
    catalog_directory: Path,
    optimizer_checkpoints: Sequence[PlacementOptimizationStageCheckpoint],
) -> PlacementAggregationResult:
    """544 entryを集約し、対象2 shardとmanifestだけを更新する。"""

    _validate_fixture_contract(current_fixture, legacy_fixture)
    guard_untouched_shards(catalog_directory)
    current_by_id = {record.key.catalog_id: record for record in current_fixture.records}
    legacy_by_id = {record.key.catalog_id: record for record in legacy_fixture.records}
    optimizer_shards = tuple(
        load_shard(shard_file(optimizer_directory, topology))
        for topology in LOWER_OBJECTIVE_TARGET_TOPOLOGIES
    )
    optimizer_by_id = {
        entry.key.catalog_id: entry for shard in optimizer_shards for entry in shard.entries
    }
    expected_ids = tuple(
        key.catalog_id
        for topology in LOWER_OBJECTIVE_TARGET_TOPOLOGIES
        for key in topology_keys(topology)
    )
    if set(optimizer_by_id) != set(expected_ids):
        raise PlacementTemplateAggregationError("optimizer shardの544 key coverageが不正です")
    _validate_checkpoint_coverage(optimizer_checkpoints, set(expected_ids))
    for catalog_id in expected_ids:
        current = current_by_id[catalog_id]
        legacy = legacy_by_id[catalog_id]
        if current.candidate is None or legacy.input_entry_sha256 != current.input_entry_sha256:
            raise PlacementTemplateAggregationError(
                f"{catalog_id}: baseline fixtureの入力entry SHAが一致しません"
            )
    for checkpoint in optimizer_checkpoints:
        catalog_id = checkpoint.key.catalog_id
        if (
            checkpoint.input_entry_sha256 != current_by_id[catalog_id].input_entry_sha256
            or checkpoint.candidate.sha256 != optimizer_by_id[catalog_id].sha256
        ):
            raise PlacementTemplateAggregationError(
                f"{catalog_id}: optimizer checkpointの入力またはcandidate SHAが一致しません"
            )

    final_entries = tuple(
        aggregate_template_entry(
            current_by_id[catalog_id],
            legacy_by_id.get(catalog_id),
            optimizer_by_id[catalog_id],
        )
        for catalog_id in expected_ids
    )
    for topology in LOWER_OBJECTIVE_TARGET_TOPOLOGIES:
        entries = tuple(
            entry
            for entry in final_entries
            if (entry.key.pool_count, entry.key.pool_size) == topology
        )
        shard = PlacementTemplateShard(
            pool_count=topology[0],
            pool_size=topology[1],
            entries=entries,
        )
        shard = shard.model_copy(update={"sha256": placement_shard_digest(shard)})
        shard = PlacementTemplateShard.model_validate(shard.model_dump(mode="json"))
        write_json_atomic(shard_file(catalog_directory, topology), shard.model_dump(mode="json"))
    manifest = merge_shards(catalog_directory)
    guard_untouched_shards(catalog_directory)
    report = render_quality_report(
        current_fixture=current_fixture,
        legacy_fixture=legacy_fixture,
        final_entries=final_entries,
        optimizer_checkpoints=optimizer_checkpoints,
    )
    return PlacementAggregationResult(
        entries=final_entries,
        manifest=manifest,
        report_markdown=report,
    )


def load_optimizer_checkpoints(
    directory: Path,
) -> tuple[PlacementOptimizationStageCheckpoint, ...]:
    """stage checkpointをkey・目的順で読み、重複を拒否する。"""

    checkpoints = tuple(
        load_optimization_stage_checkpoint(path) for path in sorted(directory.rglob("*.json"))
    )
    identities = tuple((item.key.catalog_id, item.stage_index) for item in checkpoints)
    if len(identities) != len(set(identities)):
        raise PlacementTemplateAggregationError("optimizer checkpointが重複しています")
    return tuple(sorted(checkpoints, key=lambda item: (item.key.catalog_id, item.stage_index)))


def render_quality_report(
    *,
    current_fixture: PlacementBaselineFixture,
    legacy_fixture: PlacementBaselineFixture,
    final_entries: Sequence[PlacementTemplateEntry],
    optimizer_checkpoints: Sequence[PlacementOptimizationStageCheckpoint],
) -> str:
    """証明、A/B、status、時間を固定順・固定精度のMarkdownへ集約する。"""

    current_by_id = {record.key.catalog_id: record for record in current_fixture.records}
    legacy_by_id = {record.key.catalog_id: record for record in legacy_fixture.records}
    proof_counts: Counter[tuple[str, str, str, str]] = Counter()
    comparison_counts: Counter[tuple[str, str, str, str]] = Counter()
    legacy_counts: Counter[tuple[str, str, str]] = Counter()
    legacy_wall: defaultdict[tuple[str, str, str], float] = defaultdict(float)
    checkpoint_counts: Counter[tuple[str, str, str, str, str]] = Counter()
    checkpoint_wall: defaultdict[tuple[str, str, str, str, str], float] = defaultdict(float)

    for final in sorted(final_entries, key=lambda item: item.key.catalog_id):
        topology, fallback = _group(final)
        current = current_by_id[final.key.catalog_id]
        assert current.candidate is not None and current.objective_values is not None
        for objective, before, after in zip(
            PLACEMENT_OBJECTIVES,
            current.candidate.objectives,
            final.objectives,
            strict=True,
        ):
            proof_counts[topology, fallback, objective, "before"] += int(before.optimality_proven)
            proof_counts[topology, fallback, objective, "after"] += int(after.optimality_proven)
        current_outcome = compare_objective_vectors(_entry_vector(final), current.objective_values)
        comparison_counts[topology, fallback, "current", current_outcome.value] += 1
        legacy = legacy_by_id.get(final.key.catalog_id)
        if legacy is not None:
            legacy_counts[topology, fallback, legacy.status.value] += 1
            legacy_wall[topology, fallback, legacy.status.value] += legacy.wall_time_seconds
            if legacy.objective_values is not None:
                legacy_outcome = compare_objective_vectors(
                    _entry_vector(final), legacy.objective_values
                )
                comparison_counts[topology, fallback, "legacy", legacy_outcome.value] += 1

    for checkpoint in optimizer_checkpoints:
        topology, fallback = _group(checkpoint.candidate)
        checkpoint_identity = (
            topology,
            fallback,
            checkpoint.objective,
            checkpoint.status.value,
            checkpoint.proof_method,
        )
        checkpoint_counts[checkpoint_identity] += 1
        checkpoint_wall[checkpoint_identity] += checkpoint.wall_time_seconds

    lines = [
        "# Issue #71 placement template quality report",
        "",
        f"- Final entries: {len(final_entries)}",
        f"- Current baseline SHA-256: `{current_fixture.sha256}`",
        f"- Legacy baseline SHA-256: `{legacy_fixture.sha256}`",
        "- Objective order: " + ", ".join(f"`{item}`" for item in PLACEMENT_OBJECTIVES),
        "",
        "## Proof coverage",
        "",
        "| Topology | Fallback | Objective | Before | After | Delta |",
        "| --- | --- | --- | ---: | ---: | ---: |",
    ]
    for topology, fallback in _groups():
        for objective in PLACEMENT_OBJECTIVES:
            before_count = proof_counts[topology, fallback, objective, "before"]
            after_count = proof_counts[topology, fallback, objective, "after"]
            lines.append(
                f"| {topology} | {fallback} | {objective} | {before_count} | "
                f"{after_count} | {after_count - before_count:+d} |"
            )
    lines.extend(
        (
            "",
            "## Final candidate comparison",
            "",
            "| Topology | Fallback | Baseline | Better | Equal | Worse |",
            "| --- | --- | --- | ---: | ---: | ---: |",
        )
    )
    for topology, fallback in _groups():
        for baseline in ("current", "legacy"):
            values = tuple(
                comparison_counts[topology, fallback, baseline, outcome.value]
                for outcome in LexicographicResult
            )
            row = (topology, fallback, baseline, *(str(value) for value in values))
            lines.append("| " + " | ".join(row) + " |")
    lines.extend(
        (
            "",
            "## Legacy baseline status",
            "",
            "| Topology | Fallback | Status | Count | Wall time (s) |",
            "| --- | --- | --- | ---: | ---: |",
        )
    )
    for topology, fallback in _groups():
        for status in BaselineRecordStatus:
            lines.append(
                f"| {topology} | {fallback} | {status.value} | "
                f"{legacy_counts[topology, fallback, status.value]} | "
                f"{legacy_wall[topology, fallback, status.value]:.3f} |"
            )
    lines.extend(
        (
            "",
            "## Optimizer stage checkpoints",
            "",
            "| Topology | Fallback | Objective | Status | Proof method | Count | Wall time (s) |",
            "| --- | --- | --- | --- | --- | ---: | ---: |",
        )
    )
    for report_identity in sorted(checkpoint_counts):
        lines.append(
            f"| {' | '.join(report_identity)} | {checkpoint_counts[report_identity]} | "
            f"{checkpoint_wall[report_identity]:.3f} |"
        )
    lines.append("")
    return "\n".join(lines)


def write_text_atomic(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(value, encoding="utf-8")
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _validate_fixture_contract(
    current: PlacementBaselineFixture,
    legacy: PlacementBaselineFixture,
) -> None:
    expected_topologies = LOWER_OBJECTIVE_TARGET_TOPOLOGIES
    if (
        current.source is not BaselineSource.CURRENT
        or legacy.source is not BaselineSource.LEGACY
        or current.topologies != expected_topologies
        or legacy.topologies != expected_topologies
        or not current.complete
        or not legacy.complete
    ):
        raise PlacementTemplateAggregationError(
            "current/legacy baselineは2x4・2x8の完全fixtureである必要があります"
        )
    expected_ids = {
        key.catalog_id for topology in expected_topologies for key in topology_keys(topology)
    }
    if {item.key.catalog_id for item in current.records} != expected_ids or {
        item.key.catalog_id for item in legacy.records
    } != expected_ids:
        raise PlacementTemplateAggregationError("baseline fixtureの544 key coverageが不正です")


def _validate_checkpoint_coverage(
    checkpoints: Sequence[PlacementOptimizationStageCheckpoint],
    expected_ids: set[str],
) -> None:
    identities = {(item.key.catalog_id, item.stage_index) for item in checkpoints}
    expected = {
        (catalog_id, index)
        for catalog_id in expected_ids
        for index in range(len(PLACEMENT_OBJECTIVES))
    }
    if identities != expected or len(checkpoints) != len(expected):
        raise PlacementTemplateAggregationError(
            "optimizer checkpointの全key・全目的coverageが不正です"
        )


def _audit_entry(entry: PlacementTemplateEntry, auditor: EntryAuditor) -> PlacementTemplateEntry:
    if entry.status is not PlacementTemplateStatus.AVAILABLE or not entry.sha256:
        raise PlacementTemplateAggregationError("集約候補はdigest付きavailable entryが必要です")
    try:
        audited = auditor(entry)
    except (ValueError, PlacementTemplateIntegrityError) as exc:
        raise PlacementTemplateAggregationError(
            f"{entry.key.catalog_id}: 候補のhydrateまたは独立検証に失敗しました"
        ) from exc
    if audited.key != entry.key or _entry_vector(audited) != _entry_vector(entry):
        raise PlacementTemplateAggregationError("監査処理がkeyまたは目的値を変更しました")
    return audited


def _with_entry_digest(entry: PlacementTemplateEntry) -> PlacementTemplateEntry:
    completed = entry.model_copy(update={"sha256": placement_entry_digest(entry)})
    return PlacementTemplateEntry.model_validate(completed.model_dump(mode="json"))


def _entry_vector(entry: PlacementTemplateEntry) -> tuple[int, ...]:
    return tuple(item.value for item in entry.objectives)


def _group(entry: PlacementTemplateEntry) -> tuple[str, str]:
    return (
        f"{entry.key.pool_count}x{entry.key.pool_size}",
        entry.key.day2_fallback.value,
    )


def _groups() -> tuple[tuple[str, str], ...]:
    return tuple(
        (f"{topology[0]}x{topology[1]}", fallback.value)
        for topology in LOWER_OBJECTIVE_TARGET_TOPOLOGIES
        for fallback in Day2Fallback
    )


__all__ = [
    "PlacementAggregationResult",
    "PlacementTemplateAggregationError",
    "aggregate_catalog",
    "aggregate_template_entry",
    "load_optimizer_checkpoints",
    "render_quality_report",
    "write_text_atomic",
]
