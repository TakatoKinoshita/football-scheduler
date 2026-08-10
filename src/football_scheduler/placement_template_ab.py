"""順位決定トーナメント用テンプレートの再現可能なA/B比較基盤。

このmoduleはcatalog生成のruntime経路から独立したoffline toolingである。旧solverの
自己申告metricsは採用せず、canonical配置を現行規則でhydrateしてから独立validatorで
6目的を再集計する。
"""

from __future__ import annotations

import gzip
import json
import os
import subprocess
import sys
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import suppress
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Annotated, Any, Literal, Self

from pydantic import Field, model_validator

from football_scheduler import day2_schedule
from football_scheduler.models import ContractModel, Day2Fallback, Slot, SolverStatus
from football_scheduler.placement_template_contract import (
    PLACEMENT_OBJECTIVES,
    SUPPORTED_PLACEMENT_TOPOLOGIES,
    PlacementTemplateEntry,
    PlacementTemplateKey,
    PlacementTemplateObjective,
    PlacementTemplateProvenance,
    PlacementTemplateSlot,
    PlacementTemplateStatus,
    canonical_json_bytes,
    placement_entry_digest,
    placement_referee_signature,
    sha256_hex,
)
from football_scheduler.placement_template_generator import (
    PlacementTemplateIntegrityError,
    StabilizedPlacementTemplateSolver,
    _canonical_positions,
    _canonical_referee_assignments,
    _validate_hydrated_candidate,
    topology_keys,
)
from football_scheduler.validator import validate_day2_schedule

LEGACY_SOLVER_COMMIT = "2ccf91da34717ae86a21513a43289a2e2b758617"
LEGACY_PYTHON_PREFIX = "3.14."
LEGACY_ORTOOLS_VERSION = "9.15.6755"
BASELINE_FORMAT_VERSION: Literal[1] = 1
BASELINE_RANDOM_SEED = 20260803
# Issue #71の呼び出し側とfixtureの互換性のため旧名は維持する。
TARGET_TOPOLOGIES: tuple[tuple[int, int], ...] = ((2, 4), (2, 8))
LARGE_TARGET_TOPOLOGIES: tuple[tuple[int, int], ...] = ((3, 8), (2, 16), (4, 8))
ObjectiveVector = tuple[int, int, int, int, int, int]


class PlacementABError(RuntimeError):
    """A/B比較を安全に継続できないときの基底例外。"""


class PrimaryProofConflict(PlacementABError):
    """旧solverがcatalogの証明済み最短horizonを破った。"""


class WorkerProtocolError(PlacementABError):
    """JSONL workerとの通信契約が壊れている。"""


class BaselineSource(StrEnum):
    CURRENT = "current"
    LEGACY = "legacy"
    OPTIMIZER = "optimizer"


class BaselineRecordStatus(StrEnum):
    AVAILABLE = "available"
    TIMEOUT = "timeout"
    INFEASIBLE = "infeasible"
    INVALID = "invalid"
    ERROR = "error"


class LexicographicResult(StrEnum):
    BETTER = "better"
    EQUAL = "equal"
    WORSE = "worse"


class PlacementBaselineRecord(ContractModel):
    key: PlacementTemplateKey
    input_entry_sha256: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
    status: BaselineRecordStatus
    solver_status: str | None = None
    horizon: Annotated[int, Field(gt=0)]
    objective_values: ObjectiveVector | None = None
    candidate: PlacementTemplateEntry | None = None
    diagnostics: tuple[str, ...] = ()
    wall_time_seconds: Annotated[float, Field(ge=0)] = 0
    normalized_schedule_sha256: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")] | None = None

    @model_validator(mode="after")
    def validate_candidate(self) -> Self:
        available = self.status is BaselineRecordStatus.AVAILABLE
        if available != (self.objective_values is not None and self.candidate is not None):
            raise ValueError("available recordには目的値とcandidateが必要です")
        if self.candidate is not None:
            if self.candidate.key != self.key:
                raise ValueError("recordとcandidateのkeyが一致しません")
            if tuple(item.value for item in self.candidate.objectives) != self.objective_values:
                raise ValueError("recordとcandidateの目的値が一致しません")
        return self


class PlacementBaselineEnvironment(ContractModel):
    commit_sha: Annotated[str, Field(pattern=r"^[0-9a-f]{40}$")]
    python_version: str
    ortools_version: str
    random_seed: int = BASELINE_RANDOM_SEED
    max_time_seconds: Annotated[float, Field(gt=0, le=840)] | None = None
    num_search_workers: Literal[1] = 1
    pythonhashseed: Literal["0"] = "0"


