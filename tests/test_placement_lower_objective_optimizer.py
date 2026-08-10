from __future__ import annotations

from collections.abc import Callable, Mapping
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import pytest
from ortools.sat.python import cp_model
from pydantic import ValidationError

from football_scheduler import day2_schedule
from football_scheduler import placement_lower_objective_optimizer as optimizer
from football_scheduler.day2_schedule import Day2Schedule, Day2ScheduleRequest
from football_scheduler.models import Day2Fallback, SolverStatus
from football_scheduler.placement_template_ab import read_deterministic_gzip
from football_scheduler.placement_template_contract import (
    PLACEMENT_OBJECTIVES,
    PlacementTemplateKey,
)
from football_scheduler.placement_template_generator import (
    StabilizedPlacementTemplateSolver,
    _hydrate_and_validate_entry,
)
from football_scheduler.placement_template_runtime import load_placement_template_catalog

CURRENT_BASELINE = read_deterministic_gzip(
    Path(__file__).resolve().parent
    / "fixtures"
    / "placement-template-ab"
    / "current-pre-optimizer.json.gz"
)
CURRENT_BASELINE_BY_ID = {record.key.catalog_id: record for record in CURRENT_BASELINE.records}


def _template_schedule(
    *,
    pool_count: int = 2,
    pool_size: int,
    court_count: int,
    organizer_capacity: int,
    fallback: Day2Fallback = Day2Fallback.ORGANIZER,
) -> tuple[Day2ScheduleRequest, Day2Schedule]:
    key = PlacementTemplateKey(
        pool_count=pool_count,
        pool_size=pool_size,
        court_count=court_count,
        organizer_capacity=organizer_capacity,
        day2_fallback=fallback,
    )
    if (pool_count, pool_size) in {(2, 4), (2, 8)}:
        entry = CURRENT_BASELINE_BY_ID[key.catalog_id].candidate
        assert entry is not None
    else:
        entry = load_placement_template_catalog().entry_for(key)
    request, schedule = _hydrate_and_validate_entry(entry)
    assert schedule.status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}
    return request, schedule


def _stalled_outcome(
    _request: Day2ScheduleRequest,
    _path_model: object,
    incumbent: Day2Schedule,
    **_kwargs: object,
) -> optimizer._StageOutcome:
    return optimizer._StageOutcome(
        schedule=incumbent,
        status=SolverStatus.UNKNOWN,
        optimality_proven=False,
        proof_method="unproven",
        wall_time_seconds=0,
        model_fingerprint="0" * 64,
    )


def test_objective_vector_reaudits_template_values() -> None:
    request, schedule = _template_schedule(
        pool_size=4,
        court_count=2,
        organizer_capacity=2,
    )

    values = optimizer.placement_objective_vector(request, schedule)
    stage_by_name = {stage.objective: stage.value for stage in schedule.metrics.objective_stages}

    assert values == tuple(stage_by_name[name] for name in PLACEMENT_OBJECTIVES)


