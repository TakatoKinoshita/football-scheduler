"""順位決定トーナメント日程テンプレートの読込み境界。"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from functools import cache
from importlib.resources import files
from types import MappingProxyType
from typing import Any, Literal

from pydantic import ValidationError

from football_scheduler.placement_template_contract import (
    PLACEMENT_RULESET_ID,
    SUPPORTED_PLACEMENT_TOPOLOGIES,
    TEMPLATE_FORMAT_VERSION,
    PlacementTemplateEntry,
    PlacementTemplateKey,
    PlacementTemplateManifest,
    PlacementTemplateShard,
    expected_placement_template_keys,
    manifest_digest,
    placement_entry_digest,
    placement_shard_digest,
    sha256_hex,
)

_RESOURCE_DIRECTORY = "placement_templates"
_MANIFEST_FILE = "manifest.json"
_EXPECTED_SHARD_ENTRY_COUNT = 32
_EXPECTED_CATALOG_ENTRY_COUNT = 160

CatalogFailureReason = Literal[
    "catalog_missing",
    "catalog_load_failed",
    "catalog_version_mismatch",
    "catalog_digest_mismatch",
    "catalog_coverage_mismatch",
    "catalog_topology_inconsistent",
]


class PlacementTemplateCatalogError(RuntimeError):
    """カタログを安全に利用できないときの内部エラー。"""

    def __init__(self, reason: CatalogFailureReason, detail: str) -> None:
        super().__init__(detail)
        self.reason = reason
        self.detail = detail


@dataclass(frozen=True, slots=True)
class PlacementTemplateCatalog:
    """全shardを検証済みの不変カタログ。"""

    manifest: PlacementTemplateManifest
    entries_by_id: Mapping[str, PlacementTemplateEntry]

    def entry_for(self, key: PlacementTemplateKey) -> PlacementTemplateEntry:
        try:
            return self.entries_by_id[key.catalog_id]
        except KeyError as exc:
            raise PlacementTemplateCatalogError(
                "catalog_coverage_mismatch",
                f"テンプレートキーがカタログにありません: {key.catalog_id}",
            ) from exc


CatalogLoader = Callable[[], PlacementTemplateCatalog]


def load_placement_template_entry(
    key: PlacementTemplateKey,
    *,
    catalog_loader: CatalogLoader | None = None,
) -> PlacementTemplateEntry:
    """検証済みカタログから1キーを返す。

    ``catalog_loader`` は、生成済みリソースがまだない段階でもruntimeを単体検証できる
    差し替え境界である。
    """

    loader = catalog_loader or load_placement_template_catalog
    return loader().entry_for(key)


def load_placement_template_catalog() -> PlacementTemplateCatalog:
    """package resourceのカタログを一度だけ読み込み、失敗結果もキャッシュする。"""

    loaded = _load_placement_template_catalog_cached()
    if isinstance(loaded, PlacementTemplateCatalogError):
        raise PlacementTemplateCatalogError(loaded.reason, loaded.detail)
    return loaded


def clear_placement_template_catalog_cache() -> None:
    """テストやパッケージ差替え後にpackage resource cacheを破棄する。"""

    _load_placement_template_catalog_cached.cache_clear()


@cache
def _load_placement_template_catalog_cached() -> (
    PlacementTemplateCatalog | PlacementTemplateCatalogError
):
    try:
        return _read_and_validate_catalog()
    except PlacementTemplateCatalogError as exc:
        return exc


def _read_and_validate_catalog() -> PlacementTemplateCatalog:
    resource_root = files("football_scheduler").joinpath(_RESOURCE_DIRECTORY)
    manifest_raw = _read_json_resource(resource_root.joinpath(_MANIFEST_FILE), manifest=True)
    _validate_version_fields(manifest_raw, level="manifest")
    manifest = _validate_manifest(manifest_raw)

    entries: dict[str, PlacementTemplateEntry] = {}
    for reference in manifest.shards:
        if reference.entry_count != _EXPECTED_SHARD_ENTRY_COUNT:
            raise PlacementTemplateCatalogError(
                "catalog_coverage_mismatch",
                "manifestのshard entry件数が32ではありません。",
            )
        if "/" in reference.file or "\\" in reference.file or reference.file in {".", ".."}:
            raise PlacementTemplateCatalogError(
                "catalog_load_failed",
                "manifestのshardファイル名が不正です。",
            )
        shard_raw = _read_json_resource(resource_root.joinpath(reference.file), manifest=False)
        _validate_version_fields(shard_raw, level="shard")
        raw_entries = shard_raw.get("entries")
        if not isinstance(raw_entries, list):
            raise PlacementTemplateCatalogError(
                "catalog_load_failed",
                "テンプレートshardのentriesが配列ではありません。",
            )
        if len(raw_entries) != _EXPECTED_SHARD_ENTRY_COUNT:
            raise PlacementTemplateCatalogError(
                "catalog_coverage_mismatch",
                "テンプレートshardのentry件数が32ではありません。",
            )
        for raw_entry in raw_entries:
            if not isinstance(raw_entry, dict):
                raise PlacementTemplateCatalogError(
                    "catalog_load_failed",
                    "テンプレートentryがJSON objectではありません。",
                )
            _validate_version_fields(raw_entry, level="entry")
            _validate_raw_digest(raw_entry, digest_field="sha256", level="entry")

        _validate_raw_digest(shard_raw, digest_field="sha256", level="shard")
        shard = _validate_shard(shard_raw)
        topology = (reference.pool_count, reference.pool_size)
        if (shard.pool_count, shard.pool_size) != topology:
            raise PlacementTemplateCatalogError(
                "catalog_topology_inconsistent",
                "manifestとshardのトポロジーが一致しません。",
            )
        shard_digest = placement_shard_digest(shard)
        if not shard.sha256 or shard.sha256 != shard_digest or reference.sha256 != shard_digest:
            raise PlacementTemplateCatalogError(
                "catalog_digest_mismatch",
                "テンプレートshardのSHA-256が一致しません。",
            )
        if len(shard.entries) != reference.entry_count:
            raise PlacementTemplateCatalogError(
                "catalog_coverage_mismatch",
                "manifestとshardのentry件数が一致しません。",
            )
        for entry in shard.entries:
            if not entry.sha256 or entry.sha256 != placement_entry_digest(entry):
                raise PlacementTemplateCatalogError(
                    "catalog_digest_mismatch",
                    "テンプレートentryのSHA-256が一致しません。",
                )
            if entry.key.catalog_id in entries:
                raise PlacementTemplateCatalogError(
                    "catalog_coverage_mismatch",
                    "テンプレートentryのキーがshard間で重複しています。",
                )
            entries[entry.key.catalog_id] = entry

    expected_ids = {key.catalog_id for key in expected_placement_template_keys()}
    if (
        manifest.total_entry_count != _EXPECTED_CATALOG_ENTRY_COUNT
        or len(entries) != _EXPECTED_CATALOG_ENTRY_COUNT
        or set(entries) != expected_ids
    ):
        raise PlacementTemplateCatalogError(
            "catalog_coverage_mismatch",
            "テンプレートカタログが160キーを完全に収録していません。",
        )
    return PlacementTemplateCatalog(
        manifest=manifest,
        entries_by_id=MappingProxyType(entries),
    )


def _read_json_resource(resource: Any, *, manifest: bool) -> dict[str, Any]:
    try:
        raw_bytes = resource.read_bytes()
    except FileNotFoundError as exc:
        reason: CatalogFailureReason = "catalog_missing" if manifest else "catalog_load_failed"
        raise PlacementTemplateCatalogError(reason, "テンプレートリソースがありません。") from exc
    except OSError as exc:
        raise PlacementTemplateCatalogError(
            "catalog_load_failed", "テンプレートリソースを読み込めません。"
        ) from exc
    try:
        value = json.loads(raw_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PlacementTemplateCatalogError(
            "catalog_load_failed", "テンプレートリソースが正しいJSONではありません。"
        ) from exc
    if not isinstance(value, dict):
        raise PlacementTemplateCatalogError(
            "catalog_load_failed", "テンプレートリソースのルートがJSON objectではありません。"
        )
    return value


def _validate_version_fields(value: Mapping[str, Any], *, level: str) -> None:
    if value.get("format_version") != TEMPLATE_FORMAT_VERSION or (
        level != "entry" and value.get("ruleset_id") != PLACEMENT_RULESET_ID
    ):
        raise PlacementTemplateCatalogError(
            "catalog_version_mismatch",
            f"テンプレート{level}のversionまたはrulesetが一致しません。",
        )
    if level == "entry":
        key = value.get("key")
        if not isinstance(key, dict) or key.get("ruleset_id") != PLACEMENT_RULESET_ID:
            raise PlacementTemplateCatalogError(
                "catalog_version_mismatch",
                "テンプレートentry keyのrulesetが一致しません。",
            )


def _validate_manifest(value: Mapping[str, Any]) -> PlacementTemplateManifest:
    _validate_raw_digest(value, digest_field="catalog_sha256", level="manifest")
    if value.get("total_entry_count") != _EXPECTED_CATALOG_ENTRY_COUNT:
        raise PlacementTemplateCatalogError(
            "catalog_coverage_mismatch", "テンプレートmanifestの総entry件数が不正です。"
        )
    raw_shards = value.get("shards")
    if not isinstance(raw_shards, list) or len(raw_shards) != len(SUPPORTED_PLACEMENT_TOPOLOGIES):
        raise PlacementTemplateCatalogError(
            "catalog_coverage_mismatch", "テンプレートmanifestのshard範囲が不正です。"
        )
    expected_topologies = list(SUPPORTED_PLACEMENT_TOPOLOGIES)
    actual_topologies = [
        (item.get("pool_count"), item.get("pool_size"))
        for item in raw_shards
        if isinstance(item, dict)
    ]
    if actual_topologies != expected_topologies or any(
        not isinstance(item, dict) or item.get("entry_count") != _EXPECTED_SHARD_ENTRY_COUNT
        for item in raw_shards
    ):
        raise PlacementTemplateCatalogError(
            "catalog_coverage_mismatch", "テンプレートmanifestのトポロジー範囲が不正です。"
        )
    try:
        manifest = PlacementTemplateManifest.model_validate(value)
    except ValidationError as exc:
        raise PlacementTemplateCatalogError(
            "catalog_load_failed", "テンプレートmanifestの契約が不正です。"
        ) from exc
    if tuple((item.pool_count, item.pool_size) for item in manifest.shards) != (
        SUPPORTED_PLACEMENT_TOPOLOGIES
    ):
        raise PlacementTemplateCatalogError(
            "catalog_coverage_mismatch", "テンプレートmanifestのトポロジー範囲が不正です。"
        )
    if not manifest.catalog_sha256 or manifest.catalog_sha256 != manifest_digest(manifest):
        raise PlacementTemplateCatalogError(
            "catalog_digest_mismatch", "テンプレートmanifestのSHA-256が一致しません。"
        )
    return manifest


def _validate_shard(value: Mapping[str, Any]) -> PlacementTemplateShard:
    try:
        return PlacementTemplateShard.model_validate(value)
    except ValidationError as exc:
        raise PlacementTemplateCatalogError(
            "catalog_load_failed", "テンプレートshardの契約が不正です。"
        ) from exc


def _validate_raw_digest(
    value: Mapping[str, Any],
    *,
    digest_field: str,
    level: str,
) -> None:
    actual = value.get(digest_field)
    expected = sha256_hex({key: item for key, item in value.items() if key != digest_field})
    if not isinstance(actual, str) or actual != expected:
        raise PlacementTemplateCatalogError(
            "catalog_digest_mismatch", f"テンプレート{level}のSHA-256が一致しません。"
        )
