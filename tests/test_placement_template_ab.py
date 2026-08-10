from __future__ import annotations

import sys
from pathlib import Path

import pytest

from football_scheduler import day2_schedule
from football_scheduler.placement_template_ab import (
    LEGACY_SOLVER_COMMIT,
    BaselineRecordStatus,
    BaselineSource,
    LegacyPlacementWorker,
    LexicographicResult,
    PlacementBaselineEnvironment,
    PlacementBaselineFixture,
    PrimaryProofConflict,
    baseline_candidate_for,
    canonicalize_and_reaudit,
    classify_legacy_response,
    compare_baselines,
    compare_objective_vectors,
    current_baseline_record,
    read_deterministic_gzip,
    with_fixture_digest,
    write_deterministic_gzip,
)
from football_scheduler.placement_template_contract import (
    PlacementTemplateEntry,
    PlacementTemplateKey,
    placement_entry_digest,
)
from football_scheduler.placement_template_generator import StabilizedPlacementTemplateSolver
from football_scheduler.placement_template_runtime import load_placement_template_entry


def _entry() -> object:
    return load_placement_template_entry(
        PlacementTemplateKey(
            pool_count=2,
            pool_size=4,
            court_count=2,
            organizer_capacity=2,
            day2_fallback="organizer",
        )
    )


def _current_schedule(entry: object) -> object:
    factory = StabilizedPlacementTemplateSolver(max_time_seconds=1)
    request = factory._base_request(entry.key)  # type: ignore[attr-defined]
    request = request.model_copy(
        update={"day": request.day.model_copy(update={"max_sections": entry.used_sections})}  # type: ignore[attr-defined]
    )
    path_model = day2_schedule._build_path_model(request.tournament_plan)
    return day2_schedule._generate_day2_schedule_from_template(
        request,
        path_model,
        entry.used_sections,  # type: ignore[attr-defined]
        entry,
    )


def _fixture(record: object) -> PlacementBaselineFixture:
    return with_fixture_digest(
        PlacementBaselineFixture(
            source=BaselineSource.CURRENT,
            topologies=((2, 4),),
            environment=PlacementBaselineEnvironment(
                commit_sha="a" * 40,
                python_version="3.14.2",
                ortools_version="9.15.6755",
                max_time_seconds=30,
            ),
            complete=False,
            records=(record,),  # type: ignore[arg-type]
        )
    )


def test_legacy_schedule_is_canonicalized_and_reaudited_with_current_rules() -> None:
    entry = _entry()
    schedule = _current_schedule(entry)

    candidate, normalized_sha = canonicalize_and_reaudit(
        entry,  # type: ignore[arg-type]
        schedule.model_dump(mode="json"),  # type: ignore[attr-defined]
    )

    assert tuple(item.value for item in candidate.objectives) == tuple(
        item.value
        for item in entry.objectives  # type: ignore[attr-defined]
    )
    assert candidate.objectives[0].optimality_proven is True
    assert all(not item.optimality_proven for item in candidate.objectives[1:])
    assert len(normalized_sha) == 64


def test_shorter_legacy_result_stops_on_primary_proof_conflict() -> None:
    entry = _entry()
    schedule = _current_schedule(entry).model_dump(mode="json")  # type: ignore[attr-defined]
    schedule["slots"] = [
        {**slot, "section_no": max(1, slot["section_no"] - 1)} for slot in schedule["slots"]
    ]

    with pytest.raises(PrimaryProofConflict):
        canonicalize_and_reaudit(entry, schedule)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("solver_status", "diagnostics", "expected"),
    (
        ("UNKNOWN", (), BaselineRecordStatus.TIMEOUT),
        (
            "INFEASIBLE",
            ({"code": "TOURNAMENT_SCHEDULE_INFEASIBLE"},),
            BaselineRecordStatus.INFEASIBLE,
        ),
        ("BROKEN", (), BaselineRecordStatus.ERROR),
    ),
)
def test_legacy_statuses_are_classified_separately(
    solver_status: str,
    diagnostics: tuple[dict[str, str], ...],
    expected: BaselineRecordStatus,
) -> None:
    record = classify_legacy_response(
        _entry(),  # type: ignore[arg-type]
        {
            "type": "result",
            "solver_status": solver_status,
            "diagnostics": diagnostics,
            "wall_time_seconds": 1.25,
        },
    )

    assert record.status is expected
    assert record.objective_values is None
    assert record.candidate is None


def test_fixture_gzip_is_canonical_and_mtime_zero(tmp_path: Path) -> None:
    fixture = _fixture(current_baseline_record(_entry()))  # type: ignore[arg-type]
    first = tmp_path / "first.json.gz"
    second = tmp_path / "second.json.gz"

    write_deterministic_gzip(first, fixture)
    write_deterministic_gzip(second, fixture)

    assert first.read_bytes() == second.read_bytes()
    assert first.read_bytes()[4:8] == b"\x00\x00\x00\x00"
    assert read_deterministic_gzip(first) == fixture
    assert baseline_candidate_for(fixture, _entry()) == fixture.records[0].candidate  # type: ignore[arg-type]


def test_lexicographic_comparison_and_report_count_only_available_records() -> None:
    record = current_baseline_record(_entry())  # type: ignore[arg-type]
    baseline = _fixture(record)
    changed_candidate = record.candidate.model_copy(  # type: ignore[union-attr]
        update={
            "objectives": tuple(
                objective.model_copy(update={"value": objective.value + (1 if index == 1 else 0)})
                for index, objective in enumerate(record.candidate.objectives)  # type: ignore[union-attr]
            ),
            "sha256": "",
        }
    )
    changed_candidate = PlacementTemplateEntry.model_validate(
        changed_candidate.model_copy(
            update={"sha256": placement_entry_digest(changed_candidate)}
        ).model_dump(mode="json")
    )
    worse = record.model_copy(
        update={
            "objective_values": (
                record.objective_values[0],  # type: ignore[index]
                record.objective_values[1] + 1,  # type: ignore[index]
                *record.objective_values[2:],  # type: ignore[index]
            ),
            "candidate": changed_candidate,
        }
    )
    candidate = _fixture(worse)

    assert compare_objective_vectors((5, 0, 0, 3, 2, 1), (5, 0, 0, 4, 0, 0)) is (
        LexicographicResult.BETTER
    )
    summary = compare_baselines(baseline, candidate)
    assert summary.compared == 1
    assert summary.worse == 1


def test_persistent_jsonl_worker_performs_version_handshake(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    worker_script = tmp_path / "worker.py"
    worker_script.write_text(
        """
import argparse, json, sys
p = argparse.ArgumentParser()
p.add_argument('--legacy-root')
p.add_argument('--expected-commit')
a = p.parse_args()
for line in sys.stdin:
    item = json.loads(line)
    print(json.dumps({
        'request_id': item['request_id'],
        'type': 'hello',
        'commit_sha': a.expected_commit,
        'python_version': '3.14.2',
        'ortools_version': '9.15.6755',
    }), flush=True)
""",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "football_scheduler.placement_template_ab._verify_legacy_checkout", lambda _root: None
    )

    with LegacyPlacementWorker(
        tmp_path,
        python_executable=sys.executable,
        worker_script=worker_script,
    ) as worker:
        assert worker.metadata is not None
        assert worker.metadata.commit_sha == LEGACY_SOLVER_COMMIT
