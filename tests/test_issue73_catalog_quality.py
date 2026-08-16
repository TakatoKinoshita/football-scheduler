from __future__ import annotations

from hashlib import sha256
from pathlib import Path

from football_scheduler.placement_template_ab import (
    BaselineRecordStatus,
    read_deterministic_gzip,
)
from football_scheduler.placement_template_contract import (
    LARGE_LOWER_OBJECTIVE_OPTIMIZER_VERSION,
    PLACEMENT_OBJECTIVES,
    PlacementOptimizationTargetManifest,
    PlacementTemplateEntry,
    PlacementTemplateKey,
    placement_optimization_target_manifest_digest,
)
from football_scheduler.placement_template_generator import (
    GENERATOR_VERSION,
    LARGE_LOWER_OBJECTIVE_TARGET_TOPOLOGIES,
    guard_issue73_untouched_shards,
    load_shard,
    shard_file,
)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CATALOG_DIRECTORY = PROJECT_ROOT / "src" / "football_scheduler" / "placement_templates"
FIXTURE_DIRECTORY = PROJECT_ROOT / "tests" / "fixtures" / "placement-template-ab"
CURRENT_FIXTURE = FIXTURE_DIRECTORY / "current-pre-issue73-24-32.json.gz"
LEGACY_FIXTURE = FIXTURE_DIRECTORY / "legacy-24-32-2ccf91d.json.gz"
TARGET_MANIFEST = FIXTURE_DIRECTORY / "issue73-targets.json"

EXPECTED_FIXTURE_FILE_SHA256 = {
    CURRENT_FIXTURE.name: "572f8f3e5d3e9b0326239d2d921addb8227ecfbdb4db014269c890ea60c7cf65",
    LEGACY_FIXTURE.name: "c70a44e35c60d12efbf7dec964fae1cf56e4b59dc0c850cf33aaa922c46361e2",
    TARGET_MANIFEST.name: "3339742df235b5e87a51932a8248b4ee3e9ed54d167e8ab42f07b914d7f92e73",
}


def _objective_vector(entry: PlacementTemplateEntry) -> tuple[int, ...]:
    return tuple(item.value for item in entry.objectives)


def _key_axis(key: PlacementTemplateKey) -> tuple[object, ...]:
    return (key.pool_count, key.pool_size, key.court_count, key.day2_fallback)


def test_issue73_catalog_is_not_worse_than_current_or_available_legacy() -> None:
    for path, expected_digest in (
        (CURRENT_FIXTURE, EXPECTED_FIXTURE_FILE_SHA256[CURRENT_FIXTURE.name]),
        (LEGACY_FIXTURE, EXPECTED_FIXTURE_FILE_SHA256[LEGACY_FIXTURE.name]),
        (TARGET_MANIFEST, EXPECTED_FIXTURE_FILE_SHA256[TARGET_MANIFEST.name]),
    ):
        assert sha256(path.read_bytes()).hexdigest() == expected_digest

    current = read_deterministic_gzip(CURRENT_FIXTURE)
    legacy = read_deterministic_gzip(LEGACY_FIXTURE)
    target_manifest = PlacementOptimizationTargetManifest.model_validate_json(
        TARGET_MANIFEST.read_text(encoding="utf-8")
    )
    assert target_manifest.sha256 == placement_optimization_target_manifest_digest(target_manifest)
    assert target_manifest.current_fixture_sha256 == current.sha256
    assert target_manifest.legacy_fixture_sha256 == legacy.sha256
    assert current.complete is True
    assert legacy.complete is True
    assert len(current.records) == len(legacy.records) == 816
    assert len(target_manifest.targets) == 180

    final_entries = tuple(
        entry
        for topology in LARGE_LOWER_OBJECTIVE_TARGET_TOPOLOGIES
        for entry in load_shard(shard_file(CATALOG_DIRECTORY, topology)).entries
    )
    assert len(final_entries) == 96
    final_by_id = {_key_axis(entry.key): entry for entry in final_entries}
    current_by_id = {
        _key_axis(record.key): record
        for record in current.records
        if record.key.organizer_capacity == record.key.court_count
    }
    legacy_by_id = {
        _key_axis(record.key): record
        for record in legacy.records
        if record.key.organizer_capacity == record.key.court_count
    }
    target_ids = {
        _key_axis(target.key)
        for target in target_manifest.targets
        if target.key.organizer_capacity == target.key.court_count
    }
    expected_target_ids = {
        catalog_id
        for catalog_id, legacy_record in legacy_by_id.items()
        if legacy_record.status is BaselineRecordStatus.AVAILABLE
        and legacy_record.objective_values is not None
        and current_by_id[catalog_id].objective_values is not None
        and legacy_record.objective_values < current_by_id[catalog_id].objective_values
    }
    assert target_ids == expected_target_ids
    assert len(current_by_id) == len(legacy_by_id) == 96
    assert set(final_by_id) == set(current_by_id) == set(legacy_by_id)

    for catalog_id, final in final_by_id.items():
        current_record = current_by_id[catalog_id]
        legacy_record = legacy_by_id[catalog_id]
        assert current_record.status is BaselineRecordStatus.AVAILABLE
        assert current_record.objective_values is not None
        assert _objective_vector(final) <= tuple(current_record.objective_values)
        if legacy_record.status is BaselineRecordStatus.AVAILABLE:
            assert legacy_record.objective_values is not None
            assert _objective_vector(final) <= tuple(legacy_record.objective_values)

        assert tuple(item.objective for item in final.objectives) == PLACEMENT_OBJECTIVES
        proof_flags = tuple(item.optimality_proven for item in final.objectives)
        assert proof_flags[0] is True
        assert proof_flags == tuple(sorted(proof_flags, reverse=True))
        assert final.provenance.generator_version == GENERATOR_VERSION
        if catalog_id in target_ids:
            assert final.provenance.optimization_version == (
                LARGE_LOWER_OBJECTIVE_OPTIMIZER_VERSION
            )
        else:
            assert current_record.candidate is not None
            assert final.slots == current_record.candidate.slots
            assert final.objectives == current_record.candidate.objectives
            assert final.referee_signature == current_record.candidate.referee_signature


def test_issue73_does_not_rewrite_8_or_16_team_shards() -> None:
    guard_issue73_untouched_shards(CATALOG_DIRECTORY)
