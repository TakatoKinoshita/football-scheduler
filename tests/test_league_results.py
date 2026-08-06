from __future__ import annotations

import pytest
from pydantic import ValidationError

from football_scheduler.league import generate_league_plan
from football_scheduler.league_results import LeagueResultsError, calculate_league_standings


def _request(results: list[dict[str, object]], *, seed: int = 7) -> dict[str, object]:
    plan = generate_league_plan(
        {
            "teams": [{"id": team, "name": team} for team in ("A", "B", "C", "D")],
            "block_count": 1,
            "assignment_mode": "seeded_snake",
            "random_seed": seed,
        }
    )
    return {
        "request_kind": "league_standings",
        "league_plan": plan.model_dump(mode="json"),
        "results": results,
        "random_seed": seed,
    }


def test_calculates_points_goal_difference_and_goals_for() -> None:
    result = calculate_league_standings(
        _request(
            [
                {"match_id": "LG-A-M1", "home_score": 2, "away_score": 0},
                {"match_id": "LG-A-M2", "home_score": 1, "away_score": 1},
                {"match_id": "LG-A-M3", "home_score": 0, "away_score": 3},
                {"match_id": "LG-A-M4", "home_score": 1, "away_score": 0},
                {"match_id": "LG-A-M5", "home_score": 0, "away_score": 0},
                {"match_id": "LG-A-M6", "home_score": 0, "away_score": 1},
            ]
        )
    )

    assert [standing.rank for standing in result.standings] == [1, 2, 3, 4]
    assert sum(standing.played for standing in result.standings) == 12


def test_two_team_tie_uses_head_to_head() -> None:
    result = calculate_league_standings(
        _request(
            [
                {"match_id": "LG-A-M1", "home_score": 2, "away_score": 1},
                {"match_id": "LG-A-M2", "home_score": 0, "away_score": 0},
                {"match_id": "LG-A-M3", "home_score": 1, "away_score": 0},
                {"match_id": "LG-A-M4", "home_score": 0, "away_score": 1},
                {"match_id": "LG-A-M5", "home_score": 1, "away_score": 0},
                {"match_id": "LG-A-M6", "home_score": 0, "away_score": 1},
            ]
        )
    )

    assert [standing.team_id for standing in result.standings] == ["A", "D", "C", "B"]
    assert result.standings[0].tie_break == "直接対戦"
    assert result.standings[0].head_to_head is not None
    assert result.standings[0].head_to_head.points == 3


def test_three_team_mini_league_uses_original_tied_group_values() -> None:
    result = calculate_league_standings(
        _request(
            [
                {"match_id": "LG-A-M1", "home_score": 5, "away_score": 0},
                {"match_id": "LG-A-M2", "home_score": 2, "away_score": 0},
                {"match_id": "LG-A-M3", "home_score": 3, "away_score": 0},
                {"match_id": "LG-A-M4", "home_score": 4, "away_score": 2},
                {"match_id": "LG-A-M5", "home_score": 1, "away_score": 0},
                {"match_id": "LG-A-M6", "home_score": 3, "away_score": 1},
            ]
        )
    )

    assert [standing.team_id for standing in result.standings] == ["C", "B", "A", "D"]
    assert [standing.points for standing in result.standings[:3]] == [6, 6, 6]
    assert [standing.goal_difference for standing in result.standings[:3]] == [3, 3, 3]
    assert [standing.goals_for for standing in result.standings[:3]] == [6, 6, 6]
    assert [standing.head_to_head.goal_difference for standing in result.standings[:3]] == [
        1,
        1,
        -2,
    ]


