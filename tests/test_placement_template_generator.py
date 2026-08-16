from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from hashlib import sha256
from pathlib import Path
from shutil import copy2

import pytest

from football_scheduler.models import Day2Fallback, SolverStatus
from football_scheduler.placement_template_ab import read_deterministic_gzip
from football_scheduler.placement_template_contract import (
    PLACEMENT_OBJECTIVES,
    PLACEMENT_RULESET_ID,
    SUPPORTED_PLACEMENT_TOPOLOGIES,
    TEMPLATE_FORMAT_VERSION,
    PlacementTemplateEntry,
    PlacementTemplateKey,
    PlacementTemplateShard,
    PlacementTemplateStatus,
    expected_placement_template_keys,
    placement_entry_digest,
    placement_shard_digest,
)
from football_scheduler.placement_template_generator import (
    LOWER_OBJECTIVE_TARGET_TOPOLOGIES,
    PlacementProblemBounds,
    PlacementSolveAttempt,
    StabilizedPlacementTemplateSolver,
    UnprovenPlacementTemplateError,
    _source_proves_target_primary,
    check_catalog,
    generate_template_entry,
    generate_topology_shard,
    guard_untouched_shards,
    load_shard,
    merge_shards,
    optimization_checkpoint_directory,
    optimization_stage_checkpoint_file,
    optimize_template_entry_lower_objectives,
    reaudit_absolute_lower_bound_proofs,
    shard_file,
    topology_keys,
    validate_catalog_hydration,
    write_json_atomic,
)

CATALOG_ROOT = (
    Path(__file__).resolve().parents[1] / "src" / "football_scheduler" / "placement_templates"
)
CURRENT_BASELINE = read_deterministic_gzip(
    Path(__file__).resolve().parent
    / "fixtures"
    / "placement-template-ab"
    / "current-pre-optimizer.json.gz"
)


def _migrate_reachable_v1_entry(entry: PlacementTemplateEntry) -> PlacementTemplateEntry:
    key = entry.key.model_copy(update={"ruleset_id": PLACEMENT_RULESET_ID})
    migrated = entry.model_copy(
        update={"format_version": TEMPLATE_FORMAT_VERSION, "key": key, "sha256": ""}
    )
    return PlacementTemplateEntry.model_validate(
        migrated.model_copy(update={"sha256": placement_entry_digest(migrated)}).model_dump(
            mode="json"
        )
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


@dataclass(frozen=True)
class _LowerStage:
    objective: str
    value: int
    status: SolverStatus
    optimality_proven: bool
    proof_method: str
    best_bound: float | None
    wall_time_seconds: float
    model_fingerprint: str


@dataclass(frozen=True)
class _LowerResult:
    schedule: object
    objectives: tuple[_LowerStage, ...]
    proven_objectives: tuple[str, ...]
    wall_time_seconds: float


class _KeepIncumbentOptimizer:
    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, request: object, incumbent: object, *, max_time_per_stage: float) -> object:
        del request, max_time_per_stage
        self.calls += 1
        metrics = incumbent.metrics  # type: ignore[attr-defined]
        by_name = {stage.objective: stage for stage in metrics.objective_stages}
        stages = tuple(
            _LowerStage(
                objective=name,
                value=by_name[name].value,
                status=(
                    SolverStatus.OPTIMAL
                    if by_name[name].optimality_proven
                    else SolverStatus.UNKNOWN
                ),
                optimality_proven=by_name[name].optimality_proven,
                proof_method=("existing" if by_name[name].optimality_proven else "unproven"),
                best_bound=float(by_name[name].value),
                wall_time_seconds=0,
                model_fingerprint=sha256(name.encode()).hexdigest(),
            )
            for name in PLACEMENT_OBJECTIVES
        )
        return _LowerResult(
            schedule=incumbent,
            objectives=stages,
            proven_objectives=tuple(stage.objective for stage in stages if stage.optimality_proven),
            wall_time_seconds=0,
        )

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


def test_exact_key_space_is_five_topologies_and_160_independent_keys() -> None:
    keys = expected_placement_template_keys()

    assert len(keys) == 160
    assert len({key.catalog_id for key in keys}) == 160
    assert tuple(dict.fromkeys((key.pool_count, key.pool_size) for key in keys)) == (
        SUPPORTED_PLACEMENT_TOPOLOGIES
    )
    assert all(len(topology_keys(topology)) == 32 for topology in SUPPORTED_PLACEMENT_TOPOLOGIES)
    assert all(key.organizer_capacity == key.court_count for key in keys)


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


def test_catalog_hydration_uses_each_entry_horizon() -> None:
    available = generate_template_entry(
        _key(),
        solver=StabilizedPlacementTemplateSolver(max_time_seconds=30),
    )
    entries = [
        available if key == available.key else _infeasible_entry(key)
        for key in topology_keys((2, 4))
    ]
    shard = PlacementTemplateShard(
        pool_count=2,
        pool_size=4,
        entries=tuple(entries),
    )

    assert validate_catalog_hydration((shard,)) == 1


