"""8・16チーム用テンプレートの下位目的をオフラインで再最適化する。

このモジュールはランタイム経路では使用しない。証明済みの最小 horizon と、
独立に再検証できる incumbent を受け取り、辞書式目的を悪化させずに改善する。
section 緩和の下界は、同じ値を厳密モデルで達成できた場合だけ証明として採用する。
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping
from hashlib import sha256
from time import perf_counter
from typing import Annotated, Literal, Self

from ortools.sat.python import cp_model
from pydantic import Field, model_validator

from football_scheduler import day2_schedule
from football_scheduler.day2_schedule import Day2Schedule, Day2ScheduleRequest
from football_scheduler.models import (
    ContractModel,
    Diagnostic,
    ObjectiveStageMetric,
    Slot,
    SolverStatus,
)
from football_scheduler.placement_template_contract import PLACEMENT_OBJECTIVES

LOWER_OBJECTIVE_OPTIMIZER_VERSION: Literal["placement-lower-objective-optimizer-v1"] = (
    "placement-lower-objective-optimizer-v1"
)

ProofMethod = Literal[
    "existing",
    "analytic_lower_bound",
    "section_relaxation_exact_completion",
    "full_exact",
    "unproven",
]


class LowerObjectiveStageResult(ContractModel):
    """1つの目的に対する候補値と証明の監査記録。"""

    objective: str
    value: Annotated[int, Field(ge=0)]
    status: SolverStatus
    optimality_proven: bool
    proof_method: ProofMethod
    best_bound: float | None = None
    wall_time_seconds: Annotated[float, Field(ge=0)] = 0
    model_fingerprint: str

    @model_validator(mode="after")
    def validate_proof(self) -> Self:
        if self.optimality_proven and self.proof_method == "unproven":
            raise ValueError("証明済み目的にunprovenは指定できません")
        if len(self.model_fingerprint) != 64 or any(
            character not in "0123456789abcdef" for character in self.model_fingerprint
        ):
            raise ValueError("model fingerprintは小文字のSHA-256にしてください")
        return self


class LowerObjectiveOptimizationResult(ContractModel):
    """最良の検証済み候補と、連続prefixの証明結果。"""

    optimizer_version: Literal["placement-lower-objective-optimizer-v1"] = (
        LOWER_OBJECTIVE_OPTIMIZER_VERSION
    )
    schedule: Day2Schedule
    objectives: tuple[LowerObjectiveStageResult, ...]
    proven_objectives: tuple[str, ...]
    wall_time_seconds: Annotated[float, Field(ge=0)]

    @model_validator(mode="after")
    def validate_objective_contract(self) -> Self:
        names = tuple(stage.objective for stage in self.objectives)
        if names != PLACEMENT_OBJECTIVES:
            raise ValueError("下位目的の順序がテンプレート契約と一致しません")
        seen_unproven = False
        proven: list[str] = []
        for stage in self.objectives:
            if seen_unproven and stage.optimality_proven:
                raise ValueError("目的の証明フラグは連続prefixにしてください")
            if stage.optimality_proven:
                proven.append(stage.objective)
            else:
                seen_unproven = True
        if tuple(proven) != self.proven_objectives:
            raise ValueError("proven_objectivesが目的別証明と一致しません")
        return self


class LowerObjectiveOptimizationError(RuntimeError):
    """入力候補が再最適化の安全な前提を満たさない。"""


class _ExactOutcome(ContractModel):
    schedule: Day2Schedule | None = None
    status: SolverStatus
    optimality_proven: bool
    objective_value: Annotated[int, Field(ge=0)] | None = None
    best_bound: float | None = None
    wall_time_seconds: Annotated[float, Field(ge=0)]
    model_fingerprint: str


class _StageOutcome(ContractModel):
    schedule: Day2Schedule
    status: SolverStatus
    optimality_proven: bool
    proof_method: ProofMethod
    best_bound: float | None = None
    wall_time_seconds: Annotated[float, Field(ge=0)]
    model_fingerprint: str


def placement_objective_vector(
    request: Day2ScheduleRequest,
    schedule: Day2Schedule,
) -> tuple[int, ...]:
    """配置からテンプレートの6目的をsolver自己申告値に依存せず再集計する。"""

    path_model = day2_schedule._build_path_model(request.tournament_plan)
    return _objective_vector_from_slots(request, path_model, schedule.slots)


def optimize_lower_objectives(
    request: Day2ScheduleRequest,
    incumbent: Day2Schedule,
    *,
    max_time_per_stage: float = 840.0,
) -> LowerObjectiveOptimizationResult:
    """固定最小horizonで下位目的を安全に改善し、証明prefixを返す。

    `UNKNOWN`や厳密復元失敗では、直前までに得た最良の検証済み候補を返す。
    したがって呼出し側は常に返却scheduleをcatalog候補として再監査できる。
    """

    if not 0 < max_time_per_stage <= 840:
        raise ValueError("1目的の探索時間は0秒より大きく840秒以下にしてください")
    _validate_supported_topology(request)
    path_model = day2_schedule._build_path_model(request.tournament_plan)
    current = _normalize_incumbent(request, path_model, incumbent)
    current_values = _objective_vector_from_slots(request, path_model, current.slots)
    horizon = current_values[0]
    if current_values[1] != current_values[2]:
        raise LowerObjectiveOptimizationError("2トーナメントの決勝gap最大値と合計値が一致しません")
    existing_proofs = _existing_proof_prefix(current)
    if not existing_proofs or existing_proofs[0] != "used_sections":
        raise LowerObjectiveOptimizationError("使用セクション数の最小性証明が必要です")

    stages: list[LowerObjectiveStageResult] = [
        LowerObjectiveStageResult(
            objective="used_sections",
            value=horizon,
            status=SolverStatus.OPTIMAL,
            optimality_proven=True,
            proof_method="existing",
            best_bound=float(horizon),
            model_fingerprint=_proof_fingerprint("used_sections", horizon, "existing"),
        )
    ]
    proof_open = True
    total_wall = 0.0

    # 2トーナメントでは非最高順位帯の決勝が1つだけなのでmaxとsumは同じ値。
    gap_value = current_values[1]
    gap_existing = {
        "non_primary_final_max_gap",
        "non_primary_final_sum_gap",
    }.issubset(existing_proofs)
    if proof_open and gap_existing:
        gap_outcome = _existing_outcome(current, gap_value, "non_primary_final_max_gap")
    elif proof_open and gap_value == 0:
        gap_outcome = _analytic_outcome(current, gap_value, "non_primary_final_max_gap")
    else:
        gap_outcome = _optimize_section_objective(
            request,
            path_model,
            current,
            fixed_values={"used_sections": horizon},
            objective="non_primary_final_max_gap",
            incumbent_value=gap_value,
            max_time_seconds=max_time_per_stage,
        )
    current = _select_non_worse(request, path_model, current, gap_outcome.schedule)
    current_values = _objective_vector_from_slots(request, path_model, current.slots)
    total_wall += gap_outcome.wall_time_seconds
    gap_proven = proof_open and gap_outcome.optimality_proven
    for name in ("non_primary_final_max_gap", "non_primary_final_sum_gap"):
        stages.append(
            LowerObjectiveStageResult(
                objective=name,
                value=current_values[1],
                status=gap_outcome.status,
                optimality_proven=gap_proven,
                proof_method=(gap_outcome.proof_method if gap_proven else "unproven"),
                best_bound=gap_outcome.best_bound,
                wall_time_seconds=(
                    gap_outcome.wall_time_seconds if name.endswith("max_gap") else 0
                ),
                model_fingerprint=gap_outcome.model_fingerprint,
            )
        )
    proof_open = gap_proven

    lower_bounds = {
        "maximum_team_wait_sections": 1 if path_model.dependencies else 0,
        "team_court_change_count": 0,
        "court_usage_difference": _court_usage_lower_bound(
            len(path_model.matches), len(request.courts)
        ),
    }
    objective_indexes = {
        "maximum_team_wait_sections": 3,
        "team_court_change_count": 4,
        "court_usage_difference": 5,
    }
    for name in (
        "maximum_team_wait_sections",
        "team_court_change_count",
        "court_usage_difference",
    ):
        current_values = _objective_vector_from_slots(request, path_model, current.slots)
        incumbent_value = current_values[objective_indexes[name]]
        if proof_open and name in existing_proofs:
            outcome = _existing_outcome(current, incumbent_value, name)
        elif proof_open and incumbent_value == lower_bounds[name]:
            outcome = _analytic_outcome(current, incumbent_value, name)
        elif name == "maximum_team_wait_sections":
            outcome = _optimize_section_objective(
                request,
                path_model,
                current,
                fixed_values={
                    "used_sections": horizon,
                    "non_primary_final_max_gap": current_values[1],
                    "non_primary_final_sum_gap": current_values[2],
                },
                objective=name,
                incumbent_value=incumbent_value,
                max_time_seconds=max_time_per_stage,
            )
        else:
            outcome = _optimize_full_exact_objective(
                request,
                path_model,
                current,
                fixed_values=_prior_fixed_values(name, current_values),
                objective=name,
                incumbent_value=incumbent_value,
                max_time_seconds=max_time_per_stage,
            )
        current = _select_non_worse(request, path_model, current, outcome.schedule)
        current_values = _objective_vector_from_slots(request, path_model, current.slots)
        total_wall += outcome.wall_time_seconds
        proven = proof_open and outcome.optimality_proven
        stages.append(
            LowerObjectiveStageResult(
                objective=name,
                value=current_values[objective_indexes[name]],
                status=outcome.status,
                optimality_proven=proven,
                proof_method=(outcome.proof_method if proven else "unproven"),
                best_bound=outcome.best_bound,
                wall_time_seconds=outcome.wall_time_seconds,
                model_fingerprint=outcome.model_fingerprint,
            )
        )
        proof_open = proven

    final_values = _objective_vector_from_slots(request, path_model, current.slots)
    if final_values != tuple(stage.value for stage in stages):
        raise LowerObjectiveOptimizationError("返却候補と目的別監査値が一致しません")
    current = _apply_proof_metrics(current, tuple(stages), total_wall)
    proven_names = tuple(stage.objective for stage in stages if stage.optimality_proven)
    return LowerObjectiveOptimizationResult(
        schedule=current,
        objectives=tuple(stages),
        proven_objectives=proven_names,
        wall_time_seconds=total_wall,
    )


def _optimize_section_objective(
    request: Day2ScheduleRequest,
    path_model: day2_schedule._PathModel,
    incumbent: Day2Schedule,
    *,
    fixed_values: Mapping[str, int],
    objective: str,
    incumbent_value: int,
    max_time_seconds: float,
) -> _StageOutcome:
    started = perf_counter()
    relaxation_budget = max(max_time_seconds * 0.4, 0.001)
    relaxation_model, relaxation_objective = _build_section_relaxation(
        request,
        path_model,
        fixed_values["used_sections"],
        fixed_values=fixed_values,
        objective=objective,
        upper_bound=incumbent_value,
    )
    relaxation_model.minimize(relaxation_objective)
    relaxation_fingerprint = _model_fingerprint(relaxation_model)
    relaxation_solver = day2_schedule._configured_solver(
        relaxation_budget,
        request.random_seed,
    )
    relaxation_status = day2_schedule._status(relaxation_solver.solve(relaxation_model))
    relaxation_wall = relaxation_solver.wall_time
    if relaxation_status is SolverStatus.OPTIMAL:
        relaxed_optimum = relaxation_solver.value(relaxation_objective)
        remaining = max_time_seconds - (perf_counter() - started)
        if remaining > 0.001:
            completion_budget = max(min(remaining, max_time_seconds * 0.25), 0.001)
            completion_model, completion_variables = _build_exact_model(
                request,
                path_model,
                fixed_values["used_sections"],
                fixed_values=fixed_values,
            )
            completion_var = _objective_variable(completion_variables, objective)
            completion_model.add(completion_var == relaxed_optimum)
            if objective == "non_primary_final_max_gap":
                completion_model.add(
                    completion_variables.non_primary_final_sum_gap == relaxed_optimum
                )
            completed = _solve_exact_model(
                request,
                path_model,
                completion_model,
                completion_variables,
                completion_budget,
                objective=None,
            )
            if completed.schedule is not None:
                _assert_audited_objectives(
                    request,
                    path_model,
                    completed.schedule,
                    {
                        **fixed_values,
                        objective: relaxed_optimum,
                        **(
                            {"non_primary_final_sum_gap": relaxed_optimum}
                            if objective == "non_primary_final_max_gap"
                            else {}
                        ),
                    },
                    context="section緩和の厳密復元",
                )
                return _StageOutcome(
                    schedule=completed.schedule,
                    status=SolverStatus.OPTIMAL,
                    optimality_proven=True,
                    proof_method="section_relaxation_exact_completion",
                    best_bound=float(relaxed_optimum),
                    wall_time_seconds=relaxation_wall + completed.wall_time_seconds,
                    model_fingerprint=completed.model_fingerprint,
                )

    elapsed = perf_counter() - started
    remaining = max_time_seconds - elapsed
    if remaining <= 0.001:
        return _StageOutcome(
            schedule=incumbent,
            status=SolverStatus.UNKNOWN,
            optimality_proven=False,
            proof_method="unproven",
            best_bound=(
                relaxation_solver.best_objective_bound
                if relaxation_status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}
                else None
            ),
            wall_time_seconds=relaxation_wall,
            model_fingerprint=relaxation_fingerprint,
        )
    exact = _run_full_exact_stage(
        request,
        path_model,
        fixed_values=fixed_values,
        objective=objective,
        incumbent_value=incumbent_value,
        max_time_seconds=remaining,
    )
    selected = exact.schedule or incumbent
    return _StageOutcome(
        schedule=selected,
        status=exact.status,
        optimality_proven=exact.optimality_proven,
        proof_method=("full_exact" if exact.optimality_proven else "unproven"),
        best_bound=exact.best_bound,
        wall_time_seconds=relaxation_wall + exact.wall_time_seconds,
        model_fingerprint=exact.model_fingerprint,
    )


def _optimize_full_exact_objective(
    request: Day2ScheduleRequest,
    path_model: day2_schedule._PathModel,
    incumbent: Day2Schedule,
    *,
    fixed_values: Mapping[str, int],
    objective: str,
    incumbent_value: int,
    max_time_seconds: float,
) -> _StageOutcome:
    exact = _run_full_exact_stage(
        request,
        path_model,
        fixed_values=fixed_values,
        objective=objective,
        incumbent_value=incumbent_value,
        max_time_seconds=max_time_seconds,
    )
    return _StageOutcome(
        schedule=exact.schedule or incumbent,
        status=exact.status,
        optimality_proven=exact.optimality_proven,
        proof_method=("full_exact" if exact.optimality_proven else "unproven"),
        best_bound=exact.best_bound,
        wall_time_seconds=exact.wall_time_seconds,
        model_fingerprint=exact.model_fingerprint,
    )


def _run_full_exact_stage(
    request: Day2ScheduleRequest,
    path_model: day2_schedule._PathModel,
    *,
    fixed_values: Mapping[str, int],
    objective: str,
    incumbent_value: int,
    max_time_seconds: float,
) -> _ExactOutcome:
    horizon = fixed_values["used_sections"]
    model, variables = _build_exact_model(
        request,
        path_model,
        horizon,
        fixed_values=fixed_values,
    )
    objective_var = _objective_variable(variables, objective)
    model.add(objective_var <= incumbent_value)
    model.minimize(objective_var)
    outcome = _solve_exact_model(
        request,
        path_model,
        model,
        variables,
        max_time_seconds,
        objective=objective_var,
    )
    if outcome.schedule is not None:
        expected = {**fixed_values}
        if outcome.objective_value is None:
            raise LowerObjectiveOptimizationError("厳密探索の目的値がありません")
        expected[objective] = outcome.objective_value
        _assert_audited_objectives(
            request,
            path_model,
            outcome.schedule,
            expected,
            context="full exact探索",
        )
    return outcome


def _build_exact_model(
    request: Day2ScheduleRequest,
    path_model: day2_schedule._PathModel,
    horizon: int,
    *,
    fixed_values: Mapping[str, int],
) -> tuple[cp_model.CpModel, day2_schedule._ModelVariables]:
    model, variables = day2_schedule._build_cp_model(
        request,
        path_model,
        horizon,
        exact_referee_constraints=True,
    )
    model.add(variables.used_sections == horizon)
    for name, value in fixed_values.items():
        if name == "used_sections":
            continue
        model.add(_objective_variable(variables, name) == value)
    return model, variables


def _solve_exact_model(
    request: Day2ScheduleRequest,
    path_model: day2_schedule._PathModel,
    model: cp_model.CpModel,
    variables: day2_schedule._ModelVariables,
    max_time_seconds: float,
    *,
    objective: cp_model.IntVar | None,
) -> _ExactOutcome:
    started = perf_counter()
    total_solver_wall = 0.0
    best_bound: float | None = None
    fingerprint = _model_fingerprint(model)
    while True:
        remaining = max_time_seconds - (perf_counter() - started)
        if remaining <= 0.001:
            return _ExactOutcome(
                status=SolverStatus.UNKNOWN,
                optimality_proven=False,
                best_bound=best_bound,
                wall_time_seconds=total_solver_wall,
                model_fingerprint=fingerprint,
            )
        solver = day2_schedule._configured_solver(remaining, request.random_seed)
        status = day2_schedule._status(solver.solve(model))
        total_solver_wall += solver.wall_time
        best_bound = solver.best_objective_bound if objective is not None else None
        if status not in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}:
            return _ExactOutcome(
                status=status,
                optimality_proven=False,
                best_bound=best_bound,
                wall_time_seconds=total_solver_wall,
                model_fingerprint=fingerprint,
            )
        slots = day2_schedule._extract_slots(request, path_model, variables, solver)
        candidate = day2_schedule._finalize_fixed_horizon_candidate(
            request,
            path_model,
            solver.value(variables.used_sections),
            slots,
            total_solver_wall,
        )
        if candidate is not None:
            return _ExactOutcome(
                schedule=candidate,
                status=status,
                optimality_proven=objective is not None and status is SolverStatus.OPTIMAL,
                objective_value=(solver.value(objective) if objective is not None else None),
                best_bound=best_bound,
                wall_time_seconds=total_solver_wall,
                model_fingerprint=fingerprint,
            )
        selected = [
            variable
            for _coordinate, variable in sorted(variables.placement.items())
            if solver.boolean_value(variable)
        ]
        model.add(sum(selected) <= len(path_model.matches) - 1)
        fingerprint = _model_fingerprint(model)


def _build_section_relaxation(
    request: Day2ScheduleRequest,
    path_model: day2_schedule._PathModel,
    horizon: int,
    *,
    fixed_values: Mapping[str, int],
    objective: str,
    upper_bound: int,
) -> tuple[cp_model.CpModel, cp_model.IntVar]:
    """コート・審判を除いた真の緩和問題を作る。"""

    model = cp_model.CpModel()
    match_count = len(path_model.matches)
    section_number = [
        model.new_int_var(1, horizon, f"relaxed_section_{index}") for index in range(match_count)
    ]
    in_section: dict[tuple[int, int], cp_model.IntVar] = {}
    for match_index, section_var in enumerate(section_number):
        for section in range(1, horizon + 1):
            present = model.new_bool_var(f"relaxed_m{match_index}_s{section}")
            in_section[match_index, section] = present
            model.add(section_var == section).only_enforce_if(present)
            model.add(section_var != section).only_enforce_if(present.negated())
        model.add(sum(in_section[match_index, section] for section in range(1, horizon + 1)) == 1)

    index_by_id = {match.id: index for index, match in enumerate(path_model.matches)}
    dependency_pairs: set[tuple[int, int]] = set()
    for match_id, dependency_ids in sorted(path_model.dependencies.items()):
        target = index_by_id[match_id]
        for dependency_id in sorted(dependency_ids):
            source = index_by_id[dependency_id]
            dependency_pairs.add((min(source, target), max(source, target)))
            model.add(section_number[target] >= section_number[source] + 2)
    for left, right in sorted(path_model.conflict_pairs):
        if (left, right) in dependency_pairs:
            continue
        distance = model.new_int_var(0, horizon - 1, f"relaxed_distance_{left}_{right}")
        model.add_abs_equality(distance, section_number[left] - section_number[right])
        model.add(distance >= 2)

    for section in range(1, horizon + 1):
        count = sum(in_section[index, section] for index in range(match_count))
        model.add(count >= 1)
        model.add(count <= len(request.courts))
        model.add(
            sum(in_section[index, section] for index in path_model.final_indexes)
            <= request.referees.organizer_capacity
        )
    model.add(
        sum(in_section[index, 1] for index in range(match_count))
        <= request.referees.organizer_capacity
    )
    for earlier, later in zip(
        path_model.final_indexes[1:-1],
        path_model.final_indexes[2:],
        strict=True,
    ):
        model.add(section_number[earlier] <= section_number[later])
    model.add(section_number[path_model.primary_final_index] == horizon)

    non_primary_gaps = [horizon - section_number[index] for index in path_model.final_indexes[1:]]
    gap_max = model.new_int_var(0, horizon, "relaxed_final_max_gap")
    gap_sum = model.new_int_var(0, horizon * max(1, len(non_primary_gaps)), "relaxed_final_sum_gap")
    if non_primary_gaps:
        model.add_max_equality(gap_max, non_primary_gaps)
        model.add(gap_sum == sum(non_primary_gaps))
    else:
        model.add(gap_max == 0)
        model.add(gap_sum == 0)
    waits = [
        section_number[index_by_id[target_id]] - section_number[index_by_id[source_id]] - 1
        for target_id, source_ids in sorted(path_model.dependencies.items())
        for source_id in sorted(source_ids)
    ]
    maximum_wait = model.new_int_var(0, horizon, "relaxed_maximum_wait")
    if waits:
        model.add_max_equality(maximum_wait, waits)
    else:
        model.add(maximum_wait == 0)

    variables = {
        "non_primary_final_max_gap": gap_max,
        "non_primary_final_sum_gap": gap_sum,
        "maximum_team_wait_sections": maximum_wait,
    }
    for name, value in fixed_values.items():
        if name in variables:
            model.add(variables[name] == value)
    selected = variables[objective]
    model.add(selected <= upper_bound)
    return model, selected


def _objective_variable(
    variables: day2_schedule._ModelVariables,
    objective: str,
) -> cp_model.IntVar:
    by_name = {
        "used_sections": variables.used_sections,
        "non_primary_final_max_gap": variables.non_primary_final_max_gap,
        "non_primary_final_sum_gap": variables.non_primary_final_sum_gap,
        "maximum_team_wait_sections": variables.maximum_wait,
        "team_court_change_count": variables.court_change_count,
        "court_usage_difference": variables.court_usage_difference,
    }
    try:
        return by_name[objective]
    except KeyError as exc:
        raise ValueError(f"未対応の順位決定トーナメント目的です: {objective}") from exc


def _normalize_incumbent(
    request: Day2ScheduleRequest,
    path_model: day2_schedule._PathModel,
    incumbent: Day2Schedule,
) -> Day2Schedule:
    if incumbent.status not in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}:
        raise LowerObjectiveOptimizationError("incumbentは実行可能日程である必要があります")
    horizon = max(
        (slot.section_no for slot in incumbent.slots if slot.match_id is not None),
        default=0,
    )
    if horizon <= 0:
        raise LowerObjectiveOptimizationError("incumbentに実試合がありません")
    stripped = tuple(
        slot.model_copy(update={"referee_assignment": None}) if slot.match_id is not None else slot
        for slot in incumbent.slots
    )
    normalized = day2_schedule._finalize_fixed_horizon_candidate(
        request,
        path_model,
        horizon,
        stripped,
        0.0,
    )
    if normalized is None:
        raise LowerObjectiveOptimizationError("incumbentを現行の審判規則で再検証できません")
    audited = placement_objective_vector(request, normalized)
    if audited != placement_objective_vector(request, incumbent):
        raise LowerObjectiveOptimizationError("incumbentの再検証で目的値が変化しました")
    stage_by_name = {stage.objective: stage.value for stage in incumbent.metrics.objective_stages}
    if tuple(stage_by_name.get(name) for name in PLACEMENT_OBJECTIVES) != audited:
        raise LowerObjectiveOptimizationError("incumbentの目的値が実配置の再監査値と一致しません")
    return normalized.model_copy(update={"metrics": incumbent.metrics})


def _objective_vector_from_slots(
    request: Day2ScheduleRequest,
    path_model: day2_schedule._PathModel,
    slots: tuple[Slot, ...],
) -> tuple[int, ...]:
    occupied = tuple(slot for slot in slots if slot.match_id is not None)
    positions = {slot.match_id: slot.section_no for slot in occupied}
    courts = {slot.match_id: slot.court_id for slot in occupied}
    if len(positions) != len(path_model.matches) or set(positions) != {
        match.id for match in path_model.matches
    }:
        raise LowerObjectiveOptimizationError("日程が全トーナメント試合を一度ずつ含みません")
    used_sections = max(positions.values())
    gaps = [
        used_sections - positions[path_model.matches[index].id]
        for index in path_model.final_indexes[1:]
    ]
    waits = [
        positions[target_id] - positions[source_id] - 1
        for target_id, source_ids in path_model.dependencies.items()
        for source_id in source_ids
    ]
    court_changes = sum(
        courts[target_id] != courts[source_id]
        for target_id, source_ids in path_model.dependencies.items()
        for source_id in source_ids
    )
    court_counts = Counter(slot.court_id for slot in occupied)
    counts = [court_counts[court.id] for court in request.courts]
    return (
        used_sections,
        max(gaps, default=0),
        sum(gaps),
        max(waits, default=0),
        court_changes,
        max(counts, default=0) - min(counts, default=0),
    )


def _existing_proof_prefix(schedule: Day2Schedule) -> tuple[str, ...]:
    by_name = {stage.objective: stage for stage in schedule.metrics.objective_stages}
    proven: list[str] = []
    for name in PLACEMENT_OBJECTIVES:
        stage = by_name.get(name)
        if stage is None or not stage.optimality_proven:
            break
        proven.append(name)
    return tuple(proven)


def _prior_fixed_values(objective: str, values: tuple[int, ...]) -> dict[str, int]:
    index = PLACEMENT_OBJECTIVES.index(objective)
    return dict(zip(PLACEMENT_OBJECTIVES[:index], values[:index], strict=True))


def _assert_audited_objectives(
    request: Day2ScheduleRequest,
    path_model: day2_schedule._PathModel,
    schedule: Day2Schedule,
    expected: Mapping[str, int],
    *,
    context: str,
) -> None:
    audited = _objective_vector_from_slots(request, path_model, schedule.slots)
    for name, value in expected.items():
        actual = audited[PLACEMENT_OBJECTIVES.index(name)]
        if actual != value:
            raise LowerObjectiveOptimizationError(
                f"{context}の目的値が独立再監査と一致しません: "
                f"{name} (model={value}, audited={actual})"
            )


def _select_non_worse(
    request: Day2ScheduleRequest,
    path_model: day2_schedule._PathModel,
    current: Day2Schedule,
    candidate: Day2Schedule,
) -> Day2Schedule:
    current_values = _objective_vector_from_slots(request, path_model, current.slots)
    candidate_values = _objective_vector_from_slots(request, path_model, candidate.slots)
    return candidate if candidate_values < current_values else current


def _existing_outcome(
    schedule: Day2Schedule,
    value: int,
    objective: str,
) -> _StageOutcome:
    return _StageOutcome(
        schedule=schedule,
        status=SolverStatus.OPTIMAL,
        optimality_proven=True,
        proof_method="existing",
        best_bound=float(value),
        wall_time_seconds=0,
        model_fingerprint=_proof_fingerprint(objective, value, "existing"),
    )


def _analytic_outcome(
    schedule: Day2Schedule,
    value: int,
    objective: str,
) -> _StageOutcome:
    return _StageOutcome(
        schedule=schedule,
        status=SolverStatus.OPTIMAL,
        optimality_proven=True,
        proof_method="analytic_lower_bound",
        best_bound=float(value),
        wall_time_seconds=0,
        model_fingerprint=_proof_fingerprint(objective, value, "analytic_lower_bound"),
    )


def _court_usage_lower_bound(match_count: int, court_count: int) -> int:
    return 0 if match_count % court_count == 0 else 1


def _apply_proof_metrics(
    schedule: Day2Schedule,
    stages: tuple[LowerObjectiveStageResult, ...],
    wall_time_seconds: float,
) -> Day2Schedule:
    proof_by_name = {stage.objective: stage for stage in stages}
    objective_stages = tuple(
        ObjectiveStageMetric(
            objective=stage.objective,
            value=(
                proof_by_name[stage.objective].value
                if stage.objective in proof_by_name
                else stage.value
            ),
            optimality_proven=(
                proof_by_name[stage.objective].optimality_proven
                if stage.objective in proof_by_name
                else stage.optimality_proven
            ),
        )
        for stage in schedule.metrics.objective_stages
    )
    optimized = tuple(stage.objective for stage in objective_stages if stage.optimality_proven)
    all_proven = all(stage.optimality_proven for stage in objective_stages)
    metrics = schedule.metrics.model_copy(
        update={
            "wall_time_seconds": wall_time_seconds,
            "optimized_objectives": optimized,
            "objective_stages": objective_stages,
            "optimality_proven": all_proven,
        }
    )
    diagnostics = tuple(
        diagnostic
        for diagnostic in schedule.diagnostics
        if diagnostic.code != "OPTIMALITY_NOT_PROVEN"
    )
    if not all_proven:
        diagnostics += (
            Diagnostic(
                code="OPTIMALITY_NOT_PROVEN",
                message="実行可能な2日目日程は見つかりましたが、下位の改善目標をすべて証明できませんでした。",
            ),
        )
    return schedule.model_copy(
        update={
            "status": SolverStatus.OPTIMAL if all_proven else SolverStatus.FEASIBLE,
            "metrics": metrics,
            "diagnostics": diagnostics,
        }
    )


def _validate_supported_topology(request: Day2ScheduleRequest) -> None:
    pools = request.tournament_plan.pools
    topology = (
        len(pools),
        pools[0].participant_count if pools else 0,
    )
    if topology not in {(2, 4), (2, 8)} or any(
        pool.participant_count != topology[1] for pool in pools
    ):
        raise ValueError("下位目的の再最適化は2x4または2x8だけを対象にします")


def _model_fingerprint(model: cp_model.CpModel) -> str:
    # OR-Tools 9.15のpybind protoはSerializeToStringを公開しない。変数・制約を
    # 常に安定順で追加しているため、正規化されたtext protoをfingerprintに使う。
    return sha256(str(model.proto).encode("utf-8")).hexdigest()


def _proof_fingerprint(objective: str, value: int, proof_method: str) -> str:
    payload = f"{LOWER_OBJECTIVE_OPTIMIZER_VERSION}:{objective}:{value}:{proof_method}"
    return sha256(payload.encode("utf-8")).hexdigest()


__all__ = [
    "LOWER_OBJECTIVE_OPTIMIZER_VERSION",
    "LowerObjectiveOptimizationError",
    "LowerObjectiveOptimizationResult",
    "LowerObjectiveStageResult",
    "optimize_lower_objectives",
    "placement_objective_vector",
]
