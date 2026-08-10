from __future__ import annotations

from hashlib import sha256
from pathlib import Path

import pytest

from football_scheduler.models import SolverStatus
from football_scheduler.placement_template_ab import (
    LEGACY_ORTOOLS_VERSION,
    LEGACY_SOLVER_COMMIT,
    BaselineRecordStatus,
    BaselineSource,
    PlacementBaselineEnvironment,
    PlacementBaselineFixture,
    PlacementBaselineRecord,
    with_fixture_digest,
)
from football_scheduler.placement_template_aggregator import (
    PlacementTemplateAggregationError,
    aggregate_template_entry,
    load_optimizer_checkpoints,
    render_quality_report,
)
from football_scheduler.placement_template_contract import (
    LOWER_OBJECTIVE_OPTIMIZER_VERSION,
    PLACEMENT_OBJECTIVES,
    CanonicalMatchPosition,
    PlacementOptimizationStageCheckpoint,
    PlacementTemplateEntry,
    PlacementTemplateKey,
    PlacementTemplateObjective,
    PlacementTemplateProvenance,
    PlacementTemplateSlot,
    PlacementTemplateStatus,
    placement_entry_digest,
)
from football_scheduler.placement_template_generator import (
    write_optimization_stage_checkpoint,
)


def _entry(
    vector: tuple[int, int, int, int, int, int],
    *,
    court_index: int,
    proofs: tuple[bool, bool, bool, bool, bool, bool],
    optimized: bool = False,
) -> PlacementTemplateEntry:
    provenance = PlacementTemplateProvenance(
        generator_version="placement-template-generator-v8",
        python_version="3.14.2",
        ortools_version=LEGACY_ORTOOLS_VERSION,
        optimization_version=(LOWER_OBJECTIVE_OPTIMIZER_VERSION if optimized else None),
    )
    entry = PlacementTemplateEntry(
        key=PlacementTemplateKey(
            pool_count=2,
            pool_size=4,
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
                    rank_range_end=4,
                    logical_order=1,
                ),
            ),
        ),
        objectives=tuple(
            PlacementTemplateObjective(
                objective=name,
                value=value,
                optimality_proven=proof,
            )
            for name, value, proof in zip(PLACEMENT_OBJECTIVES, vector, proofs, strict=True)
        ),
        referee_signature=f"referee-{court_index}",
        provenance=provenance,
    )
    completed = entry.model_copy(update={"sha256": placement_entry_digest(entry)})
    return PlacementTemplateEntry.model_validate(completed.model_dump(mode="json"))


def _record(
    candidate: PlacementTemplateEntry,
    *,
    input_sha: str | None = None,
    wall_time: float = 0,
) -> PlacementBaselineRecord:
    return PlacementBaselineRecord(
        key=candidate.key,
        input_entry_sha256=input_sha or candidate.sha256,
        status=BaselineRecordStatus.AVAILABLE,
        solver_status=SolverStatus.FEASIBLE.value,
        horizon=candidate.objectives[0].value,
        objective_values=tuple(item.value for item in candidate.objectives),
        candidate=candidate,
        wall_time_seconds=wall_time,
    )


def _fixture(
    source: BaselineSource,
    record: PlacementBaselineRecord,
) -> PlacementBaselineFixture:
    environment = PlacementBaselineEnvironment(
        commit_sha=(LEGACY_SOLVER_COMMIT if source is BaselineSource.LEGACY else "1" * 40),
        python_version="3.14.2",
        ortools_version=LEGACY_ORTOOLS_VERSION,
        max_time_seconds=30,
    )
    return with_fixture_digest(
        PlacementBaselineFixture(
            source=source,
            topologies=((2, 4),),
            environment=environment,
            complete=False,
            records=(record,),
        )
    )


def test_current_slot_is_kept_on_equal_vector_and_proofs_are_merged() -> None:
    vector = (5, 0, 0, 2, 1, 1)
    current = _entry(vector, court_index=0, proofs=(True, False, False, False, False, False))
    optimizer = _entry(
        vector,
        court_index=1,
        proofs=(True, True, True, False, False, False),
        optimized=True,
    )

    final = aggregate_template_entry(
        _record(current),
        None,
        optimizer,
        auditor=lambda entry: entry,
    )

    assert final.slots == current.slots
    assert tuple(item.optimality_proven for item in final.objectives) == (
        True,
        True,
        True,
        False,
        False,
        False,
    )
    assert final.provenance.optimization_version == LOWER_OBJECTIVE_OPTIMIZER_VERSION


