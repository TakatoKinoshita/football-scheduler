from __future__ import annotations

from typing import Any

import pytest

from football_scheduler.league import generate_league_plan
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


def _plan(*, resolved: bool = True) -> TournamentPlan:
    teams = [{"id": f"T{i}", "name": f"チーム{i}"} for i in range(1, 25)]
    blocks = [
        {
            "id": f"B{block + 1}",
            "team_ids": [f"T{block * 6 + rank}" for rank in range(1, 7)],
        }
        for block in range(4)
    ]
    league = generate_league_plan(
        {
            "teams": teams,
            "block_count": 4,
            "assignment_mode": "manual",
            "manual_blocks": blocks,
        }
    )
    standings = LeagueStandings(
        standings=tuple(
            Standing(
                block_id=block.id,
                rank=rank,
                team_id=team_id,
                played=5,
                wins=0,
                draws=0,
                losses=0,
                goals_for=0,
                goals_against=0,
                goal_difference=0,
                points=0,
                tie_break="テスト用確定順位",
            )
            for block in league.blocks
            for rank, team_id in enumerate(block.team_ids, 1)
        ),
        draws=(),
    )
    request: dict[str, Any] = {
        "request_kind": "tournament_plan",
        "league_plan": league.model_dump(mode="json"),
        "final_stage": {"format": "placement_tournament", "tournament_count": 3},
    }
    if resolved:
        request["league_standings"] = standings.model_dump(mode="json")
    return generate_tournament_plan(request)


def _results(
    plan: TournamentPlan, *, penalty_match_id: str | None = None
) -> list[dict[str, object]]:
    team_by_rank = {
        (seed.block_id, seed.block_rank): seed.team_id for pool in plan.pools for seed in pool.seeds
    }
    winners: dict[str, str] = {}
    losers: dict[str, str] = {}

    def team(entry: TournamentEntry) -> str:
        if isinstance(entry, ConcreteTeamRef):
            return entry.team_id
        if isinstance(entry, LeagueRankRef):
            value = team_by_rank[entry.block_id, entry.rank]
            assert value is not None
            return value
        if isinstance(entry, WinnerOfRef):
            return winners[entry.match_id]
        if isinstance(entry, LoserOfRef):
            return losers[entry.match_id]
        raise AssertionError("unsupported entry")

    result: list[dict[str, object]] = []
    for pool in plan.pools:
        for match in pool.matches:
            home, away = team(match.home), team(match.away)
            item: dict[str, object] = {
                "match_id": match.id,
                "home_team_id": home,
                "away_team_id": away,
                "regular_score_home": 1,
                "regular_score_away": 0,
            }
            if match.id == penalty_match_id:
                item.update(
                    regular_score_home=1,
                    regular_score_away=1,
                    penalty_score_home=4,
                    penalty_score_away=3,
                )
            winners[match.id], losers[match.id] = home, away
            result.append(item)
    return result


def _request(plan: TournamentPlan, results: list[dict[str, object]]) -> dict[str, object]:
    return {
        "request_kind": "tournament_results",
        "tournament_plan": plan.model_dump(mode="json"),
        "results": results,
    }


def test_results_cover_all_pools_and_overall_ranks() -> None:
    plan = _plan()
    supplied = _results(plan)

    outcome = calculate_tournament_standings(_request(plan, list(reversed(supplied))))

    assert [row.rank for row in outcome.standings] == list(range(1, 25))
    assert len({row.team_id for row in outcome.standings}) == 24
    assert [(row.pool_id, row.pool_rank, row.rank) for row in outcome.standings] == [
        (f"placement-{(rank - 1) // 8 + 1}", (rank - 1) % 8 + 1, rank) for rank in range(1, 25)
    ]
    assert len(outcome.match_results) == 36


def test_penalty_shootout_is_kept_separate() -> None:
    plan = _plan()
    match_id = plan.pools[0].matches[0].id

    outcome = calculate_tournament_standings(
        _request(plan, _results(plan, penalty_match_id=match_id))
    )
    result = next(item for item in outcome.match_results if item.match_id == match_id)

    assert result.regular_score_home == result.regular_score_away == 1
    assert (result.penalty_score_home, result.penalty_score_away) == (4, 3)
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
    plan = _plan()
    results = _results(plan)
    results[0].update(scores)

    with pytest.raises(TournamentResultsError) as exc_info:
        calculate_tournament_standings(_request(plan, results))

    assert exc_info.value.code == "TOURNAMENT_RESULT_INVALID"
    assert exc_info.value.details["reason"] == reason


def test_duplicate_unknown_incomplete_and_stale_results_are_distinguished() -> None:
    plan = _plan()
    complete = _results(plan)

    with pytest.raises(TournamentResultsError) as duplicate:
        calculate_tournament_standings(_request(plan, [*complete, complete[0]]))
    assert duplicate.value.code == "DUPLICATE_TOURNAMENT_RESULT"

    unknown = {**complete[0], "match_id": "PT-UNKNOWN"}
    with pytest.raises(TournamentResultsError) as unknown_error:
        calculate_tournament_standings(_request(plan, [*complete, unknown]))
    assert unknown_error.value.code == "UNKNOWN_TOURNAMENT_MATCH"

    with pytest.raises(TournamentResultsError) as incomplete:
        calculate_tournament_standings(_request(plan, complete[:-1]))
    assert incomplete.value.code == "TOURNAMENT_RESULTS_INCOMPLETE"

    stale = [dict(result) for result in complete]
    stale[0]["home_team_id"] = "T999"
    with pytest.raises(TournamentResultsError) as participant:
        calculate_tournament_standings(_request(plan, stale))
    assert participant.value.code == "TOURNAMENT_RESULT_PARTICIPANT_MISMATCH"


def test_provisional_plan_is_rejected() -> None:
    plan = _plan(resolved=False)

    with pytest.raises(TournamentResultsError) as exc_info:
        calculate_tournament_standings(_request(plan, []))

    assert exc_info.value.code == "TOURNAMENT_RESULTS_REQUIRE_RESOLVED_PLAN"


def test_cycle_in_any_pool_is_rejected() -> None:
    plan = _plan()
    document = plan.model_dump(mode="json")
    document["pools"][1]["logical_layout"] = None
    first_match = document["pools"][1]["matches"][0]
    first_match["home"] = {"type": "winner_of", "match_id": first_match["id"]}
    cyclic = TournamentPlan.model_validate(document)

    with pytest.raises(TournamentResultsError) as exc_info:
        calculate_tournament_standings(_request(cyclic, _results(plan)))

    assert exc_info.value.code == "TOURNAMENT_DEPENDENCY_CYCLE"
