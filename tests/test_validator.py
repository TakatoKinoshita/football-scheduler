from __future__ import annotations

from copy import deepcopy

import pytest

from football_scheduler.validator import validate_day2_schedule, validate_schedule


def team(team_id: str) -> dict[str, str]:
    return {"type": "concrete_team", "team_id": team_id}


def winner(match_id: str) -> dict[str, str]:
    return {"type": "winner_of", "match_id": match_id}


@pytest.fixture
def valid_document() -> dict[str, object]:
    return {
        "schema_version": "0.2.0",
        "config": {
            "teams": [{"id": team_id} for team_id in ("A", "B", "C", "D", "E")],
            "courts": [
                {"id": "court-a", "name": "Aコート"},
                {"id": "court-b", "name": "Bコート"},
            ],
            "days": {"day1": {"max_sections": 4}},
            "referees": {"organizer_capacity": 2},
        },
        "matches": [
            {"id": "M1", "home": team("A"), "away": team("B")},
            {"id": "M2", "home": team("C"), "away": team("D")},
            {"id": "M3", "home": winner("M1"), "away": winner("M2")},
        ],
        "schedule": {
            "slots": [
                {
                    "day_id": "day1",
                    "section_no": 1,
                    "court_id": "court-a",
                    "match_id": "M1",
                    "referee_assignment": {"type": "organizer"},
                },
                {
                    "day_id": "day1",
                    "section_no": 1,
                    "court_id": "court-b",
                    "match_id": "M2",
                    "referee_assignment": {"type": "organizer"},
                },
                {
                    "day_id": "day1",
                    "section_no": 3,
                    "court_id": "court-a",
                    "match_id": "M3",
                    "referee_assignment": {"type": "team", "team_id": "E"},
                },
            ]
        },
        "results": [{"match_id": "M1"}],
    }


def codes(document: dict[str, object]) -> set[str]:
    return {item["code"] for item in validate_schedule(document)["diagnostics"]}


def test_valid_schedule_passes_independent_validation(valid_document: dict[str, object]) -> None:
    report = validate_schedule(valid_document)

    assert report == {
        "valid": True,
        "diagnostics": [],
        "summary": {
            "checked_match_count": 3,
            "checked_slot_count": 3,
            "error_count": 0,
            "league_team_referee_counts": [
                {"team_id": "A", "count": 0},
                {"team_id": "B", "count": 0},
                {"team_id": "C", "count": 0},
                {"team_id": "D", "count": 0},
                {"team_id": "E", "count": 1},
            ],
            "league_team_referee_count_min": 0,
            "league_team_referee_count_max": 1,
            "league_team_referee_count_difference": 1,
            "adjacent_assignment_court_change_count": 0,
        },
    }


def test_accepts_an_object_with_model_dump(valid_document: dict[str, object]) -> None:
    class ModelLike:
        def model_dump(self, *, mode: str) -> dict[str, object]:
            assert mode == "python"
            return valid_document

    assert validate_schedule(ModelLike())["valid"] is True


def test_referee_summary_excludes_tournament_matches(
    valid_document: dict[str, object],
) -> None:
    document = deepcopy(valid_document)
    matches = document["matches"]  # type: ignore[assignment]
    matches[2]["phase"] = "placement_tournament"

    summary = validate_schedule(document)["summary"]

    assert summary["league_team_referee_counts"] == [
        {"team_id": team_id, "count": 0} for team_id in ("A", "B", "C", "D", "E")
    ]
    assert summary["league_team_referee_count_difference"] == 0


def test_detects_missing_and_duplicate_match_assignments(
    valid_document: dict[str, object],
) -> None:
    document = deepcopy(valid_document)
    slots = document["schedule"]["slots"]  # type: ignore[index]
    slots[1]["match_id"] = "M1"

    result_codes = codes(document)

    assert "MATCH_ASSIGNED_MULTIPLE_TIMES" in result_codes
    assert "MATCH_NOT_ASSIGNED" in result_codes


def test_detects_unknown_match_id_and_duplicate_slot(
    valid_document: dict[str, object],
) -> None:
    document = deepcopy(valid_document)
    slots = document["schedule"]["slots"]  # type: ignore[index]
    slots.append(
        {
            "day_id": "day1",
            "section_no": 1,
            "court_id": "court-a",
            "match_id": "UNKNOWN",
            "referee_assignment": {"type": "organizer"},
        }
    )

    result_codes = codes(document)

    assert "UNKNOWN_MATCH_ID" in result_codes
    assert "SLOT_OCCUPIED_MULTIPLE_TIMES" in result_codes


