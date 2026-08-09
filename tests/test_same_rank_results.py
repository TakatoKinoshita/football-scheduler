from __future__ import annotations

from collections.abc import Iterable

import pytest

from football_scheduler.league import LeaguePlan, generate_league_plan
from football_scheduler.league_results import LeagueStandings, Standing
from football_scheduler.same_rank_league import (
    SameRankGroup,
    SameRankLeaguePlan,
    generate_same_rank_league_plan,
)
from football_scheduler.same_rank_results import (
    SameRankResultsError,
    calculate_same_rank_standings,
)


def _league_plan(team_count: int, block_count: int) -> LeaguePlan:
    return generate_league_plan(
        {
            "teams": [
                {"id": f"team-{number:02d}", "name": f"Team {number}"}
                for number in range(1, team_count + 1)
            ],
            "block_count": block_count,
            "assignment_mode": "seeded_snake",
        }
    )


def _standings(plan: LeaguePlan) -> LeagueStandings:
    return LeagueStandings(
        standings=tuple(
            Standing(
                block_id=block.id,
                rank=rank,
                team_id=team_id,
                played=0,
                wins=0,
                draws=0,
                losses=0,
                goals_for=0,
                goals_against=0,
                goal_difference=0,
                points=0,
                tie_break="fixture",
            )
            for block in plan.blocks
            for rank, team_id in enumerate(block.team_ids, 1)
        ),
        draws=(),
    )


def _plan(
    team_count: int = 8,
    block_count: int = 4,
    policy: str = "strict_same_rank",
    *,
    resolved: bool = True,
    random_seed: int = 41,
) -> SameRankLeaguePlan:
    league_plan = _league_plan(team_count, block_count)
    return generate_same_rank_league_plan(
        {
            "request_kind": "same_rank_league_plan",
            "league_plan": league_plan.model_dump(mode="json"),
            "league_standings": (
                _standings(league_plan).model_dump(mode="json") if resolved else None
            ),
            "final_stage": {"format": "same_rank_league", "uneven_policy": policy},
            "random_seed": random_seed,
        }
    )


def _result(
    group: SameRankGroup,
    scores: Iterable[tuple[int, int]] | None = None,
) -> list[dict[str, object]]:
    score_values = list(scores) if scores is not None else [(0, 0)] * len(group.matches)
    return [
        {
            "match_id": match.id,
            "home_team_id": match.home_team.team_id if match.home_team else "unresolved-home",
            "away_team_id": match.away_team.team_id if match.away_team else "unresolved-away",
            "regular_score_home": home_score,
            "regular_score_away": away_score,
        }
        for match, (home_score, away_score) in zip(group.matches, score_values, strict=True)
    ]


def _request(
    plan: SameRankLeaguePlan,
    results: list[dict[str, object]],
) -> dict[str, object]:
    return {
        "request_kind": "same_rank_league_results",
        "same_rank_plan": plan.model_dump(mode="json"),
        "results": results,
    }


def test_all_draws_are_reproducible_and_cover_every_final_rank_once() -> None:
    plan = _plan(18, 4, "merge_bottom")
    results = [item for group in plan.groups for item in _result(group)]

    first = calculate_same_rank_standings(_request(plan, results))
    second = calculate_same_rank_standings(_request(plan, results))

    assert first == second
    assert [standing.rank for standing in first.standings] == list(range(1, 19))
    assert len({standing.team_id for standing in first.standings}) == 18
    assert all(standing.draws == standing.played for standing in first.standings)
    assert all(standing.points == standing.played for standing in first.standings)
    assert first.draws
    assert all(record.random_seed == 41 for record in first.draws)


def test_two_team_group_uses_three_one_zero_and_allows_draw() -> None:
    plan = _plan(4, 2)
    results = [
        *_result(plan.groups[0], [(2, 0)]),
        *_result(plan.groups[1], [(1, 1)]),
    ]

    result = calculate_same_rank_standings(_request(plan, results))
    first_group = [standing for standing in result.standings if standing.group_id == "same-rank-1"]
    second_group = [standing for standing in result.standings if standing.group_id == "same-rank-2"]

    assert [standing.points for standing in first_group] == [3, 0]
    assert {standing.points for standing in second_group} == {1}
    assert result.match_results[1].outcome == "draw"


