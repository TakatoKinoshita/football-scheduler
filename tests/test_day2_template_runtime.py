from __future__ import annotations

import json
from pathlib import Path

import pytest

import football_scheduler.day2_schedule as day2_schedule
import football_scheduler.placement_template_runtime as template_runtime
from football_scheduler.day2_schedule import Day2Schedule, Day2ScheduleRequest
from football_scheduler.models import SolverStatus
from football_scheduler.placement_template_contract import (
    PLACEMENT_OBJECTIVES,
    CanonicalMatchPosition,
    CanonicalRefereeAssignment,
    PlacementTemplateEntry,
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
from football_scheduler.placement_template_runtime import PlacementTemplateCatalogError
from football_scheduler.validator import validate_day2_schedule
from tests.test_day2_schedule import _request, _validation_document

_SUPPORTED_TOURNAMENT_CONFIGURATIONS = (
    (8, 2, 2),
    (8, 4, 2),
    (16, 2, 2),
    (16, 4, 2),
    (16, 8, 2),
    (24, 2, 3),
    (24, 4, 3),
    (24, 8, 3),
    (32, 2, 2),
    (32, 4, 2),
    (32, 8, 2),
    (32, 16, 2),
    (32, 2, 4),
    (32, 4, 4),
    (32, 8, 4),
)


@pytest.fixture(scope="module")
def available_template() -> tuple[Day2ScheduleRequest, PlacementTemplateEntry, Day2Schedule]:
    request, _plan = _request(max_time_seconds=20)
    solved = day2_schedule._generate_day2_schedule_with_solver(request)
    assert solved.status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}
    positions = _positions(request)
    metric_by_name = {stage.objective: stage for stage in solved.metrics.objective_stages}
    template_slots = tuple(
        PlacementTemplateSlot(
            section_no=slot.section_no,
            court_index=next(
                index for index, court in enumerate(request.courts) if court.id == slot.court_id
            ),
            match_position=positions[slot.match_id],
        )
        for slot in solved.slots
        if slot.match_id is not None
    )
    assignments = []
    for slot in solved.slots:
        if slot.match_id is None:
            continue
        assignment = slot.referee_assignment
        assert assignment is not None
        assignments.append(
            CanonicalRefereeAssignment(
                match_position=positions[slot.match_id],
                kind=assignment.kind.value,
                organizer_reason=assignment.organizer_reason,
                source_match_position=(
                    positions[assignment.source_match_id]
                    if assignment.source_match_id is not None
                    else None
                ),
                fallback_reasons=tuple(sorted(assignment.fallback_reasons)),
            )
        )
    assert solved.metrics.used_sections is not None
    entry = PlacementTemplateEntry(
        key=day2_schedule._placement_template_key(request),
        status=PlacementTemplateStatus.AVAILABLE,
        used_sections=solved.metrics.used_sections,
        slots=template_slots,
        objectives=tuple(
            PlacementTemplateObjective(
                objective=name,
                value=metric_by_name[name].value,
                optimality_proven=metric_by_name[name].optimality_proven,
            )
            for name in PLACEMENT_OBJECTIVES
        ),
        referee_signature=placement_referee_signature(assignments),
        provenance=PlacementTemplateProvenance(
            generator_version="test",
            python_version="3.14",
            ortools_version=solved.metrics.ortools_version,
        ),
    )
    return request, entry, solved


def test_available_template_hydrates_without_calling_solver(
    monkeypatch: pytest.MonkeyPatch,
    available_template: tuple[Day2ScheduleRequest, PlacementTemplateEntry, Day2Schedule],
) -> None:
    request, entry, solved = available_template
    monkeypatch.setattr(day2_schedule, "load_placement_template_entry", lambda _key: entry)
    monkeypatch.setattr(
        day2_schedule,
        "_generate_day2_schedule_with_solver",
        lambda _request: pytest.fail("CP-SAT fallback must not run"),
    )

    result = day2_schedule.generate_day2_schedule(request)

    assert result.status is solved.status
    assert [(slot.match_id, slot.section_no, slot.court_id) for slot in result.slots] == [
        (slot.match_id, slot.section_no, slot.court_id) for slot in solved.slots
    ]
    assert len(result.slots) == result.metrics.used_sections * len(request.courts)  # type: ignore[operator]
    assert result.metrics.objective_stages == solved.metrics.objective_stages
    report = validate_day2_schedule(_validation_document(request, result))
    assert report["valid"] is True, report