class PlacementBaselineFixture(ContractModel):
    format_version: Literal[1] = BASELINE_FORMAT_VERSION
    source: BaselineSource
    topologies: tuple[tuple[int, int], ...]
    environment: PlacementBaselineEnvironment
    complete: bool
    records: tuple[PlacementBaselineRecord, ...]
    sha256: str = ""

    @model_validator(mode="after")
    def validate_coverage(self) -> Self:
        if not self.topologies or any(
            item not in SUPPORTED_PLACEMENT_TOPOLOGIES for item in self.topologies
        ):
            raise ValueError("baselineの対象は対応済みトポロジーにしてください")
        if tuple(dict.fromkeys(self.topologies)) != self.topologies:
            raise ValueError("baselineのtopologyが重複しています")
        canonical_topologies = tuple(
            item for item in SUPPORTED_PLACEMENT_TOPOLOGIES if item in self.topologies
        )
        if self.topologies != canonical_topologies:
            raise ValueError("baselineのtopologyは正規順にしてください")
        ids = [record.key.catalog_id for record in self.records]
        if ids != sorted(ids) or len(ids) != len(set(ids)):
            raise ValueError("baseline recordはcatalog ID順かつ一意にしてください")
        expected = {
            key.catalog_id for topology in self.topologies for key in topology_keys(topology)
        }
        if not set(ids) <= expected or (self.complete and set(ids) != expected):
            raise ValueError("baseline recordのkey範囲が一致しません")
        if self.source is BaselineSource.LEGACY and (
            self.environment.commit_sha != LEGACY_SOLVER_COMMIT
            or not self.environment.python_version.startswith(LEGACY_PYTHON_PREFIX)
            or self.environment.ortools_version != LEGACY_ORTOOLS_VERSION
            or (self.complete and self.environment.max_time_seconds != 30)
        ):
            raise ValueError("legacy baselineの固定実行環境が一致しません")
        if self.sha256 and self.sha256 != baseline_fixture_digest(self):
            raise ValueError("baseline fixtureのSHA-256が一致しません")
        return self


class PlacementABSummary(ContractModel):
    compared: Annotated[int, Field(ge=0)]
    better: Annotated[int, Field(ge=0)]
    equal: Annotated[int, Field(ge=0)]
    worse: Annotated[int, Field(ge=0)]
    unavailable: Annotated[int, Field(ge=0)]
    timeout: Annotated[int, Field(ge=0)]
    infeasible: Annotated[int, Field(ge=0)]
    invalid: Annotated[int, Field(ge=0)]
    error: Annotated[int, Field(ge=0)]


def baseline_fixture_digest(fixture: PlacementBaselineFixture) -> str:
    return sha256_hex(fixture.model_dump(mode="json", exclude={"sha256"}))


def with_fixture_digest(fixture: PlacementBaselineFixture) -> PlacementBaselineFixture:
    updated = fixture.model_copy(update={"sha256": baseline_fixture_digest(fixture)})
    return PlacementBaselineFixture.model_validate(updated.model_dump(mode="json"))


def write_deterministic_gzip(path: Path, fixture: PlacementBaselineFixture) -> None:
    """canonical JSONをmtime=0のgzipへatomicに保存する。"""

    checked = with_fixture_digest(fixture)
    compressed = gzip.compress(canonical_json_bytes(checked), compresslevel=9, mtime=0)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_bytes(compressed)
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


def read_deterministic_gzip(path: Path) -> PlacementBaselineFixture:
    try:
        raw = gzip.decompress(path.read_bytes())
        data = json.loads(raw)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PlacementABError(f"baseline fixtureを読み込めません: {path}") from exc
    fixture = PlacementBaselineFixture.model_validate(data)
    if not fixture.sha256 or fixture.sha256 != baseline_fixture_digest(fixture):
        raise PlacementABError(f"baseline fixtureのdigestが一致しません: {path}")
    return fixture


