"""順位決定トーナメント日程テンプレートをオフライン生成する。

ランタイム用の探索ではない。各キーを独立に、理論下限から有界 horizon の
実行可能性として解き、未証明の結果を catalog へ混入させない。
"""

from __future__ import annotations

import json
import math
import os
import platform
from collections import Counter
from collections.abc import Callable, Iterable, Mapping, Sequence
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass
from hashlib import sha256
from importlib import import_module
from importlib.metadata import version
from itertools import combinations_with_replacement, pairwise
from pathlib import Path
from typing import Any, Protocol, cast

from ortools.sat.python import cp_model

from football_scheduler import day2_schedule
from football_scheduler.day2_schedule import Day2Schedule, Day2ScheduleRequest
from football_scheduler.league import generate_league_plan
from football_scheduler.models import (
    Day2Fallback,
    RefereeKind,
    Slot,
    SolverStatus,
)
from football_scheduler.placement_template_contract import (
    LARGE_LOWER_OBJECTIVE_OPTIMIZER_VERSION,
    LOWER_OBJECTIVE_OPTIMIZER_VERSION,
    PLACEMENT_OBJECTIVES,
    SUPPORTED_PLACEMENT_TOPOLOGIES,
    CanonicalMatchPosition,
    CanonicalRefereeAssignment,
    OptimizationProofMethod,
    PlacementOptimizationStageCheckpoint,
    PlacementOptimizationTarget,
    PlacementOptimizationTargetManifest,
    PlacementTemplateEntry,
    PlacementTemplateKey,
    PlacementTemplateManifest,
    PlacementTemplateObjective,
    PlacementTemplateProvenance,
    PlacementTemplateShard,
    PlacementTemplateShardReference,
    PlacementTemplateSlot,
    PlacementTemplateStatus,
    expected_placement_template_keys,
    manifest_digest,
    placement_entry_digest,
    placement_optimization_checkpoint_digest,
    placement_referee_signature,
    placement_shard_digest,
)
from football_scheduler.timekeeping import expected_end_time, section_timings
from football_scheduler.tournament import generate_tournament_plan
from football_scheduler.validator import validate_day2_schedule

Topology = tuple[int, int]

GENERATOR_VERSION = "placement-template-generator-v8"
DEFAULT_RANDOM_SEED = 20260803
DEFAULT_MAX_TIME_SECONDS = 840.0
CHECKPOINT_DIRECTORY = ".checkpoints"
MANIFEST_FILE = "manifest.json"
OPTIMIZATION_CHECKPOINT_DIRECTORY = ".optimization-checkpoints"
LOWER_OBJECTIVE_TARGET_TOPOLOGIES: tuple[Topology, ...] = ((2, 4), (2, 8))
LARGE_LOWER_OBJECTIVE_TARGET_TOPOLOGIES: tuple[Topology, ...] = (
    (3, 8),
    (2, 16),
    (4, 8),
)
_ISSUE73_WORKER_TARGET_MANIFEST: PlacementOptimizationTargetManifest | None = None

# An Issue #71 rerun must not rewrite the 24/32-team shards.  Pin the bytes and
# parsed canonical digests finalized by Issue #73, so a future small-topology
# campaign preserves the latest large-topology catalog.
UNTOUCHED_SHARD_DIGESTS: Mapping[Topology, tuple[str, str]] = {
    (3, 8): (
        "a8c425447529b7044fc35f9655d3e678c786ab26320536d5ad5e0dcda726a7f6",
        "ffc05d6de33aee8a336aa26e181c0d1fad5c1e101a82b80d13ce682c5fd2dcfd",
    ),
    (2, 16): (
        "2336584da1bbf68eea8145b9f0654734e3a90a8ed8d560d0d24e36b48a33ecf1",
        "7efcaefb7d4cad6c9ae8c5b695a1cb9b990c480134c676e116ac9ec17e82d02a",
    ),
    (4, 8): (
        "8682c1e8e093799ead83c4c6fa25da3922e0292f4baef948f76d2e10338fa117",
        "cf83b99ecf85d76d7ec3caddfa6b5c4e8283d101163a8f4ed95a8e77c1ade362",
    ),
}

# Issue #73 may only rewrite the 24/32-team shards.  Keep the optimized 8/16-team
# catalog from Issue #71 byte-for-byte and semantically pinned throughout a run.
ISSUE73_UNTOUCHED_SHARD_DIGESTS: Mapping[Topology, tuple[str, str]] = {
    (2, 4): (
        "61dc331b0fb0e96171e9412d61181330bdd0e017c51c150a7ab88f82298e9115",
        "9050f9844ec034b08dffa9acb74b4d45db454168ade33e5b1c28533e18f0bf2c",
    ),
    (2, 8): (
        "3e4f1fedd96bc3cf8fc3b76a7279bacb9ff043105034a9af70fa6267cc1e55cb",
        "1c1e80ede74d3c538a1dd57902f5d22de181a0970b8dbd4ffcf53ddb3ea32055",
    ),
}

ValidationReport = Mapping[str, object]
CandidateValidator = Callable[[object], ValidationReport]


class PlacementTemplateGenerationError(RuntimeError):
    """テンプレート生成を安全に継続できない場合の基底例外。"""


class UnprovenPlacementTemplateError(PlacementTemplateGenerationError):
    """タイムアウトなどにより available/infeasible のどちらも証明できない。"""


class PlacementTemplateIntegrityError(PlacementTemplateGenerationError):
    """checkpoint、shard、manifest または独立検証が不正である。"""


@dataclass(frozen=True, slots=True)
class PlacementProblemBounds:
    """単一キーの有界探索範囲。"""

    lower_horizon: int
    upper_horizon: int

    def __post_init__(self) -> None:
        if self.lower_horizon <= 0 or self.upper_horizon < self.lower_horizon:
            raise ValueError("テンプレート探索範囲が不正です")


@dataclass(frozen=True, slots=True)
class PlacementSolveAttempt:
    """1つの固定上限 horizon に対するソルバー結果。"""

    status: SolverStatus
    optimality_proven: bool
    request: Day2ScheduleRequest | None = None
    schedule: Day2Schedule | None = None
    failure_code: str | None = None

    def __post_init__(self) -> None:
        has_candidate = self.request is not None or self.schedule is not None
        if self.status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}:
            if self.request is None or self.schedule is None:
                raise ValueError("実行可能結果にはrequestとscheduleが必要です")
        elif has_candidate:
            raise ValueError("非実行可能結果にcandidateを指定できません")


class PlacementTemplateSolver(Protocol):
    """テストで小さな偽ソルバーへ差し替え可能な生成境界。"""

    def bounds(self, key: PlacementTemplateKey) -> PlacementProblemBounds: ...

    def solve_horizon(self, key: PlacementTemplateKey, horizon: int) -> PlacementSolveAttempt: ...


class LowerObjectiveStageResultLike(Protocol):
    objective: str
    value: int
    status: SolverStatus
    optimality_proven: bool
    proof_method: OptimizationProofMethod
    best_bound: float | None
    wall_time_seconds: float
    model_fingerprint: str


class LowerObjectiveOptimizationResultLike(Protocol):
    schedule: Day2Schedule
    objectives: tuple[LowerObjectiveStageResultLike, ...]
    proven_objectives: tuple[str, ...]
    wall_time_seconds: float


class LowerObjectiveOptimizer(Protocol):
    def __call__(
        self,
        request: Day2ScheduleRequest,
        incumbent: Day2Schedule,
        *,
        max_time_per_stage: float,
    ) -> LowerObjectiveOptimizationResultLike: ...


@dataclass(frozen=True, slots=True)
class LargeObjectiveOptimizationRequest:
    """Issue #73 optimizerへ渡す、永続化から独立した1 targetの入力。"""

    current_entry: PlacementTemplateEntry
    legacy_incumbent: PlacementTemplateEntry
    target: PlacementOptimizationTarget
    target_manifest_sha256: str
    completed_checkpoints: tuple[PlacementOptimizationStageCheckpoint, ...]
    max_time_per_stage: float


LargeObjectiveCheckpointSink = Callable[[PlacementOptimizationStageCheckpoint], None]


class LargeObjectiveOptimizer(Protocol):
    """目的段階ごとのcheckpointをsinkへ渡すIssue #73 optimizer境界。"""

    def __call__(
        self,
        request: LargeObjectiveOptimizationRequest,
        emit_checkpoint: LargeObjectiveCheckpointSink,
    ) -> PlacementTemplateEntry: ...