def test_detects_same_section_conflict_from_possible_team_set(
    valid_document: dict[str, object],
) -> None:
    document = deepcopy(valid_document)
    matches = document["matches"]  # type: ignore[assignment]
    matches[1]["possible_team_ids"] = ["A", "C", "D"]

    report = validate_schedule(document)
    conflict = next(
        item for item in report["diagnostics"] if item["code"] == "TEAM_SAME_SECTION_CONFLICT"
    )

    assert conflict["details"]["possible_team_ids"] == ["A"]


def test_detects_consecutive_section_conflict_through_winner_reference(
    valid_document: dict[str, object],
) -> None:
    document = deepcopy(valid_document)
    slots = document["schedule"]["slots"]  # type: ignore[index]
    slots[2]["section_no"] = 2

    result_codes = codes(document)

    assert "TEAM_CONSECUTIVE_SECTION_CONFLICT" in result_codes
    assert "DEPENDENCY_REST_VIOLATION" in result_codes


def test_detects_dependency_order_violation(valid_document: dict[str, object]) -> None:
    document = deepcopy(valid_document)
    slots = document["schedule"]["slots"]  # type: ignore[index]
    slots[2]["section_no"] = 1
    slots[2]["court_id"] = "court-c"

    assert "DEPENDENCY_ORDER_VIOLATION" in codes(document)


def test_detects_referee_team_as_participant(valid_document: dict[str, object]) -> None:
    document = deepcopy(valid_document)
    slots = document["schedule"]["slots"]  # type: ignore[index]
    slots[2]["referee_assignment"] = {"type": "team", "team_id": "A"}

    assert "REFEREE_TEAM_IS_PARTICIPANT" in codes(document)


def test_detects_match_and_referee_role_conflict_in_same_section(
    valid_document: dict[str, object],
) -> None:
    document = deepcopy(valid_document)
    slots = document["schedule"]["slots"]  # type: ignore[index]
    slots[0]["referee_assignment"] = {"type": "team", "team_id": "C"}

    assert "TEAM_ROLE_SAME_SECTION_CONFLICT" in codes(document)


def test_detects_adjacent_assignment_court_change(
    valid_document: dict[str, object],
) -> None:
    document = deepcopy(valid_document)
    slots = document["schedule"]["slots"]  # type: ignore[index]
    slots[0]["referee_assignment"] = {"type": "team", "team_id": "E"}
    slots[2]["section_no"] = 2
    slots[2]["court_id"] = "court-b"

    report = validate_schedule(document)
    conflict = next(
        item
        for item in report["diagnostics"]
        if item["code"] == "ADJACENT_ASSIGNMENT_COURT_CONFLICT"
        and item["details"]["team_id"] == "E"
    )

    assert conflict["details"] == {
        "day_id": "day1",
        "team_id": "E",
        "section_nos": [1, 2],
        "court_ids": ["court-a", "court-b"],
        "roles": ["referee", "referee"],
        "match_ids": ["M1", "M3"],
    }
    assert report["summary"]["adjacent_assignment_court_change_count"] == 3


def test_detects_organizer_capacity_overrun(valid_document: dict[str, object]) -> None:
    document = deepcopy(valid_document)
    document["config"]["referees"]["organizer_capacity"] = 1  # type: ignore[index]

    assert "ORGANIZER_CAPACITY_EXCEEDED" in codes(document)


def test_detects_max_sections_overrun(valid_document: dict[str, object]) -> None:
    document = deepcopy(valid_document)
    slots = document["schedule"]["slots"]  # type: ignore[index]
    slots[2]["section_no"] = 5

    assert "MAX_SECTIONS_EXCEEDED" in codes(document)


@pytest.mark.parametrize(
    ("results", "expected_code"),
    [
        ([{"match_id": "M404"}], "RESULT_UNKNOWN_MATCH_ID"),
        ([{"regular_score_home": 1}], "RESULT_MATCH_ID_MISSING"),
        ({"M1": {"match_id": "M2"}}, "RESULT_MATCH_ID_MISMATCH"),
    ],
)
def test_detects_result_match_id_inconsistency(
    valid_document: dict[str, object],
    results: object,
    expected_code: str,
) -> None:
    document = deepcopy(valid_document)
    document["results"] = results

    assert expected_code in codes(document)


