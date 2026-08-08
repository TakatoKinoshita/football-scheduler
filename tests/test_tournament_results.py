from __future__ import annotations

from typing import Any

import pytest

from football_scheduler.league import LeaguePlan, generate_league_plan
from football_scheduler.league_results import LeagueStandings, Standing
from football_scheduler.tournament import (
    ConcreteTeamRef,
    LeagueRankRef,
    LoserOfRef,
    TournamentEntry,
    TournamentPlan,
    WinnerOfRef,
    generate_tournament_plan,
)
from football_scheduler.tournament_results import (
    TournamentResultsError,
    calculate_tournament_standings,
)


def _source(block_sizes: tuple[int, ...]) -> tuple[LeaguePlan, LeagueStandings]:
    teams = [
        {"id": f"T{index}", "name": f"チーム{index}"} for index in range(1, sum(block_sizes) + 1)
    ]
    manual_blocks: list[dict[str, object]] = []
    offset = 0
    for index, size in enumerate(block_sizes):
        manual_blocks.append(
            {
                "id": f"B{index + 1}",
                "team_ids": [team["id"] for team in teams[offset : offset + size]],
            }
        )
        offset += size
    league_plan = generate_league_plan(
        {
            "teams": teams,
            "block_count": len(block_sizes),
            "assignment_mode": "manual",
            "manual_blocks": manual_blocks,
            "random_seed": 31,
        }
    )
    standings = LeagueStandings(
        standings=tuple(
            Standing(
                block_id=block.id,
                rank=rank,
                team_id=team_id,
                played=max(0, len(block.team_ids) - 1),
                wins=0,
                draws=0,
                losses=0,
                goals_for=0,
                goals_against=0,
                goal_difference=0,
                points=0,
                tie_break="テスト用確定順位",
            )
            for block in league_plan.blocks
            for rank, team_id in enumerate(block.team_ids, 1)
        ),
        draws=(),
    )
    return league_plan, standings


def _plan(block_sizes: tuple[int, ...], *, resolved: bool = True) -> TournamentPlan:
    league_plan, standings = _source(block_sizes)
    request: dict[str, Any] = {
        "request_kind": "tournament_plan",
        "league_plan": league_plan.model_dump(mode="json"),
        "odd_split_policy": "upper",
        "random_seed": 31,
    }
    if resolved:
        request["league_standings"] = standings.model_dump(mode="json")
    return generate_tournament_plan(request)


def _result_inputs(
    plan: TournamentPlan,
    *,
    penalty_match_id: str | None = None,
) -> list[dict[str, object]]:
    team_by_rank = {
        (seed.block_id, seed.block_rank): seed.team_id
        for pool in (plan.upper, plan.lower)
        for seed in pool.seeds
    }
    winners: dict[str, str] = {}
    losers: dict[str, str] = {}

    def team(entry: TournamentEntry) -> str:
        if isinstance(entry, ConcreteTeamRef):
            return entry.team_id
        if isinstance(entry, LeagueRankRef):
            value = team_by_rank[(entry.block_id, entry.rank)]
            assert value is not None
            return value
        if isinstance(entry, WinnerOfRef):
            return winners[entry.match_id]
        if isinstance(entry, LoserOfRef):
            return losers[entry.match_id]
        raise AssertionError("unsupported entry")

    results: list[dict[str, object]] = []
    for pool in (plan.upper, plan.lower):
        for match in pool.matches:
            home, away = team(match.home), team(match.away)
            result: dict[str, object] = {
                "match_id": match.id,
                "home_team_id": home,
                "away_team_id": away,
                "regular_score_home": 1,
                "regular_score_away": 0,
            }
            if match.id == penalty_match_id:
                result.update(
                    regular_score_home=1,
                    regular_score_away=1,
                    penalty_score_home=4,
                    penalty_score_away=3,
                )
            winners[match.id], losers[match.id] = home, away
            results.append(result)
    return results


def _request(plan: TournamentPlan, results: list[dict[str, object]]) -> dict[str, object]:
    return {
        "request_kind": "tournament_results",
        "tournament_plan": plan.model_dump(mode="json"),
        "results": results,
    }


@pytest.mark.parametrize("participant_count", [2, 4, 6])
def test_complete_standings_cover_every_overall_rank(participant_count: int) -> None:
    plan = _plan((1,) * participant_count)
    results = _result_inputs(plan)

    outcome = calculate_tournament_standings(_request(plan, list(reversed(results))))

    assert [row.rank for row in outcome.standings] == list(range(1, participant_count + 1))
    assert len({row.team_id for row in outcome.standings}) == participant_count
    assert len(outcome.match_results) == len(results)


