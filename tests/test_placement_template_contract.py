from __future__ import annotations

import pytest

from football_scheduler.models import Day2Fallback
from football_scheduler.placement_template_contract import (
    LARGE_LOWER_OBJECTIVE_OPTIMIZER_VERSION,
    PLACEMENT_OBJECTIVES,
    CanonicalMatchPosition,
    PlacementOptimizationTarget,
    PlacementOptimizationTargetManifest,
    PlacementTemplateEntry,
    PlacementTemplateKey,
    PlacementTemplateObjective,
    PlacementTemplateProvenance,
    PlacementTemplateSlot,
    PlacementTemplateStatus,
    expected_placement_template_keys,
    placement_entry_digest,
    placement_optimization_target_manifest_digest,
)


def _entry() -> PlacementTemplateEntry:
    entry = PlacementTemplateEntry(
        key=PlacementTemplateKey(
            pool_count=2,
            pool_size=4,
            court_count=2,
            organizer_capacity=2,
            day2_fallback="organizer",
        ),
        status=PlacementTemplateStatus.AVAILABLE,
        used_sections=5,
        slots=(
            PlacementTemplateSlot(
                section_no=1,
                court_index=0,
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
                value=5 if name == "used_sections" else 0,
                optimality_proven=True,
            )
            for name in PLACEMENT_OBJECTIVES
        ),
        referee_signature="sha256:referee",
        provenance=PlacementTemplateProvenance(
            generator_version="test",
            python_version="3.14",
            ortools_version="9.15",
        ),
    )
    return entry.model_copy(update={"sha256": placement_entry_digest(entry)})


def test_expected_key_space_contains_all_1360_unique_keys() -> None:
    keys = expected_placement_template_keys()

    assert len(keys) == 1360
    assert len({key.catalog_id for key in keys}) == 1360


def test_key_normalizes_capacity_above_court_count() -> None:
    key = PlacementTemplateKey.normalized(
        pool_count=2,
        pool_size=16,
        court_count=4,
        organizer_capacity=16,
        day2_fallback=Day2Fallback.ORGANIZER,
    )

    assert key.organizer_capacity == 4


def test_entry_digest_round_trips_through_contract() -> None:
    entry = _entry()

    restored = PlacementTemplateEntry.model_validate(entry.model_dump(mode="json"))

    assert restored.sha256 == placement_entry_digest(restored)


def test_optional_optimizer_provenance_is_omitted_when_unused() -> None:
    entry = _entry()

    dumped = entry.model_dump(mode="json")

    assert "optimization_version" not in dumped["provenance"]


def test_v2_optimizer_provenance_is_accepted() -> None:
    entry = _entry()
    provenance = entry.provenance.model_copy(
        update={"optimization_version": LARGE_LOWER_OBJECTIVE_OPTIMIZER_VERSION}
    )

    restored = PlacementTemplateEntry.model_validate(
        entry.model_copy(update={"provenance": provenance, "sha256": ""}).model_dump(mode="json")
    )

    assert restored.provenance.optimization_version == LARGE_LOWER_OBJECTIVE_OPTIMIZER_VERSION


def test_target_manifest_requires_legacy_improvement_and_round_trips_digest() -> None:
    target = PlacementOptimizationTarget(
        key=PlacementTemplateKey(
            pool_count=3,
            pool_size=8,
            court_count=2,
            organizer_capacity=2,
            day2_fallback="organizer",
        ),
        current_entry_sha256="a" * 64,
        legacy_entry_sha256="b" * 64,
        current_objectives=(8, 2, 3, 5, 1, 1),
        legacy_objectives=(8, 1, 3, 5, 1, 1),
        first_differing_objective="non_primary_final_max_gap",
    )
    manifest = PlacementOptimizationTargetManifest(
        current_fixture_sha256="c" * 64,
        legacy_fixture_sha256="d" * 64,
        topologies=((3, 8), (2, 16), (4, 8)),
        targets=(target,),
    )
    completed = manifest.model_copy(
        update={"sha256": placement_optimization_target_manifest_digest(manifest)}
    )

    restored = PlacementOptimizationTargetManifest.model_validate(completed.model_dump(mode="json"))

    assert restored.sha256 == placement_optimization_target_manifest_digest(restored)

    with pytest.raises(ValueError, match="currentより良いlegacy"):
        PlacementOptimizationTarget.model_validate(
            target.model_copy(update={"legacy_objectives": target.current_objectives}).model_dump(
                mode="json"
            )
        )


def test_entry_rejects_non_prefix_objective_proofs() -> None:
    entry = _entry()
    broken = entry.model_dump(mode="json")
    broken["sha256"] = ""
    broken["objectives"][3]["optimality_proven"] = False
    broken["objectives"][4]["optimality_proven"] = True

    with pytest.raises(ValueError, match="連続prefix"):
        PlacementTemplateEntry.model_validate(broken)