class StabilizedPlacementTemplateSolver:
    """安定化済みの非公開2日目ソルバーを固定horizonで呼び出す。"""

    def __init__(self, *, max_time_seconds: float = DEFAULT_MAX_TIME_SECONDS) -> None:
        if not 0 < max_time_seconds <= 840:
            raise ValueError("1回の探索時間は0秒より大きく840秒以下にしてください")
        self._max_time_seconds = max_time_seconds
        self._requests: dict[str, Day2ScheduleRequest] = {}
        self._bounds: dict[str, PlacementProblemBounds] = {}

    def bounds(self, key: PlacementTemplateKey) -> PlacementProblemBounds:
        cached = self._bounds.get(key.catalog_id)
        if cached is not None:
            return cached
        request = self._base_request(key)
        match_count = sum(len(pool.matches) for pool in request.tournament_plan.pools)
        # 第1セクションは主催者能力まで、それ以降はコート数まで配置できる。
        first_section_capacity = min(key.court_count, key.organizer_capacity, match_count)
        slot_bound = 1 + math.ceil(max(0, match_count - first_section_capacity) / key.court_count)
        dependency_depth = key.pool_size.bit_length() - 1
        dependency_bound = dependency_depth * 2 - 1
        court_opening_capacity = 0
        court_opening_bound = 0
        while court_opening_capacity < match_count:
            court_opening_bound += 1
            court_opening_capacity += min(
                key.court_count,
                court_opening_bound * key.organizer_capacity,
            )
        referee_capacity_bound = 0
        if key.day2_fallback is Day2Fallback.STRICT:
            earliest_final_section = max(
                dependency_bound,
                math.ceil((key.pool_size - 2) / key.organizer_capacity) + 2,
            )
            referee_capacity_bound = _strict_referee_capacity_lower_horizon(
                match_count=match_count,
                court_count=key.court_count,
                organizer_capacity=key.organizer_capacity,
                final_count=key.pool_count,
                earliest_final_section=earliest_final_section,
                ancestor_matches_per_final=key.pool_size - 2,
            )
        # active sectionには最低1試合が必要なため、使用section数は試合数を超えない。
        lower_horizon = max(
            slot_bound,
            dependency_bound,
            court_opening_bound,
            referee_capacity_bound,
        )
        path_model = day2_schedule._build_path_model(request.tournament_plan)
        while lower_horizon < match_count:
            status = _section_relaxation_status(
                request,
                path_model,
                lower_horizon,
            )
            if status is not SolverStatus.INFEASIBLE:
                break
            lower_horizon += 1
        # 3x8を6sectionへ詰める境界では、主催者7・9コート以上だけが
        # section緩和を通る一方、終端sectionの安全な審判供給元を
        # 全列挙すると不足する。主催者8以上には6section witnessがある。
        if (
            key.day2_fallback is Day2Fallback.STRICT
            and key.pool_count == 3
            and key.pool_size == 8
            and key.court_count >= 9
            and key.organizer_capacity == 7
        ):
            lower_horizon = max(lower_horizon, 7)
        # organizer主催者2の3x8は、匿名court-chainの全列挙で7sectionが
        # 実行不能である。7section中に開ける理論上限14コートでも同じ
        # 結果なので、それ以上の入力コート数にも適用できる。
        if (
            key.day2_fallback is Day2Fallback.ORGANIZER
            and key.pool_count == 3
            and key.pool_size == 8
            and key.court_count >= 8
            and key.organizer_capacity == 2
        ):
            lower_horizon = max(lower_horizon, 8)
        # 2x16の8sectionでは、連続active制約によりsection 7にも
        # round 4を置く必要がある。その8つのround 1祖先はすべて
        # section 1に必要なので、organizer主催者7以下では実行不能となる。
        if (
            key.day2_fallback is Day2Fallback.ORGANIZER
            and key.pool_count == 2
            and key.pool_size == 16
            and key.organizer_capacity <= 7
        ):
            lower_horizon = max(lower_horizon, 9)
        # 4x8を6sectionへ詰めるorganizer境界は、強制される3ラウンドの
        # 審判frontierを全列挙して確定している。主催者6では14コート、
        # 主催者7では12コートが最初の実行可能構成になる。
        if (
            key.day2_fallback is Day2Fallback.ORGANIZER
            and key.pool_count == 4
            and key.pool_size == 8
            and (
                key.organizer_capacity <= 5
                or (key.organizer_capacity == 6 and key.court_count <= 13)
                or (key.organizer_capacity == 7 and key.court_count <= 11)
            )
        ):
            lower_horizon = max(lower_horizon, 7)
        result = PlacementProblemBounds(
            lower_horizon=lower_horizon,
            upper_horizon=match_count,
        )
        self._bounds[key.catalog_id] = result
        return result

    def solve_horizon(self, key: PlacementTemplateKey, horizon: int) -> PlacementSolveAttempt:
        base = self._base_request(key)
        request = base.model_copy(
            update={
                "day": base.day.model_copy(update={"max_sections": horizon}),
            }
        )
        schedule = day2_schedule._generate_day2_schedule_at_fixed_horizon(request, horizon)
        if schedule.metrics.num_search_workers != 1:
            raise PlacementTemplateIntegrityError(
                f"{key.catalog_id}: CP-SATのnum_search_workersが1ではありません"
            )
        failure_code = schedule.diagnostics[0].code if schedule.diagnostics else None
        if schedule.status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}:
            return PlacementSolveAttempt(
                status=schedule.status,
                optimality_proven=schedule.metrics.optimality_proven,
                request=request,
                schedule=schedule,
            )
        # 算術上のslot不足またはCP-SAT自身のINFEASIBLEだけを証明として扱う。
        proven = schedule.status is SolverStatus.INFEASIBLE and failure_code in {
            "INSUFFICIENT_SLOTS",
            "TOURNAMENT_SCHEDULE_INFEASIBLE",
        }
        return PlacementSolveAttempt(
            status=schedule.status,
            optimality_proven=proven,
            failure_code=failure_code,
        )

    def _base_request(self, key: PlacementTemplateKey) -> Day2ScheduleRequest:
        cached = self._requests.get(key.catalog_id)
        if cached is not None:
            return cached
        team_count = key.pool_count * key.pool_size
        # この構成なら各blockの人数がpool_countとなり、各poolへ同順位を1枠ずつ送る。
        block_count = key.pool_size
        teams = [
            {"id": f"T{index:02d}", "name": f"チーム{index:02d}"}
            for index in range(1, team_count + 1)
        ]
        blocks = [
            {
                "id": f"B{block_index:02d}",
                "team_ids": [
                    f"T{block_index + offset * block_count:02d}" for offset in range(key.pool_count)
                ],
            }
            for block_index in range(1, block_count + 1)
        ]
        league_plan = generate_league_plan(
            {
                "teams": teams,
                "block_count": block_count,
                "assignment_mode": "manual",
                "manual_blocks": blocks,
                "random_seed": DEFAULT_RANDOM_SEED,
            }
        )
        tournament_plan = generate_tournament_plan(
            {
                "request_kind": "tournament_plan",
                "league_plan": league_plan.model_dump(mode="json"),
                "final_stage": {
                    "format": "placement_tournament",
                    "tournament_count": key.pool_count,
                },
                "random_seed": DEFAULT_RANDOM_SEED,
            }
        )
        request = Day2ScheduleRequest.model_validate(
            {
                "request_kind": "day2_schedule",
                "teams": teams,
                "courts": [
                    {"id": f"court-{index:02d}", "name": f"第{index}コート"}
                    for index in range(1, key.court_count + 1)
                ],
                "league_plan": league_plan.model_dump(mode="json"),
                "day1_schedule": {"day": {"id": "day1"}, "slots": []},
                "tournament_plan": tournament_plan.model_dump(mode="json"),
                "day": {
                    "id": "day2",
                    "start_time": "00:00",
                    "game_duration_minutes": 1,
                    "margin_minutes": 0,
                    "max_sections": 1,
                },
                "referees": {
                    "organizer_capacity": key.organizer_capacity,
                    "day2_fallback": key.day2_fallback.value,
                },
                "random_seed": DEFAULT_RANDOM_SEED,
                "solver": {"max_time_seconds": self._max_time_seconds},
            }
        )
        self._requests[key.catalog_id] = request
        return request


def _strict_referee_capacity_lower_horizon(
    *,
    match_count: int,
    court_count: int,
    organizer_capacity: int,
    final_count: int,
    earliest_final_section: int,
    ancestor_matches_per_final: int,
) -> int:
    """strictで各sectionに置ける試合数の楽観上限からhorizon下限を返す。"""

    pool_size = ancestor_matches_per_final + 2
    depth = pool_size.bit_length() - 1
    initial_courts = min(court_count, organizer_capacity)
    useful_openings = min(final_count, max(0, court_count - initial_courts))
    for horizon in range(1, match_count + 1):
        if horizon < earliest_final_section and useful_openings:
            continue
        for opening_sections in combinations_with_replacement(
            range(earliest_final_section, horizon + 1),
            useful_openings,
        ):
            if (
                useful_openings == final_count
                and opening_sections
                and opening_sections[-1] != horizon
            ):
                continue
            if any(
                opening_sections.count(section) > organizer_capacity
                for section in set(opening_sections)
            ):
                continue
            capacity = initial_courts * horizon + sum(
                horizon - opening_section + 1 for opening_section in opening_sections
            )
            if capacity < match_count:
                continue
            deadlines_fit = True
            for section in range(1, horizon + 1):
                required = 0
                for opening_section in opening_sections:
                    if opening_section <= section:
                        required += 1
                    for round_no in range(1, depth):
                        deadline = opening_section - 2 * (depth - round_no)
                        if deadline <= section:
                            required += pool_size // (2**round_no)
                available = initial_courts * section + sum(
                    max(0, section - opening_section + 1) for opening_section in opening_sections
                )
                if required > available:
                    deadlines_fit = False
                    break
            if deadlines_fit:
                return horizon
    return match_count


def _section_relaxation_status(
    request: Day2ScheduleRequest,
    path_model: Any,
    horizon: int,
) -> SolverStatus:
    """コート開設数を含むsection緩和問題を証明用に解く。"""

    model = cp_model.CpModel()
    match_count = len(path_model.matches)
    section_by_match = [
        model.new_int_var(1, horizon, f"relaxed_section_{index}") for index in range(match_count)
    ]
    in_section: dict[tuple[int, int], cp_model.IntVar] = {}
    for match_index, section_var in enumerate(section_by_match):
        for section in range(1, horizon + 1):
            present = model.new_bool_var(f"relaxed_m{match_index}_s{section}")
            in_section[match_index, section] = present
            model.add(section_var == section).only_enforce_if(present)
            model.add(section_var != section).only_enforce_if(present.negated())

    index_by_id = {match.id: index for index, match in enumerate(path_model.matches)}
    for match_id, dependency_ids in sorted(path_model.dependencies.items()):
        target = index_by_id[match_id]
        for dependency_id in sorted(dependency_ids):
            model.add(section_by_match[target] >= section_by_match[index_by_id[dependency_id]] + 2)
    for left, right in sorted(path_model.conflict_pairs):
        distance = model.new_int_var(0, horizon - 1, f"relaxed_gap_{left}_{right}")
        model.add_abs_equality(
            distance,
            section_by_match[left] - section_by_match[right],
        )
        model.add(distance >= 2)

    final_indexes = tuple(path_model.final_indexes)
    for earlier, later in pairwise(final_indexes[1:]):
        model.add(section_by_match[earlier] <= section_by_match[later])
    model.add(section_by_match[path_model.primary_final_index] == horizon)
    for section in range(1, horizon + 1):
        section_count = sum(in_section[match_index, section] for match_index in range(match_count))
        model.add(section_count <= len(request.courts))
        if request.referees.day2_fallback is Day2Fallback.STRICT:
            cumulative_finals = sum(
                in_section[final_index, earlier_section]
                for final_index in final_indexes
                for earlier_section in range(1, section + 1)
            )
            model.add(section_count <= request.referees.organizer_capacity + cumulative_finals)
        else:
            model.add(
                section_count
                <= min(
                    len(request.courts),
                    section * request.referees.organizer_capacity,
                )
            )
        model.add(
            sum(in_section[final_index, section] for final_index in final_indexes)
            <= request.referees.organizer_capacity
        )

    solver = day2_schedule._configured_solver(2.0, request.random_seed)
    return day2_schedule._status(solver.solve(model))


