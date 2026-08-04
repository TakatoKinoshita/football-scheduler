from __future__ import annotations

from itertools import combinations

import pytest

from football_scheduler.league import LeagueGenerationError, generate_league_plan
from football_scheduler.models import (
    Court,
    DaySettings,
    MatchSpec,
    RefereeSettings,
    ScheduleRequest,
    Team,
)


def _teams(count: int) -> list[dict[str, object]]:
    return [
        {"id": f"team-{index:02}", "name": f"チーム{index}", "seed": index}
        for index in range(1, count + 1)
    ]


def _request(
    team_count: int,
    block_count: int,
    *,
    assignment_mode: str = "random",
    random_seed: int = 20260803,
) -> dict[str, object]:
    return {
        "schema_version": "0.1.0",
        "teams": _teams(team_count),
        "block_count": block_count,
        "assignment_mode": assignment_mode,
        "random_seed": random_seed,
    }


@pytest.mark.parametrize(
    ("team_count", "block_count", "sizes"),
    [(8, 4, [2, 2, 2, 2]), (10, 4, [3, 3, 2, 2])],
)
def test_random_assignment_balances_block_sizes(
    team_count: int, block_count: int, sizes: list[int]
) -> None:
    plan = generate_league_plan(_request(team_count, block_count))

    assert [len(block.team_ids) for block in plan.blocks] == sizes
    assert {team_id for block in plan.blocks for team_id in block.team_ids} == {
        team["id"] for team in _teams(team_count)
    }


def test_same_random_seed_produces_same_json_plan() -> None:
    request = _request(10, 3, random_seed=1234)

    first = generate_league_plan(request)
    second = generate_league_plan(request)

    assert first == second
    assert first.model_dump(mode="json") == second.model_dump(mode="json")


def test_seeded_snake_is_stable_when_input_order_changes() -> None:
    request = _request(10, 4, assignment_mode="seeded_snake")
    reversed_request = {**request, "teams": list(reversed(_teams(10)))}

    first = generate_league_plan(request)
    second = generate_league_plan(reversed_request)

    assert first.blocks == second.blocks
    assert [block.team_ids for block in first.blocks] == [
        ("team-01", "team-08", "team-09"),
        ("team-02", "team-07", "team-10"),
        ("team-03", "team-06"),
        ("team-04", "team-05"),
    ]


@pytest.mark.parametrize("team_count", range(2, 33))
def test_round_robin_contains_every_pair_exactly_once(team_count: int) -> None:
    plan = generate_league_plan(_request(team_count, 1, assignment_mode="seeded_snake"))
    actual_pairs = [
        frozenset((*match.possible_home_team_ids, *match.possible_away_team_ids))
        for match in plan.matches
    ]
    expected_pairs = {
        frozenset(pair) for pair in combinations((team["id"] for team in _teams(team_count)), 2)
    }

    assert len(actual_pairs) == team_count * (team_count - 1) // 2
    assert len(actual_pairs) == len(set(actual_pairs))
    assert set(actual_pairs) == expected_pairs
    assert all(isinstance(match, MatchSpec) for match in plan.matches)
    assert all(match.phase == "league" for match in plan.matches)
    assert all(match.prerequisite_match_ids == () for match in plan.matches)


def test_logical_rounds_are_separate_from_schedule_sections() -> None:
    plan = generate_league_plan(_request(5, 1, assignment_mode="seeded_snake"))

    assert len(plan.logical_rounds) == 5
    assert all(len(round_.match_ids) == 2 for round_ in plan.logical_rounds)
    serialized = plan.model_dump(mode="json")
    assert "section_no" not in str(serialized)
    assert "court_id" not in str(serialized)
    assert all(match.organizer_referee_required is False for match in plan.matches)


