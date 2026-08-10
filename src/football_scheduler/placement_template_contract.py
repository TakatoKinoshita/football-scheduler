"""順位決定トーナメント日程テンプレートの内部保存契約。"""

from __future__ import annotations

import json
from collections.abc import Iterable
from enum import StrEnum
from hashlib import sha256
from typing import Annotated, Literal, Self

from pydantic import Field, model_validator

from football_scheduler.models import (
    ContractModel,
    Day2Fallback,
    Identifier,
    NonEmptyText,
    SolverStatus,
)

TEMPLATE_FORMAT_VERSION: Literal[1] = 1
PLACEMENT_RULESET_ID: Literal["placement-schedule-v1"] = "placement-schedule-v1"
LOWER_OBJECTIVE_OPTIMIZER_VERSION: Literal["placement-lower-objective-optimizer-v1"] = (
    "placement-lower-objective-optimizer-v1"
)
SUPPORTED_PLACEMENT_TOPOLOGIES: tuple[tuple[int, int], ...] = (
    (2, 4),
    (2, 8),
    (3, 8),
    (2, 16),
    (4, 8),
)
PLACEMENT_OBJECTIVES: tuple[str, ...] = (
    "used_sections",
    "non_primary_final_max_gap",
    "non_primary_final_sum_gap",
    "maximum_team_wait_sections",
    "team_court_change_count",
    "court_usage_difference",
)
Sha256Digest = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
OptimizationProofMethod = Literal[
    "existing",
    "analytic_lower_bound",
    "section_relaxation_exact_completion",
    "full_exact",
    "unproven",
]


class PlacementTemplateStatus(StrEnum):
    AVAILABLE = "available"
    PROVEN_INFEASIBLE = "proven_infeasible"


class PlacementTemplateKey(ContractModel):
    ruleset_id: Literal["placement-schedule-v1"] = PLACEMENT_RULESET_ID
    pool_count: Annotated[int, Field(gt=0)]
    pool_size: Annotated[int, Field(gt=1)]
    court_count: Annotated[int, Field(ge=1, le=16)]
    organizer_capacity: Annotated[int, Field(ge=1, le=16)]
    day2_fallback: Day2Fallback

    @model_validator(mode="after")
    def validate_supported_key(self) -> Self:
        if (self.pool_count, self.pool_size) not in SUPPORTED_PLACEMENT_TOPOLOGIES:
            raise ValueError("未対応の順位決定トーナメント構成です")
        if self.organizer_capacity > self.court_count:
            raise ValueError("正規化済み主催者審判数はコート数以下にしてください")
        return self

    @property
    def catalog_id(self) -> str:
        return (
            f"{self.ruleset_id}:p{self.pool_count}:s{self.pool_size}:"
            f"c{self.court_count}:o{self.organizer_capacity}:f{self.day2_fallback.value}"
        )

    @classmethod
    def normalized(
        cls,
        *,
        pool_count: int,
        pool_size: int,
        court_count: int,
        organizer_capacity: int,
        day2_fallback: Day2Fallback,
    ) -> Self:
        if organizer_capacity <= 0:
            raise ValueError("主催者審判数が0の構成はテンプレート化しません")
        return cls(
            pool_count=pool_count,
            pool_size=pool_size,
            court_count=court_count,
            organizer_capacity=min(organizer_capacity, court_count),
            day2_fallback=day2_fallback,
        )


class CanonicalMatchPosition(ContractModel):
    pool_index: Annotated[int, Field(gt=0)]
    rank_range_start: Annotated[int, Field(gt=0)]
    rank_range_end: Annotated[int, Field(gt=0)]
    logical_order: Annotated[int, Field(gt=0)]

    @model_validator(mode="after")
    def validate_range(self) -> Self:
        if self.rank_range_end < self.rank_range_start:
            raise ValueError("試合位置の順位範囲が逆転しています")
        return self


class PlacementTemplateSlot(ContractModel):
    section_no: Annotated[int, Field(gt=0)]
    court_index: Annotated[int, Field(ge=0, le=15)]
    match_position: CanonicalMatchPosition


class CanonicalRefereeAssignment(ContractModel):
    match_position: CanonicalMatchPosition
    kind: Literal["organizer", "team"]
    organizer_reason: str | None = None
    source_match_position: CanonicalMatchPosition | None = None
    fallback_reasons: tuple[str, ...] = ()

    @model_validator(mode="after")
    def validate_assignment(self) -> Self:
        if self.kind == "team" and self.source_match_position is None:
            raise ValueError("チーム審判には供給元試合位置が必要です")
        if self.kind == "organizer" and self.source_match_position is not None:
            raise ValueError("主催者審判に供給元試合位置は指定できません")
        if self.fallback_reasons != tuple(sorted(self.fallback_reasons)):
            raise ValueError("審判フォールバック理由は安定順で保存してください")
        return self


class PlacementTemplateObjective(ContractModel):
    objective: Identifier
    value: Annotated[int, Field(ge=0)]
    optimality_proven: bool