def topology_keys(topology: Topology) -> tuple[PlacementTemplateKey, ...]:
    """正本の1360キーから指定トポロジーの272キーを安定順で返す。"""

    if topology not in SUPPORTED_PLACEMENT_TOPOLOGIES:
        raise ValueError(f"未対応のトポロジーです: {topology[0]}x{topology[1]}")
    keys = tuple(
        key
        for key in expected_placement_template_keys()
        if (key.pool_count, key.pool_size) == topology
    )
    if len(keys) != 272 or len({key.catalog_id for key in keys}) != 272:
        raise PlacementTemplateIntegrityError("トポロジーのキー空間が272件ではありません")
    return keys


def generate_template_entry(
    key: PlacementTemplateKey,
    *,
    solver: PlacementTemplateSolver | None = None,
    validator: CandidateValidator = validate_day2_schedule,
) -> PlacementTemplateEntry:
    """単一キーを独立生成する。UNKNOWNや未証明失敗はcheckpointへ保存しない。"""

    active_solver = solver or StabilizedPlacementTemplateSolver()
    bounds = active_solver.bounds(key)
    for horizon in range(bounds.lower_horizon, bounds.upper_horizon + 1):
        attempt = active_solver.solve_horizon(key, horizon)
        if attempt.status is SolverStatus.UNKNOWN:
            raise UnprovenPlacementTemplateError(
                f"{key.catalog_id}: horizon={horizon}の探索がUNKNOWNで終了しました"
            )
        if attempt.status is SolverStatus.INFEASIBLE:
            if not attempt.optimality_proven:
                detail = f" ({attempt.failure_code})" if attempt.failure_code else ""
                raise UnprovenPlacementTemplateError(
                    f"{key.catalog_id}: horizon={horizon}の実行不能が証明されていません{detail}"
                )
            continue
        if attempt.status not in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}:
            raise UnprovenPlacementTemplateError(
                f"{key.catalog_id}: horizon={horizon}の状態を保存できません: {attempt.status}"
            )
        assert attempt.request is not None and attempt.schedule is not None
        used_sections = attempt.schedule.metrics.used_sections
        if used_sections != horizon:
            raise PlacementTemplateIntegrityError(
                f"{key.catalog_id}: 下限探索と使用セクション数が一致しません "
                f"(horizon={horizon}, used={used_sections})"
            )
        entry = _available_entry(key, attempt.request, attempt.schedule)
        _validate_hydrated_candidate(
            entry,
            attempt.request,
            attempt.schedule,
            validator,
        )
        return _with_entry_digest(entry)

    entry = PlacementTemplateEntry(
        key=key,
        status=PlacementTemplateStatus.PROVEN_INFEASIBLE,
        provenance=current_provenance(),
    )
    return _with_entry_digest(entry)


def generate_topology_shard(
    topology: Topology,
    output_directory: Path,
    *,
    resume: bool = False,
    workers: int = 1,
    max_time_seconds: float = DEFAULT_MAX_TIME_SECONDS,
    solver: PlacementTemplateSolver | None = None,
    validator: CandidateValidator = validate_day2_schedule,
) -> PlacementTemplateShard:
    """272個のkey checkpointを集約し、1つの完全なtopology shardを書く。"""

    if workers < 1:
        raise ValueError("workersは1以上にしてください")
    if solver is not None and workers != 1:
        raise ValueError("差し替えsolverはworkers=1で使用してください")
    keys = topology_keys(topology)
    checkpoint_directory = _checkpoint_directory(output_directory, topology)
    checkpoint_directory.mkdir(parents=True, exist_ok=True)
    entries: dict[str, PlacementTemplateEntry] = {}
    pending: list[PlacementTemplateKey] = []
    for key in keys:
        checkpoint = checkpoint_directory / checkpoint_file_name(key)
        if resume and checkpoint.exists():
            entry = load_entry(checkpoint)
            if entry.key != key:
                raise PlacementTemplateIntegrityError(
                    f"checkpointのキーが一致しません: {checkpoint}"
                )
            if entry.provenance != current_provenance():
                raise PlacementTemplateIntegrityError(
                    f"checkpointのgenerator環境が現在と一致しません: {checkpoint}"
                )
            entries[key.catalog_id] = entry
        else:
            pending.append(key)

    if workers == 1:
        active_solver = solver or StabilizedPlacementTemplateSolver(
            max_time_seconds=max_time_seconds
        )
        ordered_pending = sorted(
            pending,
            key=lambda key: (
                key.court_count,
                key.organizer_capacity,
                0 if key.day2_fallback is Day2Fallback.STRICT else 1,
            ),
        )
        for key in ordered_pending:
            generated_entry = (
                _derive_placement_template_entry(
                    key,
                    entries.values(),
                    solver=active_solver,
                    validator=validator,
                )
                if isinstance(active_solver, StabilizedPlacementTemplateSolver)
                else None
            )
            if generated_entry is None:
                generated_entry = generate_template_entry(
                    key,
                    solver=active_solver,
                    validator=validator,
                )
            write_entry_checkpoint(generated_entry, checkpoint_directory)
            entries[key.catalog_id] = generated_entry
    else:
        payloads = [(key.model_dump(mode="json"), max_time_seconds) for key in pending]
        with ProcessPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(_generate_entry_worker, payload): payload[0] for payload in payloads
            }
            for future in as_completed(futures):
                entry = PlacementTemplateEntry.model_validate(future.result())
                write_entry_checkpoint(entry, checkpoint_directory)
                entries[entry.key.catalog_id] = entry

    ordered_entries = tuple(entries[key.catalog_id] for key in keys)
    shard = PlacementTemplateShard(
        pool_count=topology[0],
        pool_size=topology[1],
        entries=ordered_entries,
    )
    shard = shard.model_copy(update={"sha256": placement_shard_digest(shard)})
    # model_copyはvalidatorを再実行しないため、書込み前に最終契約を再検証する。
    shard = PlacementTemplateShard.model_validate(shard.model_dump(mode="json"))
    write_json_atomic(shard_file(output_directory, topology), shard.model_dump(mode="json"))
    return shard


def merge_shards(output_directory: Path) -> PlacementTemplateManifest:
    """5 shardを安定順に単一プロセスで集約しmanifestを書く。"""

    shards = tuple(
        load_shard(shard_file(output_directory, topology))
        for topology in SUPPORTED_PLACEMENT_TOPOLOGIES
    )
    provenances = {
        (
            entry.provenance.generator_version,
            entry.provenance.python_version,
            entry.provenance.ortools_version,
        )
        for shard in shards
        for entry in shard.entries
    }
    if len(provenances) != 1:
        raise PlacementTemplateIntegrityError(
            "全shardは同一generator・Python・OR-Tools版で生成してください"
        )
    generator_version, python_version, ortools_version = provenances.pop()
    references = tuple(
        PlacementTemplateShardReference(
            pool_count=shard.pool_count,
            pool_size=shard.pool_size,
            file=shard_file(output_directory, (shard.pool_count, shard.pool_size)).name,
            entry_count=len(shard.entries),
            sha256=shard.sha256,
        )
        for shard in shards
    )
    manifest = PlacementTemplateManifest(
        generator_version=generator_version,
        python_version=python_version,
        ortools_version=ortools_version,
        shards=references,
    )
    manifest = manifest.model_copy(update={"catalog_sha256": manifest_digest(manifest)})
    manifest = PlacementTemplateManifest.model_validate(manifest.model_dump(mode="json"))
    write_json_atomic(output_directory / MANIFEST_FILE, manifest.model_dump(mode="json"))
    return manifest


def check_catalog(
    output_directory: Path,
    *,
    topologies: Sequence[Topology] | None = None,
) -> tuple[PlacementTemplateShard, ...]:
    """保存JSONをparsed canonical JSON digestで再検証する。"""

    selected = SUPPORTED_PLACEMENT_TOPOLOGIES if topologies is None else tuple(topologies)
    shards = tuple(load_shard(shard_file(output_directory, topology)) for topology in selected)
    if topologies is not None:
        return shards

    manifest_path = output_directory / MANIFEST_FILE
    manifest = load_manifest(manifest_path)
    by_topology = {(shard.pool_count, shard.pool_size): shard for shard in shards}
    for reference in manifest.shards:
        topology = (reference.pool_count, reference.pool_size)
        shard = by_topology[topology]
        expected_file = shard_file(output_directory, topology).name
        if (
            reference.file != expected_file
            or reference.entry_count != len(shard.entries)
            or reference.sha256 != shard.sha256
        ):
            raise PlacementTemplateIntegrityError(
                f"manifestとshardが一致しません: {reference.file}"
            )
        expected_provenance = {
            (
                entry.provenance.generator_version,
                entry.provenance.python_version,
                entry.provenance.ortools_version,
            )
            for entry in shard.entries
        }
        if expected_provenance != {
            (manifest.generator_version, manifest.python_version, manifest.ortools_version)
        }:
            raise PlacementTemplateIntegrityError(
                f"manifestとentryのprovenanceが一致しません: {reference.file}"
            )
    return shards


def validate_catalog_hydration(
    shards: Sequence[PlacementTemplateShard],
    *,
    validator: CandidateValidator = validate_day2_schedule,
) -> int:
    """全available entryを実planへ復元し、独立validatorで検査する。

    これはcatalog検証専用でありCP-SATを呼ばない。proven_infeasibleは
    配置を持たないことをモデル検証済みなので対象外とする。
    """

    request_factory = StabilizedPlacementTemplateSolver(max_time_seconds=1)
    hydrated_count = 0
    for shard in shards:
        for entry in shard.entries:
            if entry.status is PlacementTemplateStatus.PROVEN_INFEASIBLE:
                continue
            _hydrate_and_validate_entry(
                entry,
                request_factory=request_factory,
                validator=validator,
            )
            hydrated_count += 1
    return hydrated_count


