from __future__ import annotations

from copy import deepcopy

import pytest

from football_scheduler.validator import validate_schedule


def team(team_id: str) -> dict[str, str]:
    return {"type": "concrete_team", "team_id": team_id}


def winner(match_id: str) -> dict[str, str]:
    return {"type": "winner_of", "match_id": match_id}


@pytest.fixture
def valid_document() -> dict[str, object]:
    return {
        "schema_version": "0.1.0",
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
    matches[2]["phase"] = "upper_tournament"

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