def test_available_template_preserves_resolved_annotations(
    monkeypatch: pytest.MonkeyPatch,
    available_template: tuple[Day2ScheduleRequest, PlacementTemplateEntry, Day2Schedule],
) -> None:
    _request_source, entry, _solved = available_template
    resolved_request, _plan = _request(resolved=True, max_time_seconds=20)
    monkeypatch.setattr(day2_schedule, "load_placement_template_entry", lambda _key: entry)

    result = day2_schedule.generate_day2_schedule(resolved_request)

    assert all(match.possible_team_ids for match in result.tournament_matches)
    assert all(route.team_id is not None for route in result.team_schedules)


def test_proven_infeasible_template_does_not_fallback(
    monkeypatch: pytest.MonkeyPatch,
    available_template: tuple[Day2ScheduleRequest, PlacementTemplateEntry, Day2Schedule],
) -> None:
    request, entry, _solved = available_template
    infeasible = PlacementTemplateEntry(
        key=entry.key,
        status=PlacementTemplateStatus.PROVEN_INFEASIBLE,
        provenance=entry.provenance,
    )
    monkeypatch.setattr(day2_schedule, "load_placement_template_entry", lambda _key: infeasible)
    monkeypatch.setattr(
        day2_schedule,
        "_generate_day2_schedule_with_solver",
        lambda _request: pytest.fail("proven infeasible must not fall back"),
    )

    result = day2_schedule.generate_day2_schedule(request)

    assert result.status is SolverStatus.INFEASIBLE
    assert result.diagnostics[0].code == "TOURNAMENT_SCHEDULE_INFEASIBLE"


def test_catalog_failure_warns_only_when_solver_fallback_succeeds(
    monkeypatch: pytest.MonkeyPatch,
    available_template: tuple[Day2ScheduleRequest, PlacementTemplateEntry, Day2Schedule],
) -> None:
    request, _entry, solved = available_template

    def missing(_key: object) -> PlacementTemplateEntry:
        raise PlacementTemplateCatalogError("catalog_missing", "test")

    monkeypatch.setattr(day2_schedule, "load_placement_template_entry", missing)
    monkeypatch.setattr(day2_schedule, "_generate_day2_schedule_with_solver", lambda _data: solved)

    result = day2_schedule.generate_day2_schedule(request)

    warning = result.diagnostics[-1]
    assert warning.code == "PLACEMENT_TEMPLATE_FALLBACK_USED"
    assert warning.details == {"reason": "catalog_missing"}


def test_horizon_below_template_minimum_returns_existing_diagnostic(
    monkeypatch: pytest.MonkeyPatch,
    available_template: tuple[Day2ScheduleRequest, PlacementTemplateEntry, Day2Schedule],
) -> None:
    request, entry, _solved = available_template
    assert entry.used_sections is not None
    minimum_sections = entry.used_sections + 1
    objectives = tuple(
        objective.model_copy(update={"value": minimum_sections})
        if objective.objective == "used_sections"
        else objective
        for objective in entry.objectives
    )
    short_horizon_entry = entry.model_copy(
        update={"used_sections": minimum_sections, "objectives": objectives}
    )
    limited = request.model_copy(
        update={"day": request.day.model_copy(update={"max_sections": entry.used_sections})}
    )
    monkeypatch.setattr(
        day2_schedule, "load_placement_template_entry", lambda _key: short_horizon_entry
    )
    monkeypatch.setattr(
        day2_schedule,
        "_generate_day2_schedule_with_solver",
        lambda _request: pytest.fail("short horizon must not fall back"),
    )

    result = day2_schedule.generate_day2_schedule(limited)

    assert result.status is SolverStatus.INFEASIBLE
    assert result.diagnostics[0].code == "TOURNAMENT_SCHEDULE_INFEASIBLE"
    assert result.diagnostics[0].details["minimum_sections"] == minimum_sections


def test_zero_organizer_capacity_keeps_existing_diagnostic(
    monkeypatch: pytest.MonkeyPatch,
    available_template: tuple[Day2ScheduleRequest, PlacementTemplateEntry, Day2Schedule],
) -> None:
    request, _entry, _solved = available_template
    zero = request.model_copy(
        update={
            "referees": request.referees.model_copy(update={"organizer_capacity": 0}),
        }
    )
    monkeypatch.setattr(
        day2_schedule,
        "load_placement_template_entry",
        lambda _key: pytest.fail("capacity zero must not load a template"),
    )

    result = day2_schedule.generate_day2_schedule(zero)

    assert result.status is SolverStatus.INFEASIBLE
    assert result.diagnostics[0].code == "ORGANIZER_CAPACITY_INSUFFICIENT"