def _hydrate_and_validate_entry(
    entry: PlacementTemplateEntry,
    *,
    request_factory: StabilizedPlacementTemplateSolver | None = None,
    validator: CandidateValidator = validate_day2_schedule,
) -> tuple[Day2ScheduleRequest, Day2Schedule]:
    """単一entryを実planへ復元し、目的値と独立制約を再監査する。"""

    if entry.status is not PlacementTemplateStatus.AVAILABLE or entry.used_sections is None:
        raise PlacementTemplateIntegrityError(
            f"{entry.key.catalog_id}: available entryに使用セクション数がありません"
        )
    factory = request_factory or StabilizedPlacementTemplateSolver(max_time_seconds=1)
    base_request = factory._base_request(entry.key)
    request = base_request.model_copy(
        update={
            "day": base_request.day.model_copy(update={"max_sections": entry.used_sections}),
        }
    )
    path_model = day2_schedule._build_path_model(request.tournament_plan)
    schedule = day2_schedule._generate_day2_schedule_from_template(
        request,
        path_model,
        entry.used_sections,
        entry,
    )
    if schedule.status not in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}:
        raise PlacementTemplateIntegrityError(
            f"{entry.key.catalog_id}: template hydrateが成功しませんでした"
        )
    _validate_hydrated_candidate(entry, request, schedule, validator)
    return request, schedule


def load_entry(path: Path) -> PlacementTemplateEntry:
    """digestを含めcheckpoint entryを検証する。"""

    entry = PlacementTemplateEntry.model_validate(_read_json(path))
    if not entry.sha256 or entry.sha256 != placement_entry_digest(entry):
        raise PlacementTemplateIntegrityError(f"entry digestが一致しません: {path}")
    return entry


def load_shard(path: Path) -> PlacementTemplateShard:
    """entryとshard両方のdigestを検証する。"""

    shard = PlacementTemplateShard.model_validate(_read_json(path))
    if not shard.sha256 or shard.sha256 != placement_shard_digest(shard):
        raise PlacementTemplateIntegrityError(f"shard digestが一致しません: {path}")
    return shard


def load_manifest(path: Path) -> PlacementTemplateManifest:
    """catalog root digestを含めmanifestを検証する。"""

    manifest = PlacementTemplateManifest.model_validate(_read_json(path))
    if not manifest.catalog_sha256 or manifest.catalog_sha256 != manifest_digest(manifest):
        raise PlacementTemplateIntegrityError(f"manifest digestが一致しません: {path}")
    return manifest


def write_entry_checkpoint(entry: PlacementTemplateEntry, directory: Path) -> Path:
    """単一keyをatomicに保存し、再開単位にする。"""

    checked = PlacementTemplateEntry.model_validate(entry.model_dump(mode="json"))
    if not checked.sha256:
        raise PlacementTemplateIntegrityError("digestのないentryはcheckpointへ保存できません")
    path = directory / checkpoint_file_name(checked.key)
    write_json_atomic(path, checked.model_dump(mode="json"))
    return path


def write_json_atomic(path: Path, value: object) -> None:
    """同じdirectory内の一時ファイルから置換し、途中JSONを残さない。"""

    path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(serialized, encoding="utf-8")
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


def shard_file(output_directory: Path, topology: Topology) -> Path:
    return output_directory / f"placement-p{topology[0]}-s{topology[1]}.json"


def checkpoint_file_name(key: PlacementTemplateKey) -> str:
    return (
        f"p{key.pool_count}-s{key.pool_size}-c{key.court_count}-"
        f"o{key.organizer_capacity}-f{key.day2_fallback.value}.json"
    )


def current_provenance() -> PlacementTemplateProvenance:
    return PlacementTemplateProvenance(
        generator_version=GENERATOR_VERSION,
        python_version=platform.python_version(),
        ortools_version=version("ortools"),
    )


def optimizer_provenance() -> PlacementTemplateProvenance:
    """基礎generator版を変えず、下位目的optimizerだけを識別する。"""

    return current_provenance().model_copy(
        update={"optimization_version": LOWER_OBJECTIVE_OPTIMIZER_VERSION}
    )


def large_optimizer_provenance() -> PlacementTemplateProvenance:
    """Issue #73で選択したlegacy/new候補をv2 campaignとして識別する。"""

    return current_provenance().model_copy(
        update={"optimization_version": LARGE_LOWER_OBJECTIVE_OPTIMIZER_VERSION}
    )


def guard_campaign_shards(
    output_directory: Path,
    expected_digests: Mapping[Topology, tuple[str, str]],
) -> None:
    """campaign対象外shardをraw bytesとparsed digestの両方で固定する。"""

    for topology, (expected_raw, expected_internal) in expected_digests.items():
        path = shard_file(output_directory, topology)
        try:
            raw_digest = sha256(path.read_bytes()).hexdigest()
        except OSError as exc:
            raise PlacementTemplateIntegrityError(
                f"対象外shardを読み込めません: {path}: {exc}"
            ) from exc
        if raw_digest != expected_raw:
            raise PlacementTemplateIntegrityError(
                f"対象外shardのraw SHA-256が変更されています: {path.name}"
            )
        if load_shard(path).sha256 != expected_internal:
            raise PlacementTemplateIntegrityError(
                f"対象外shardの内部SHA-256が変更されています: {path.name}"
            )


def guard_untouched_shards(output_directory: Path) -> None:
    """Issue #71対象外の24/32-team shardが一切変わっていないことを検査する。"""

    guard_campaign_shards(output_directory, UNTOUCHED_SHARD_DIGESTS)


def guard_issue73_untouched_shards(output_directory: Path) -> None:
    """Issue #73対象外の8/16-team shardが一切変わっていないことを検査する。"""

    guard_campaign_shards(output_directory, ISSUE73_UNTOUCHED_SHARD_DIGESTS)


def reaudit_absolute_lower_bound_proofs(
    entry: PlacementTemplateEntry,
    *,
    validator: CandidateValidator = validate_day2_schedule,
) -> PlacementTemplateEntry:
    """独立検証済み実値が絶対下限なら、連続prefixの範囲で証明を昇格する。"""

    if entry.status is not PlacementTemplateStatus.AVAILABLE:
        return entry
    _hydrate_and_validate_entry(entry, validator=validator)
    match_count = len(entry.slots)
    court_lower_bound = int(match_count % entry.key.court_count != 0)
    lower_bounds: tuple[int | None, ...] = (
        entry.used_sections,
        0,
        0,
        1,
        0,
        court_lower_bound,
    )
    proof_prefix = True
    changed = False
    objectives: list[PlacementTemplateObjective] = []
    for objective, lower_bound in zip(entry.objectives, lower_bounds, strict=True):
        promoted = proof_prefix and (
            objective.optimality_proven
            or (lower_bound is not None and objective.value == lower_bound)
        )
        changed = changed or promoted != objective.optimality_proven
        objectives.append(objective.model_copy(update={"optimality_proven": promoted}))
        proof_prefix = promoted
    if not changed:
        return entry
    return _with_entry_digest(
        entry.model_copy(update={"objectives": tuple(objectives), "sha256": ""})
    )


def select_best_validated_template_candidate(
    current: PlacementTemplateEntry,
    candidates: Iterable[PlacementTemplateEntry],
    *,
    validator: CandidateValidator = validate_day2_schedule,
) -> PlacementTemplateEntry:
    """current/legacy/new候補を監査し、同値ならcurrentを維持して辞書式最良を返す。"""

    _hydrate_and_validate_entry(current, validator=validator)
    best = current
    current_primary = current.objectives[0].value
    for candidate in candidates:
        if candidate.key != current.key:
            raise PlacementTemplateIntegrityError("比較候補のkeyがcurrentと一致しません")
        _hydrate_and_validate_entry(candidate, validator=validator)
        candidate_primary = candidate.objectives[0].value
        if candidate_primary < current_primary:
            raise PlacementTemplateIntegrityError(
                f"{current.key.catalog_id}: 証明済み最小horizonより短い候補を検出しました"
            )
        if _objective_vector(candidate) < _objective_vector(best):
            best = candidate
    return best


def optimization_checkpoint_directory(
    output_directory: Path,
    key: PlacementTemplateKey,
) -> Path:
    key_name = checkpoint_file_name(key).removesuffix(".json")
    return (
        output_directory
        / OPTIMIZATION_CHECKPOINT_DIRECTORY
        / LOWER_OBJECTIVE_OPTIMIZER_VERSION
        / f"p{key.pool_count}-s{key.pool_size}"
        / key_name
    )


def optimization_stage_checkpoint_file(
    directory: Path,
    stage_index: int,
) -> Path:
    if not 0 <= stage_index < len(PLACEMENT_OBJECTIVES):
        raise ValueError("最適化stage indexが範囲外です")
    return directory / f"{stage_index:02d}-{PLACEMENT_OBJECTIVES[stage_index]}.json"


def write_optimization_stage_checkpoint(
    checkpoint: PlacementOptimizationStageCheckpoint,
    directory: Path,
) -> Path:
    completed = checkpoint.model_copy(
        update={"sha256": placement_optimization_checkpoint_digest(checkpoint)}
    )
    checked = PlacementOptimizationStageCheckpoint.model_validate(completed.model_dump(mode="json"))
    path = optimization_stage_checkpoint_file(directory, checked.stage_index)
    write_json_atomic(path, checked.model_dump(mode="json"))
    return path


def load_optimization_stage_checkpoint(
    path: Path,
) -> PlacementOptimizationStageCheckpoint:
    checkpoint = PlacementOptimizationStageCheckpoint.model_validate(_read_json(path))
    if not checkpoint.sha256 or checkpoint.sha256 != placement_optimization_checkpoint_digest(
        checkpoint
    ):
        raise PlacementTemplateIntegrityError(f"最適化checkpointのdigestが一致しません: {path}")
    return checkpoint


def issue73_optimization_checkpoint_directory(
    output_directory: Path,
    key: PlacementTemplateKey,
) -> Path:
    """Issue #73の疎なtarget専用checkpoint directory。"""

    key_name = checkpoint_file_name(key).removesuffix(".json")
    return (
        output_directory
        / OPTIMIZATION_CHECKPOINT_DIRECTORY
        / LARGE_LOWER_OBJECTIVE_OPTIMIZER_VERSION
        / f"p{key.pool_count}-s{key.pool_size}"
        / key_name
    )


def issue73_optimizer_candidate_file(
    output_directory: Path,
    key: PlacementTemplateKey,
) -> Path:
    """単一aggregatorが読む、target単位の最終候補artifact。"""

    return (
        output_directory
        / ".optimization-candidates"
        / LARGE_LOWER_OBJECTIVE_OPTIMIZER_VERSION
        / f"p{key.pool_count}-s{key.pool_size}"
        / checkpoint_file_name(key)
    )


