from __future__ import annotations

import pytest

from football_scheduler.league import LeaguePlan, generate_league_plan
from football_scheduler.league_results import LeagueStandings, Standing
from football_scheduler.tournament import (
    ConcreteTeamRef,
    LeagueRankRef,
    LoserOfRef,
    TournamentGenerationError,
    TournamentPlan,
    WinnerOfRef,
    generate_tournament_plan,
)


def _source(block_sizes: tuple[int, ...], *, seed: int = 17) -> tuple[LeaguePlan, LeagueStandings]:
    team_count = sum(block_sizes)
    teams = [{"id": f"T{index}", "name": f"チーム{index}"} for index in range(1, team_count + 1)]
    manual_blocks: list[dict[str, object]] = []
    offset = 0
    for index, size in enumerate(block_sizes):
        manual_blocks.append(
            {
                "id": chr(ord("A") + index),
                "team_ids": [team["id"] for team in teams[offset : offset + size]],
            }
        )
        offset += size
    plan = generate_league_plan(
        {
            "teams": teams,
            "block_count": len(block_sizes),
            "assignment_mode": "manual",
            "manual_blocks": manual_blocks,
            "random_seed": seed,
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
            for block in plan.blocks
            for rank, team_id in enumerate(block.team_ids, 1)
        ),
        draws=(),
    )
    return plan, standings


def _request(
    block_sizes: tuple[int, ...], *, policy: str = "upper", seed: int = 17
) -> dict[str, object]:
    plan, standings = _source(block_sizes, seed=seed)
    return {
        "request_kind": "tournament_plan",
        "league_plan": plan.model_dump(mode="json"),
        "league_standings": standings.model_dump(mode="json"),
        "odd_split_policy": policy,
        "random_seed": seed,
    }


@pytest.mark.parametrize(
    ("participant_count", "expected_matches"),
    [(2, 1), (4, 4), (8, 12)],
)
def test_power_of_two_complete_placement_tables(
    participant_count: int, expected_matches: int
) -> None:
    result = generate_tournament_plan(_request((participant_count * 2,)))

    assert result.upper.participant_count == participant_count
    assert len(result.upper.matches) == expected_matches
    assert [placement.rank for placement in result.upper.placements] == list(
        range(1, participant_count + 1)
    )
    assert result.upper.byes == ()


@pytest.mark.parametrize(
    ("participant_count", "expected_matches", "expected_byes"),
    [(3, 2, 1), (5, 5, 3), (6, 7, 2), (7, 9, 2), (9, 13, 7), (10, 15, 6)],
)
def test_arbitrary_size_tables_cover_every_rank_without_bye_matches(
    participant_count: int, expected_matches: int, expected_byes: int
) -> None:
    result = generate_tournament_plan(_request((participant_count * 2,)))
    plan = result.upper

    assert len(plan.matches) == expected_matches
    assert len(plan.byes) == expected_byes
    assert all(bye.result == "advance_by_bye" for bye in plan.byes)
    assert all(bye.next_match_id in {match.id for match in plan.matches} for bye in plan.byes)
    assert [placement.rank for placement in plan.placements] == list(
        range(1, participant_count + 1)
    )
    assert len({match.id for match in plan.matches}) == expected_matches


def test_six_team_table_has_two_preliminaries_and_seven_matches() -> None:
    result = generate_tournament_plan(_request((12,))).upper

    assert len([match for match in result.matches if "-PRELIM-" in match.id]) == 2
    assert len(result.matches) == 7
    assert len([match for match in result.matches if match.rank_range != (5, 6)]) == 6
    assert len([match for match in result.matches if match.rank_range == (5, 6)]) == 1


def test_odd_split_policy_upper_lower_and_alternate() -> None:
    upper = generate_tournament_plan(_request((3, 3), policy="upper"))
    lower = generate_tournament_plan(_request((3, 3), policy="lower"))
    alternate = generate_tournament_plan(_request((3, 3), policy="alternate"))

    assert (upper.upper.participant_count, upper.lower.participant_count) == (4, 2)
    assert (lower.upper.participant_count, lower.lower.participant_count) == (2, 4)
    assert (alternate.upper.participant_count, alternate.lower.participant_count) == (3, 3)


