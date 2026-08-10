from __future__ import annotations

from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace

import pytest

from football_scheduler import placement_template_aggregator as aggregator
from football_scheduler import placement_template_generator as generator
from football_scheduler.models import SolverStatus
from football_scheduler.placement_template_ab import (
    BaselineRecordStatus,
    BaselineSource,
    PlacementBaselineFixture,
    PlacementBaselineRecord,
)
from football_scheduler.placement_template_contract import (
    LARGE_LOWER_OBJECTIVE_OPTIMIZER_VERSION,
    PLACEMENT_OBJECTIVES,
    CanonicalMatchPosition,
    PlacementOptimizationStageCheckpoint,
    PlacementOptimizationTarget,
    PlacementOptimizationTargetManifest,
    PlacementTemplateEntry,
    PlacementTemplateKey,
    PlacementTemplateObjective,
    PlacementTemplateProvenance,
    PlacementTemplateSlot,
    PlacementTemplateStatus,
    placement_entry_digest,
    placement_optimization_target_manifest_digest,
)


def _entry(
    vector: tuple[int, int, int, int, int, int],
    *,
    court_index: int,
    proofs: tuple[bool, bool, bool, bool, bool, bool],
    optimized: bool = False,
) -> PlacementTemplateEntry:
    entry = PlacementTemplateEntry(
        key=PlacementTemplateKey(
            pool_count=3,
            pool_size=8,
            court_count=2,
            organizer_capacity=2,
            day2_fallback="organizer",
        ),
        status=PlacementTemplateStatus.AVAILABLE,
        used_sections=vector[0],
        slots=(
            PlacementTemplateSlot(
                section_no=1,
                court_index=court_index,
                match_position=CanonicalMatchPosition(
                    pool_index=1,
                    rank_range_start=1,
                    rank_range_end=8,
                    logical_order=1,
                ),
            ),
        ),
        objectives=tuple(
            PlacementTemplateObjective(objective=name, value=value, optimality_proven=proof)
            for name, value, proof in zip(PLACEMENT_OBJECTIVES, vector, proofs, strict=True)
        ),
        referee_signature=f"referee-{court_index}",
        provenance=PlacementTemplateProvenance(
            generator_version=generator.GENERATOR_VERSION,
            python_version="3.14.2",
            ortools_version="9.15.6755",
            optimization_version=(LARGE_LOWER_OBJECTIVE_OPTIMIZER_VERSION if optimized else None),
        ),
    )
    completed = entry.model_copy(update={"sha256": placement_entry_digest(entry)})
    return PlacementTemplateEntry.model_validate(completed.model_dump(mode="json"))


def _record(
    candidate: PlacementTemplateEntry,
    *,
    input_sha: str | None = None,
) -> PlacementBaselineRecord:
    return PlacementBaselineRecord(
        key=candidate.key,
        input_entry_sha256=input_sha or candidate.sha256,
        status=BaselineRecordStatus.AVAILABLE,
        solver_status=SolverStatus.FEASIBLE.value,
        horizon=candidate.used_sections or 1,
        objective_values=tuple(item.value for item in candidate.objectives),
        candidate=candidate,
    )


def _fixture(
    source: BaselineSource,
    record: PlacementBaselineRecord,
    *,
    sha: str,
) -> PlacementBaselineFixture:
    # placement_template_abのlarge-topology拡張とは独立してaggregator契約をテストする。
    return PlacementBaselineFixture.model_construct(
        source=source,
        topologies=generator.LARGE_LOWER_OBJECTIVE_TARGET_TOPOLOGIES,
        complete=True,
        records=(record,),
        sha256=sha,
    )


def _target_manifest(
    current: PlacementTemplateEntry,
    legacy: PlacementTemplateEntry,
) -> PlacementOptimizationTargetManifest:
    target = PlacementOptimizationTarget(
        key=current.key,
        current_entry_sha256=current.sha256,
        legacy_entry_sha256=legacy.sha256,
        current_objectives=tuple(item.value for item in current.objectives),
        legacy_objectives=tuple(item.value for item in legacy.objectives),
        first_differing_objective="non_primary_final_max_gap",
    )
    manifest = PlacementOptimizationTargetManifest(
        current_fixture_sha256="1" * 64,
        legacy_fixture_sha256="2" * 64,
        topologies=generator.LARGE_LOWER_OBJECTIVE_TARGET_TOPOLOGIES,
        targets=(target,),
    )
    completed = manifest.model_copy(
        update={"sha256": placement_optimization_target_manifest_digest(manifest)}
    )
    return PlacementOptimizationTargetManifest.model_validate(completed.model_dump(mode="json"))


