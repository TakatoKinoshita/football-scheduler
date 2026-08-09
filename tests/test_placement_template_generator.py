from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from football_scheduler.models import Day2Fallback, SolverStatus
from football_scheduler.placement_template_contract import (
    SUPPORTED_PLACEMENT_TOPOLOGIES,
    PlacementTemplateEntry,
    PlacementTemplateKey,
    PlacementTemplateShard,
    PlacementTemplateStatus,
    expected_placement_template_keys,
    placement_entry_digest,
    placement_shard_digest,
)
from football_scheduler.placement_template_generator import (
    PlacementProblemBounds,
    PlacementSolveAttempt,
    StabilizedPlacementTemplateSolver,
    UnprovenPlacementTemplateError,
    check_catalog,
    generate_template_entry,
    generate_topology_shard,
    load_shard,
    merge_shards,
    shard_file,
    topology_keys,
    write_json_atomic,
)


@dataclass
class _ProvenInfeasibleSolver:
    calls: list[tuple[str, int]] = field(default_factory=list)

    def bounds(self, key: PlacementTemplateKey) -> PlacementProblemBounds:
        return PlacementProblemBounds(1, 1)

    def solve_horizon(self, key: PlacementTemplateKey, horizon: int) -> PlacementSolveAttempt:
        self.calls.append((key.catalog_id, horizon))
        return PlacementSolveAttempt(
            status=SolverStatus.INFEASIBLE,
            optimality_proven=True,
            failure_code="test_proof",
        )


class _MustNotRunSolver:
    def bounds(self, key: PlacementTemplateKey) -> PlacementProblemBounds:
        raise AssertionError(f"resume済みkeyを再計算しました: {key.catalog_id}")

    def solve_horizon(self, key: PlacementTemplateKey, horizon: int) -> PlacementSolveAttempt:
        raise AssertionError(f"resume済みkeyを再計算しました: {key.catalog_id}")


def _key() -> PlacementTemplateKey:
    return PlacementTemplateKey(
        pool_count=2,
        pool_size=4,
        court_count=2,
        organizer_capacity=2,
        day2_fallback=Day2Fallback.ORGANIZER,
    )


def _infeasible_entry(key: PlacementTemplateKey) -> PlacementTemplateEntry:
    entry = PlacementTemplateEntry(
        key=key,
        status=PlacementTemplateStatus.PROVEN_INFEASIBLE,
        provenance={
            "generator_version": "test-v1",
            "python_version": "3.14.2",
            "ortools_version": "9.15.6755",
        },
    )
    return PlacementTemplateEntry.model_validate(
        entry.model_copy(update={"sha256": placement_entry_digest(entry)}).model_dump(mode="json")
    )


def _write_complete_shard(output: Path, topology: tuple[int, int]) -> PlacementTemplateShard:
    shard = PlacementTemplateShard(
        pool_count=topology[0],
        pool_size=topology[1],
        entries=tuple(_infeasible_entry(key) for key in topology_keys(topology)),
    )
    shard = PlacementTemplateShard.model_validate(
        shard.model_copy(update={"sha256": placement_shard_digest(shard)}).model_dump(mode="json")
    )
    write_json_atomic(shard_file(output, topology), shard.model_dump(mode="json"))
    return shard


def test_exact_key_space_is_five_topologies_and_1360_independent_keys() -> None:
    keys = expected_placement_template_keys()

    assert len(keys) == 1360
    assert len({key.catalog_id for key in keys}) == 1360
    assert tuple(dict.fromkeys((key.pool_count, key.pool_size) for key in keys)) == (
        SUPPORTED_PLACEMENT_TOPOLOGIES
    )
    assert all(len(topology_keys(topology)) == 272 for topology in SUPPORTED_PLACEMENT_TOPOLOGIES)


@pytest.mark.parametrize(
    "attempt",
    [
        PlacementSolveAttempt(status=SolverStatus.UNKNOWN, optimality_proven=False),
        PlacementSolveAttempt(
            status=SolverStatus.INFEASIBLE,
            optimality_proven=False,
            failure_code="TOURNAMENT_REFEREE_UNAVAILABLE",
        ),
    ],
)
def test_unknown_or_unproven_failure_is_never_serialized(
    attempt: PlacementSolveAttempt,
) -> None:
    class _Solver:
        def bounds(self, key: PlacementTemplateKey) -> PlacementProblemBounds:
            return PlacementProblemBounds(1, 1)

        def solve_horizon(self, key: PlacementTemplateKey, horizon: int) -> PlacementSolveAttempt:
            return attempt

    with pytest.raises(UnprovenPlacementTemplateError):
        generate_template_entry(_key(), solver=_Solver())


def test_smallest_real_candidate_is_hydrated_and_independently_validated() -> None:
    solver = StabilizedPlacementTemplateSolver(max_time_seconds=30)

    entry = generate_template_entry(_key(), solver=solver)

    assert entry.status is PlacementTemplateStatus.AVAILABLE
    assert entry.used_sections == solver.bounds(_key()).lower_horizon
    assert entry.objectives[0].optimality_proven is True
    assert tuple(objective.objective for objective in entry.objectives) == (
        "used_sections",
        "non_primary_final_max_gap",
        "non_primary_final_sum_gap",
        "maximum_team_wait_sections",
        "team_court_change_count",
        "court_usage_difference",
    )
    assert entry.referee_signature
    assert entry.sha256 == placement_entry_digest(entry)


def test_topology_generation_checkpoints_every_key_and_resume_skips_solver(
    tmp_path: Path,
) -> None:
    solver = _ProvenInfeasibleSolver()

    first = generate_topology_shard((2, 4), tmp_path, solver=solver)
    resumed = generate_topology_shard(
        (2, 4),
        tmp_path,
        resume=True,
        solver=_MustNotRunSolver(),
    )

    checkpoints = list((tmp_path / ".checkpoints" / "p2-s4").glob("*.json"))
    assert len(solver.calls) == 272
    assert len(checkpoints) == 272
    assert resumed.sha256 == first.sha256
    assert resumed.model_dump(mode="json") == first.model_dump(mode="json")


def test_single_aggregator_manifest_and_checks_use_parsed_json_digest(tmp_path: Path) -> None:
    shards = {
        topology: _write_complete_shard(tmp_path, topology)
        for topology in SUPPORTED_PLACEMENT_TOPOLOGIES
    }

    manifest = merge_shards(tmp_path)
    checked = check_catalog(tmp_path)

    assert manifest.total_entry_count == 1360
    assert [reference.sha256 for reference in manifest.shards] == [
        shards[topology].sha256 for topology in SUPPORTED_PLACEMENT_TOPOLOGIES
    ]
    assert len(checked) == 5

    # JSONの空白やkey順はdigest契約に含めず、parse後のcanonical値だけを対象にする。
    path = shard_file(tmp_path, (2, 4))
    parsed = json.loads(path.read_text(encoding="utf-8"))
    path.write_text(json.dumps(parsed, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    assert load_shard(path).sha256 == shards[(2, 4)].sha256
    check_catalog(tmp_path)

    environment = {**os.environ, "PYTHONPATH": "src"}
    completed = subprocess.run(
        [
            sys.executable,
            "scripts/generate_placement_templates.py",
            "--check",
            "--output",
            str(tmp_path),
        ],
        cwd=Path(__file__).resolve().parents[1],
        env=environment,
        check=True,
        capture_output=True,
        text=True,
    )
    assert f"catalog SHA-256: {manifest.catalog_sha256}" in completed.stdout
    assert "available: 0" in completed.stdout
    assert "proven_infeasible: 1360" in completed.stdout