def test_package_loader_validates_and_indexes_all_160_entries(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    resource_root = tmp_path / "placement_templates"
    resource_root.mkdir()
    manifest, shards = _catalog_documents()
    (resource_root / "manifest.json").write_text(
        json.dumps(manifest.model_dump(mode="json"), ensure_ascii=False),
        encoding="utf-8",
    )
    for reference, shard in zip(manifest.shards, shards, strict=True):
        (resource_root / reference.file).write_text(
            json.dumps(shard.model_dump(mode="json"), ensure_ascii=False),
            encoding="utf-8",
        )
    monkeypatch.setattr(template_runtime, "files", lambda _package: tmp_path)
    template_runtime.clear_placement_template_catalog_cache()


@pytest.mark.parametrize(
    ("team_count", "block_count", "tournament_count"),
    _SUPPORTED_TOURNAMENT_CONFIGURATIONS,
)
@pytest.mark.parametrize("random_seed", (17, 101, 20260803))
@pytest.mark.parametrize("resolved", (False, True))
def test_all_supported_tournaments_use_catalog_without_solver(
    monkeypatch: pytest.MonkeyPatch,
    team_count: int,
    block_count: int,
    tournament_count: int,
    random_seed: int,
    resolved: bool,
) -> None:
    request, _plan = _request(
        team_count=team_count,
        block_count=block_count,
        tournament_count=tournament_count,
        court_count=4,
        organizer_capacity=4,
        resolved=resolved,
        max_sections=80,
        random_seed=random_seed,
    )
    monkeypatch.setattr(
        day2_schedule,
        "_generate_day2_schedule_with_solver",
        lambda _request: pytest.fail("収録済みキーでCP-SAT fallbackを呼びました"),
    )

    result = day2_schedule.generate_day2_schedule(request)

    assert result.status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}
    assert all(item.code != "PLACEMENT_TEMPLATE_FALLBACK_USED" for item in result.diagnostics)
    report = validate_day2_schedule(_validation_document(request, result))
    assert report["valid"] is True, report

    catalog = template_runtime.load_placement_template_catalog()

    assert len(catalog.entries_by_id) == 160
    assert all(catalog.entry_for(key).key == key for key in expected_placement_template_keys())
    template_runtime.clear_placement_template_catalog_cache()


def _positions(request: Day2ScheduleRequest) -> dict[str, CanonicalMatchPosition]:
    result: dict[str, CanonicalMatchPosition] = {}
    for pool in request.tournament_plan.pools:
        assert pool.logical_layout is not None
        for position in pool.logical_layout.match_positions:
            result[position.match_id] = CanonicalMatchPosition(
                pool_index=pool.pool_index,
                rank_range_start=position.rank_range[0],
                rank_range_end=position.rank_range[1],
                logical_order=position.order,
            )
    return result


def _catalog_documents() -> tuple[
    PlacementTemplateManifest,
    tuple[PlacementTemplateShard, ...],
]:
    provenance = PlacementTemplateProvenance(
        generator_version="test",
        python_version="3.14",
        ortools_version="9.15",
    )
    entries = []
    for key in expected_placement_template_keys():
        entry = PlacementTemplateEntry(
            key=key,
            status=PlacementTemplateStatus.PROVEN_INFEASIBLE,
            provenance=provenance,
        )
        entries.append(entry.model_copy(update={"sha256": placement_entry_digest(entry)}))
    shards = []
    references = []
    for pool_count, pool_size in ((2, 4), (2, 8), (3, 8), (2, 16), (4, 8)):
        shard = PlacementTemplateShard(
            pool_count=pool_count,
            pool_size=pool_size,
            entries=tuple(
                entry
                for entry in entries
                if (entry.key.pool_count, entry.key.pool_size) == (pool_count, pool_size)
            ),
        )
        shard = shard.model_copy(update={"sha256": placement_shard_digest(shard)})
        shards.append(shard)
        references.append(
            PlacementTemplateShardReference(
                pool_count=pool_count,
                pool_size=pool_size,
                file=f"p{pool_count}-s{pool_size}.json",
                entry_count=len(shard.entries),
                sha256=shard.sha256,
            )
        )
    manifest = PlacementTemplateManifest(
        generator_version="test",
        python_version="3.14",
        ortools_version="9.15",
        shards=tuple(references),
    )
    manifest = manifest.model_copy(update={"catalog_sha256": manifest_digest(manifest)})
    return manifest, tuple(shards)