def load_issue73_optimization_checkpoints(
    directory: Path,
    *,
    key: PlacementTemplateKey,
) -> tuple[PlacementOptimizationStageCheckpoint, ...]:
    """先頭から連続したv2 checkpointだけを再開入力として読み込む。"""

    paths = tuple(
        optimization_stage_checkpoint_file(directory, index)
        for index in range(len(PLACEMENT_OBJECTIVES))
    )
    present = tuple(path.exists() for path in paths)
    if any(present[index] and not all(present[:index]) for index in range(len(present))):
        raise PlacementTemplateIntegrityError("v2 checkpointに途中の欠落があります")
    checkpoints = tuple(
        load_optimization_stage_checkpoint(path)
        for path, exists in zip(paths, present, strict=True)
        if exists
    )
    if any(
        checkpoint.optimization_version != LARGE_LOWER_OBJECTIVE_OPTIMIZER_VERSION
        or checkpoint.key != key
        or checkpoint.stage_index != index
        for index, checkpoint in enumerate(checkpoints)
    ):
        raise PlacementTemplateIntegrityError("v2 checkpointのversion・key・段階が不正です")
    return checkpoints


def optimize_issue73_target_entry(
    *,
    current_entry: PlacementTemplateEntry,
    legacy_incumbent: PlacementTemplateEntry,
    target: PlacementOptimizationTarget,
    target_manifest: PlacementOptimizationTargetManifest,
    output_directory: Path,
    optimizer: LargeObjectiveOptimizer,
    resume: bool = False,
    max_time_per_stage: float = 60.0,
    validator: CandidateValidator = validate_day2_schedule,
) -> PlacementTemplateEntry:
    """1 targetをadapterで処理し、各stageと最終候補をatomicに保存する。"""

    if not 0 < max_time_per_stage <= 840:
        raise ValueError("1段階の探索時間は0秒より大きく840秒以下にしてください")
    if not target_manifest.sha256:
        raise PlacementTemplateIntegrityError("target manifestにSHA-256がありません")
    if target not in target_manifest.targets:
        raise PlacementTemplateIntegrityError("targetがmanifestに含まれていません")
    if (
        current_entry.key != target.key
        or legacy_incumbent.key != target.key
        or current_entry.sha256 != target.current_entry_sha256
        or legacy_incumbent.sha256 != target.legacy_entry_sha256
        or _objective_vector(current_entry) != target.current_objectives
        or _objective_vector(legacy_incumbent) != target.legacy_objectives
    ):
        raise PlacementTemplateIntegrityError("targetとcurrent/legacy incumbentが一致しません")
    _hydrate_and_validate_entry(current_entry, validator=validator)
    _hydrate_and_validate_entry(legacy_incumbent, validator=validator)

    checkpoint_directory = issue73_optimization_checkpoint_directory(output_directory, target.key)
    completed = (
        load_issue73_optimization_checkpoints(checkpoint_directory, key=target.key)
        if resume
        else ()
    )
    for checkpoint in completed:
        _validate_issue73_checkpoint(
            checkpoint,
            current_entry=current_entry,
            legacy_incumbent=legacy_incumbent,
            target_manifest_sha256=target_manifest.sha256,
        )
    candidate_path = issue73_optimizer_candidate_file(output_directory, target.key)
    if len(completed) == len(PLACEMENT_OBJECTIVES):
        checkpoint_candidate = completed[-1].candidate
        if candidate_path.exists():
            resumed = load_entry(candidate_path)
            if resumed.sha256 != checkpoint_candidate.sha256:
                raise PlacementTemplateIntegrityError(
                    "v2最終候補と最後のcheckpoint candidateが一致しません"
                )
            return resumed
        _hydrate_and_validate_entry(checkpoint_candidate, validator=validator)
        write_entry_checkpoint(checkpoint_candidate, candidate_path.parent)
        restored_path = candidate_path.parent / checkpoint_file_name(checkpoint_candidate.key)
        if restored_path != candidate_path:
            raise PlacementTemplateIntegrityError("v2 optimizer候補の復元先が一致しません")
        return checkpoint_candidate

    emitted = list(completed)

    def emit_checkpoint(checkpoint: PlacementOptimizationStageCheckpoint) -> None:
        expected_index = len(emitted)
        if expected_index >= len(PLACEMENT_OBJECTIVES):
            raise PlacementTemplateIntegrityError("v2 optimizerが余分なstageを出力しました")
        _validate_issue73_checkpoint(
            checkpoint,
            current_entry=current_entry,
            legacy_incumbent=legacy_incumbent,
            target_manifest_sha256=target_manifest.sha256,
        )
        if checkpoint.stage_index != expected_index:
            raise PlacementTemplateIntegrityError("v2 optimizerのstage出力が連続していません")
        write_optimization_stage_checkpoint(checkpoint, checkpoint_directory)
        emitted.append(checkpoint)

    request = LargeObjectiveOptimizationRequest(
        current_entry=current_entry,
        legacy_incumbent=legacy_incumbent,
        target=target,
        target_manifest_sha256=target_manifest.sha256,
        completed_checkpoints=completed,
        max_time_per_stage=max_time_per_stage,
    )
    candidate = optimizer(request, emit_checkpoint)
    if len(emitted) != len(PLACEMENT_OBJECTIVES):
        raise PlacementTemplateIntegrityError("v2 optimizerのtarget x 6 stage coverageが不正です")
    if (
        candidate.key != target.key
        or candidate.sha256 != emitted[-1].candidate.sha256
        or candidate.provenance.optimization_version != LARGE_LOWER_OBJECTIVE_OPTIMIZER_VERSION
    ):
        raise PlacementTemplateIntegrityError(
            "v2 optimizer最終候補のkey・SHA・provenanceが不正です"
        )
    _hydrate_and_validate_entry(candidate, validator=validator)
    if (
        _objective_vector(candidate) > target.current_objectives
        or _objective_vector(candidate) > target.legacy_objectives
    ):
        raise PlacementTemplateIntegrityError("v2 optimizer最終候補が品質floorより悪化しました")
    write_entry_checkpoint(candidate, candidate_path.parent)
    written_path = candidate_path.parent / checkpoint_file_name(candidate.key)
    if written_path != candidate_path:
        raise PlacementTemplateIntegrityError("v2 optimizer候補の保存先が一致しません")
    return candidate


def optimize_issue73_targets(
    target_manifest: PlacementOptimizationTargetManifest,
    current_entries: Mapping[str, PlacementTemplateEntry],
    legacy_entries: Mapping[str, PlacementTemplateEntry],
    output_directory: Path,
    *,
    resume: bool = False,
    workers: int = 1,
    max_time_per_stage: float = 60.0,
    optimizer: LargeObjectiveOptimizer | None = None,
    validator: CandidateValidator = validate_day2_schedule,
) -> dict[str, PlacementTemplateEntry]:
    """manifestの疎なtargetだけを最適化し、shardを書かずにcandidateを返す。"""

    if workers < 1:
        raise ValueError("workersは1以上にしてください")
    if optimizer is not None and workers != 1:
        raise ValueError("差し替えIssue #73 optimizerはworkers=1で使用してください")
    target_ids = {target.key.catalog_id for target in target_manifest.targets}
    if set(current_entries) != target_ids or set(legacy_entries) != target_ids:
        raise PlacementTemplateIntegrityError(
            "Issue #73 optimizer入力の疎target coverageが不正です"
        )
    if workers == 1:
        active_optimizer = optimizer or _default_large_objective_optimizer()
        results = {
            target.key.catalog_id: optimize_issue73_target_entry(
                current_entry=current_entries[target.key.catalog_id],
                legacy_incumbent=legacy_entries[target.key.catalog_id],
                target=target,
                target_manifest=target_manifest,
                output_directory=output_directory,
                optimizer=active_optimizer,
                resume=resume,
                max_time_per_stage=max_time_per_stage,
                validator=validator,
            )
            for target in target_manifest.targets
        }
    else:
        payloads = tuple(
            (
                current_entries[target.key.catalog_id].model_dump(mode="json"),
                legacy_entries[target.key.catalog_id].model_dump(mode="json"),
                target.model_dump(mode="json"),
                str(output_directory),
                resume,
                max_time_per_stage,
            )
            for target in target_manifest.targets
        )
        results = {}
        with ProcessPoolExecutor(
            max_workers=workers,
            initializer=_initialize_issue73_worker,
            initargs=(target_manifest.model_dump(mode="json"),),
        ) as executor:
            futures = {
                executor.submit(_optimize_issue73_entry_worker, payload): payload[2]
                for payload in payloads
            }
            for future in as_completed(futures):
                entry = PlacementTemplateEntry.model_validate(future.result())
                results[entry.key.catalog_id] = entry
    if set(results) != target_ids:
        raise PlacementTemplateIntegrityError(
            "Issue #73 optimizer出力の疎target coverageが不正です"
        )
    return results


def _validate_issue73_checkpoint(
    checkpoint: PlacementOptimizationStageCheckpoint,
    *,
    current_entry: PlacementTemplateEntry,
    legacy_incumbent: PlacementTemplateEntry,
    target_manifest_sha256: str,
) -> None:
    if (
        checkpoint.optimization_version != LARGE_LOWER_OBJECTIVE_OPTIMIZER_VERSION
        or checkpoint.key != current_entry.key
        or checkpoint.input_entry_sha256 != current_entry.sha256
        or checkpoint.current_entry_sha256 != current_entry.sha256
        or checkpoint.legacy_incumbent_sha256 != legacy_incumbent.sha256
        or checkpoint.target_manifest_sha256 != target_manifest_sha256
    ):
        raise PlacementTemplateIntegrityError("v2 checkpointのcampaign SHA契約が一致しません")
    if checkpoint.candidate.provenance.optimization_version != (
        LARGE_LOWER_OBJECTIVE_OPTIMIZER_VERSION
    ):
        raise PlacementTemplateIntegrityError("v2 checkpoint candidateのprovenanceが不正です")


