"""順位決定トーナメント日程テンプレートの内部保存契約。"""

from __future__ import annotations

import json
from enum import StrEnum
from hashlib import sha256
from typing import Annotated, Literal, Self

from pydantic import Field, model_validator

from football_scheduler.models import ContractModel, Day2Fallback, Identifier, NonEmptyText

TEMPLATE_FORMAT_VERSION: Literal[1] = 1
PLACEMENT_RULESET_ID: Literal["placement-schedule-v1"] = "placement-schedule-v1"
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


class PlacementTemplateObjective(ContractModel):
    objective: Identifier
    value: Annotated[int, Field(ge=0)]
    optimality_proven: bool


class PlacementTemplateProvenance(ContractModel):
    generator_version: NonEmptyText
    python_version: NonEmptyText
    ortools_version: NonEmptyText


class PlacementTemplateEntry(ContractModel):
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
            if not self.referee_signature:
                raise ValueError("テンプレートの審判署名が必要です")
        elif self.used_sections is not None or self.slots or self.objectives:
            raise ValueError("実行不能テンプレートに配置情報は保存できません")
        if self.sha256 and self.sha256 != placement_entry_digest(self):
            raise ValueError("テンプレートのSHA-256が一致しません")
        return self


class PlacementTemplateShardReference(ContractModel):
    pool_count: Annotated[int, Field(gt=0)]
    pool_size: Annotated[int, Field(gt=1)]
    file: NonEmptyText
    entry_count: Annotated[int, Field(gt=0)]
    sha256: NonEmptyText


class PlacementTemplateManifest(ContractModel):
    format_version: Literal[1] = TEMPLATE_FORMAT_VERSION
    ruleset_id: Literal["placement-schedule-v1"] = PLACEMENT_RULESET_ID
    generator_version: NonEmptyText
    python_version: NonEmptyText
    ortools_version: NonEmptyText
    total_entry_count: Literal[1360] = 1360
    shards: tuple[PlacementTemplateShardReference, ...]
    catalog_sha256: NonEmptyText


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