def merge_baseline_fixtures(
    fixtures: Sequence[PlacementBaselineFixture],
    expected_topologies: Sequence[tuple[int, int]],
) -> PlacementBaselineFixture:
    """digest付きpartial fixtureを環境とcoverageを確認して統合する。"""

    if not fixtures:
        raise PlacementABError("統合するbaseline fixtureがありません")
    requested = tuple(expected_topologies)
    expected = tuple(item for item in SUPPORTED_PLACEMENT_TOPOLOGIES if item in requested)
    if not requested or len(requested) != len(set(requested)) or requested != expected:
        raise PlacementABError("統合対象topologyは重複のない正規順にしてください")

    first = fixtures[0]
    records: list[PlacementBaselineRecord] = []
    actual_topologies: list[tuple[int, int]] = []
    for fixture in fixtures:
        # in-memoryで組み立てたfixtureでも、ファイル読込み時と同じ検査を行う。
        checked = PlacementBaselineFixture.model_validate(fixture.model_dump(mode="json"))
        if not checked.sha256 or checked.sha256 != baseline_fixture_digest(checked):
            raise PlacementABError("partial baseline fixtureのdigestが一致しません")
        if not checked.complete:
            raise PlacementABError("partial baseline fixtureのcompleteがfalseです")
        if checked.source is not first.source:
            raise PlacementABError("partial baseline fixtureのsourceが一致しません")
        if checked.environment != first.environment:
            raise PlacementABError("partial baseline fixtureの実行環境が一致しません")
        overlap = set(actual_topologies) & set(checked.topologies)
        if overlap:
            names = ", ".join(
                f"{pool_count}x{pool_size}" for pool_count, pool_size in sorted(overlap)
            )
            raise PlacementABError(f"partial baseline fixtureのtopologyが重複しています: {names}")
        actual_topologies.extend(checked.topologies)
        records.extend(checked.records)

    if set(actual_topologies) != set(expected):
        actual = ", ".join(
            f"{pool_count}x{pool_size}" for pool_count, pool_size in actual_topologies
        )
        wanted = ", ".join(f"{pool_count}x{pool_size}" for pool_count, pool_size in expected)
        raise PlacementABError(
            f"partial baseline fixtureのtopology coverageが一致しません: "
            f"expected={wanted}, actual={actual}"
        )

    merged = PlacementBaselineFixture(
        source=first.source,
        topologies=expected,
        environment=first.environment,
        complete=True,
        records=tuple(sorted(records, key=lambda item: item.key.catalog_id)),
    )
    return with_fixture_digest(merged)


def compare_objective_vectors(
    candidate: Sequence[int], baseline: Sequence[int]
) -> LexicographicResult:
    if len(candidate) != len(PLACEMENT_OBJECTIVES) or len(baseline) != len(PLACEMENT_OBJECTIVES):
        raise ValueError("目的ベクトルは6要素にしてください")
    candidate_tuple, baseline_tuple = tuple(candidate), tuple(baseline)
    if candidate_tuple < baseline_tuple:
        return LexicographicResult.BETTER
    if candidate_tuple > baseline_tuple:
        return LexicographicResult.WORSE
    return LexicographicResult.EQUAL


def compare_baselines(
    baseline: PlacementBaselineFixture,
    candidate: PlacementBaselineFixture,
) -> PlacementABSummary:
    baseline_by_id = {record.key.catalog_id: record for record in baseline.records}
    counts = Counter[str]()
    for record in candidate.records:
        reference = baseline_by_id.get(record.key.catalog_id)
        if (
            reference is None
            or reference.objective_values is None
            or record.objective_values is None
        ):
            counts["unavailable"] += 1
            counts[record.status.value] += 1
            continue
        outcome = compare_objective_vectors(record.objective_values, reference.objective_values)
        counts[outcome.value] += 1
        counts["compared"] += 1
    return PlacementABSummary(
        compared=counts["compared"],
        better=counts["better"],
        equal=counts["equal"],
        worse=counts["worse"],
        unavailable=counts["unavailable"],
        timeout=counts["timeout"],
        infeasible=counts["infeasible"],
        invalid=counts["invalid"],
        error=counts["error"],
    )


def baseline_candidate_for(
    fixture: PlacementBaselineFixture,
    current_entry: PlacementTemplateEntry,
) -> PlacementTemplateEntry | None:
    """入力entry SHAまで一致する検証済みcandidateだけを返す。"""

    record = next(
        (item for item in fixture.records if item.key.catalog_id == current_entry.key.catalog_id),
        None,
    )
    if (
        record is None
        or record.status is not BaselineRecordStatus.AVAILABLE
        or record.input_entry_sha256 != current_entry.sha256
        or record.candidate is None
    ):
        return None
    return record.candidate