def _provisional_day2_document() -> dict[str, object]:
    rank_1 = {"type": "league_rank", "block_id": "A", "rank": 1}
    rank_2 = {"type": "league_rank", "block_id": "A", "rank": 2}
    match = {
        "id": "PT-1-FINAL",
        "phase": "placement_tournament",
        "pool_id": "placement-1",
        "round": "final",
        "round_no": 1,
        "home": rank_1,
        "away": rank_2,
        "rank_range": [1, 2],
        "possible_rank_refs": [rank_1, rank_2],
        "possible_team_ids": [],
        "prerequisite_match_ids": [],
        "final": True,
    }
    slot = {
        "day_id": "day2",
        "section_no": 1,
        "court_id": "court-a",
        "match_id": "PT-1-FINAL",
        "referee_assignment": {"kind": "organizer", "organizer_reason": "first_section"},
    }
    routes = [
        {
            "rank_ref": rank_ref,
            "team_id": None,
            "role": "match",
            "match_id": "PT-1-FINAL",
            "section_no": 1,
            "court_id": "court-a",
            "conditions": [],
        }
        for rank_ref in (rank_1, rank_2)
    ]
    return {
        "participant_resolution": "provisional",
        "config": {
            "teams": [{"id": "T1"}, {"id": "T2"}],
            "courts": [{"id": "court-a"}],
            "days": {
                "day2": {
                    "start_time": "09:30",
                    "game_duration_minutes": 35,
                    "margin_minutes": 10,
                }
            },
            "referees": {"organizer_capacity": 1, "day2_fallback": "organizer"},
        },
        "league_plan": {"blocks": [{"id": "A", "team_ids": ["T1", "T2"]}]},
        "tournament_plan": {
            "participant_resolution": "provisional",
            "pools": [
                {
                    "pool_id": "placement-1",
                    "participant_count": 2,
                    "overall_rank_range": [1, 2],
                    "matches": [
                        {
                            "id": "PT-1-FINAL",
                            "rank_range": [1, 2],
                        }
                    ],
                    "seeds": [
                        {"block_id": "A", "block_rank": 1, "team_id": None},
                        {"block_id": "A", "block_rank": 2, "team_id": None},
                    ],
                }
            ],
        },
        "matches": [match],
        "team_schedules": routes,
        "schedule": {
            "participant_resolution": "provisional",
            "slots": [slot],
            "section_timings": [
                {
                    "day_id": "day2",
                    "section_no": 1,
                    "start_time": "09:30",
                    "match_end_time": "10:05",
                    "break_after_minutes": 0,
                }
            ],
            "expected_end_time": "10:05",
        },
    }


def test_provisional_day2_rank_paths_pass_independent_validation() -> None:
    report = validate_day2_schedule(_provisional_day2_document())

    assert report["valid"] is True, report


@pytest.mark.parametrize(
    ("mutation", "expected_code"),
    [
        ("rank_annotation", "TOURNAMENT_RANK_ANNOTATION_MISMATCH"),
        ("team_annotation", "TOURNAMENT_ROUTE_ANNOTATION_MISMATCH"),
    ],
)
def test_provisional_day2_rejects_tampered_participant_annotations(
    mutation: str, expected_code: str
) -> None:
    document = _provisional_day2_document()
    if mutation == "rank_annotation":
        document["matches"][0]["possible_rank_refs"].pop()  # type: ignore[index, union-attr]
    else:
        document["team_schedules"][0]["team_id"] = "T1"  # type: ignore[index]

    report = validate_day2_schedule(document)

    assert report["valid"] is False
    assert expected_code in {issue["code"] for issue in report["diagnostics"]}


def test_resolved_day2_rejects_rank_to_team_annotation_swap() -> None:
    document = _provisional_day2_document()
    document["participant_resolution"] = "resolved"
    document["schedule"]["participant_resolution"] = "resolved"  # type: ignore[index]
    document["tournament_plan"]["participant_resolution"] = "resolved"  # type: ignore[index]
    seeds = document["tournament_plan"]["pools"][0]["seeds"]  # type: ignore[index]
    seeds[0]["team_id"] = "T1"  # type: ignore[index]
    seeds[1]["team_id"] = "T2"  # type: ignore[index]
    document["matches"][0]["possible_team_ids"] = ["T2", "T1"]  # type: ignore[index]
    routes = document["team_schedules"]  # type: ignore[assignment]
    routes[0]["team_id"] = "T1"  # type: ignore[index]
    routes[1]["team_id"] = "T2"  # type: ignore[index]

    report = validate_day2_schedule(document)

    assert report["valid"] is False
    assert "TOURNAMENT_TEAM_ANNOTATION_MISMATCH" in {
        issue["code"] for issue in report["diagnostics"]
    }