class PlacementTemplateProvenance(ContractModel):
    generator_version: NonEmptyText
    python_version: NonEmptyText
    ortools_version: NonEmptyText
    optimization_version: Literal["placement-lower-objective-optimizer-v1"] | None = Field(
        default=None,
        exclude_if=lambda value: value is None,
    )


class PlacementTemplateEntry(ContractModel):
    format_version: Literal[1] = TEMPLATE_FORMAT_VERSION
    key: PlacementTemplateKey
    status: PlacementTemplateStatus
    used_sections: Annotated[int, Field(gt=0)] | None = None
    slots: tuple[PlacementTemplateSlot, ...] = ()
    objectives: tuple[PlacementTemplateObjective, ...] = ()
    referee_signature: str = ""
    provenance: PlacementTemplateProvenance
    sha256: str = ""

    @model_validator(mode="after")
    def validate_outcome(self) -> Self:
        if self.status is PlacementTemplateStatus.AVAILABLE:
            if self.used_sections is None or not self.slots:
                raise ValueError("利用可能テンプレートには配置が必要です")
            if any(slot.court_index >= self.key.court_count for slot in self.slots):
                raise ValueError("テンプレートのコートindexが構成範囲外です")
            if any(slot.section_no > self.used_sections for slot in self.slots):
                raise ValueError("テンプレートのセクションが使用範囲外です")
            if len({slot.match_position.model_dump_json() for slot in self.slots}) != len(
                self.slots
            ):
                raise ValueError("テンプレートの試合位置が重複しています")
            objective_names = tuple(item.objective for item in self.objectives)
            if objective_names != PLACEMENT_OBJECTIVES:
                raise ValueError("テンプレートの目的順が規則と一致しません")
            primary = self.objectives[0]
            if primary.value != self.used_sections or not primary.optimality_proven:
                raise ValueError("使用セクション数の最適性証明が必要です")
            proof_flags = tuple(item.optimality_proven for item in self.objectives)
            if any(
                proof_flags[index] and not proof_flags[index - 1]
                for index in range(1, len(proof_flags))
            ):
                raise ValueError("目的の最適性証明はtrueの連続prefixにしてください")
            if not self.referee_signature:
                raise ValueError("テンプレートの審判署名が必要です")
        elif self.used_sections is not None or self.slots or self.objectives:
            raise ValueError("実行不能テンプレートに配置情報は保存できません")
        if self.sha256 and self.sha256 != placement_entry_digest(self):
            raise ValueError("テンプレートのSHA-256が一致しません")
        return self


class PlacementOptimizationStageCheckpoint(ContractModel):
    """下位目的optimizerのkey・目的段階ごとの再開可能な正本。"""

    format_version: Literal[1] = 1
    optimization_version: Literal["placement-lower-objective-optimizer-v1"] = (
        LOWER_OBJECTIVE_OPTIMIZER_VERSION
    )
    key: PlacementTemplateKey
    stage_index: Annotated[int, Field(ge=0, le=5)]
    objective: Identifier
    input_entry_sha256: Sha256Digest
    candidate: PlacementTemplateEntry
    status: SolverStatus
    value: Annotated[int, Field(ge=0)]
    optimality_proven: bool
    proof_method: OptimizationProofMethod
    best_bound: float | None = None
    wall_time_seconds: Annotated[float, Field(ge=0)] = 0
    model_fingerprint: Sha256Digest
    sha256: str = ""

    @model_validator(mode="after")
    def validate_stage(self) -> Self:
        if self.objective != PLACEMENT_OBJECTIVES[self.stage_index]:
            raise ValueError("checkpointの目的と段階番号が一致しません")
        if self.candidate.key != self.key:
            raise ValueError("checkpointのkeyとcandidateが一致しません")
        candidate_values = {item.objective: item.value for item in self.candidate.objectives}
        if candidate_values.get(self.objective) != self.value:
            raise ValueError("checkpointの目的値とcandidateが一致しません")
        candidate_proof = self.candidate.objectives[self.stage_index].optimality_proven
        if candidate_proof != self.optimality_proven:
            raise ValueError("checkpointの証明状態とcandidateが一致しません")
        if self.optimality_proven and self.proof_method == "unproven":
            raise ValueError("証明済みcheckpointにunprovenは指定できません")
        if not self.optimality_proven and self.proof_method != "unproven":
            raise ValueError("未証明checkpointのproof_methodはunprovenにしてください")
        if self.sha256 and self.sha256 != placement_optimization_checkpoint_digest(self):
            raise ValueError("最適化checkpointのSHA-256が一致しません")
        return self


class PlacementTemplateShardReference(ContractModel):
    pool_count: Annotated[int, Field(gt=0)]
    pool_size: Annotated[int, Field(gt=1)]
    file: NonEmptyText
    entry_count: Annotated[int, Field(gt=0)]
    sha256: Sha256Digest