def _default_large_objective_optimizer() -> LargeObjectiveOptimizer:
    try:
        module = import_module("football_scheduler.placement_lower_objective_optimizer")
        native_optimizer = module.optimize_lower_objectives
        progress_model = module.LowerObjectiveOptimizationProgress
        stage_model = module.LowerObjectiveStageResult
    except (AttributeError, ImportError) as exc:
        raise PlacementTemplateGenerationError(
            "Issue #73 optimizer adapterを読み込めません。optimizer-v2実装を統合してください"
        ) from exc

    def adapter(
        request: LargeObjectiveOptimizationRequest,
        emit_checkpoint: LargeObjectiveCheckpointSink,
    ) -> PlacementTemplateEntry:
        current_request, current_schedule = _hydrate_and_validate_entry(request.current_entry)
        legacy_request, legacy_schedule = _hydrate_and_validate_entry(request.legacy_incumbent)
        if current_request != legacy_request:
            raise PlacementTemplateIntegrityError(
                "Issue #73 current/legacyのhydrate requestが一致しません"
            )
        resume_from = None
        if request.completed_checkpoints:
            latest = request.completed_checkpoints[-1]
            _resume_request, resume_schedule = _hydrate_and_validate_entry(latest.candidate)
            stage_fields = stage_model.model_fields
            stages = []
            for checkpoint in request.completed_checkpoints:
                values: dict[str, object] = {
                    "objective": checkpoint.objective,
                    "value": checkpoint.value,
                    "status": checkpoint.status,
                    "optimality_proven": checkpoint.optimality_proven,
                    "proof_method": checkpoint.proof_method,
                    "best_bound": checkpoint.best_bound,
                    "wall_time_seconds": checkpoint.wall_time_seconds,
                    "model_fingerprint": checkpoint.model_fingerprint,
                }
                if "termination_reason" in stage_fields:
                    values["termination_reason"] = checkpoint.termination_reason
                stages.append(stage_model(**values))
            resume_from = progress_model(
                optimizer_version=LARGE_LOWER_OBJECTIVE_OPTIMIZER_VERSION,
                schedule=resume_schedule,
                objectives=tuple(stages),
                proven_objectives=tuple(
                    stage.objective for stage in stages if stage.optimality_proven
                ),
                wall_time_seconds=sum(stage.wall_time_seconds for stage in stages),
            )

        latest_candidate: PlacementTemplateEntry | None = None

        def stage_callback(progress: object) -> None:
            nonlocal latest_candidate
            progress_stages = tuple(progress.objectives)  # type: ignore[attr-defined]
            if not progress_stages:
                raise PlacementTemplateIntegrityError("optimizer-v2 progressに目的段階がありません")
            schedule_entry = _available_entry(
                request.current_entry.key,
                current_request,
                progress.schedule,  # type: ignore[attr-defined]
            )
            proof_by_name = {stage.objective: stage.optimality_proven for stage in progress_stages}
            candidate = _with_entry_digest(
                schedule_entry.model_copy(
                    update={
                        "objectives": tuple(
                            objective.model_copy(
                                update={
                                    "optimality_proven": proof_by_name.get(
                                        objective.objective, False
                                    )
                                }
                            )
                            for objective in schedule_entry.objectives
                        ),
                        "provenance": large_optimizer_provenance(),
                        "sha256": "",
                    }
                )
            )
            stage = progress_stages[-1]
            stage_index = len(progress_stages) - 1
            checkpoint = PlacementOptimizationStageCheckpoint(
                optimization_version=LARGE_LOWER_OBJECTIVE_OPTIMIZER_VERSION,
                key=request.current_entry.key,
                stage_index=stage_index,
                objective=stage.objective,
                input_entry_sha256=request.current_entry.sha256,
                candidate=candidate,
                status=stage.status,
                value=stage.value,
                optimality_proven=stage.optimality_proven,
                proof_method=stage.proof_method,
                best_bound=stage.best_bound,
                wall_time_seconds=stage.wall_time_seconds,
                model_fingerprint=stage.model_fingerprint,
                current_entry_sha256=request.current_entry.sha256,
                legacy_incumbent_sha256=request.legacy_incumbent.sha256,
                target_manifest_sha256=request.target_manifest_sha256,
                fixed_objectives=candidate.objectives[:stage_index],
                termination_reason=getattr(stage, "termination_reason", None),
            )
            emit_checkpoint(checkpoint)
            latest_candidate = candidate

        native_optimizer(
            current_request,
            current_schedule,
            legacy_incumbent=legacy_schedule,
            resume_from=resume_from,
            stage_callback=stage_callback,
            max_time_per_stage=request.max_time_per_stage,
        )
        if latest_candidate is None:
            raise PlacementTemplateIntegrityError("optimizer-v2が新しいstageを出力しませんでした")
        return latest_candidate

    return adapter


def _optimize_issue73_entry_worker(
    payload: tuple[
        dict[str, Any],
        dict[str, Any],
        dict[str, Any],
        str,
        bool,
        float,
    ],
) -> dict[str, Any]:
    (
        current_data,
        legacy_data,
        target_data,
        output_directory,
        resume,
        max_time_per_stage,
    ) = payload
    if _ISSUE73_WORKER_TARGET_MANIFEST is None:
        raise PlacementTemplateIntegrityError("Issue #73 worker manifestが初期化されていません")
    result = optimize_issue73_target_entry(
        current_entry=PlacementTemplateEntry.model_validate(current_data),
        legacy_incumbent=PlacementTemplateEntry.model_validate(legacy_data),
        target=PlacementOptimizationTarget.model_validate(target_data),
        target_manifest=_ISSUE73_WORKER_TARGET_MANIFEST,
        output_directory=Path(output_directory),
        optimizer=_default_large_objective_optimizer(),
        resume=resume,
        max_time_per_stage=max_time_per_stage,
    )
    return result.model_dump(mode="json")


def _initialize_issue73_worker(manifest_data: dict[str, Any]) -> None:
    """target manifestをworkerごとに1回だけ復元し、targetごとの複製を避ける。"""

    global _ISSUE73_WORKER_TARGET_MANIFEST
    _ISSUE73_WORKER_TARGET_MANIFEST = PlacementOptimizationTargetManifest.model_validate(
        manifest_data
    )


def _load_resumable_optimization_candidate(
    source: PlacementTemplateEntry,
    directory: Path,
) -> PlacementTemplateEntry | None:
    paths = tuple(
        optimization_stage_checkpoint_file(directory, index)
        for index in range(len(PLACEMENT_OBJECTIVES))
    )
    if not any(path.exists() for path in paths):
        return None
    if not all(path.exists() for path in paths):
        return None
    checkpoints = tuple(load_optimization_stage_checkpoint(path) for path in paths)
    if any(checkpoint.key != source.key for checkpoint in checkpoints):
        raise PlacementTemplateIntegrityError("最適化checkpointのkeyが一致しません")
    if any(checkpoint.input_entry_sha256 != source.sha256 for checkpoint in checkpoints):
        raise PlacementTemplateIntegrityError("最適化checkpointの入力entryが一致しません")
    candidate_digests = {checkpoint.candidate.sha256 for checkpoint in checkpoints}
    if len(candidate_digests) != 1:
        raise PlacementTemplateIntegrityError("最適化checkpointのcandidateが一致しません")
    return checkpoints[-1].candidate


def _available_entry(
    key: PlacementTemplateKey,
    request: Day2ScheduleRequest,
    schedule: Day2Schedule,
) -> PlacementTemplateEntry:
    if schedule.status not in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}:
        raise PlacementTemplateIntegrityError("実行可能でないscheduleをentryへ変換できません")
    used_sections = schedule.metrics.used_sections
    if used_sections is None or used_sections <= 0:
        raise PlacementTemplateIntegrityError("scheduleの使用セクション数がありません")
    position_by_match = _canonical_positions(request)
    court_index = {court.id: index for index, court in enumerate(request.courts)}
    occupied = tuple(slot for slot in schedule.slots if slot.match_id is not None)
    if len(occupied) != len(position_by_match):
        raise PlacementTemplateIntegrityError("scheduleの配置試合数がトーナメント表と一致しません")
    slots = tuple(
        sorted(
            (
                PlacementTemplateSlot(
                    section_no=slot.section_no,
                    court_index=court_index[slot.court_id],
                    match_position=position_by_match[_match_id(slot)],
                )
                for slot in occupied
            ),
            key=_slot_sort_key,
        )
    )
    assignments = _canonical_referee_assignments(occupied, position_by_match)
    stage_by_name = {stage.objective: stage for stage in schedule.metrics.objective_stages}
    objectives: list[PlacementTemplateObjective] = []
    proof_prefix = True
    for index, objective in enumerate(PLACEMENT_OBJECTIVES):
        stage = stage_by_name.get(objective)
        if stage is None:
            raise PlacementTemplateIntegrityError(f"目的値がありません: {objective}")
        requested_proof = True if index == 0 else stage.optimality_proven
        proven = proof_prefix and requested_proof
        objectives.append(
            PlacementTemplateObjective(
                objective=objective,
                value=stage.value,
                optimality_proven=proven,
            )
        )
        proof_prefix = proof_prefix and requested_proof
    return PlacementTemplateEntry(
        key=key,
        status=PlacementTemplateStatus.AVAILABLE,
        used_sections=used_sections,
        slots=slots,
        objectives=tuple(objectives),
        referee_signature=placement_referee_signature(assignments),
        provenance=current_provenance(),
    )