def test_analytic_gap_proof_promotes_reused_entry_and_preserves_prefix(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # p2-s8/c2/o2はgap=0だが、#69の再利用時に下位証明を保守的に落としている。
    request, schedule = _template_schedule(
        pool_size=8,
        court_count=2,
        organizer_capacity=2,
    )
    before = optimizer.placement_objective_vector(request, schedule)
    stage_by_name = {stage.objective: stage for stage in schedule.metrics.objective_stages}
    assert before[1:3] == (0, 0)
    assert stage_by_name["non_primary_final_max_gap"].optimality_proven is False
    monkeypatch.setattr(optimizer, "_optimize_section_objective", _stalled_outcome)
    monkeypatch.setattr(optimizer, "_optimize_full_exact_objective", _stalled_outcome)

    result = optimizer.optimize_lower_objectives(request, schedule, max_time_per_stage=0.01)

    assert optimizer.placement_objective_vector(request, result.schedule) == before
    assert result.proven_objectives == PLACEMENT_OBJECTIVES[:3]
    assert [stage.proof_method for stage in result.objectives[:3]] == [
        "existing",
        "analytic_lower_bound",
        "analytic_lower_bound",
    ]
    assert all(not stage.optimality_proven for stage in result.objectives[3:])


def test_unknown_preserves_incumbent_and_does_not_create_proof(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request, schedule = _template_schedule(
        pool_size=4,
        court_count=2,
        organizer_capacity=2,
    )
    before = optimizer.placement_objective_vector(request, schedule)
    assert before[1] > 0
    monkeypatch.setattr(optimizer, "_optimize_section_objective", _stalled_outcome)
    monkeypatch.setattr(optimizer, "_optimize_full_exact_objective", _stalled_outcome)

    result = optimizer.optimize_lower_objectives(request, schedule, max_time_per_stage=0.01)

    assert optimizer.placement_objective_vector(request, result.schedule) == before
    assert result.proven_objectives == ("used_sections",)
    assert result.objectives[1].status is SolverStatus.UNKNOWN
    assert all(not stage.optimality_proven for stage in result.objectives[1:])


@pytest.mark.parametrize(("pool_count", "pool_size"), [(3, 8), (2, 16), (4, 8)])
def test_large_topologies_use_v2_and_keep_max_and_sum_as_separate_stages(
    monkeypatch: pytest.MonkeyPatch,
    pool_count: int,
    pool_size: int,
) -> None:
    request, schedule = _template_schedule(
        pool_count=pool_count,
        pool_size=pool_size,
        court_count=2,
        organizer_capacity=2,
    )
    before = optimizer.placement_objective_vector(request, schedule)
    calls: list[tuple[str, Mapping[str, int], bool]] = []
    progress_lengths: list[int] = []

    def stalled_section(
        request: Day2ScheduleRequest,
        path_model: object,
        incumbent: Day2Schedule,
        **kwargs: object,
    ) -> optimizer._StageOutcome:
        fixed_values = kwargs["fixed_values"]
        assert isinstance(fixed_values, Mapping)
        calls.append(
            (
                str(kwargs["objective"]),
                dict(fixed_values),
                bool(kwargs.get("attempt_global_proof", True)),
            )
        )
        return _stalled_outcome(request, path_model, incumbent, **kwargs)

    monkeypatch.setattr(optimizer, "_optimize_section_objective", stalled_section)
    monkeypatch.setattr(optimizer, "_optimize_full_exact_objective", _stalled_outcome)

    result = optimizer.optimize_lower_objectives(
        request,
        schedule,
        max_time_per_stage=0.01,
        stage_callback=lambda progress: progress_lengths.append(len(progress.objectives)),
    )

    assert result.optimizer_version == optimizer.LARGE_LOWER_OBJECTIVE_OPTIMIZER_VERSION
    assert optimizer.placement_objective_vector(request, result.schedule) == before
    assert calls[0] == (
        "non_primary_final_max_gap",
        {"used_sections": before[0]},
        True,
    )
    if pool_count == 2:
        assert "non_primary_final_sum_gap" not in {call[0] for call in calls}
    else:
        assert calls[1] == (
            "non_primary_final_sum_gap",
            {
                "used_sections": before[0],
                "non_primary_final_max_gap": before[1],
            },
            False,
        )
    assert progress_lengths == [1, 2, 3, 4, 5, 6]
    assert result.proven_objectives == ("used_sections",)


def test_legacy_incumbent_is_retained_when_all_new_stages_are_unknown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request, incumbent = _template_schedule(
        pool_size=4,
        court_count=3,
        organizer_capacity=2,
    )
    path_model = day2_schedule._build_path_model(request.tournament_plan)
    before = optimizer.placement_objective_vector(request, incumbent)
    fixed = optimizer._run_fixed_section_court_stage(
        request,
        path_model,
        incumbent,
        fixed_values=optimizer._prior_fixed_values("team_court_change_count", before),
        objective="team_court_change_count",
        incumbent_value=before[4],
        max_time_seconds=4,
    )
    assert fixed.schedule is not None
    legacy = fixed.schedule
    legacy_values = optimizer.placement_objective_vector(request, legacy)
    assert legacy_values < before
    monkeypatch.setattr(optimizer, "_optimize_section_objective", _stalled_outcome)
    monkeypatch.setattr(optimizer, "_optimize_full_exact_objective", _stalled_outcome)

    result = optimizer.optimize_lower_objectives(
        request,
        incumbent,
        legacy_incumbent=legacy,
        max_time_per_stage=0.01,
    )

    assert optimizer.placement_objective_vector(request, result.schedule) == legacy_values
    assert optimizer.placement_objective_vector(request, result.schedule) < before


def test_stage_progress_can_resume_from_next_unfinished_objective(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request, schedule = _template_schedule(
        pool_count=3,
        pool_size=8,
        court_count=2,
        organizer_capacity=2,
    )
    monkeypatch.setattr(optimizer, "_optimize_section_objective", _stalled_outcome)
    monkeypatch.setattr(optimizer, "_optimize_full_exact_objective", _stalled_outcome)
    first_progress: list[optimizer.LowerObjectiveOptimizationProgress] = []
    optimizer.optimize_lower_objectives(
        request,
        schedule,
        max_time_per_stage=0.01,
        stage_callback=first_progress.append,
    )
    resume = first_progress[2]
    assert tuple(stage.objective for stage in resume.objectives) == PLACEMENT_OBJECTIVES[:3]
    resumed_progress: list[optimizer.LowerObjectiveOptimizationProgress] = []

    result = optimizer.optimize_lower_objectives(
        request,
        schedule,
        resume_from=resume,
        max_time_per_stage=0.01,
        stage_callback=resumed_progress.append,
    )

    assert [len(progress.objectives) for progress in resumed_progress] == [4, 5, 6]
    assert result.objectives[:3] == resume.objectives
    assert result.wall_time_seconds == resume.wall_time_seconds


def test_unproven_prefix_skips_solver_for_later_absolute_lower_bounds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request, schedule = _template_schedule(
        pool_size=4,
        court_count=2,
        organizer_capacity=2,
    )
    values = optimizer.placement_objective_vector(request, schedule)
    assert values[1] > 0
    assert values[3] == 1
    assert values[4] > 0
    assert values[5] == 0
    section_calls: list[str] = []
    section_proof_attempts: list[bool] = []
    full_exact_calls: list[str] = []
    full_exact_proof_attempts: list[bool] = []

    def stalled_section(
        request: Day2ScheduleRequest,
        path_model: object,
        incumbent: Day2Schedule,
        **kwargs: object,
    ) -> optimizer._StageOutcome:
        section_calls.append(str(kwargs["objective"]))
        section_proof_attempts.append(bool(kwargs.get("attempt_global_proof", True)))
        return _stalled_outcome(request, path_model, incumbent, **kwargs)

    def stalled_full_exact(
        request: Day2ScheduleRequest,
        path_model: object,
        incumbent: Day2Schedule,
        **kwargs: object,
    ) -> optimizer._StageOutcome:
        full_exact_calls.append(str(kwargs["objective"]))
        full_exact_proof_attempts.append(bool(kwargs["attempt_global_proof"]))
        return _stalled_outcome(request, path_model, incumbent, **kwargs)

    monkeypatch.setattr(optimizer, "_optimize_section_objective", stalled_section)
    monkeypatch.setattr(optimizer, "_optimize_full_exact_objective", stalled_full_exact)

    result = optimizer.optimize_lower_objectives(request, schedule, max_time_per_stage=0.01)

    assert section_calls == ["non_primary_final_max_gap"]
    assert section_proof_attempts == [True]
    assert full_exact_calls == ["team_court_change_count"]
    assert full_exact_proof_attempts == [False]
    assert result.proven_objectives == ("used_sections",)
    assert result.objectives[3].proof_method == "unproven"
    assert result.objectives[5].proof_method == "unproven"
    assert all(not stage.optimality_proven for stage in result.objectives[1:])


def test_optimizer_rejects_incumbent_with_self_reported_metric_mismatch() -> None:
    request, schedule = _template_schedule(
        pool_size=4,
        court_count=2,
        organizer_capacity=2,
    )
    mutated_stages = tuple(
        stage.model_copy(update={"value": stage.value + 1})
        if stage.objective == "maximum_team_wait_sections"
        else stage
        for stage in schedule.metrics.objective_stages
    )
    corrupted = schedule.model_copy(
        update={"metrics": schedule.metrics.model_copy(update={"objective_stages": mutated_stages})}
    )

    with pytest.raises(optimizer.LowerObjectiveOptimizationError, match="再監査値"):
        optimizer.optimize_lower_objectives(request, corrupted, max_time_per_stage=0.01)


def test_section_relaxation_alone_never_creates_proof(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request, incumbent = _template_schedule(
        pool_size=4,
        court_count=2,
        organizer_capacity=2,
    )
    path_model = day2_schedule._build_path_model(request.tournament_plan)
    incumbent_value = optimizer.placement_objective_vector(request, incumbent)[1]
    assert incumbent.metrics.used_sections is not None

    def no_exact_completion(*_args: object, **_kwargs: object) -> optimizer._ExactOutcome:
        return optimizer._ExactOutcome(
            status=SolverStatus.UNKNOWN,
            optimality_proven=False,
            wall_time_seconds=0,
            model_fingerprint="0" * 64,
        )

    monkeypatch.setattr(optimizer, "_solve_exact_model", no_exact_completion)
    outcome = optimizer._optimize_section_objective(
        request,
        path_model,
        incumbent,
        fixed_values={"used_sections": incumbent.metrics.used_sections},
        objective="non_primary_final_max_gap",
        incumbent_value=incumbent_value,
        max_time_seconds=0.05,
    )

    assert outcome.schedule == incumbent
    assert outcome.optimality_proven is False
    assert outcome.proof_method == "unproven"


def test_max_gap_exact_completion_does_not_force_sum_gap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request, incumbent = _template_schedule(
        pool_count=3,
        pool_size=8,
        court_count=5,
        organizer_capacity=2,
    )
    path_model = day2_schedule._build_path_model(request.tournament_plan)
    values = optimizer.placement_objective_vector(request, incumbent)
    assert values[1] != values[2]
    captured_sum_equalities: list[tuple[int, ...]] = []
    relaxation_models: list[cp_model.CpModel] = []

    def fixed_relaxation(
        *_args: object, **_kwargs: object
    ) -> tuple[cp_model.CpModel, cp_model.IntVar]:
        model = cp_model.CpModel()
        objective = model.new_int_var(values[1], values[1], "fixed_relaxed_max_gap")
        relaxation_models.append(model)
        return model, objective

    def tiny_exact_model(
        *_args: object, **_kwargs: object
    ) -> tuple[cp_model.CpModel, day2_schedule._ModelVariables]:
        model = cp_model.CpModel()
        variables = SimpleNamespace(
            used_sections=model.new_int_var(values[0], values[0], "used_sections"),
            non_primary_final_max_gap=model.new_int_var(0, values[0], "max_gap"),
            non_primary_final_sum_gap=model.new_int_var(0, values[0] * 2, "sum_gap"),
            maximum_wait=model.new_int_var(0, values[0], "maximum_wait"),
            court_change_count=model.new_int_var(0, 100, "court_change_count"),
            court_usage_difference=model.new_int_var(0, 100, "court_usage_difference"),
        )
        return model, cast(day2_schedule._ModelVariables, variables)

    def inspect_completion(
        _request: Day2ScheduleRequest,
        _path_model: day2_schedule._PathModel,
        model: cp_model.CpModel,
        variables: day2_schedule._ModelVariables,
        _max_time_seconds: float,
        *,
        objective: cp_model.IntVar | None,
    ) -> optimizer._ExactOutcome:
        assert objective is None
        sum_index = variables.non_primary_final_sum_gap.index
        for constraint in model.proto.constraints:
            if tuple(constraint.linear.vars) == (sum_index,):
                captured_sum_equalities.append(tuple(constraint.linear.domain))
        return optimizer._ExactOutcome(
            schedule=incumbent,
            status=SolverStatus.OPTIMAL,
            optimality_proven=False,
            wall_time_seconds=0,
            model_fingerprint="4" * 64,
        )

    monkeypatch.setattr(optimizer, "_build_section_relaxation", fixed_relaxation)
    monkeypatch.setattr(optimizer, "_build_exact_model", tiny_exact_model)
    monkeypatch.setattr(optimizer, "_solve_exact_model", inspect_completion)

    outcome = optimizer._optimize_section_objective(
        request,
        path_model,
        incumbent,
        fixed_values={"used_sections": values[0]},
        objective="non_primary_final_max_gap",
        incumbent_value=values[1],
        max_time_seconds=1,
    )

    assert captured_sum_equalities == []
    assert outcome.optimality_proven is True
    assert outcome.proof_method == "section_relaxation_exact_completion"
    assert outcome.model_fingerprint == optimizer._combined_model_fingerprint(
        optimizer._model_fingerprint(relaxation_models[0]), "4" * 64
    )
    assert optimizer.placement_objective_vector(request, outcome.schedule)[1:3] == values[1:3]


def test_section_lower_bound_is_proven_only_after_exact_completion() -> None:
    request, incumbent = _template_schedule(
        pool_size=4,
        court_count=4,
        organizer_capacity=2,
    )
    path_model = day2_schedule._build_path_model(request.tournament_plan)
    values = optimizer.placement_objective_vector(request, incumbent)
    assert values[1:3] == (0, 0)

    outcome = optimizer._optimize_section_objective(
        request,
        path_model,
        incumbent,
        fixed_values={"used_sections": values[0]},
        objective="non_primary_final_max_gap",
        incumbent_value=values[1],
        max_time_seconds=5,
    )

    assert outcome.status is SolverStatus.OPTIMAL
    assert outcome.optimality_proven is True
    assert outcome.proof_method == "section_relaxation_exact_completion"
    assert optimizer.placement_objective_vector(request, outcome.schedule)[1:3] == (0, 0)


def test_small_topology_uses_full_exact_fallback_and_proves_all_objectives(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request, incumbent = _template_schedule(
        pool_size=4,
        court_count=2,
        organizer_capacity=2,
    )
    before = optimizer.placement_objective_vector(request, incumbent)
    fixed_section_calls: list[str] = []
    original_fixed_section = optimizer._run_fixed_section_court_stage

    def tracked_fixed_section(
        request: Day2ScheduleRequest,
        path_model: day2_schedule._PathModel,
        incumbent: Day2Schedule,
        *,
        fixed_values: Mapping[str, int],
        objective: str,
        incumbent_value: int,
        max_time_seconds: float,
    ) -> optimizer._ExactOutcome:
        fixed_section_calls.append(objective)
        return original_fixed_section(
            request,
            path_model,
            incumbent,
            fixed_values=fixed_values,
            objective=objective,
            incumbent_value=incumbent_value,
            max_time_seconds=max_time_seconds,
        )

    monkeypatch.setattr(optimizer, "_run_fixed_section_court_stage", tracked_fixed_section)

    result = optimizer.optimize_lower_objectives(
        request,
        incumbent,
        max_time_per_stage=2,
    )

    after = optimizer.placement_objective_vector(request, result.schedule)
    assert after <= before
    assert result.proven_objectives == PLACEMENT_OBJECTIVES
    assert result.objectives[4].proof_method == "full_exact"
    assert all(stage.optimality_proven for stage in result.objectives)
    assert "team_court_change_count" in fixed_section_calls


def test_fixed_section_candidate_is_retained_without_becoming_global_proof(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request, incumbent = _template_schedule(
        pool_size=4,
        court_count=3,
        organizer_capacity=2,
    )
    path_model = day2_schedule._build_path_model(request.tournament_plan)
    before = optimizer.placement_objective_vector(request, incumbent)
    assert before[4] == 6

    def full_exact_unknown(*_args: object, **_kwargs: object) -> optimizer._ExactOutcome:
        return optimizer._ExactOutcome(
            status=SolverStatus.UNKNOWN,
            optimality_proven=False,
            wall_time_seconds=0,
            model_fingerprint="1" * 64,
        )

    monkeypatch.setattr(optimizer, "_run_full_exact_stage", full_exact_unknown)
    outcome = optimizer._optimize_full_exact_objective(
        request,
        path_model,
        incumbent,
        fixed_values=optimizer._prior_fixed_values("team_court_change_count", before),
        objective="team_court_change_count",
        incumbent_value=before[4],
        max_time_seconds=4,
    )

    after = optimizer.placement_objective_vector(request, outcome.schedule)
    assert after < before
    assert after[4] == 4
    assert outcome.status is SolverStatus.UNKNOWN
    assert outcome.optimality_proven is False
    assert outcome.proof_method == "unproven"
    assert outcome.best_bound is None
    assert outcome.model_fingerprint == "1" * 64


def test_unproven_court_stage_runs_only_fixed_section_candidate_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request, incumbent = _template_schedule(
        pool_size=4,
        court_count=3,
        organizer_capacity=2,
    )
    path_model = day2_schedule._build_path_model(request.tournament_plan)
    before = optimizer.placement_objective_vector(request, incumbent)

    def unexpected_full_exact(*_args: object, **_kwargs: object) -> optimizer._ExactOutcome:
        pytest.fail("前段未証明のコート目的でfull exactを呼んではならない")

    monkeypatch.setattr(optimizer, "_run_full_exact_stage", unexpected_full_exact)
    outcome = optimizer._optimize_full_exact_objective(
        request,
        path_model,
        incumbent,
        fixed_values=optimizer._prior_fixed_values("team_court_change_count", before),
        objective="team_court_change_count",
        incumbent_value=before[4],
        max_time_seconds=4,
        attempt_global_proof=False,
    )

    after = optimizer.placement_objective_vector(request, outcome.schedule)
    assert after < before
    assert after[4] == 4
    assert outcome.status is SolverStatus.FEASIBLE
    assert outcome.optimality_proven is False
    assert outcome.proof_method == "unproven"


def test_unproven_wait_stage_uses_only_quarter_budget_for_candidate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request, incumbent = _template_schedule(
        pool_size=4,
        court_count=3,
        organizer_capacity=2,
    )
    path_model = day2_schedule._build_path_model(request.tournament_plan)
    values = optimizer.placement_objective_vector(request, incumbent)
    assert values[3] > 1
    budgets: list[float] = []

    def candidate_unknown(
        *_args: object,
        **kwargs: object,
    ) -> optimizer._ExactOutcome:
        budget = kwargs["max_time_seconds"]
        assert isinstance(budget, int | float)
        budgets.append(float(budget))
        return optimizer._ExactOutcome(
            status=SolverStatus.UNKNOWN,
            optimality_proven=False,
            wall_time_seconds=0,
            model_fingerprint="2" * 64,
        )

    def unexpected_relaxation(*_args: object, **_kwargs: object) -> None:
        pytest.fail("前段未証明の待ち時間候補でsection緩和を呼んではならない")

    monkeypatch.setattr(optimizer, "_run_full_exact_stage", candidate_unknown)
    monkeypatch.setattr(optimizer, "_build_section_relaxation", unexpected_relaxation)
    outcome = optimizer._optimize_section_objective(
        request,
        path_model,
        incumbent,
        fixed_values={
            "used_sections": values[0],
            "non_primary_final_max_gap": values[1],
            "non_primary_final_sum_gap": values[2],
        },
        objective="maximum_team_wait_sections",
        incumbent_value=values[3],
        max_time_seconds=840,
        attempt_global_proof=False,
    )

    assert budgets == [210]
    assert outcome.schedule == incumbent
    assert outcome.status is SolverStatus.UNKNOWN
    assert outcome.optimality_proven is False
    assert outcome.proof_method == "unproven"


def test_result_contract_rejects_non_prefix_proof() -> None:
    request, schedule = _template_schedule(
        pool_size=4,
        court_count=2,
        organizer_capacity=2,
    )
    values = optimizer.placement_objective_vector(request, schedule)
    stages = tuple(
        optimizer.LowerObjectiveStageResult(
            objective=name,
            value=value,
            status=SolverStatus.OPTIMAL,
            optimality_proven=index in {0, 3},
            proof_method="existing",
            model_fingerprint="0" * 64,
        )
        for index, (name, value) in enumerate(zip(PLACEMENT_OBJECTIVES, values, strict=True))
    )

    with pytest.raises(ValidationError, match="連続prefix"):
        optimizer.LowerObjectiveOptimizationResult(
            schedule=schedule,
            objectives=stages,
            proven_objectives=("used_sections", "maximum_team_wait_sections"),
            wall_time_seconds=0,
        )


@pytest.mark.parametrize(
    ("match_count", "court_count", "expected"),
    [(12, 4, 0), (12, 5, 1), (4, 8, 1), (4, 1, 0)],
)
def test_court_usage_analytic_lower_bound(
    match_count: int,
    court_count: int,
    expected: int,
) -> None:
    assert optimizer._court_usage_lower_bound(match_count, court_count) == expected


def test_optimizer_rejects_out_of_scope_topology() -> None:
    key = PlacementTemplateKey(
        pool_count=3,
        pool_size=8,
        court_count=3,
        organizer_capacity=3,
        day2_fallback=Day2Fallback.ORGANIZER,
    )
    solver = StabilizedPlacementTemplateSolver(max_time_seconds=0.1)
    request = solver._base_request(key)
    request = request.model_copy(
        update={
            "tournament_plan": request.tournament_plan.model_copy(
                update={"pools": request.tournament_plan.pools[:1]}
            )
        }
    )
    check: Callable[[Day2ScheduleRequest], object] = optimizer._validate_supported_topology

    with pytest.raises(ValueError, match="5トポロジー"):
        check(request)