def test_two_team_tie_is_ordered_by_their_direct_match() -> None:
    plan = _plan(8, 4)
    scores = [(2, 1), (0, 0), (1, 0), (0, 1), (1, 0), (0, 1)]
    results = [*_result(plan.groups[0], scores), *_result(plan.groups[1])]
    participant_ids = [
        participant.team.team_id for participant in plan.groups[0].participants if participant.team
    ]

    result = calculate_same_rank_standings(_request(plan, results))
    ranked = [standing for standing in result.standings if standing.group_id == "same-rank-1"]

    assert [standing.team_id for standing in ranked] == [
        participant_ids[0],
        participant_ids[3],
        participant_ids[2],
        participant_ids[1],
    ]
    assert ranked[0].tie_break == "直接対戦"
    assert ranked[0].head_to_head is not None
    assert ranked[0].head_to_head.points == 3


def test_three_plus_team_tie_uses_original_mini_league_without_recalculation() -> None:
    plan = _plan(10, 5, random_seed=0)
    first_group = plan.groups[0]
    scores = [
        (4, 0),
        (1, 2),
        (2, 3),
        (3, 1),
        (4, 2),
        (4, 1),
        (0, 0),
        (1, 4),
        (2, 3),
        (1, 3),
    ]
    results = [*_result(first_group, scores), *_result(plan.groups[1])]
    participant_ids = [
        participant.team.team_id for participant in first_group.participants if participant.team
    ]

    result = calculate_same_rank_standings(_request(plan, results))
    ranked = [
        standing.team_id for standing in result.standings if standing.group_id == first_group.id
    ]

    assert ranked == [
        participant_ids[0],
        participant_ids[1],
        participant_ids[3],
        participant_ids[4],
        participant_ids[2],
    ]
    assert result.draws[0].candidates == tuple(sorted((participant_ids[1], participant_ids[3])))
    # 8試合目は両者の直接対戦で後者が勝つが、元の3チーム同点群の値を維持して抽選する。
    assert scores[7] == (1, 4)


def test_singleton_group_is_returned_as_automatic_17th_without_result() -> None:
    plan = _plan(17, 4)
    results = [item for group in plan.groups for item in _result(group)]

    result = calculate_same_rank_standings(_request(plan, results))
    last = result.standings[-1]

    assert last.rank == 17
    assert last.group_id == plan.groups[-1].id
    assert last.automatic is True
    assert last.played == 0
    assert last.points == 0


def test_rejects_penalty_scores_even_when_regular_score_is_drawn() -> None:
    plan = _plan()
    results = [item for group in plan.groups for item in _result(group)]
    results[0]["penalty_score_home"] = 3
    results[0]["penalty_score_away"] = 2

    with pytest.raises(SameRankResultsError) as error:
        calculate_same_rank_standings(_request(plan, results))

    assert error.value.code == "SAME_RANK_PENALTY_NOT_ALLOWED"


def test_rejects_results_until_league_ranks_are_resolved() -> None:
    plan = _plan(resolved=False)

    with pytest.raises(SameRankResultsError) as error:
        calculate_same_rank_standings(_request(plan, []))

    assert error.value.code == "SAME_RANK_RESULTS_REQUIRE_RESOLVED_PLAN"


@pytest.mark.parametrize(
    ("mutate", "code"),
    [
        (lambda results: results.pop(), "SAME_RANK_RESULTS_INCOMPLETE"),
        (
            lambda results: results.append({**results[0], "match_id": "SR-UNKNOWN-M1"}),
            "UNKNOWN_SAME_RANK_MATCH",
        ),
        (lambda results: results.append(results[0]), "DUPLICATE_SAME_RANK_RESULT"),
        (
            lambda results: results[0].update({"home_team_id": "wrong-team"}),
            "SAME_RANK_RESULT_PARTICIPANT_MISMATCH",
        ),
    ],
)
def test_rejects_invalid_result_sets(mutate: object, code: str) -> None:
    plan = _plan()
    results = [item for group in plan.groups for item in _result(group)]
    assert callable(mutate)
    mutate(results)

    with pytest.raises(SameRankResultsError) as error:
        calculate_same_rank_standings(_request(plan, results))

    assert error.value.code == code