def optimize_template_entry_lower_objectives(
    source: PlacementTemplateEntry,
    *,
    output_directory: Path,
    resume: bool = False,
    max_time_per_stage: float = DEFAULT_MAX_TIME_SECONDS,
    optimizer: LowerObjectiveOptimizer | None = None,
    validator: CandidateValidator = validate_day2_schedule,
) -> PlacementTemplateEntry:
    """検証済みentryを固定horizonで再最適化し、段階checkpointを保存する。"""

    if not 0 < max_time_per_stage <= 840:
        raise ValueError("1段階の探索時間は0秒より大きく840秒以下にしてください")
    if source.status is not PlacementTemplateStatus.AVAILABLE:
        return source
    if not source.sha256:
        raise PlacementTemplateIntegrityError("最適化元entryにSHA-256がありません")
    if source.provenance.optimization_version == LOWER_OBJECTIVE_OPTIMIZER_VERSION:
        _hydrate_and_validate_entry(source, validator=validator)
        return source

    checkpoint_directory = optimization_checkpoint_directory(output_directory, source.key)
    if resume:
        resumed = _load_resumable_optimization_candidate(source, checkpoint_directory)
        if resumed is not None:
            _hydrate_and_validate_entry(resumed, validator=validator)
            if _objective_vector(resumed) > _objective_vector(source):
                raise PlacementTemplateIntegrityError(
                    f"{source.key.catalog_id}: resume候補が元entryより悪化しています"
                )
            return resumed

    request, incumbent_schedule = _hydrate_and_validate_entry(source, validator=validator)
    reaudited_source = reaudit_absolute_lower_bound_proofs(source, validator=validator)
    active_optimizer = optimizer or _default_lower_objective_optimizer()
    result = active_optimizer(
        request,
        incumbent_schedule,
        max_time_per_stage=max_time_per_stage,
    )
    stages = tuple(result.objectives)
    if tuple(stage.objective for stage in stages) != PLACEMENT_OBJECTIVES:
        raise PlacementTemplateIntegrityError("optimizerの目的順が規則と一致しません")
    result_proven = tuple(stage.objective for stage in stages if stage.optimality_proven)
    if result_proven != tuple(result.proven_objectives):
        raise PlacementTemplateIntegrityError("optimizerの証明prefix情報が一致しません")
    if result_proven != PLACEMENT_OBJECTIVES[: len(result_proven)]:
        raise PlacementTemplateIntegrityError("optimizerの証明はtrueの連続prefixではありません")

    schedule_entry = _available_entry(source.key, request, result.schedule)
    schedule_values = {item.objective: item.value for item in schedule_entry.objectives}
    if any(schedule_values[stage.objective] != stage.value for stage in stages):
        raise PlacementTemplateIntegrityError("optimizer目的値が実配置の監査値と一致しません")
    candidate = _with_entry_digest(
        schedule_entry.model_copy(
            update={
                "objectives": tuple(
                    PlacementTemplateObjective(
                        objective=stage.objective,
                        value=stage.value,
                        optimality_proven=stage.optimality_proven,
                    )
                    for stage in stages
                ),
                "provenance": optimizer_provenance(),
                "sha256": "",
            }
        )
    )
    candidate = reaudit_absolute_lower_bound_proofs(candidate, validator=validator)
    _hydrate_and_validate_entry(candidate, validator=validator)
    source_vector = _objective_vector(reaudited_source)
    candidate_vector = _objective_vector(candidate)
    if candidate_vector > source_vector:
        raise PlacementTemplateIntegrityError(
            f"{source.key.catalog_id}: optimizer候補が元entryより辞書式に悪化しました"
        )
    if candidate_vector == source_vector:
        proof_flags = tuple(
            current.optimality_proven or optimized.optimality_proven
            for current, optimized in zip(
                reaudited_source.objectives,
                candidate.objectives,
                strict=True,
            )
        )
        chosen = _with_entry_digest(
            reaudited_source.model_copy(
                update={
                    "objectives": tuple(
                        objective.model_copy(update={"optimality_proven": proof})
                        for objective, proof in zip(
                            reaudited_source.objectives,
                            proof_flags,
                            strict=True,
                        )
                    ),
                    "provenance": optimizer_provenance(),
                    "sha256": "",
                }
            )
        )
    else:
        chosen = candidate
    _hydrate_and_validate_entry(chosen, validator=validator)
    _write_optimization_result_checkpoints(
        source=source,
        chosen=chosen,
        stages=stages,
        directory=checkpoint_directory,
    )
    return chosen


def optimize_topology_lower_objectives(
    topology: Topology,
    output_directory: Path,
    *,
    resume: bool = False,
    workers: int = 1,
    max_time_per_stage: float = DEFAULT_MAX_TIME_SECONDS,
    optimizer: LowerObjectiveOptimizer | None = None,
    validator: CandidateValidator = validate_day2_schedule,
) -> PlacementTemplateShard:
    """2x4/2x8 shardだけを再最適化し、単一のatomic shardとして確定する。"""

    if topology not in LOWER_OBJECTIVE_TARGET_TOPOLOGIES:
        raise ValueError("下位目的の再最適化対象は2x4と2x8だけです")
    if workers < 1:
        raise ValueError("workersは1以上にしてください")
    if optimizer is not None and workers != 1:
        raise ValueError("差し替えoptimizerはworkers=1で使用してください")
    guard_untouched_shards(output_directory)
    source_shard = load_shard(shard_file(output_directory, topology))
    if workers == 1:
        entries = tuple(
            optimize_template_entry_lower_objectives(
                entry,
                output_directory=output_directory,
                resume=resume,
                max_time_per_stage=max_time_per_stage,
                optimizer=optimizer,
                validator=validator,
            )
            for entry in source_shard.entries
        )
    else:
        payloads = tuple(
            (
                entry.model_dump(mode="json"),
                str(output_directory),
                resume,
                max_time_per_stage,
            )
            for entry in source_shard.entries
        )
        by_id: dict[str, PlacementTemplateEntry] = {}
        with ProcessPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(_optimize_entry_worker, payload): payload[0]["key"]
                for payload in payloads
            }
            for future in as_completed(futures):
                entry = PlacementTemplateEntry.model_validate(future.result())
                by_id[entry.key.catalog_id] = entry
        entries = tuple(by_id[entry.key.catalog_id] for entry in source_shard.entries)
    shard = PlacementTemplateShard(
        pool_count=topology[0],
        pool_size=topology[1],
        entries=entries,
    )
    shard = shard.model_copy(update={"sha256": placement_shard_digest(shard)})
    shard = PlacementTemplateShard.model_validate(shard.model_dump(mode="json"))
    write_json_atomic(shard_file(output_directory, topology), shard.model_dump(mode="json"))
    guard_untouched_shards(output_directory)
    return shard


def _write_optimization_result_checkpoints(
    *,
    source: PlacementTemplateEntry,
    chosen: PlacementTemplateEntry,
    stages: Sequence[LowerObjectiveStageResultLike],
    directory: Path,
) -> None:
    original_proofs = tuple(item.optimality_proven for item in source.objectives)
    for index, (stage, objective) in enumerate(zip(stages, chosen.objectives, strict=True)):
        if objective.optimality_proven and stage.optimality_proven:
            proof_method = stage.proof_method
        elif objective.optimality_proven and original_proofs[index]:
            proof_method = "existing"
        elif objective.optimality_proven:
            proof_method = "analytic_lower_bound"
        else:
            proof_method = "unproven"
        best_bound = (
            float(objective.value)
            if proof_method in {"existing", "analytic_lower_bound"}
            else stage.best_bound
        )
        checkpoint = PlacementOptimizationStageCheckpoint(
            key=source.key,
            stage_index=index,
            objective=objective.objective,
            input_entry_sha256=source.sha256,
            candidate=chosen,
            status=stage.status,
            value=objective.value,
            optimality_proven=objective.optimality_proven,
            proof_method=proof_method,
            best_bound=best_bound,
            wall_time_seconds=stage.wall_time_seconds,
            model_fingerprint=stage.model_fingerprint,
        )
        write_optimization_stage_checkpoint(checkpoint, directory)


def _default_lower_objective_optimizer() -> LowerObjectiveOptimizer:
    try:
        module = import_module("football_scheduler.placement_lower_objective_optimizer")
    except ImportError as exc:
        raise PlacementTemplateGenerationError(
            "下位目的optimizerを読み込めません。Wave 1A実装を統合してください"
        ) from exc
    return cast(LowerObjectiveOptimizer, module.optimize_lower_objectives)


def _objective_vector(entry: PlacementTemplateEntry) -> tuple[int, ...]:
    return tuple(item.value for item in entry.objectives)


def _optimize_entry_worker(
    payload: tuple[dict[str, Any], str, bool, float],
) -> dict[str, Any]:
    entry_data, output_directory, resume, max_time_per_stage = payload
    entry = PlacementTemplateEntry.model_validate(entry_data)
    result = optimize_template_entry_lower_objectives(
        entry,
        output_directory=Path(output_directory),
        resume=resume,
        max_time_per_stage=max_time_per_stage,
    )
    return result.model_dump(mode="json")


def _derive_placement_template_entry(
    target_key: PlacementTemplateKey,
    candidates: Iterable[PlacementTemplateEntry],
    *,
    solver: StabilizedPlacementTemplateSolver,
    validator: CandidateValidator,
) -> PlacementTemplateEntry | None:
    """同じ理論下限を達成した、より厳しいキーの配置を安全に再利用する。"""

    lower_horizon = solver.bounds(target_key).lower_horizon
    compatible = sorted(
        (
            entry
            for entry in candidates
            if entry.status is PlacementTemplateStatus.AVAILABLE
            and entry.used_sections is not None
            and _source_proves_target_primary(
                entry.key,
                entry.used_sections,
                target_key,
                lower_horizon,
            )
            and entry.key.pool_count == target_key.pool_count
            and entry.key.pool_size == target_key.pool_size
            and entry.key.court_count <= target_key.court_count
            and entry.key.organizer_capacity <= target_key.organizer_capacity
            and (
                entry.key.day2_fallback is target_key.day2_fallback
                or (
                    entry.key.day2_fallback is Day2Fallback.STRICT
                    and target_key.day2_fallback is Day2Fallback.ORGANIZER
                )
            )
        ),
        key=lambda entry: (
            0 if entry.key.day2_fallback is target_key.day2_fallback else 1,
            entry.key.organizer_capacity,
            entry.key.catalog_id,
        ),
    )
    for source in compatible:
        court_counts = Counter(slot.court_index for slot in source.slots)
        counts = [court_counts[index] for index in range(target_key.court_count)]
        court_usage_difference = max(counts, default=0) - min(counts, default=0)
        objectives = tuple(
            objective.model_copy(
                update={
                    "value": (
                        court_usage_difference
                        if objective.objective == "court_usage_difference"
                        else objective.value
                    ),
                    "optimality_proven": index == 0,
                },
            )
            for index, objective in enumerate(source.objectives)
        )
        candidate = _with_entry_digest(
            source.model_copy(
                update={
                    "key": target_key,
                    "objectives": objectives,
                    "sha256": "",
                }
            )
        )
        candidate_horizon = source.used_sections
        if candidate_horizon is None:
            continue
        base_request = solver._base_request(target_key)
        request = base_request.model_copy(
            update={
                "day": base_request.day.model_copy(update={"max_sections": candidate_horizon}),
            }
        )
        path_model = day2_schedule._build_path_model(request.tournament_plan)
        schedule = day2_schedule._generate_day2_schedule_from_template(
            request,
            path_model,
            candidate_horizon,
            candidate,
        )
        if schedule.status not in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}:
            continue
        _validate_hydrated_candidate(candidate, request, schedule, validator)
        return candidate
    return None