def test_remaining_tie_does_not_recalculate_head_to_head_group() -> None:
    plan = generate_league_plan(
        {
            "teams": [{"id": team, "name": team} for team in ("A", "B", "C", "D", "E")],
            "block_count": 1,
            "assignment_mode": "seeded_snake",
        }
    )
    scores = [
        ("LG-A-M1", 4, 0),
        ("LG-A-M2", 1, 2),
        ("LG-A-M3", 2, 3),
        ("LG-A-M4", 3, 1),
        ("LG-A-M5", 4, 2),
        ("LG-A-M6", 4, 1),
        ("LG-A-M7", 0, 0),
        ("LG-A-M8", 1, 4),
        ("LG-A-M9", 2, 3),
        ("LG-A-M10", 1, 3),
    ]

    result = calculate_league_standings(
        {
            "request_kind": "league_standings",
            "league_plan": plan.model_dump(mode="json"),
            "results": [
                {"match_id": match_id, "home_score": home, "away_score": away}
                for match_id, home, away in scores
            ],
        }
    )

    assert [standing.team_id for standing in result.standings] == ["A", "B", "D", "E", "C"]
    assert result.draws[0].candidates == ("B", "D")
    # B対DはDの勝利だが、最初のB・D・E同点群のミニリーグ値を維持して抽選する。
    assert next(score for score in scores if score[0] == "LG-A-M8")[1:] == (1, 4)


def test_final_tie_is_seeded_and_audited() -> None:
    results = [
        {"match_id": match_id, "home_score": 0, "away_score": 0}
        for match_id in ("LG-A-M1", "LG-A-M2", "LG-A-M3", "LG-A-M4", "LG-A-M5", "LG-A-M6")
    ]
    first = calculate_league_standings(_request(results, seed=99))
    second = calculate_league_standings(_request(results, seed=99))

    assert first == second
    assert first.draws[0].candidates == ("A", "B", "C", "D")
    assert [candidate.team_id for candidate in first.draws[0].candidate_values] == [
        "A",
        "B",
        "C",
        "D",
    ]


def test_block_id_with_hyphen_is_resolved_from_logical_round() -> None:
    plan = generate_league_plan(
        {
            "teams": [{"id": "A", "name": "A"}, {"id": "B", "name": "B"}],
            "block_count": 1,
            "assignment_mode": "manual",
            "manual_blocks": [{"id": "north-1", "team_ids": ["A", "B"]}],
        }
    )
    result = calculate_league_standings(
        {
            "request_kind": "league_standings",
            "league_plan": plan.model_dump(mode="json"),
            "results": [{"match_id": "LG-north-1-M1", "home_score": 1, "away_score": 0}],
        }
    )

    assert {standing.block_id for standing in result.standings} == {"north-1"}


@pytest.mark.parametrize(
    "mutate",
    [
        lambda plan: plan["matches"][0].update({"phase": "upper_tournament"}),
        lambda plan: plan["logical_rounds"][1]["match_ids"].append(
            plan["logical_rounds"][0]["match_ids"][0]
        ),
        lambda plan: plan["logical_rounds"][0].update({"block_id": "missing"}),
        lambda plan: plan["matches"][0].update({"possible_home_team_ids": ["A", "B"]}),
    ],
)
def test_rejects_inconsistent_league_plan(mutate: object) -> None:
    request = _request(
        [
            {"match_id": match_id, "home_score": 0, "away_score": 0}
            for match_id in (
                "LG-A-M1",
                "LG-A-M2",
                "LG-A-M3",
                "LG-A-M4",
                "LG-A-M5",
                "LG-A-M6",
            )
        ]
    )
    assert callable(mutate)
    mutate(request["league_plan"])

    with pytest.raises(LeagueResultsError) as error:
        calculate_league_standings(request)

    assert error.value.code == "LEAGUE_PLAN_INVALID"


@pytest.mark.parametrize(
    ("results", "code"),
    [
        ([], "LEAGUE_RESULTS_INCOMPLETE"),
        ([{"match_id": "missing", "home_score": 0, "away_score": 0}], "UNKNOWN_LEAGUE_MATCH"),
        (
            [{"match_id": "LG-A-M1", "home_score": 0, "away_score": 0}] * 2,
            "DUPLICATE_LEAGUE_RESULT",
        ),
    ],
)
def test_rejects_incomplete_unknown_and_duplicate_results(
    results: list[dict[str, object]], code: str
) -> None:
    with pytest.raises(LeagueResultsError) as error:
        calculate_league_standings(_request(results))
    assert error.value.code == code


def test_rejects_negative_score() -> None:
    with pytest.raises(ValidationError):
        calculate_league_standings(
            _request([{"match_id": "LG-A-M1", "home_score": -1, "away_score": 0}])
        )
