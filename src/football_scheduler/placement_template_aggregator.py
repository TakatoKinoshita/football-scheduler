"""Issue #71/#73の最終catalog集約と決定的な品質レポート。"""

from __future__ import annotations

import os
from collections import Counter, defaultdict
from collections.abc import Callable, Mapping, Sequence
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
    LARGE_LOWER_OBJECTIVE_OPTIMIZER_VERSION,
    LOWER_OBJECTIVE_OPTIMIZER_VERSION,
    PLACEMENT_OBJECTIVES,
    PlacementOptimizationStageCheckpoint,
    PlacementOptimizationTarget,
    PlacementOptimizationTargetManifest,
    PlacementTemplateEntry,
    PlacementTemplateManifest,
    PlacementTemplateObjective,
    PlacementTemplateShard,
    PlacementTemplateStatus,
    placement_entry_digest,
    placement_optimization_target_manifest_digest,
    placement_shard_digest,
)
from football_scheduler.placement_template_generator import (
    GENERATOR_VERSION,
    LARGE_LOWER_OBJECTIVE_TARGET_TOPOLOGIES,
    LOWER_OBJECTIVE_TARGET_TOPOLOGIES,
    PlacementTemplateIntegrityError,
    guard_issue73_untouched_shards,
    guard_untouched_shards,
    issue73_optimizer_candidate_file,
    large_optimizer_provenance,
    load_entry,
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
    selected_sources: tuple[tuple[str, str], ...] = ()


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


def build_issue73_target_manifest(
    current_fixture: PlacementBaselineFixture,
    legacy_fixture: PlacementBaselineFixture,
    *,
    auditor: EntryAuditor = reaudit_absolute_lower_bound_proofs,
) -> PlacementOptimizationTargetManifest:
    """有効なlegacyがcurrentより良いkeyだけを決定的な疎manifestへ抽出する。"""

    _validate_issue73_fixture_contract(current_fixture, legacy_fixture)
    current_by_id = {record.key.catalog_id: record for record in current_fixture.records}
    legacy_by_id = {record.key.catalog_id: record for record in legacy_fixture.records}
    targets: list[PlacementOptimizationTarget] = []
    for catalog_id in sorted(current_by_id):
        current = current_by_id[catalog_id]
        legacy = legacy_by_id[catalog_id]
        current_entry = _available_baseline_candidate(current, source="current")
        if current.input_entry_sha256 != current_entry.sha256:
            raise PlacementTemplateAggregationError(
                f"{catalog_id}: current baselineの入力entry SHAがcandidateと一致しません"
            )
        if legacy.input_entry_sha256 != current_entry.sha256:
            raise PlacementTemplateAggregationError(
                f"{catalog_id}: legacy baselineの入力entry SHAがcurrentと一致しません"
            )
        if legacy.status is not BaselineRecordStatus.AVAILABLE:
            continue
        legacy_entry = _available_baseline_candidate(legacy, source="legacy")
        audited_current = _audit_entry(current_entry, auditor)
        audited_legacy = _audit_entry(legacy_entry, auditor)
        current_vector = _entry_vector(audited_current)
        legacy_vector = _entry_vector(audited_legacy)
        if legacy_vector >= current_vector:
            continue
        differing_index = next(
            index
            for index, (current_value, legacy_value) in enumerate(
                zip(current_vector, legacy_vector, strict=True)
            )
            if current_value != legacy_value
        )
        if audited_current.objectives[differing_index].optimality_proven:
            raise PlacementTemplateAggregationError(
                f"{catalog_id}: legacy候補がcurrentの証明済み目的prefixを破りました"
            )
        targets.append(
            PlacementOptimizationTarget(
                key=current.key,
                current_entry_sha256=current_entry.sha256,
                legacy_entry_sha256=legacy_entry.sha256,
                current_objectives=current_vector,
                legacy_objectives=legacy_vector,
                first_differing_objective=PLACEMENT_OBJECTIVES[differing_index],
            )
        )
    manifest = PlacementOptimizationTargetManifest(
        current_fixture_sha256=current_fixture.sha256,
        legacy_fixture_sha256=legacy_fixture.sha256,
        topologies=LARGE_LOWER_OBJECTIVE_TARGET_TOPOLOGIES,
        targets=tuple(targets),
    )
    completed = manifest.model_copy(
        update={"sha256": placement_optimization_target_manifest_digest(manifest)}
    )
    return PlacementOptimizationTargetManifest.model_validate(completed.model_dump(mode="json"))


def aggregate_issue73_template_entry(
    current: PlacementBaselineRecord,
    legacy: PlacementBaselineRecord,
    target: PlacementOptimizationTarget,
    optimizer_entry: PlacementTemplateEntry | None = None,
    *,
    auditor: EntryAuditor = reaudit_absolute_lower_bound_proofs,
) -> tuple[PlacementTemplateEntry, str]:
    """targetのcurrent/optimizer-v2/legacyから品質floorを満たす候補を選ぶ。"""

    current_entry = _available_baseline_candidate(current, source="current")
    legacy_entry = _available_baseline_candidate(legacy, source="legacy")
    if (
        current_entry.key != target.key
        or legacy_entry.key != target.key
        or current_entry.sha256 != target.current_entry_sha256
        or legacy_entry.sha256 != target.legacy_entry_sha256
        or legacy.input_entry_sha256 != current_entry.sha256
        or _entry_vector(current_entry) != target.current_objectives
        or _entry_vector(legacy_entry) != target.legacy_objectives
    ):
        raise PlacementTemplateAggregationError("targetとbaseline candidateが一致しません")

    candidates: list[tuple[str, PlacementTemplateEntry]] = [
        (BaselineSource.CURRENT.value, _audit_entry(current_entry, auditor)),
    ]
    if optimizer_entry is not None:
        if (
            optimizer_entry.key != target.key
            or optimizer_entry.provenance.generator_version != GENERATOR_VERSION
            or optimizer_entry.provenance.optimization_version
            != LARGE_LOWER_OBJECTIVE_OPTIMIZER_VERSION
        ):
            raise PlacementTemplateAggregationError(
                "optimizer-v2候補のkeyまたはprovenanceが不正です"
            )
        candidates.append((BaselineSource.OPTIMIZER.value, _audit_entry(optimizer_entry, auditor)))
    candidates.append((BaselineSource.LEGACY.value, _audit_entry(legacy_entry, auditor)))

    current_vector = _entry_vector(candidates[0][1])
    for _source, candidate in candidates[1:]:
        if _entry_vector(candidate)[0] < current_vector[0]:
            raise PlacementTemplateAggregationError(
                f"{target.key.catalog_id}: 証明済み最小horizonより短い候補を検出しました"
            )
    best_vector = min(_entry_vector(candidate) for _source, candidate in candidates)
    preference = {
        BaselineSource.CURRENT.value: 0,
        BaselineSource.OPTIMIZER.value: 1,
        BaselineSource.LEGACY.value: 2,
    }
    tied = tuple(
        (source, candidate)
        for source, candidate in candidates
        if _entry_vector(candidate) == best_vector
    )
    selected_source, selected = min(tied, key=lambda item: preference[item[0]])

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
                "provenance": large_optimizer_provenance(),
                "sha256": "",
            }
        )
    )
    final = _audit_entry(final, auditor)
    if _entry_vector(final) > current_vector or _entry_vector(final) > target.legacy_objectives:
        raise PlacementTemplateAggregationError("Issue #73最終候補が品質floorより悪化しました")
    return final, selected_source