def _source_proves_target_primary(
    source_key: PlacementTemplateKey,
    source_used_sections: int,
    target_key: PlacementTemplateKey,
    target_lower_horizon: int,
) -> bool:
    if source_used_sections == target_lower_horizon:
        return True
    # strictでは、あるコートの最初の実試合が非決勝戦なら、第1sectionで
    # 主催者審判を割り当てる必要がある。それ以外に新しいコートを開けるのは
    # 各poolの決勝だけなので、O + pool_countを超えるコートは実行可能集合を
    # 広げない。コートIDを入れ替えてsource側へ正規化できる。
    return (
        source_key.day2_fallback is Day2Fallback.STRICT
        and target_key.day2_fallback is Day2Fallback.STRICT
        and source_key.organizer_capacity == target_key.organizer_capacity
        and source_key.court_count >= source_key.organizer_capacity + source_key.pool_count
    )


def _validate_hydrated_candidate(
    entry: PlacementTemplateEntry,
    request: Day2ScheduleRequest,
    solved_schedule: Day2Schedule,
    validator: CandidateValidator,
) -> None:
    """canonical位置を実IDへ戻し、審判を再構築して独立検証する。"""

    if entry.used_sections is None:
        raise PlacementTemplateIntegrityError("利用可能entryに使用セクション数がありません")
    position_by_match = _canonical_positions(request)
    match_by_position = {position: match_id for match_id, position in position_by_match.items()}
    if len(match_by_position) != len(position_by_match):
        raise PlacementTemplateIntegrityError("canonical試合位置が重複しています")
    matches_by_coordinate = {
        (slot.section_no, slot.court_index): match_by_position[slot.match_position]
        for slot in entry.slots
    }
    if len(matches_by_coordinate) != len(entry.slots):
        raise PlacementTemplateIntegrityError("canonical配置のslot座標が重複しています")
    hydrated = tuple(
        Slot(
            day_id="day2",
            section_no=section_no,
            court_id=court.id,
            match_id=matches_by_coordinate.get((section_no, court_index)),
            referee_assignment=None,
        )
        for section_no in range(1, entry.used_sections + 1)
        for court_index, court in enumerate(request.courts)
    )
    path_model = day2_schedule._build_path_model(request.tournament_plan)
    assignments, invalid = day2_schedule._assign_referees(request, path_model, hydrated)
    if invalid and request.referees.day2_fallback is Day2Fallback.STRICT:
        raise PlacementTemplateIntegrityError(
            "hydrate後の配置がstrict審判条件を満たしていません: " + ", ".join(sorted(invalid))
        )
    hydrated = tuple(
        slot.model_copy(
            update={
                "referee_assignment": (
                    assignments[slot.match_id] if slot.match_id is not None else None
                )
            }
        )
        for slot in hydrated
    )
    organizer_by_section = Counter(
        slot.section_no
        for slot in hydrated
        if slot.referee_assignment is not None
        and slot.referee_assignment.kind is RefereeKind.ORGANIZER
    )
    if any(count > request.referees.organizer_capacity for count in organizer_by_section.values()):
        raise PlacementTemplateIntegrityError("hydrate後の主催者審判数が能力上限を超えています")
    occupied = tuple(slot for slot in hydrated if slot.match_id is not None)
    signature = placement_referee_signature(
        _canonical_referee_assignments(occupied, position_by_match)
    )
    if signature != entry.referee_signature:
        raise PlacementTemplateIntegrityError("hydrate前後で審判署名が一致しません")

    # 元ソルバーの全監査値を独立集計と照合する。entryへ保存する6目的だけに
    # 縮小すると、空slot数や審判件数の回帰を検出できない。
    metrics = solved_schedule.metrics.model_dump(mode="json")
    document = {
        "config": {
            "teams": [team.model_dump(mode="json") for team in request.teams],
            "courts": [court.model_dump(mode="json") for court in request.courts],
            "days": {"day2": request.day.model_dump(mode="json")},
            "referees": request.referees.model_dump(mode="json"),
        },
        "league_plan": request.league_plan.model_dump(mode="json"),
        "day1_schedule": request.day1_schedule.model_dump(mode="json"),
        "tournament_plan": request.tournament_plan.model_dump(mode="json"),
        "participant_resolution": request.tournament_plan.participant_resolution.value,
        "matches": [match.model_dump(mode="json") for match in path_model.matches],
        "schedule": {
            "participant_resolution": request.tournament_plan.participant_resolution.value,
            "slots": [slot.model_dump(mode="json") for slot in hydrated],
            "section_timings": [
                timing.model_dump(mode="json")
                for timing in section_timings(request.day, entry.used_sections)
            ],
            "expected_end_time": expected_end_time(request.day, entry.used_sections),
            "metrics": metrics,
        },
    }
    report = validator(document)
    if report.get("valid") is not True:
        raise PlacementTemplateIntegrityError(
            "hydrate後の日程が独立検証に失敗しました: "
            + json.dumps(report.get("diagnostics", ()), ensure_ascii=False, sort_keys=True)
        )


def _canonical_positions(
    request: Day2ScheduleRequest,
) -> dict[str, CanonicalMatchPosition]:
    result: dict[str, CanonicalMatchPosition] = {}
    for pool in request.tournament_plan.pools:
        layout = pool.logical_layout
        if layout is None:
            raise PlacementTemplateIntegrityError(
                f"{pool.pool_id}: canonical論理試合位置がありません"
            )
        for position in layout.match_positions:
            result[position.match_id] = CanonicalMatchPosition(
                pool_index=pool.pool_index,
                rank_range_start=position.rank_range[0],
                rank_range_end=position.rank_range[1],
                logical_order=position.order,
            )
    expected = sum(len(pool.matches) for pool in request.tournament_plan.pools)
    if len(result) != expected:
        raise PlacementTemplateIntegrityError("canonical論理試合位置に不足または重複があります")
    return result


def _canonical_referee_assignments(
    slots: Sequence[Slot],
    position_by_match: Mapping[str, CanonicalMatchPosition],
) -> tuple[CanonicalRefereeAssignment, ...]:
    result: list[CanonicalRefereeAssignment] = []
    for slot in slots:
        match_id = _match_id(slot)
        assignment = slot.referee_assignment
        if assignment is None:
            raise PlacementTemplateIntegrityError(f"{match_id}: 審判割当てがありません")
        source_position = (
            position_by_match[assignment.source_match_id]
            if assignment.source_match_id is not None
            else None
        )
        result.append(
            CanonicalRefereeAssignment(
                match_position=position_by_match[match_id],
                kind=assignment.kind.value,
                organizer_reason=assignment.organizer_reason,
                source_match_position=source_position,
                fallback_reasons=tuple(sorted(assignment.fallback_reasons)),
            )
        )
    return tuple(result)


def _with_entry_digest(entry: PlacementTemplateEntry) -> PlacementTemplateEntry:
    completed = entry.model_copy(update={"sha256": placement_entry_digest(entry)})
    return PlacementTemplateEntry.model_validate(completed.model_dump(mode="json"))


def _generate_entry_worker(
    payload: tuple[dict[str, Any], float],
) -> dict[str, Any]:
    key_data, max_time_seconds = payload
    key = PlacementTemplateKey.model_validate(key_data)
    solver = StabilizedPlacementTemplateSolver(max_time_seconds=max_time_seconds)
    return generate_template_entry(key, solver=solver).model_dump(mode="json")


def _checkpoint_directory(output_directory: Path, topology: Topology) -> Path:
    return output_directory / CHECKPOINT_DIRECTORY / f"p{topology[0]}-s{topology[1]}"


def _read_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PlacementTemplateIntegrityError(f"JSONを読み込めません: {path}: {exc}") from exc


def _match_id(slot: Slot) -> str:
    if slot.match_id is None:
        raise PlacementTemplateIntegrityError("未使用slotをcanonical配置へ変換できません")
    return slot.match_id


def _slot_sort_key(slot: PlacementTemplateSlot) -> tuple[int, int, int, int, int, int]:
    position = slot.match_position
    return (
        slot.section_no,
        slot.court_index,
        position.pool_index,
        position.rank_range_start,
        position.rank_range_end,
        position.logical_order,
    )


__all__ = [
    "CHECKPOINT_DIRECTORY",
    "DEFAULT_MAX_TIME_SECONDS",
    "GENERATOR_VERSION",
    "ISSUE73_UNTOUCHED_SHARD_DIGESTS",
    "LARGE_LOWER_OBJECTIVE_TARGET_TOPOLOGIES",
    "LOWER_OBJECTIVE_TARGET_TOPOLOGIES",
    "MANIFEST_FILE",
    "OPTIMIZATION_CHECKPOINT_DIRECTORY",
    "UNTOUCHED_SHARD_DIGESTS",
    "LargeObjectiveCheckpointSink",
    "LargeObjectiveOptimizationRequest",
    "LargeObjectiveOptimizer",
    "LowerObjectiveOptimizationResultLike",
    "LowerObjectiveOptimizer",
    "LowerObjectiveStageResultLike",
    "PlacementProblemBounds",
    "PlacementSolveAttempt",
    "PlacementTemplateGenerationError",
    "PlacementTemplateIntegrityError",
    "PlacementTemplateSolver",
    "StabilizedPlacementTemplateSolver",
    "UnprovenPlacementTemplateError",
    "check_catalog",
    "checkpoint_file_name",
    "current_provenance",
    "generate_template_entry",
    "generate_topology_shard",
    "guard_campaign_shards",
    "guard_issue73_untouched_shards",
    "guard_untouched_shards",
    "issue73_optimization_checkpoint_directory",
    "issue73_optimizer_candidate_file",
    "large_optimizer_provenance",
    "load_entry",
    "load_issue73_optimization_checkpoints",
    "load_manifest",
    "load_optimization_stage_checkpoint",
    "load_shard",
    "merge_shards",
    "optimization_checkpoint_directory",
    "optimization_stage_checkpoint_file",
    "optimize_issue73_target_entry",
    "optimize_issue73_targets",
    "optimize_template_entry_lower_objectives",
    "optimize_topology_lower_objectives",
    "optimizer_provenance",
    "reaudit_absolute_lower_bound_proofs",
    "select_best_validated_template_candidate",
    "shard_file",
    "topology_keys",
    "validate_catalog_hydration",
    "write_entry_checkpoint",
    "write_optimization_stage_checkpoint",
]