@dataclass(frozen=True, slots=True)
class LegacyWorkerMetadata:
    commit_sha: str
    python_version: str
    ortools_version: str


class LegacyPlacementWorker:
    """1 processで複数keyを処理するline-delimited JSON worker。"""

    def __init__(
        self,
        legacy_root: Path,
        *,
        python_executable: Path | str = sys.executable,
        worker_script: Path | None = None,
    ) -> None:
        self.legacy_root = legacy_root.resolve()
        self.python_executable = str(python_executable)
        self.worker_script = worker_script or (
            Path(__file__).resolve().parents[2] / "scripts" / "legacy_placement_worker.py"
        )
        self._process: subprocess.Popen[str] | None = None
        self.metadata: LegacyWorkerMetadata | None = None

    def __enter__(self) -> Self:
        _verify_legacy_checkout(self.legacy_root)
        environment = {**os.environ, "PYTHONHASHSEED": "0"}
        self._process = subprocess.Popen(
            (
                self.python_executable,
                str(self.worker_script),
                "--legacy-root",
                str(self.legacy_root),
                "--expected-commit",
                LEGACY_SOLVER_COMMIT,
            ),
            cwd=self.legacy_root,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        try:
            hello = self.request({"command": "hello", "request_id": "hello"})
            if hello.get("type") != "hello" or hello.get("commit_sha") != LEGACY_SOLVER_COMMIT:
                raise WorkerProtocolError("legacy workerのversion handshakeに失敗しました")
            self.metadata = LegacyWorkerMetadata(
                commit_sha=str(hello["commit_sha"]),
                python_version=str(hello["python_version"]),
                ortools_version=str(hello["ortools_version"]),
            )
            if (
                not self.metadata.python_version.startswith(LEGACY_PYTHON_PREFIX)
                or self.metadata.ortools_version != LEGACY_ORTOOLS_VERSION
            ):
                raise WorkerProtocolError("legacy workerのPythonまたはOR-Tools versionが不正です")
        except Exception:
            self.__exit__()
            raise
        return self

    def __exit__(self, *_args: object) -> None:
        process = self._process
        self._process = None
        if process is None:
            return
        if process.stdin is not None:
            with suppress(BrokenPipeError):
                process.stdin.close()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=5)

    def request(self, payload: Mapping[str, object]) -> dict[str, Any]:
        process = self._process
        if process is None or process.stdin is None or process.stdout is None:
            raise WorkerProtocolError("legacy workerが起動していません")
        process.stdin.write(json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n")
        process.stdin.flush()
        response_line = process.stdout.readline()
        if not response_line:
            detail = process.stderr.read().strip() if process.stderr is not None else ""
            raise WorkerProtocolError(f"legacy workerが応答せず終了しました: {detail[:500]}")
        try:
            response = json.loads(response_line)
        except json.JSONDecodeError as exc:
            raise WorkerProtocolError("legacy workerが不正なJSONを返しました") from exc
        if not isinstance(response, dict):
            raise WorkerProtocolError("legacy worker応答がobjectではありません")
        if response.get("request_id") != payload.get("request_id"):
            raise WorkerProtocolError("legacy workerのrequest IDが一致しません")
        return response


def current_baseline_record(entry: PlacementTemplateEntry) -> PlacementBaselineRecord:
    if entry.status is not PlacementTemplateStatus.AVAILABLE or entry.used_sections is None:
        raise PlacementABError(f"current baselineがavailableではありません: {entry.key.catalog_id}")
    return PlacementBaselineRecord(
        key=entry.key,
        input_entry_sha256=entry.sha256,
        status=BaselineRecordStatus.AVAILABLE,
        solver_status="catalog",
        horizon=entry.used_sections,
        objective_values=_entry_vector(entry),
        candidate=entry,
        normalized_schedule_sha256=sha256_hex(
            [slot.model_dump(mode="json") for slot in entry.slots]
        ),
    )


def classify_legacy_response(
    entry: PlacementTemplateEntry,
    response: Mapping[str, Any],
) -> PlacementBaselineRecord:
    """worker応答を現行規則でhydrate・独立検証しbaseline recordへ変換する。"""

    if entry.status is not PlacementTemplateStatus.AVAILABLE or entry.used_sections is None:
        raise PlacementABError(f"legacy比較元がavailableではありません: {entry.key.catalog_id}")
    wall_time = _nonnegative_float(response.get("wall_time_seconds"))
    if response.get("type") == "error":
        return _unavailable_record(
            entry,
            BaselineRecordStatus.ERROR,
            wall_time,
            str(response.get("error", "legacy worker error")),
        )
    if response.get("type") != "result":
        raise WorkerProtocolError("legacy workerの応答typeが不正です")
    solver_status = str(response.get("solver_status", ""))
    diagnostics = tuple(_diagnostic_codes(response.get("diagnostics")))
    if (
        solver_status == SolverStatus.UNKNOWN.value
        or "TOURNAMENT_SCHEDULE_SEARCH_TIMEOUT" in diagnostics
    ):
        return _unavailable_record(
            entry,
            BaselineRecordStatus.TIMEOUT,
            wall_time,
            *diagnostics,
            solver_status=solver_status,
        )
    if solver_status == SolverStatus.INFEASIBLE.value:
        return _unavailable_record(
            entry,
            BaselineRecordStatus.INFEASIBLE,
            wall_time,
            *diagnostics,
            solver_status=solver_status,
        )
    if solver_status not in {SolverStatus.OPTIMAL.value, SolverStatus.FEASIBLE.value}:
        return _unavailable_record(
            entry,
            BaselineRecordStatus.ERROR,
            wall_time,
            f"unknown solver status: {solver_status}",
            *diagnostics,
            solver_status=solver_status,
        )
    schedule = response.get("schedule")
    if not isinstance(schedule, Mapping):
        return _unavailable_record(
            entry,
            BaselineRecordStatus.INVALID,
            wall_time,
            "schedule missing",
            solver_status=solver_status,
        )
    try:
        candidate, normalized_sha = canonicalize_and_reaudit(entry, schedule)
    except PrimaryProofConflict:
        raise
    except (KeyError, TypeError, ValueError, PlacementTemplateIntegrityError) as exc:
        return _unavailable_record(
            entry,
            BaselineRecordStatus.INVALID,
            wall_time,
            str(exc)[:500],
            *diagnostics,
            solver_status=solver_status,
        )
    return PlacementBaselineRecord(
        key=entry.key,
        input_entry_sha256=entry.sha256,
        status=BaselineRecordStatus.AVAILABLE,
        solver_status=solver_status,
        horizon=entry.used_sections,
        objective_values=_entry_vector(candidate),
        candidate=candidate,
        diagnostics=diagnostics,
        wall_time_seconds=wall_time,
        normalized_schedule_sha256=normalized_sha,
    )


def canonicalize_and_reaudit(
    current_entry: PlacementTemplateEntry,
    raw_schedule: Mapping[str, Any],
) -> tuple[PlacementTemplateEntry, str]:
    """legacy配置からIDを除き、現行審判規則とvalidatorで再構築する。"""

    key = current_entry.key
    assert current_entry.used_sections is not None
    request_factory = StabilizedPlacementTemplateSolver(max_time_seconds=1)
    base = request_factory._base_request(key)
    request = base.model_copy(
        update={"day": base.day.model_copy(update={"max_sections": current_entry.used_sections})}
    )
    positions = _canonical_positions(request)
    court_index = {court.id: index for index, court in enumerate(request.courts)}
    raw_slots = raw_schedule.get("slots")
    if not isinstance(raw_slots, Sequence) or isinstance(raw_slots, (str, bytes, bytearray)):
        raise ValueError("legacy scheduleのslotsが配列ではありません")
    occupied = tuple(
        Slot.model_validate(slot)
        for slot in raw_slots
        if isinstance(slot, Mapping) and slot.get("match_id") is not None
    )
    if len(occupied) != len(positions):
        raise ValueError("legacy scheduleが全試合を一度ずつ配置していません")
    used_sections = max(slot.section_no for slot in occupied)
    if used_sections < current_entry.used_sections:
        raise PrimaryProofConflict(
            f"{key.catalog_id}: legacy={used_sections}, proven={current_entry.used_sections}"
        )
    if used_sections != current_entry.used_sections:
        raise ValueError("legacy scheduleが証明済み最短horizonを達成していません")
    template_slots = tuple(
        sorted(
            (
                PlacementTemplateSlot(
                    section_no=slot.section_no,
                    court_index=court_index[slot.court_id],
                    match_position=positions[str(slot.match_id)],
                )
                for slot in occupied
            ),
            key=lambda item: (
                item.section_no,
                item.court_index,
                item.match_position.pool_index,
                item.match_position.logical_order,
            ),
        )
    )
    vector = _objective_vector(request, template_slots)
    hydrated_without_referees = tuple(
        Slot(
            day_id="day2",
            section_no=section,
            court_id=court.id,
            match_id=next(
                (
                    match_id
                    for match_id, position in positions.items()
                    if any(
                        item.section_no == section
                        and item.court_index == index
                        and item.match_position == position
                        for item in template_slots
                    )
                ),
                None,
            ),
            referee_assignment=None,
        )
        for section in range(1, used_sections + 1)
        for index, court in enumerate(request.courts)
    )
    path_model = day2_schedule._build_path_model(request.tournament_plan)
    assignments, invalid = day2_schedule._assign_referees(
        request, path_model, hydrated_without_referees
    )
    if invalid and key.day2_fallback is Day2Fallback.STRICT:
        raise ValueError("legacy配置を現行strict審判規則で復元できません")
    hydrated = tuple(
        slot.model_copy(
            update={
                "referee_assignment": (
                    assignments[slot.match_id] if slot.match_id is not None else None
                )
            }
        )
        for slot in hydrated_without_referees
    )
    referee_signature = placement_referee_signature(
        _canonical_referee_assignments(
            tuple(slot for slot in hydrated if slot.match_id is not None), positions
        )
    )
    candidate = PlacementTemplateEntry(
        key=key,
        status=PlacementTemplateStatus.AVAILABLE,
        used_sections=used_sections,
        slots=template_slots,
        objectives=tuple(
            PlacementTemplateObjective(
                objective=name,
                value=value,
                optimality_proven=index == 0,
            )
            for index, (name, value) in enumerate(zip(PLACEMENT_OBJECTIVES, vector, strict=True))
        ),
        referee_signature=referee_signature,
        provenance=PlacementTemplateProvenance(
            generator_version=f"legacy-{LEGACY_SOLVER_COMMIT[:12]}-reaudited",
            python_version=str(raw_schedule.get("legacy_python_version", "unknown")),
            ortools_version=str(raw_schedule.get("legacy_ortools_version", "unknown")),
        ),
    )
    candidate = candidate.model_copy(update={"sha256": placement_entry_digest(candidate)})
    candidate = PlacementTemplateEntry.model_validate(candidate.model_dump(mode="json"))
    solved = day2_schedule._generate_day2_schedule_from_template(
        request,
        path_model,
        used_sections,
        candidate,
    )
    if solved.status not in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}:
        raise ValueError("legacy配置を現行runtimeでhydrateできません")
    _validate_hydrated_candidate(candidate, request, solved, validate_day2_schedule)
    normalized_sha = sha256_hex(
        [slot.model_dump(mode="json") for slot in solved.slots if slot.match_id is not None]
    )
    return candidate, normalized_sha