def aggregate_issue73_catalog(
    *,
    current_fixture: PlacementBaselineFixture,
    legacy_fixture: PlacementBaselineFixture,
    target_manifest: PlacementOptimizationTargetManifest,
    catalog_directory: Path,
    optimizer_entries: Mapping[str, PlacementTemplateEntry] | None = None,
    optimizer_checkpoints: Sequence[PlacementOptimizationStageCheckpoint] = (),
) -> PlacementAggregationResult:
    """疎なtargetだけを置換し、24/32-teamの3 shardとmanifestを確定する。"""

    _validate_issue73_fixture_contract(current_fixture, legacy_fixture)
    _validate_issue73_target_manifest(target_manifest, current_fixture, legacy_fixture)
    guard_issue73_untouched_shards(catalog_directory)
    current_by_id = {record.key.catalog_id: record for record in current_fixture.records}
    legacy_by_id = {record.key.catalog_id: record for record in legacy_fixture.records}
    target_by_id = {target.key.catalog_id: target for target in target_manifest.targets}
    optimizer_by_id = dict(optimizer_entries or {})
    if set(optimizer_by_id) - set(target_by_id):
        raise PlacementTemplateAggregationError("非targetのoptimizer-v2候補が含まれています")
    if target_by_id and set(optimizer_by_id) != set(target_by_id):
        raise PlacementTemplateAggregationError("optimizer-v2候補の疎target coverageが不正です")
    _validate_issue73_checkpoint_coverage(
        optimizer_checkpoints,
        target_by_id=target_by_id,
        current_by_id=current_by_id,
        legacy_by_id=legacy_by_id,
        optimizer_by_id=optimizer_by_id,
        target_manifest_sha256=target_manifest.sha256,
    )

    final_entries: list[PlacementTemplateEntry] = []
    selected_sources: list[tuple[str, str]] = []
    for topology in LARGE_LOWER_OBJECTIVE_TARGET_TOPOLOGIES:
        for key in topology_keys(topology):
            catalog_id = key.catalog_id
            current_entry = _available_baseline_candidate(
                current_by_id[catalog_id], source="current"
            )
            target = target_by_id.get(catalog_id)
            if target is None:
                final = current_entry
                source = BaselineSource.CURRENT.value
                if (
                    current_by_id[catalog_id].input_entry_sha256 != current_entry.sha256
                    or final.sha256 != current_entry.sha256
                    or final.model_dump_json() != current_entry.model_dump_json()
                ):
                    raise PlacementTemplateAggregationError(
                        f"{catalog_id}: 非target entryがbyte-levelで変更されました"
                    )
            else:
                final, source = aggregate_issue73_template_entry(
                    current_by_id[catalog_id],
                    legacy_by_id[catalog_id],
                    target,
                    optimizer_by_id.get(catalog_id),
                )
            final_entries.append(final)
            selected_sources.append((catalog_id, source))

    for topology in LARGE_LOWER_OBJECTIVE_TARGET_TOPOLOGIES:
        entries = tuple(
            entry
            for entry in final_entries
            if (entry.key.pool_count, entry.key.pool_size) == topology
        )
        shard = PlacementTemplateShard(
            pool_count=topology[0], pool_size=topology[1], entries=entries
        )
        shard = shard.model_copy(update={"sha256": placement_shard_digest(shard)})
        checked = PlacementTemplateShard.model_validate(shard.model_dump(mode="json"))
        write_json_atomic(shard_file(catalog_directory, topology), checked.model_dump(mode="json"))
    manifest = merge_shards(catalog_directory)
    guard_issue73_untouched_shards(catalog_directory)
    report = render_issue73_quality_report(
        current_fixture=current_fixture,
        legacy_fixture=legacy_fixture,
        target_manifest=target_manifest,
        final_entries=tuple(final_entries),
        optimizer_checkpoints=optimizer_checkpoints,
        selected_sources=tuple(selected_sources),
        manifest=manifest,
    )
    return PlacementAggregationResult(
        entries=tuple(final_entries),
        manifest=manifest,
        report_markdown=report,
        selected_sources=tuple(selected_sources),
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


def load_issue73_optimizer_entries(
    directory: Path,
    target_manifest: PlacementOptimizationTargetManifest,
) -> dict[str, PlacementTemplateEntry]:
    """target manifestに列挙された最終候補だけを読み、余剰artifactを拒否する。"""

    expected = {target.key.catalog_id: target for target in target_manifest.targets}
    entries: dict[str, PlacementTemplateEntry] = {}
    for target in target_manifest.targets:
        path = issue73_optimizer_candidate_file(directory, target.key)
        if not path.exists():
            raise PlacementTemplateAggregationError(f"optimizer-v2候補がありません: {path}")
        entry = load_entry(path)
        entries[entry.key.catalog_id] = entry
    if set(entries) != set(expected) or len(entries) != len(expected):
        raise PlacementTemplateAggregationError("optimizer-v2候補の疎target coverageが不正です")
    candidate_root = (
        directory / ".optimization-candidates" / LARGE_LOWER_OBJECTIVE_OPTIMIZER_VERSION
    )
    files = tuple(sorted(candidate_root.rglob("*.json"))) if candidate_root.exists() else ()
    if len(files) != len(expected):
        raise PlacementTemplateAggregationError("optimizer-v2候補directoryに余剰fileがあります")
    return entries


def render_issue73_quality_report(
    *,
    current_fixture: PlacementBaselineFixture,
    legacy_fixture: PlacementBaselineFixture,
    target_manifest: PlacementOptimizationTargetManifest,
    final_entries: Sequence[PlacementTemplateEntry],
    optimizer_checkpoints: Sequence[PlacementOptimizationStageCheckpoint],
    selected_sources: Sequence[tuple[str, str]],
    manifest: PlacementTemplateManifest,
) -> str:
    """Issue #73のtarget、採用元、品質floor、証明と探索時間を動的に集計する。"""

    current_by_id = {record.key.catalog_id: record for record in current_fixture.records}
    legacy_by_id = {record.key.catalog_id: record for record in legacy_fixture.records}
    source_by_id = dict(selected_sources)
    target_by_id = {target.key.catalog_id: target for target in target_manifest.targets}
    proof_counts: Counter[tuple[str, str, str, str]] = Counter()
    comparison_counts: Counter[tuple[str, str, str, str]] = Counter()
    status_counts: Counter[tuple[str, str, str]] = Counter()
    status_wall: defaultdict[tuple[str, str, str], float] = defaultdict(float)
    legacy_reason_counts: Counter[tuple[str, str, str, str]] = Counter()
    source_counts: Counter[tuple[str, str, str]] = Counter()
    target_counts: Counter[tuple[str, str, str]] = Counter()
    checkpoint_counts: Counter[tuple[str, str, str, str, str, str]] = Counter()
    checkpoint_wall: defaultdict[tuple[str, str, str, str, str, str], float] = defaultdict(float)

    for final in sorted(final_entries, key=lambda item: item.key.catalog_id):
        topology, fallback = _group(final)
        current = current_by_id[final.key.catalog_id]
        assert current.candidate is not None and current.objective_values is not None
        for objective, before_objective, after_objective in zip(
            PLACEMENT_OBJECTIVES, current.candidate.objectives, final.objectives, strict=True
        ):
            proof_counts[topology, fallback, objective, "before"] += int(
                before_objective.optimality_proven
            )
            proof_counts[topology, fallback, objective, "after"] += int(
                after_objective.optimality_proven
            )
        current_result = compare_objective_vectors(_entry_vector(final), current.objective_values)
        comparison_counts[topology, fallback, "current", current_result.value] += 1
        legacy = legacy_by_id[final.key.catalog_id]
        status_counts[topology, fallback, legacy.status.value] += 1
        status_wall[topology, fallback, legacy.status.value] += legacy.wall_time_seconds
        reasons = legacy.diagnostics or (f"solver_status:{legacy.solver_status or 'none'}",)
        for reason in reasons:
            legacy_reason_counts[topology, fallback, legacy.status.value, reason] += 1
        if legacy.objective_values is not None:
            legacy_result = compare_objective_vectors(_entry_vector(final), legacy.objective_values)
            comparison_counts[topology, fallback, "legacy", legacy_result.value] += 1
        source_counts[topology, fallback, source_by_id[final.key.catalog_id]] += 1
        target = target_by_id.get(final.key.catalog_id)
        if target is not None:
            target_counts[topology, fallback, target.first_differing_objective] += 1

    for checkpoint in optimizer_checkpoints:
        topology, fallback = _group(checkpoint.candidate)
        checkpoint_counts[
            topology,
            fallback,
            checkpoint.objective,
            checkpoint.status.value,
            checkpoint.proof_method,
            checkpoint.termination_reason or "unspecified",
        ] += 1
        checkpoint_wall[
            topology,
            fallback,
            checkpoint.objective,
            checkpoint.status.value,
            checkpoint.proof_method,
            checkpoint.termination_reason or "unspecified",
        ] += checkpoint.wall_time_seconds

    groups = _topology_groups(LARGE_LOWER_OBJECTIVE_TARGET_TOPOLOGIES)
    current_better = sum(
        comparison_counts[topology, fallback, "current", LexicographicResult.BETTER.value]
        for topology, fallback in groups
    )
    current_equal = sum(
        comparison_counts[topology, fallback, "current", LexicographicResult.EQUAL.value]
        for topology, fallback in groups
    )
    current_worse = sum(
        comparison_counts[topology, fallback, "current", LexicographicResult.WORSE.value]
        for topology, fallback in groups
    )
    legacy_better = sum(
        comparison_counts[topology, fallback, "legacy", LexicographicResult.BETTER.value]
        for topology, fallback in groups
    )
    legacy_equal = sum(
        comparison_counts[topology, fallback, "legacy", LexicographicResult.EQUAL.value]
        for topology, fallback in groups
    )
    legacy_worse = sum(
        comparison_counts[topology, fallback, "legacy", LexicographicResult.WORSE.value]
        for topology, fallback in groups
    )
    selected_current = sum(
        source_counts[topology, fallback, BaselineSource.CURRENT.value]
        for topology, fallback in groups
    )
    selected_optimizer = sum(
        source_counts[topology, fallback, BaselineSource.OPTIMIZER.value]
        for topology, fallback in groups
    )
    selected_legacy = sum(
        source_counts[topology, fallback, BaselineSource.LEGACY.value]
        for topology, fallback in groups
    )
    legacy_available = legacy_better + legacy_equal + legacy_worse
    used_sections_proven = sum(
        proof_counts[topology, fallback, "used_sections", "after"] for topology, fallback in groups
    )
    legacy_wall_seconds = sum(status_wall.values())
    optimizer_wall_seconds = sum(checkpoint_wall.values())

    lines = [
        "# Issue #73 placement template quality report",
        "",
        f"- Final entries: {len(final_entries)}",
        f"- Optimization targets: {len(target_manifest.targets)}",
        f"- Current baseline SHA-256: `{current_fixture.sha256}`",
        f"- Legacy baseline SHA-256: `{legacy_fixture.sha256}`",
        f"- Target manifest SHA-256: `{target_manifest.sha256}`",
        f"- Catalog SHA-256: `{manifest.catalog_sha256}`",
        "- Objective order: " + ", ".join(f"`{item}`" for item in PLACEMENT_OBJECTIVES),
        "",
        "## 結果概要",
        "",
        f"- 24・32チーム用の全{len(final_entries)} entryを`available`として維持し、"
        f"使用セクション数の最小性を全{used_sections_proven}件で証明済みのまま維持した。",
        f"- current catalogとの比較は改善{current_better}件、同等{current_equal}件、"
        f"悪化{current_worse}件だった。",
        f"- legacy 30秒solverで現行規則上有効だった{legacy_available}件との比較は"
        f"改善{legacy_better}件、同等{legacy_equal}件、悪化{legacy_worse}件だった。",
        f"- 最終配置はcurrent {selected_current}件、optimizer-v2 {selected_optimizer}件、"
        f"legacy {selected_legacy}件を採用した。同値時はcurrentを優先した。",
        "- 8・16チーム用の2 shardはraw SHA-256と内部digestのguardにより変更していない。",
        "",
        "## 実行条件と所要時間",
        "",
        "- legacyはcommit `2ccf91da34717ae86a21513a43289a2e2b758617`、Python 3.14、"
        "OR-Tools 9.15.6755、`random_seed=20260803`、`PYTHONHASHSEED=0`、"
        "1 worker、1 key 30秒で全816件を実行した。",
        f"- legacyのsolver wall time合計は{legacy_wall_seconds:.3f}秒だった。"
        "3 topologyを並列実行したため、これは経過時間ではなく各keyのsolver時間の合計である。",
        f"- optimizer-v2のstage wall time合計は{optimizer_wall_seconds:.3f}秒だった。"
        "3 workerで並列実行したため、これも経過時間ではない。",
        "- すべての候補はcanonical slotへ変換後、現行の審判復元、6目的の再集計、"
        "固定配置監査、独立validatorを通過したものだけを比較対象にした。",
        "",
        "## Catalog shard digests",
        "",
        "| Topology | File | Entries | Internal SHA-256 |",
        "| --- | --- | ---: | --- |",
    ]
    lines.extend(
        f"| {shard.pool_count}x{shard.pool_size} | `{shard.file}` | {shard.entry_count} | "
        f"`{shard.sha256}` |"
        for shard in manifest.shards
    )
    lines.extend(
        (
            "",
            "## Target distribution",
            "",
            "| Topology | Fallback | First differing objective | Targets |",
            "| --- | --- | --- | ---: |",
        )
    )
    for topology, fallback in groups:
        for objective in PLACEMENT_OBJECTIVES:
            count = target_counts[topology, fallback, objective]
            if count:
                lines.append(f"| {topology} | {fallback} | {objective} | {count} |")
    lines.extend(
        (
            "",
            "## Candidate source",
            "",
            "| Topology | Fallback | Current | Optimizer-v2 | Legacy |",
            "| --- | --- | ---: | ---: | ---: |",
        )
    )
    for topology, fallback in groups:
        lines.append(
            f"| {topology} | {fallback} | "
            f"{source_counts[topology, fallback, BaselineSource.CURRENT.value]} | "
            f"{source_counts[topology, fallback, BaselineSource.OPTIMIZER.value]} | "
            f"{source_counts[topology, fallback, BaselineSource.LEGACY.value]} |"
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
    for topology, fallback in groups:
        for baseline in ("current", "legacy"):
            values = tuple(
                comparison_counts[topology, fallback, baseline, result.value]
                for result in LexicographicResult
            )
            lines.append(
                f"| {topology} | {fallback} | {baseline} | "
                + " | ".join(str(value) for value in values)
                + " |"
            )
    lines.extend(
        (
            "",
            "## Proof coverage",
            "",
            "| Topology | Fallback | Objective | Before | After | Delta |",
            "| --- | --- | --- | ---: | ---: | ---: |",
        )
    )
    for topology, fallback in groups:
        for objective in PLACEMENT_OBJECTIVES:
            before = proof_counts[topology, fallback, objective, "before"]
            after = proof_counts[topology, fallback, objective, "after"]
            lines.append(
                f"| {topology} | {fallback} | {objective} | {before} | {after} | "
                f"{after - before:+d} |"
            )
    lines.extend(
        (
            "",
            "## Legacy status",
            "",
            "| Topology | Fallback | Status | Count | Wall time (s) |",
            "| --- | --- | --- | ---: | ---: |",
        )
    )
    for topology, fallback in groups:
        for status in BaselineRecordStatus:
            lines.append(
                f"| {topology} | {fallback} | {status.value} | "
                f"{status_counts[topology, fallback, status.value]} | "
                f"{status_wall[topology, fallback, status.value]:.3f} |"
            )
    lines.extend(
        (
            "",
            "## Legacy diagnostics and timeout reasons",
            "",
            "| Topology | Fallback | Status | Reason | Count |",
            "| --- | --- | --- | --- | ---: |",
        )
    )
    for reason_identity in sorted(legacy_reason_counts):
        lines.append(f"| {' | '.join(reason_identity)} | {legacy_reason_counts[reason_identity]} |")
    lines.extend(
        (
            "",
            "## Optimizer stage checkpoints",
            "",
            "| Topology | Fallback | Objective | Status | Proof method | "
            "Termination reason | Count | Wall time (s) |",
            "| --- | --- | --- | --- | --- | --- | ---: | ---: |",
        )
    )
    for checkpoint_identity in sorted(checkpoint_counts):
        lines.append(
            f"| {' | '.join(checkpoint_identity)} | "
            f"{checkpoint_counts[checkpoint_identity]} | "
            f"{checkpoint_wall[checkpoint_identity]:.3f} |"
        )
    lines.append("")
    return "\n".join(lines)


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


def _validate_issue73_fixture_contract(
    current: PlacementBaselineFixture,
    legacy: PlacementBaselineFixture,
) -> None:
    expected_topologies = LARGE_LOWER_OBJECTIVE_TARGET_TOPOLOGIES
    if (
        current.source is not BaselineSource.CURRENT
        or legacy.source is not BaselineSource.LEGACY
        or current.topologies != expected_topologies
        or legacy.topologies != expected_topologies
        or not current.complete
        or not legacy.complete
        or not current.sha256
        or not legacy.sha256
    ):
        raise PlacementTemplateAggregationError(
            "current/legacy baselineは3x8・2x16・4x8の完全fixtureである必要があります"
        )
    expected_ids = {
        key.catalog_id for topology in expected_topologies for key in topology_keys(topology)
    }
    if {record.key.catalog_id for record in current.records} != expected_ids or {
        record.key.catalog_id for record in legacy.records
    } != expected_ids:
        raise PlacementTemplateAggregationError("Issue #73 baselineの816 key coverageが不正です")
    if any(
        record.candidate is None or record.input_entry_sha256 != record.candidate.sha256
        for record in current.records
    ):
        raise PlacementTemplateAggregationError(
            "Issue #73 current baselineの入力entry SHAがcandidateと一致しません"
        )


def _validate_issue73_target_manifest(
    manifest: PlacementOptimizationTargetManifest,
    current: PlacementBaselineFixture,
    legacy: PlacementBaselineFixture,
) -> None:
    if (
        not manifest.sha256
        or manifest.current_fixture_sha256 != current.sha256
        or manifest.legacy_fixture_sha256 != legacy.sha256
    ):
        raise PlacementTemplateAggregationError("target manifestのfixture SHAが一致しません")
    expected = build_issue73_target_manifest(current, legacy, auditor=lambda entry: entry)
    if manifest != expected:
        raise PlacementTemplateAggregationError(
            "target manifestがcurrent/legacy比較の再計算結果と一致しません"
        )


def _validate_issue73_checkpoint_coverage(
    checkpoints: Sequence[PlacementOptimizationStageCheckpoint],
    *,
    target_by_id: Mapping[str, PlacementOptimizationTarget],
    current_by_id: Mapping[str, PlacementBaselineRecord],
    legacy_by_id: Mapping[str, PlacementBaselineRecord],
    optimizer_by_id: Mapping[str, PlacementTemplateEntry],
    target_manifest_sha256: str,
) -> None:
    if not optimizer_by_id:
        if checkpoints:
            raise PlacementTemplateAggregationError(
                "optimizer-v2候補なしでcheckpointだけを集約できません"
            )
        return
    identities = {(item.key.catalog_id, item.stage_index) for item in checkpoints}
    expected = {
        (catalog_id, index)
        for catalog_id in target_by_id
        for index in range(len(PLACEMENT_OBJECTIVES))
    }
    if identities != expected or len(checkpoints) != len(expected):
        raise PlacementTemplateAggregationError(
            "optimizer-v2 checkpointのtarget IDs x 6疎coverageが不正です"
        )
    by_identity = {
        (checkpoint.key.catalog_id, checkpoint.stage_index): checkpoint
        for checkpoint in checkpoints
    }
    for catalog_id, target in target_by_id.items():
        current_entry = _available_baseline_candidate(current_by_id[catalog_id], source="current")
        legacy_entry = _available_baseline_candidate(legacy_by_id[catalog_id], source="legacy")
        optimizer_entry = optimizer_by_id[catalog_id]
        for index in range(len(PLACEMENT_OBJECTIVES)):
            checkpoint = by_identity[catalog_id, index]
            if (
                checkpoint.optimization_version != LARGE_LOWER_OBJECTIVE_OPTIMIZER_VERSION
                or checkpoint.key != target.key
                or checkpoint.input_entry_sha256 != current_entry.sha256
                or checkpoint.current_entry_sha256 != current_entry.sha256
                or checkpoint.legacy_incumbent_sha256 != legacy_entry.sha256
                or checkpoint.target_manifest_sha256 != target_manifest_sha256
            ):
                raise PlacementTemplateAggregationError(
                    f"{catalog_id}: optimizer-v2 checkpointのcampaign SHAが不正です"
                )
        if by_identity[catalog_id, len(PLACEMENT_OBJECTIVES) - 1].candidate.sha256 != (
            optimizer_entry.sha256
        ):
            raise PlacementTemplateAggregationError(
                f"{catalog_id}: 最終checkpointとoptimizer-v2候補が一致しません"
            )


def _available_baseline_candidate(
    record: PlacementBaselineRecord,
    *,
    source: str,
) -> PlacementTemplateEntry:
    if (
        record.status is not BaselineRecordStatus.AVAILABLE
        or record.candidate is None
        or record.objective_values is None
        or not record.candidate.sha256
    ):
        raise PlacementTemplateAggregationError(f"{source} baselineはavailableが必要です")
    if _entry_vector(record.candidate) != tuple(record.objective_values):
        raise PlacementTemplateAggregationError(f"{source} baselineの目的値が一致しません")
    return record.candidate


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
    return _topology_groups(LOWER_OBJECTIVE_TARGET_TOPOLOGIES)


def _topology_groups(topologies: Sequence[tuple[int, int]]) -> tuple[tuple[str, str], ...]:
    return tuple(
        (f"{topology[0]}x{topology[1]}", fallback.value)
        for topology in topologies
        for fallback in Day2Fallback
    )


__all__ = [
    "PlacementAggregationResult",
    "PlacementTemplateAggregationError",
    "aggregate_catalog",
    "aggregate_issue73_catalog",
    "aggregate_issue73_template_entry",
    "aggregate_template_entry",
    "build_issue73_target_manifest",
    "load_issue73_optimizer_entries",
    "load_optimizer_checkpoints",
    "render_issue73_quality_report",
    "render_quality_report",
    "write_text_atomic",
]
