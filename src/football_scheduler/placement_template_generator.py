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
from importlib.metadata import version
from pathlib import Path
from typing import Any, Protocol

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
    PLACEMENT_OBJECTIVES,
    SUPPORTED_PLACEMENT_TOPOLOGIES,
    CanonicalMatchPosition,
    CanonicalRefereeAssignment,
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
    placement_referee_signature,
    placement_shard_digest,
)
from football_scheduler.timekeeping import expected_end_time, section_timings
from football_scheduler.tournament import generate_tournament_plan
from football_scheduler.validator import validate_day2_schedule

GENERATOR_VERSION = "placement-template-generator-v8"
DEFAULT_RANDOM_SEED = 20260803
DEFAULT_MAX_TIME_SECONDS = 840.0
CHECKPOINT_DIRECTORY = ".checkpoints"
MANIFEST_FILE = "manifest.json"

Topology = tuple[int, int]
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


class StabilizedPlacementTemplateSolver:
    """安定化済みの非公開2日目ソルバーを固定horizonで呼び出す。"""

    def __init__(self, *, max_time_seconds: float = DEFAULT_MAX_TIME_SECONDS) -> None:
        if not 0 < max_time_seconds <= 840:
            raise ValueError("1回の探索時間は0秒より大きく840秒以下にしてください")
        self._max_time_seconds = max_time_seconds
        self._requests: dict[str, Day2ScheduleRequest] = {}

    def bounds(self, key: PlacementTemplateKey) -> PlacementProblemBounds:
        request = self._base_request(key)
        match_count = sum(len(pool.matches) for pool in request.tournament_plan.pools)
        # 第1セクションは主催者能力まで、それ以降はコート数まで配置できる。
        first_section_capacity = min(key.court_count, key.organizer_capacity, match_count)
        slot_bound = 1 + math.ceil(max(0, match_count - first_section_capacity) / key.court_count)
        dependency_depth = key.pool_size.bit_length() - 1
        dependency_bound = dependency_depth * 2 - 1
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
        return PlacementProblemBounds(
            lower_horizon=max(slot_bound, dependency_bound, referee_capacity_bound),
            upper_horizon=match_count,
        )

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

    active_courts = min(court_count, organizer_capacity)
    unopened_by_final = final_count
    capacity = 0
    capacity_by_section: list[int] = []
    horizon = 0
    while capacity < match_count:
        horizon += 1
        if horizon >= earliest_final_section and unopened_by_final > 0:
            ancestor_capacity = capacity_by_section[horizon - 3] if horizon >= 3 else 0
            maximum_ready_finals = min(
                final_count,
                ancestor_capacity // ancestor_matches_per_final,
            )
            opened_finals = final_count - unopened_by_final
            newly_opened = min(
                organizer_capacity,
                unopened_by_final,
                court_count - active_courts,
                max(0, maximum_ready_finals - opened_finals),
            )
            active_courts += newly_opened
            unopened_by_final -= newly_opened
        capacity += active_courts
        capacity_by_section.append(capacity)
    return horizon


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
            if entry.used_sections is None:
                raise PlacementTemplateIntegrityError(
                    f"{entry.key.catalog_id}: available entryに使用セクション数がありません"
                )
            request = request_factory._base_request(entry.key)
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
            hydrated_count += 1
    return hydrated_count


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
    "MANIFEST_FILE",
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
    "load_entry",
    "load_manifest",
    "load_shard",
    "merge_shards",
    "shard_file",
    "topology_keys",
    "validate_catalog_hydration",
    "write_entry_checkpoint",
]