def run_legacy_records(
    entries: Sequence[PlacementTemplateEntry],
    legacy_root: Path,
    checkpoint_directory: Path,
    *,
    max_time_seconds: float = 30,
    workers: int = 1,
    resume: bool = False,
    python_executable: Path | str = sys.executable,
    worker_script: Path | None = None,
) -> tuple[tuple[PlacementBaselineRecord, ...], LegacyWorkerMetadata]:
    """entryをpersistent workerへ分配し、key単位checkpointで再開可能にする。"""

    if workers < 1:
        raise ValueError("workersは1以上にしてください")
    if not 0 < max_time_seconds <= 840:
        raise ValueError("max_time_secondsは0より大きく840以下にしてください")
    ordered = tuple(sorted(entries, key=lambda item: item.key.catalog_id))
    checkpoint_directory.mkdir(parents=True, exist_ok=True)
    records: dict[str, PlacementBaselineRecord] = {}
    pending: list[PlacementTemplateEntry] = []
    for entry in ordered:
        checkpoint = checkpoint_directory / f"{_safe_key(entry.key)}.json"
        if resume and checkpoint.exists():
            record = PlacementBaselineRecord.model_validate(json.loads(checkpoint.read_text()))
            if record.key != entry.key or record.input_entry_sha256 != entry.sha256:
                raise PlacementABError(f"checkpointの入力entryが一致しません: {checkpoint}")
            records[entry.key.catalog_id] = record
        else:
            pending.append(entry)

    batches = [pending[index::workers] for index in range(workers)]
    active_batches = [batch for batch in batches if batch]
    metadata_items: list[LegacyWorkerMetadata] = []

    def run_batch(
        batch: Sequence[PlacementTemplateEntry],
    ) -> tuple[LegacyWorkerMetadata, tuple[PlacementBaselineRecord, ...]]:
        batch_records: list[PlacementBaselineRecord] = []
        with LegacyPlacementWorker(
            legacy_root,
            python_executable=python_executable,
            worker_script=worker_script,
        ) as worker:
            assert worker.metadata is not None
            for entry in batch:
                response = worker.request(
                    {
                        "command": "solve",
                        "request_id": entry.key.catalog_id,
                        "key": entry.key.model_dump(mode="json"),
                        "horizon": entry.used_sections,
                        "max_time_seconds": max_time_seconds,
                        "random_seed": BASELINE_RANDOM_SEED,
                    }
                )
                if isinstance(response.get("schedule"), dict):
                    response["schedule"]["legacy_python_version"] = worker.metadata.python_version
                    response["schedule"]["legacy_ortools_version"] = worker.metadata.ortools_version
                record = classify_legacy_response(entry, response)
                _write_record_checkpoint(
                    checkpoint_directory / f"{_safe_key(entry.key)}.json", record
                )
                batch_records.append(record)
            return worker.metadata, tuple(batch_records)

    if active_batches:
        with ThreadPoolExecutor(max_workers=len(active_batches)) as executor:
            futures = [executor.submit(run_batch, batch) for batch in active_batches]
            for future in as_completed(futures):
                metadata, batch_records = future.result()
                metadata_items.append(metadata)
                records.update((record.key.catalog_id, record) for record in batch_records)
    else:
        with LegacyPlacementWorker(
            legacy_root,
            python_executable=python_executable,
            worker_script=worker_script,
        ) as worker:
            assert worker.metadata is not None
            metadata_items.append(worker.metadata)
    first = metadata_items[0]
    if any(item != first for item in metadata_items[1:]):
        raise PlacementABError("legacy worker間で実行環境が一致しません")
    return tuple(records[entry.key.catalog_id] for entry in ordered), first