class PlacementTemplateShard(ContractModel):
    format_version: Literal[1] = TEMPLATE_FORMAT_VERSION
    ruleset_id: Literal["placement-schedule-v1"] = PLACEMENT_RULESET_ID
    pool_count: Annotated[int, Field(gt=0)]
    pool_size: Annotated[int, Field(gt=1)]
    entries: tuple[PlacementTemplateEntry, ...]
    sha256: str = ""

    @model_validator(mode="after")
    def validate_entries(self) -> Self:
        topology = (self.pool_count, self.pool_size)
        if topology not in SUPPORTED_PLACEMENT_TOPOLOGIES:
            raise ValueError("未対応のテンプレートshardです")
        if len(self.entries) != 272:
            raise ValueError("各トポロジーのshardには272キーが必要です")
        entry_ids = [entry.key.catalog_id for entry in self.entries]
        if len(set(entry_ids)) != len(entry_ids):
            raise ValueError("テンプレートshardのキーが重複しています")
        if any((entry.key.pool_count, entry.key.pool_size) != topology for entry in self.entries):
            raise ValueError("テンプレートshardとentryのトポロジーが一致しません")
        if any(not entry.sha256 for entry in self.entries):
            raise ValueError("テンプレートentryにSHA-256が必要です")
        expected_ids = {
            key.catalog_id
            for key in expected_placement_template_keys()
            if (key.pool_count, key.pool_size) == topology
        }
        if set(entry_ids) != expected_ids:
            raise ValueError("テンプレートshardのキー範囲が一致しません")
        if self.sha256 and (
            not _is_sha256(self.sha256) or self.sha256 != placement_shard_digest(self)
        ):
            raise ValueError("テンプレートshardのSHA-256が一致しません")
        return self


class PlacementTemplateManifest(ContractModel):
    format_version: Literal[1] = TEMPLATE_FORMAT_VERSION
    ruleset_id: Literal["placement-schedule-v1"] = PLACEMENT_RULESET_ID
    generator_version: NonEmptyText
    python_version: NonEmptyText
    ortools_version: NonEmptyText
    total_entry_count: Literal[1360] = 1360
    shards: tuple[PlacementTemplateShardReference, ...]
    catalog_sha256: str = ""

    @model_validator(mode="after")
    def validate_coverage(self) -> Self:
        topologies = [(item.pool_count, item.pool_size) for item in self.shards]
        if tuple(topologies) != SUPPORTED_PLACEMENT_TOPOLOGIES:
            raise ValueError("manifestのshard順またはトポロジー範囲が一致しません")
        if sum(item.entry_count for item in self.shards) != self.total_entry_count:
            raise ValueError("manifestのentry件数が一致しません")
        if len({item.file for item in self.shards}) != len(self.shards):
            raise ValueError("manifestのshardファイルが重複しています")
        if self.catalog_sha256 and (
            not _is_sha256(self.catalog_sha256) or self.catalog_sha256 != manifest_digest(self)
        ):
            raise ValueError("catalog root SHA-256が一致しません")
        return self


def expected_placement_template_keys() -> tuple[PlacementTemplateKey, ...]:
    return tuple(
        PlacementTemplateKey(
            pool_count=pool_count,
            pool_size=pool_size,
            court_count=court_count,
            organizer_capacity=organizer_capacity,
            day2_fallback=fallback,
        )
        for pool_count, pool_size in SUPPORTED_PLACEMENT_TOPOLOGIES
        for court_count in range(1, 17)
        for organizer_capacity in range(1, court_count + 1)
        for fallback in Day2Fallback
    )


def canonical_json_bytes(value: object) -> bytes:
    if isinstance(value, ContractModel):
        value = value.model_dump(mode="json")
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()


def sha256_hex(value: object) -> str:
    return sha256(canonical_json_bytes(value)).hexdigest()


def placement_entry_digest(entry: PlacementTemplateEntry) -> str:
    payload = entry.model_dump(mode="json", exclude={"sha256"})
    return sha256_hex(payload)


def placement_optimization_checkpoint_digest(
    checkpoint: PlacementOptimizationStageCheckpoint,
) -> str:
    payload = checkpoint.model_dump(mode="json", exclude={"sha256"})
    return sha256_hex(payload)


def placement_shard_digest(shard: PlacementTemplateShard) -> str:
    """shardの自己digestを除いたcanonical parsed JSONのSHA-256を返す。"""

    payload = shard.model_dump(mode="json", exclude={"sha256"})
    return sha256_hex(payload)


def manifest_digest(manifest: PlacementTemplateManifest) -> str:
    """root digestを除いたmanifestのcanonical parsed JSONのSHA-256を返す。"""

    payload = manifest.model_dump(mode="json", exclude={"catalog_sha256"})
    return sha256_hex(payload)


def placement_referee_signature(
    assignments: Iterable[CanonicalRefereeAssignment],
) -> str:
    """canonical試合位置順の審判割当てSHA-256を返す。"""

    records = sorted(
        assignments,
        key=lambda item: (
            item.match_position.pool_index,
            item.match_position.rank_range_start,
            item.match_position.rank_range_end,
            item.match_position.logical_order,
        ),
    )
    return sha256_hex([item.model_dump(mode="json") for item in records])


def _is_sha256(value: str) -> bool:
    return len(value) == 64 and all(character in "0123456789abcdef" for character in value)