def test_empty_and_single_participant_pools_do_not_create_matches() -> None:
    one_each = generate_tournament_plan(_request((2,)))
    empty_lower = generate_tournament_plan(_request((1, 1), policy="upper"))

    assert len(one_each.upper.matches) == len(one_each.lower.matches) == 0
    assert len(one_each.upper.placements) == len(one_each.lower.placements) == 1
    assert empty_lower.lower.participant_count == 0
    assert empty_lower.lower.matches == ()
    assert empty_lower.lower.placements == ()


def test_equal_block_rank_seed_draw_is_reproducible_and_audited() -> None:
    first = generate_tournament_plan(_request((4, 4, 4, 4), seed=99))
    second = generate_tournament_plan(_request((4, 4, 4, 4), seed=99))

    assert first == second
    assert first.seed_draws
    assert all(draw.random_seed == 99 for draw in first.seed_draws)
    assert set(first.seed_draws[0].candidates) == set(first.seed_draws[0].decided_order)
    assert [seed.block_rank for seed in first.upper.seeds] == sorted(
        seed.block_rank for seed in first.upper.seeds
    )


def test_avoidable_same_block_first_matches_are_avoided() -> None:
    result = generate_tournament_plan(_request((4, 4, 4, 4)))

    assert result.upper.evaluation.first_match_same_block_count == 0
    assert result.lower.evaluation.first_match_same_block_count == 0
    assert result.upper.evaluation.earliest_possible_same_block_round == 3
    assert result.lower.evaluation.earliest_possible_same_block_round == 3
    assert result.warnings == ()


def test_unavoidable_same_block_first_match_is_minimized_and_warned() -> None:
    result = generate_tournament_plan(_request((8,)))

    assert result.upper.evaluation.first_match_same_block_count == 2
    assert result.warnings[0].code == "SAME_BLOCK_FIRST_MATCH_UNAVOIDABLE"
    assert len(result.warnings[0].match_ids) == 2


def test_seed_entries_keep_league_rank_and_concrete_team_separate() -> None:
    seed = generate_tournament_plan(_request((4, 4))).upper.seeds[0]

    assert seed.entry.type == "league_rank"
    assert seed.team.type == "concrete_team"
    assert seed.team.team_id == seed.team_id


def test_rejects_missing_or_inconsistent_final_standings() -> None:
    request = _request((4, 4))
    request["league_standings"]["standings"].pop()

    with pytest.raises(TournamentGenerationError) as error:
        generate_tournament_plan(request)

    assert error.value.code == "TOURNAMENT_SOURCE_INVALID"
    assert "順位を再確定" in error.value.message


def test_generated_json_round_trip_is_stable() -> None:
    result = generate_tournament_plan(_request((3, 4, 5), policy="alternate"))

    restored = TournamentPlan.model_validate_json(result.model_dump_json())

    assert restored == result


@pytest.mark.parametrize("participant_count", range(2, 8))
def test_every_outcome_path_assigns_each_team_to_one_final_rank(
    participant_count: int,
) -> None:
    pool = generate_tournament_plan(_request((participant_count * 2,))).upper
    rank_teams = {(seed.block_id, seed.block_rank): seed.team_id for seed in pool.seeds}

    for outcome_bits in range(1 << len(pool.matches)):
        winners: dict[str, str] = {}
        losers: dict[str, str] = {}

        def resolve(
            entry: ConcreteTeamRef | LeagueRankRef | WinnerOfRef | LoserOfRef,
            winning_teams: dict[str, str] = winners,
            losing_teams: dict[str, str] = losers,
        ) -> str:
            if isinstance(entry, ConcreteTeamRef):
                return entry.team_id
            if isinstance(entry, LeagueRankRef):
                return rank_teams[(entry.block_id, entry.rank)]
            if isinstance(entry, WinnerOfRef):
                return winning_teams[entry.match_id]
            return losing_teams[entry.match_id]

        for index, match in enumerate(pool.matches):
            home = resolve(match.home)
            away = resolve(match.away)
            if outcome_bits & (1 << index):
                winners[match.id], losers[match.id] = home, away
            else:
                winners[match.id], losers[match.id] = away, home

        placed = [resolve(placement.entry) for placement in pool.placements]
        assert len(placed) == participant_count
        assert set(placed) == {seed.team_id for seed in pool.seeds}
