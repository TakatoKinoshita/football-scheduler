from __future__ import annotations

from hashlib import sha256
from pathlib import Path

from football_scheduler.placement_template_ab import (
    BaselineRecordStatus,
    read_deterministic_gzip,
)
from football_scheduler.placement_template_contract import (
    LOWER_OBJECTIVE_OPTIMIZER_VERSION,
    PLACEMENT_OBJECTIVES,
    PlacementTemplateEntry,
    PlacementTemplateKey,
)
from football_scheduler.placement_template_generator import (
    GENERATOR_VERSION,
    LOWER_OBJECTIVE_TARGET_TOPOLOGIES,
    guard_untouched_shards,
    load_shard,
    shard_file,
)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CATALOG_DIRECTORY = PROJECT_ROOT / "src" / "football_scheduler" / "placement_templates"
FIXTURE_DIRECTORY = PROJECT_ROOT / "tests" / "fixtures" / "placement-template-ab"
CURRENT_FIXTURE = FIXTURE_DIRECTORY / "current-pre-optimizer.json.gz"
LEGACY_FIXTURE = FIXTURE_DIRECTORY / "legacy-2ccf91d.json.gz"

EXPECTED_FIXTURE_FILE_SHA256 = {
    CURRENT_FIXTURE.name: "13bbd417865673ee1802dcb9c1c456e1e527af7384c075186a17dcca71bc961f",
    LEGACY_FIXTURE.name: "70280c94afc6984818a5ffb66bf82f84a362176579c8da597c63b6ad9a806c20",
}


def _objective_vector(entry: PlacementTemplateEntry) -> tuple[int, ...]:
    return tuple(item.value for item in entry.objectives)


def _key_axis(key: PlacementTemplateKey) -> tuple[object, ...]:
    return (key.pool_count, key.pool_size, key.court_count, key.day2_fallback)


def test_issue71_catalog_is_not_worse_than_current_or_available_legacy() -> None:
    for path, expected_digest in (
        (CURRENT_FIXTURE, EXPECTED_FIXTURE_FILE_SHA256[CURRENT_FIXTURE.name]),
        (LEGACY_FIXTURE, EXPECTED_FIXTURE_FILE_SHA256[LEGACY_FIXTURE.name]),
    ):
        assert sha256(path.read_bytes()).hexdigest() == expected_digest

    current = read_deterministic_gzip(CURRENT_FIXTURE)
    legacy = read_deterministic_gzip(LEGACY_FIXTURE)
    assert current.complete is True
    assert legacy.complete is True
    assert len(current.records) == len(legacy.records) == 544

    final_entries = tuple(
        entry
        for topology in LOWER_OBJECTIVE_TARGET_TOPOLOGIES
        for entry in load_shard(shard_file(CATALOG_DIRECTORY, topology)).entries
    )
    assert len(final_entries) == 64
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
    assert len(current_by_id) == len(legacy_by_id) == 64
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
        assert proof_flags == tuple(sorted(proof_flags, reverse=True))
        assert final.provenance.generator_version == GENERATOR_VERSION
        assert final.provenance.optimization_version == LOWER_OBJECTIVE_OPTIMIZER_VERSION


def test_issue71_does_not_rewrite_24_or_32_team_shards() -> None:
    guard_untouched_shards(CATALOG_DIRECTORY)
