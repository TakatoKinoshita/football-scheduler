from __future__ import annotations

import pytest

from football_scheduler.models import Day2Fallback
from football_scheduler.placement_template_contract import (
    PLACEMENT_OBJECTIVES,
    CanonicalMatchPosition,
    PlacementTemplateEntry,
    PlacementTemplateKey,
    PlacementTemplateObjective,
    PlacementTemplateProvenance,
    PlacementTemplateSlot,
    PlacementTemplateStatus,
    expected_placement_template_keys,
    placement_entry_digest,
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


def test_entry_rejects_non_prefix_objective_proofs() -> None:
    entry = _entry()
    broken = entry.model_dump(mode="json")
    broken["sha256"] = ""
    broken["objectives"][3]["optimality_proven"] = False
    broken["objectives"][4]["optimality_proven"] = True

    with pytest.raises(ValueError, match="連続prefix"):
        PlacementTemplateEntry.model_validate(broken)