def test_generated_matches_fit_existing_solver_contract() -> None:
    plan = generate_league_plan(_request(4, 1, assignment_mode="seeded_snake"))

    schedule_request = ScheduleRequest(
        teams=tuple(Team(id=f"team-{index:02}", name=f"チーム{index}") for index in range(1, 5)),
        courts=(Court(id="court-a", name="Aコート"),),
        matches=plan.matches,
        day=DaySettings(max_sections=12),
        referees=RefereeSettings(organizer_capacity=1),
        random_seed=plan.random_seed,
    )

    assert schedule_request.matches == plan.matches


def test_manual_assignment_preserves_blocks_and_generates_matches() -> None:
    request = {
        **_request(5, 2, assignment_mode="manual"),
        "manual_blocks": [
            {"id": "A", "team_ids": ["team-01", "team-03", "team-05"]},
            {"id": "B", "team_ids": ["team-02", "team-04"]},
        ],
    }

    plan = generate_league_plan(request)

    assert [block.team_ids for block in plan.blocks] == [
        ("team-01", "team-03", "team-05"),
        ("team-02", "team-04"),
    ]
    assert [match.id for match in plan.matches] == [
        "LG-A-M1",
        "LG-A-M2",
        "LG-A-M3",
        "LG-B-M1",
    ]


@pytest.mark.parametrize(
    ("manual_blocks", "code"),
    [
        (
            [
                {"id": "A", "team_ids": ["team-01", "team-02"]},
                {"id": "B", "team_ids": ["team-02", "team-03", "team-04"]},
            ],
            "DUPLICATE_TEAM_IN_MANUAL_BLOCKS",
        ),
        (
            [
                {"id": "A", "team_ids": ["team-01", "team-02"]},
                {"id": "B", "team_ids": ["team-03"]},
            ],
            "TEAM_MISSING_FROM_MANUAL_BLOCKS",
        ),
        (
            [
                {"id": "A", "team_ids": ["team-01", "team-02"]},
                {"id": "B", "team_ids": ["team-03", "team-99"]},
            ],
            "UNKNOWN_TEAM_IN_MANUAL_BLOCKS",
        ),
    ],
)
def test_manual_assignment_rejects_invalid_membership(
    manual_blocks: list[dict[str, object]], code: str
) -> None:
    request = {
        **_request(4, 2, assignment_mode="manual"),
        "manual_blocks": manual_blocks,
    }

    with pytest.raises(LeagueGenerationError) as error:
        generate_league_plan(request)

    assert error.value.code == code
    assert error.value.message


def test_rejects_duplicate_and_empty_team_ids_with_diagnostics() -> None:
    duplicate_request = _request(3, 1)
    duplicate_request["teams"] = [
        {"id": "same", "name": "チーム1"},
        {"id": "same", "name": "チーム2"},
    ]
    with pytest.raises(LeagueGenerationError) as duplicate_error:
        generate_league_plan(duplicate_request)
    assert duplicate_error.value.code == "DUPLICATE_TEAM_ID"

    empty_request = _request(3, 1)
    empty_request["teams"] = [
        {"id": "", "name": "チーム1"},
        {"id": "team-02", "name": "チーム2"},
    ]
    with pytest.raises(LeagueGenerationError) as empty_error:
        generate_league_plan(empty_request)
    assert empty_error.value.code == "LEAGUE_INPUT_INVALID"
    assert empty_error.value.as_diagnostic()["message"] == (
        "リーグ設定に入力不備があります。表示された項目を確認してください。"
    )


def test_rejects_block_count_greater_than_team_count() -> None:
    with pytest.raises(LeagueGenerationError) as error:
        generate_league_plan(_request(3, 4))

    assert error.value.code == "INVALID_BLOCK_COUNT"
    assert error.value.details == {"block_count": 4, "team_count": 3}


def test_allows_one_team_blocks_without_creating_fake_matches() -> None:
    plan = generate_league_plan(_request(3, 3, assignment_mode="seeded_snake"))

    assert [len(block.team_ids) for block in plan.blocks] == [1, 1, 1]
    assert plan.matches == ()
    assert plan.logical_rounds == ()