def render_comparison_markdown(
    baseline: PlacementBaselineFixture,
    candidate: PlacementBaselineFixture,
) -> str:
    summary = compare_baselines(baseline, candidate)
    baseline_by_id = {record.key.catalog_id: record for record in baseline.records}
    grouped: Counter[tuple[str, str, str]] = Counter()
    first_difference: Counter[tuple[str, str]] = Counter()
    for record in candidate.records:
        topology = f"{record.key.pool_count}x{record.key.pool_size}"
        fallback = record.key.day2_fallback.value
        reference = baseline_by_id.get(record.key.catalog_id)
        if (
            reference is None
            or reference.objective_values is None
            or record.objective_values is None
        ):
            grouped[topology, fallback, "unavailable"] += 1
            continue
        outcome = compare_objective_vectors(record.objective_values, reference.objective_values)
        grouped[topology, fallback, outcome.value] += 1
        if outcome is LexicographicResult.EQUAL:
            continue
        index = next(
            index
            for index, (left, right) in enumerate(
                zip(record.objective_values, reference.objective_values, strict=True)
            )
            if left != right
        )
        first_difference[PLACEMENT_OBJECTIVES[index], outcome.value] += 1
    lines = [
        "# Placement template A/B comparison",
        "",
        f"- Baseline: `{baseline.source.value}` (`{baseline.environment.commit_sha}`)",
        f"- Candidate: `{candidate.source.value}` (`{candidate.environment.commit_sha}`)",
        f"- Compared: {summary.compared}",
        f"- Better / equal / worse: {summary.better} / {summary.equal} / {summary.worse}",
        f"- Unavailable: {summary.unavailable}",
        f"- Timeout / infeasible / invalid / error: {summary.timeout} / "
        f"{summary.infeasible} / {summary.invalid} / {summary.error}",
        "",
        "## Topology and fallback",
        "",
        "| Topology | Fallback | Better | Equal | Worse | Unavailable |",
        "| --- | --- | ---: | ---: | ---: | ---: |",
    ]
    report_topologies = tuple(
        topology
        for topology in SUPPORTED_PLACEMENT_TOPOLOGIES
        if topology in set(baseline.topologies) | set(candidate.topologies)
    )
    for pool_count, pool_size in report_topologies:
        topology = f"{pool_count}x{pool_size}"
        for fallback in (Day2Fallback.ORGANIZER.value, Day2Fallback.STRICT.value):
            lines.append(
                f"| {topology} | {fallback} | {grouped[topology, fallback, 'better']} | "
                f"{grouped[topology, fallback, 'equal']} | "
                f"{grouped[topology, fallback, 'worse']} | "
                f"{grouped[topology, fallback, 'unavailable']} |"
            )
    lines.extend(
        (
            "",
            "## First differing objective",
            "",
            "| Objective | Better | Worse |",
            "| --- | ---: | ---: |",
        )
    )
    lines.extend(
        f"| {objective} | {first_difference[objective, 'better']} | "
        f"{first_difference[objective, 'worse']} |"
        for objective in PLACEMENT_OBJECTIVES
    )
    lines.append("")
    return "\n".join(lines)