def _checkpoint(
    current: PlacementTemplateEntry,
    legacy: PlacementTemplateEntry,
    candidate: PlacementTemplateEntry,
    manifest: PlacementOptimizationTargetManifest,
    index: int,
) -> PlacementOptimizationStageCheckpoint:
    objective = candidate.objectives[index]
    return PlacementOptimizationStageCheckpoint(
        optimization_version=LARGE_LOWER_OBJECTIVE_OPTIMIZER_VERSION,
        key=current.key,
        stage_index=index,
        objective=objective.objective,
        input_entry_sha256=current.sha256,
        candidate=candidate,
        status=(SolverStatus.OPTIMAL if objective.optimality_proven else SolverStatus.UNKNOWN),
        value=objective.value,
        optimality_proven=objective.optimality_proven,
        proof_method=("existing" if objective.optimality_proven else "unproven"),
        best_bound=float(objective.value),
        model_fingerprint=sha256(objective.objective.encode()).hexdigest(),
        current_entry_sha256=current.sha256,
        legacy_incumbent_sha256=legacy.sha256,
        target_manifest_sha256=manifest.sha256,
        fixed_objectives=candidate.objectives[:index],
        termination_reason=(None if objective.optimality_proven else "timeout"),
    )


def test_target_manifest_extracts_only_legacy_improvement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    current = _entry(
        (8, 2, 4, 3, 2, 1),
        court_index=0,
        proofs=(True, False, False, False, False, False),
    )
    legacy = _entry(
        (8, 1, 3, 4, 3, 2),
        court_index=1,
        proofs=(True, False, False, False, False, False),
    )
    monkeypatch.setattr(aggregator, "topology_keys", lambda _topology: (current.key,))

    manifest = aggregator.build_issue73_target_manifest(
        _fixture(BaselineSource.CURRENT, _record(current), sha="1" * 64),
        _fixture(
            BaselineSource.LEGACY,
            _record(legacy, input_sha=current.sha256),
            sha="2" * 64,
        ),
        auditor=lambda entry: entry,
    )

    assert tuple(target.key.catalog_id for target in manifest.targets) == (current.key.catalog_id,)
    assert manifest.targets[0].first_differing_objective == ("non_primary_final_max_gap")
    assert manifest.sha256 == placement_optimization_target_manifest_digest(manifest)


