from __future__ import annotations

from collections.abc import Callable

import pytest
from pydantic import ValidationError

from football_scheduler import day2_schedule
from football_scheduler import placement_lower_objective_optimizer as optimizer
from football_scheduler.day2_schedule import (
    Day2Schedule,
    Day2ScheduleRequest,
    generate_day2_schedule,
)
from football_scheduler.models import Day2Fallback, SolverStatus
from football_scheduler.placement_template_contract import (
    PLACEMENT_OBJECTIVES,
    PlacementTemplateKey,
)
from football_scheduler.placement_template_generator import StabilizedPlacementTemplateSolver
from football_scheduler.placement_template_runtime import load_placement_template_entry


def _template_schedule(
    *,
    pool_size: int,
    court_count: int,
    organizer_capacity: int,
    fallback: Day2Fallback = Day2Fallback.ORGANIZER,
) -> tuple[Day2ScheduleRequest, Day2Schedule]:
    key = PlacementTemplateKey(
        pool_count=2,
        pool_size=pool_size,
        court_count=court_count,
        organizer_capacity=organizer_capacity,
        day2_fallback=fallback,
    )
    solver = StabilizedPlacementTemplateSolver(max_time_seconds=0.1)
    base = solver._base_request(key)
    entry = load_placement_template_entry(key)
    assert entry.used_sections is not None
    request = base.model_copy(
        update={
            "day": base.day.model_copy(update={"max_sections": entry.used_sections}),
        }
    )
    schedule = generate_day2_schedule(request)
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
        max_time_seconds=1,
    )

    assert outcome.status is SolverStatus.OPTIMAL
    assert outcome.optimality_proven is True
    assert outcome.proof_method == "section_relaxation_exact_completion"
    assert optimizer.placement_objective_vector(request, outcome.schedule)[1:3] == (0, 0)


def test_small_topology_uses_full_exact_fallback_and_proves_all_objectives() -> None:
    request, incumbent = _template_schedule(
        pool_size=4,
        court_count=2,
        organizer_capacity=2,
    )
    before = optimizer.placement_objective_vector(request, incumbent)

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
    check: Callable[[Day2ScheduleRequest], None] = optimizer._validate_supported_topology

    with pytest.raises(ValueError, match="2x4または2x8"):
        check(request)