def test_optimizer_wins_equal_best_vector_over_legacy() -> None:
    current = _entry(
        (5, 1, 1, 3, 2, 1),
        court_index=0,
        proofs=(True, False, False, False, False, False),
    )
    legacy = _entry(
        (5, 0, 0, 2, 1, 1),
        court_index=0,
        proofs=(True, False, False, False, False, False),
    )
    optimizer = _entry(
        (5, 0, 0, 2, 1, 1),
        court_index=1,
        proofs=(True, True, True, False, False, False),
        optimized=True,
    )

    final = aggregate_template_entry(
        _record(current),
        _record(legacy, input_sha=current.sha256),
        optimizer,
        auditor=lambda entry: entry,
    )

    assert final.slots == optimizer.slots
    assert tuple(item.value for item in final.objectives) == (5, 0, 0, 2, 1, 1)


def test_available_legacy_must_match_current_input_sha() -> None:
    current = _entry(
        (5, 1, 1, 3, 2, 1),
        court_index=0,
        proofs=(True, False, False, False, False, False),
    )
    optimizer = _entry(
        (5, 1, 1, 3, 2, 1),
        court_index=1,
        proofs=(True, False, False, False, False, False),
        optimized=True,
    )

    with pytest.raises(PlacementTemplateAggregationError, match="入力SHA"):
        aggregate_template_entry(
            _record(current),
            _record(current, input_sha="0" * 64),
            optimizer,
            auditor=lambda entry: entry,
        )


def test_quality_report_and_checkpoint_loading_are_deterministic(tmp_path: Path) -> None:
    current = _entry(
        (5, 1, 1, 3, 2, 1),
        court_index=0,
        proofs=(True, False, False, False, False, False),
    )
    final = _entry(
        (5, 0, 0, 2, 1, 1),
        court_index=1,
        proofs=(True, True, True, False, False, False),
        optimized=True,
    )
    current_fixture = _fixture(BaselineSource.CURRENT, _record(current))
    legacy_fixture = _fixture(
        BaselineSource.LEGACY,
        _record(final, input_sha=current.sha256, wall_time=12.3456),
    )
    checkpoint_root = tmp_path / "checkpoints"
    for index, objective in enumerate(final.objectives):
        checkpoint = PlacementOptimizationStageCheckpoint(
            key=final.key,
            stage_index=index,
            objective=objective.objective,
            input_entry_sha256=current.sha256,
            candidate=final,
            status=(SolverStatus.OPTIMAL if objective.optimality_proven else SolverStatus.UNKNOWN),
            value=objective.value,
            optimality_proven=objective.optimality_proven,
            proof_method=("analytic_lower_bound" if objective.optimality_proven else "unproven"),
            best_bound=float(objective.value),
            wall_time_seconds=index / 10,
            model_fingerprint=sha256(objective.objective.encode()).hexdigest(),
        )
        write_optimization_stage_checkpoint(checkpoint, checkpoint_root / "entry")

    checkpoints = load_optimizer_checkpoints(checkpoint_root)
    first = render_quality_report(
        current_fixture=current_fixture,
        legacy_fixture=legacy_fixture,
        final_entries=(final,),
        optimizer_checkpoints=checkpoints,
    )
    second = render_quality_report(
        current_fixture=current_fixture,
        legacy_fixture=legacy_fixture,
        final_entries=(final,),
        optimizer_checkpoints=tuple(reversed(checkpoints)),
    )

    assert len(checkpoints) == len(PLACEMENT_OBJECTIVES)
    assert first == second
    assert "| 2x4 | organizer | non_primary_final_max_gap | 0 | 1 | +1 |" in first
    assert "| 2x4 | organizer | legacy | 0 | 1 | 0 |" in first
    assert "| 2x4 | organizer | available | 1 | 12.346 |" in first
    assert "analytic_lower_bound" in first