def test_lower_pool_ranks_are_offset_after_upper_pool() -> None:
    plan = _plan((3, 3))

    outcome = calculate_tournament_standings(_request(plan, _result_inputs(plan)))

    assert plan.upper.participant_count == 4
    assert plan.lower.participant_count == 2
    assert [(row.pool.value, row.pool_rank, row.rank) for row in outcome.standings] == [
        ("upper", 1, 1),
        ("upper", 2, 2),
        ("upper", 3, 3),
        ("upper", 4, 4),
        ("lower", 1, 5),
        ("lower", 2, 6),
    ]


def test_penalty_shootout_is_kept_separate_and_decides_winner() -> None:
    plan = _plan((1, 1))
    match_id = plan.upper.matches[0].id

    outcome = calculate_tournament_standings(
        _request(plan, _result_inputs(plan, penalty_match_id=match_id))
    )

    result = outcome.match_results[0]
    assert result.regular_score_home == result.regular_score_away == 1
    assert (result.penalty_score_home, result.penalty_score_away) == (4, 3)
    assert result.winner == "home"
    assert result.decision == "penalty_shootout"


@pytest.mark.parametrize(
    ("scores", "reason"),
    [
        (
            {
                "regular_score_home": 2,
                "regular_score_away": 1,
                "penalty_score_home": 3,
                "penalty_score_away": 2,
            },
            "penalty_for_non_draw",
        ),
        ({"regular_score_home": 1, "regular_score_away": 1}, "penalty_required"),
        (
            {
                "regular_score_home": 1,
                "regular_score_away": 1,
                "penalty_score_home": 4,
                "penalty_score_away": 4,
            },
            "penalty_still_tied",
        ),
    ],
)
def test_inconsistent_score_is_rejected(scores: dict[str, int], reason: str) -> None:
    plan = _plan((1, 1))
    results = _result_inputs(plan)
    results[0].update(scores)

    with pytest.raises(TournamentResultsError) as exc_info:
        calculate_tournament_standings(_request(plan, results))

    assert exc_info.value.code == "TOURNAMENT_RESULT_INVALID"
    assert exc_info.value.details["reason"] == reason


def test_duplicate_unknown_incomplete_and_stale_results_are_distinguished() -> None:
    plan = _plan((1, 1, 1, 1))
    complete = _result_inputs(plan)

    with pytest.raises(TournamentResultsError) as duplicate:
        calculate_tournament_standings(_request(plan, [*complete, complete[0]]))
    assert duplicate.value.code == "DUPLICATE_TOURNAMENT_RESULT"

    unknown_result = {**complete[0], "match_id": "UT-UNKNOWN"}
    with pytest.raises(TournamentResultsError) as unknown:
        calculate_tournament_standings(_request(plan, [*complete, unknown_result]))
    assert unknown.value.code == "UNKNOWN_TOURNAMENT_MATCH"

    with pytest.raises(TournamentResultsError) as incomplete:
        calculate_tournament_standings(_request(plan, complete[:-1]))
    assert incomplete.value.code == "TOURNAMENT_RESULTS_INCOMPLETE"

    stale = [dict(result) for result in complete]
    stale[0]["home_team_id"] = "T999"
    with pytest.raises(TournamentResultsError) as participant:
        calculate_tournament_standings(_request(plan, stale))
    assert participant.value.code == "TOURNAMENT_RESULT_PARTICIPANT_MISMATCH"


def test_provisional_plan_is_rejected() -> None:
    plan = _plan((1, 1), resolved=False)

    with pytest.raises(TournamentResultsError) as exc_info:
        calculate_tournament_standings(_request(plan, []))

    assert exc_info.value.code == "TOURNAMENT_RESULTS_REQUIRE_RESOLVED_PLAN"


def test_cycle_in_match_references_is_rejected() -> None:
    plan = _plan((1, 1))
    plan_data = plan.model_dump(mode="json")
    plan_data["upper"]["logical_layout"] = None
    first_match = plan_data["upper"]["matches"][0]
    first_match["home"] = {"type": "winner_of", "match_id": first_match["id"]}
    cyclic_plan = TournamentPlan.model_validate(plan_data)
    results = _result_inputs(plan)

    with pytest.raises(TournamentResultsError) as exc_info:
        calculate_tournament_standings(_request(cyclic_plan, results))

    assert exc_info.value.code == "TOURNAMENT_DEPENDENCY_CYCLE"