def _objective_vector(request: Any, slots: Sequence[PlacementTemplateSlot]) -> ObjectiveVector:
    position_by_match = _canonical_positions(request)
    match_by_position = {position: match_id for match_id, position in position_by_match.items()}
    section_by_match = {match_by_position[item.match_position]: item.section_no for item in slots}
    court_by_match = {match_by_position[item.match_position]: item.court_index for item in slots}
    path_model = day2_schedule._build_path_model(request.tournament_plan)
    used = max(section_by_match.values(), default=0)
    non_primary = [
        used - section_by_match[path_model.matches[index].id]
        for index in path_model.final_indexes[1:]
    ]
    waits = [
        section_by_match[target] - section_by_match[source] - 1
        for target, sources in path_model.dependencies.items()
        for source in sources
    ]
    court_changes = sum(
        court_by_match[target] != court_by_match[source]
        for target, sources in path_model.dependencies.items()
        for source in sources
    )
    counts_by_court = Counter(item.court_index for item in slots)
    counts = [counts_by_court[index] for index in range(len(request.courts))]
    return (
        used,
        max(non_primary, default=0),
        sum(non_primary),
        max(waits, default=0),
        court_changes,
        max(counts, default=0) - min(counts, default=0),
    )


def _entry_vector(entry: PlacementTemplateEntry) -> ObjectiveVector:
    values = tuple(item.value for item in entry.objectives)
    if len(values) != len(PLACEMENT_OBJECTIVES):
        raise PlacementABError(f"目的値が6件ではありません: {entry.key.catalog_id}")
    return (values[0], values[1], values[2], values[3], values[4], values[5])