def test_target_manifest_stops_when_legacy_breaks_proven_prefix(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    current = _entry(
        (8, 2, 4, 3, 2, 1),
        court_index=0,
        proofs=(True, True, False, False, False, False),
    )
    legacy = _entry(
        (8, 1, 3, 4, 3, 2),
        court_index=1,
        proofs=(True, False, False, False, False, False),
    )
    monkeypatch.setattr(aggregator, "topology_keys", lambda _topology: (current.key,))

    with pytest.raises(aggregator.PlacementTemplateAggregationError, match="証明済み目的"):
        aggregator.build_issue73_target_manifest(
            _fixture(BaselineSource.CURRENT, _record(current), sha="1" * 64),
            _fixture(
                BaselineSource.LEGACY,
                _record(legacy, input_sha=current.sha256),
                sha="2" * 64,
            ),
            auditor=lambda entry: entry,
        )


def test_optimizer_v2_wins_tie_over_legacy_and_marks_v2_provenance() -> None:
    current = _entry(
        (8, 2, 4, 3, 2, 1),
        court_index=0,
        proofs=(True, False, False, False, False, False),
    )
    legacy = _entry(
        (8, 1, 3, 4, 3, 2),
        court_index=0,
        proofs=(True, False, False, False, False, False),
    )
    optimizer = _entry(
        (8, 1, 3, 4, 3, 2),
        court_index=1,
        proofs=(True, True, False, False, False, False),
        optimized=True,
    )
    target = _target_manifest(current, legacy).targets[0]

    final, source = aggregator.aggregate_issue73_template_entry(
        _record(current),
        _record(legacy, input_sha=current.sha256),
        target,
        optimizer,
        auditor=lambda entry: entry,
    )

    assert source == BaselineSource.OPTIMIZER.value
    assert final.slots == optimizer.slots
    assert final.provenance.optimization_version == (LARGE_LOWER_OBJECTIVE_OPTIMIZER_VERSION)


def test_sparse_checkpoint_coverage_requires_every_target_stage() -> None:
    current = _entry(
        (8, 2, 4, 3, 2, 1),
        court_index=0,
        proofs=(True, False, False, False, False, False),
    )
    legacy = _entry(
        (8, 1, 3, 4, 3, 2),
        court_index=0,
        proofs=(True, False, False, False, False, False),
    )
    optimizer = _entry(
        (8, 1, 3, 4, 3, 2),
        court_index=1,
        proofs=(True, False, False, False, False, False),
        optimized=True,
    )
    manifest = _target_manifest(current, legacy)
    target = manifest.targets[0]
    checkpoints = tuple(
        _checkpoint(current, legacy, optimizer, manifest, index)
        for index in range(len(PLACEMENT_OBJECTIVES))
    )
    arguments = {
        "target_by_id": {current.key.catalog_id: target},
        "current_by_id": {current.key.catalog_id: _record(current)},
        "legacy_by_id": {current.key.catalog_id: _record(legacy, input_sha=current.sha256)},
        "optimizer_by_id": {current.key.catalog_id: optimizer},
        "target_manifest_sha256": manifest.sha256,
    }

    aggregator._validate_issue73_checkpoint_coverage(checkpoints, **arguments)
    with pytest.raises(aggregator.PlacementTemplateAggregationError, match="coverage"):
        aggregator._validate_issue73_checkpoint_coverage(checkpoints[:-1], **arguments)


def test_generator_adapter_writes_all_stages_and_resumes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    current = _entry(
        (8, 2, 4, 3, 2, 1),
        court_index=0,
        proofs=(True, False, False, False, False, False),
    )
    legacy = _entry(
        (8, 1, 3, 4, 3, 2),
        court_index=0,
        proofs=(True, False, False, False, False, False),
    )
    optimizer = _entry(
        (8, 1, 3, 4, 3, 2),
        court_index=1,
        proofs=(True, False, False, False, False, False),
        optimized=True,
    )
    manifest = _target_manifest(current, legacy)
    monkeypatch.setattr(
        generator,
        "_hydrate_and_validate_entry",
        lambda *_args, **_kwargs: (object(), object()),
    )
    calls = 0

    def adapter(
        request: generator.LargeObjectiveOptimizationRequest,
        emit: generator.LargeObjectiveCheckpointSink,
    ) -> PlacementTemplateEntry:
        nonlocal calls
        calls += 1
        assert request.completed_checkpoints == ()
        for index in range(len(PLACEMENT_OBJECTIVES)):
            emit(_checkpoint(current, legacy, optimizer, manifest, index))
        return optimizer

    generated = generator.optimize_issue73_target_entry(
        current_entry=current,
        legacy_incumbent=legacy,
        target=manifest.targets[0],
        target_manifest=manifest,
        output_directory=tmp_path,
        optimizer=adapter,
    )
    candidate_path = generator.issue73_optimizer_candidate_file(tmp_path, current.key)
    candidate_path.unlink()
    resumed = generator.optimize_issue73_target_entry(
        current_entry=current,
        legacy_incumbent=legacy,
        target=manifest.targets[0],
        target_manifest=manifest,
        output_directory=tmp_path,
        optimizer=lambda *_args, **_kwargs: pytest.fail("resume must not call optimizer"),
        resume=True,
    )

    checkpoint_directory = generator.issue73_optimization_checkpoint_directory(
        tmp_path, current.key
    )
    assert calls == 1
    assert generated == optimizer
    assert resumed == optimizer
    assert candidate_path.exists()
    assert len(tuple(checkpoint_directory.glob("*.json"))) == len(PLACEMENT_OBJECTIVES)


def test_optimizer_v2_accepts_empty_isolated_output_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    current = _entry(
        (8, 2, 4, 3, 2, 1),
        court_index=0,
        proofs=(True, False, False, False, False, False),
    )
    legacy = _entry(
        (8, 1, 3, 4, 3, 2),
        court_index=0,
        proofs=(True, False, False, False, False, False),
    )
    candidate = _entry(
        (8, 1, 3, 4, 3, 2),
        court_index=1,
        proofs=(True, False, False, False, False, False),
        optimized=True,
    )
    manifest = _target_manifest(current, legacy)
    monkeypatch.setattr(
        generator,
        "_hydrate_and_validate_entry",
        lambda *_args, **_kwargs: (object(), object()),
    )

    def adapter(
        request: generator.LargeObjectiveOptimizationRequest,
        emit: generator.LargeObjectiveCheckpointSink,
    ) -> PlacementTemplateEntry:
        for index in range(len(PLACEMENT_OBJECTIVES)):
            emit(_checkpoint(current, legacy, candidate, manifest, index))
        return candidate

    output = tmp_path / "isolated-output"
    result = generator.optimize_issue73_targets(
        manifest,
        {current.key.catalog_id: current},
        {legacy.key.catalog_id: legacy},
        output,
        optimizer=adapter,
    )

    assert result == {current.key.catalog_id: candidate}
    assert not (output / "placement-p2-s4.json").exists()


def test_issue73_catalog_rejects_target_without_optimizer(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    current = _entry(
        (8, 2, 4, 3, 2, 1),
        court_index=0,
        proofs=(True, False, False, False, False, False),
    )
    legacy = _entry(
        (8, 1, 3, 4, 3, 2),
        court_index=0,
        proofs=(True, False, False, False, False, False),
    )
    current_fixture = _fixture(BaselineSource.CURRENT, _record(current), sha="1" * 64)
    legacy_fixture = _fixture(
        BaselineSource.LEGACY,
        _record(legacy, input_sha=current.sha256),
        sha="2" * 64,
    )
    manifest = _target_manifest(current, legacy)
    monkeypatch.setattr(aggregator, "_validate_issue73_fixture_contract", lambda *_args: None)
    monkeypatch.setattr(aggregator, "_validate_issue73_target_manifest", lambda *_args: None)
    monkeypatch.setattr(aggregator, "guard_issue73_untouched_shards", lambda *_args: None)

    with pytest.raises(aggregator.PlacementTemplateAggregationError, match="coverage"):
        aggregator.aggregate_issue73_catalog(
            current_fixture=current_fixture,
            legacy_fixture=legacy_fixture,
            target_manifest=manifest,
            catalog_directory=tmp_path,
        )


def test_default_adapter_converts_native_progress_to_v2_checkpoints(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from football_scheduler import placement_lower_objective_optimizer as native

    current = _entry(
        (8, 2, 4, 3, 2, 1),
        court_index=0,
        proofs=(True, False, False, False, False, False),
    )
    legacy = _entry(
        (8, 1, 3, 4, 3, 2),
        court_index=0,
        proofs=(True, False, False, False, False, False),
    )
    candidate = _entry(
        (8, 1, 3, 4, 3, 2),
        court_index=1,
        proofs=(True, False, False, False, False, False),
        optimized=True,
    )
    manifest = _target_manifest(current, legacy)
    hydrated_request = object()
    current_schedule = object()
    legacy_schedule = object()
    hydration = iter(((hydrated_request, current_schedule), (hydrated_request, legacy_schedule)))
    monkeypatch.setattr(
        generator, "_hydrate_and_validate_entry", lambda *_args, **_kwargs: next(hydration)
    )
    monkeypatch.setattr(generator, "_available_entry", lambda *_args, **_kwargs: candidate)

    def fake_native(
        request: object,
        incumbent: object,
        **kwargs: object,
    ) -> object:
        assert request is hydrated_request
        assert incumbent is current_schedule
        assert kwargs["legacy_incumbent"] is legacy_schedule
        callback = kwargs["stage_callback"]
        assert callable(callback)
        stages = []
        for index, objective in enumerate(candidate.objectives):
            stages.append(
                SimpleNamespace(
                    objective=objective.objective,
                    value=objective.value,
                    status=(SolverStatus.OPTIMAL if index == 0 else SolverStatus.UNKNOWN),
                    optimality_proven=index == 0,
                    proof_method=("existing" if index == 0 else "unproven"),
                    best_bound=float(objective.value),
                    wall_time_seconds=0.1,
                    model_fingerprint=sha256(objective.objective.encode()).hexdigest(),
                    termination_reason=(None if index == 0 else "timeout"),
                )
            )
            callback(
                SimpleNamespace(
                    schedule=object(),
                    objectives=tuple(stages),
                )
            )
        return object()

    monkeypatch.setattr(native, "optimize_lower_objectives", fake_native)
    adapter = generator._default_large_objective_optimizer()
    emitted: list[PlacementOptimizationStageCheckpoint] = []
    result = adapter(
        generator.LargeObjectiveOptimizationRequest(
            current_entry=current,
            legacy_incumbent=legacy,
            target=manifest.targets[0],
            target_manifest_sha256=manifest.sha256,
            completed_checkpoints=(),
            max_time_per_stage=60,
        ),
        emitted.append,
    )

    assert result.provenance.optimization_version == (LARGE_LOWER_OBJECTIVE_OPTIMIZER_VERSION)
    assert [checkpoint.stage_index for checkpoint in emitted] == list(
        range(len(PLACEMENT_OBJECTIVES))
    )
    assert all(checkpoint.target_manifest_sha256 == manifest.sha256 for checkpoint in emitted)