def test_primary_proof_reuses_only_candidate_at_target_lower_horizon() -> None:
    source = PlacementTemplateKey(
        pool_count=2,
        pool_size=8,
        court_count=2,
        organizer_capacity=2,
        day2_fallback=Day2Fallback.STRICT,
    )
    target = PlacementTemplateKey(
        pool_count=2,
        pool_size=8,
        court_count=3,
        organizer_capacity=3,
        day2_fallback=Day2Fallback.STRICT,
    )

    assert _source_proves_target_primary(source, 7, target, 7) is True
    assert _source_proves_target_primary(source, 8, target, 7) is False


@pytest.mark.parametrize("fallback", tuple(Day2Fallback))
@pytest.mark.parametrize("court_count", (1, 4, 16))
def test_current_bounds_only_accept_court_derived_capacity(
    court_count: int,
    fallback: Day2Fallback,
) -> None:
    key = PlacementTemplateKey(
        pool_count=2,
        pool_size=4,
        court_count=court_count,
        organizer_capacity=court_count,
        day2_fallback=fallback,
    )

    bounds = StabilizedPlacementTemplateSolver(max_time_seconds=30).bounds(key)

    assert 3 <= bounds.lower_horizon <= bounds.upper_horizon


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

    checkpoints = list(
        (tmp_path / ".checkpoints" / "placement-schedule-v2" / "p2-s4").glob("*.json")
    )
    assert len(solver.calls) == 32
    assert len(checkpoints) == 32
    assert resumed.sha256 == first.sha256
    assert resumed.model_dump(mode="json") == first.model_dump(mode="json")


def test_single_aggregator_manifest_and_checks_use_parsed_json_digest(tmp_path: Path) -> None:
    shards = {
        topology: _write_complete_shard(tmp_path, topology)
        for topology in SUPPORTED_PLACEMENT_TOPOLOGIES
    }

    manifest = merge_shards(tmp_path)
    checked = check_catalog(tmp_path)

    assert manifest.total_entry_count == 160
    assert [reference.sha256 for reference in manifest.shards] == [
        shards[topology].sha256 for topology in SUPPORTED_PLACEMENT_TOPOLOGIES
    ]
    assert len(checked) == 5
    assert validate_catalog_hydration(checked) == 0

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
    assert "proven_infeasible: 160" in completed.stdout


def test_absolute_bound_reaudit_promotes_only_a_true_prefix() -> None:
    entry = _migrate_reachable_v1_entry(
        next(
            record.candidate
            for record in CURRENT_BASELINE.records
            if record.candidate is not None
            and record.key.organizer_capacity == record.key.court_count
            and record.key.pool_size == 8
            and tuple(value.value for value in record.candidate.objectives)[1:3] == (0, 0)
            and not record.candidate.objectives[1].optimality_proven
        )
    )

    reaudited = reaudit_absolute_lower_bound_proofs(entry)

    assert tuple(item.optimality_proven for item in reaudited.objectives) == (
        True,
        True,
        True,
        False,
        False,
        False,
    )
    assert reaudited.sha256 == placement_entry_digest(reaudited)


def test_lower_objective_optimization_checkpoints_and_resumes(tmp_path: Path) -> None:
    source = _migrate_reachable_v1_entry(
        next(
            record.candidate
            for record in CURRENT_BASELINE.records
            if record.candidate is not None
            and record.key.organizer_capacity == record.key.court_count
            and record.key.pool_size == 4
        )
    )
    optimizer = _KeepIncumbentOptimizer()

    optimized = optimize_template_entry_lower_objectives(
        source,
        output_directory=tmp_path,
        optimizer=optimizer,  # type: ignore[arg-type]
    )
    resumed = optimize_template_entry_lower_objectives(
        source,
        output_directory=tmp_path,
        resume=True,
        optimizer=lambda *_args, **_kwargs: pytest.fail("resume must not call optimizer"),
    )

    checkpoint_directory = optimization_checkpoint_directory(tmp_path, source.key)
    assert optimizer.calls == 1
    assert optimized.provenance.optimization_version == ("placement-lower-objective-optimizer-v1")
    assert resumed == optimized
    assert all(
        optimization_stage_checkpoint_file(checkpoint_directory, index).exists()
        for index in range(len(PLACEMENT_OBJECTIVES))
    )


def test_untouched_shards_are_guarded_by_raw_and_internal_digest(tmp_path: Path) -> None:
    assert LOWER_OBJECTIVE_TARGET_TOPOLOGIES == ((2, 4), (2, 8))
    for name in (
        "placement-p3-s8.json",
        "placement-p2-s16.json",
        "placement-p4-s8.json",
    ):
        copy2(CATALOG_ROOT / name, tmp_path / name)

    guard_untouched_shards(tmp_path)
    protected = tmp_path / "placement-p3-s8.json"
    protected.write_bytes(protected.read_bytes() + b"\n")

    with pytest.raises(Exception, match="raw SHA-256"):
        guard_untouched_shards(tmp_path)