def _unavailable_record(
    entry: PlacementTemplateEntry,
    status: BaselineRecordStatus,
    wall_time: float,
    *diagnostics: str,
    solver_status: str | None = None,
) -> PlacementBaselineRecord:
    assert entry.used_sections is not None
    return PlacementBaselineRecord(
        key=entry.key,
        input_entry_sha256=entry.sha256,
        status=status,
        solver_status=solver_status,
        horizon=entry.used_sections,
        diagnostics=tuple(item for item in diagnostics if item),
        wall_time_seconds=wall_time,
    )


def _diagnostic_codes(value: object) -> Iterable[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return ()
    return (
        str(item.get("code", ""))
        for item in value
        if isinstance(item, Mapping) and item.get("code")
    )


def _nonnegative_float(value: object) -> float:
    try:
        result = float(value)  # type: ignore[arg-type]
    except TypeError, ValueError:
        return 0
    return max(0, result)


def _verify_legacy_checkout(root: Path) -> None:
    try:
        commit = subprocess.run(
            ("git", "rev-parse", "HEAD"),
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as exc:
        raise PlacementABError(f"legacy checkoutを確認できません: {root}") from exc
    if commit != LEGACY_SOLVER_COMMIT:
        raise PlacementABError(
            f"legacy checkoutが固定commitではありません: expected={LEGACY_SOLVER_COMMIT}, "
            f"actual={commit}"
        )


def _safe_key(key: PlacementTemplateKey) -> str:
    return (
        f"p{key.pool_count}-s{key.pool_size}-c{key.court_count}-"
        f"o{key.organizer_capacity}-f{key.day2_fallback.value}"
    )


def _write_record_checkpoint(path: Path, record: PlacementBaselineRecord) -> None:
    serialized = (
        json.dumps(record.model_dump(mode="json"), ensure_ascii=False, indent=2, sort_keys=True)
        + "\n"
    )
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(serialized, encoding="utf-8")
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()
