from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from football_scheduler.final_stage import FinalStageConfigurationError
from football_scheduler.league import LeaguePlan, generate_league_plan
from football_scheduler.league_results import LeagueStandings, Standing
from football_scheduler.tournament import (
    LeagueRankRef,
    ParticipantResolution,
    TournamentPlan,
    TournamentSeed,
    generate_tournament_plan,
)


def _source(team_count: int, block_count: int) -> tuple[LeaguePlan, LeagueStandings]:
    teams = [{"id": f"T{i}", "name": f"チーム{i}"} for i in range(1, team_count + 1)]
    block_size = team_count // block_count
    blocks = [
        {
            "id": f"B{index + 1}",
            "team_ids": [f"T{index * block_size + offset}" for offset in range(1, block_size + 1)],
        }
        for index in range(block_count)
    ]
    plan = generate_league_plan(
        {
            "teams": teams,
            "block_count": block_count,
            "assignment_mode": "manual",
            "manual_blocks": blocks,
            "random_seed": 17,
        }
    )
    standings = LeagueStandings(
        standings=tuple(
            Standing(
                block_id=block.id,
                rank=rank,
                team_id=team_id,
                played=block_size - 1,
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
    team_count: int,
    block_count: int,
    tournament_count: int,
    *,
    resolved: bool = True,
    random_seed: int = 17,
) -> dict[str, Any]:
    plan, standings = _source(team_count, block_count)
    request: dict[str, Any] = {
        "request_kind": "tournament_plan",
        "league_plan": plan.model_dump(mode="json"),
        "final_stage": {
            "format": "placement_tournament",
            "tournament_count": tournament_count,
        },
        "random_seed": random_seed,
    }
    if resolved:
        request["league_standings"] = standings.model_dump(mode="json")
    return request


@pytest.mark.parametrize(
    ("team_count", "tournament_count", "block_count", "pool_size", "matches"),
    [
        (8, 2, 2, 4, 4),
        (16, 2, 4, 8, 12),
        (24, 3, 8, 8, 12),
        (32, 2, 16, 16, 32),
        (32, 4, 8, 8, 12),
    ],
)
def test_supported_placement_configurations_generate_ordered_pools(
    team_count: int,
    tournament_count: int,
    block_count: int,
    pool_size: int,
    matches: int,
) -> None:
    plan = generate_tournament_plan(
        _request(team_count, block_count, tournament_count, resolved=False)
    )

    assert plan.tournament_count == tournament_count
    assert [pool.pool_id for pool in plan.pools] == [
        f"placement-{index}" for index in range(1, tournament_count + 1)
    ]
    assert [pool.pool_index for pool in plan.pools] == list(range(1, tournament_count + 1))
    assert all(pool.participant_count == pool_size for pool in plan.pools)
    assert all(len(pool.matches) == matches for pool in plan.pools)
    assert all(pool.logical_layout is not None for pool in plan.pools)
    assert all("byes" not in pool.model_dump(mode="json") for pool in plan.pools)
    assert all("PRELIM" not in match.id for pool in plan.pools for match in pool.matches)


def test_custom_tournament_names_are_preserved_in_generated_pools() -> None:
    request = _request(8, 2, 2, resolved=False)
    request["final_stage"]["tournament_names"] = [  # type: ignore[index]
        "チャンピオンリーグ",
        "チャレンジリーグ",
    ]

    plan = generate_tournament_plan(request)

    assert plan.tournament_names == ("チャンピオンリーグ", "チャレンジリーグ")
    assert [pool.display_name for pool in plan.pools] == [
        "チャンピオンリーグ",
        "チャレンジリーグ",
    ]


@pytest.mark.parametrize(
    ("team_count", "block_count", "tournament_count", "code"),
    [
        (12, 2, 2, "PLACEMENT_TOURNAMENT_TEAM_COUNT_UNSUPPORTED"),
        (24, 4, 2, "PLACEMENT_TOURNAMENT_COUNT_INVALID"),
        (16, 16, 2, "PLACEMENT_TOURNAMENT_BLOCK_COUNT_INVALID"),
    ],
)
def test_unsupported_configuration_is_rejected_with_specific_code(
    team_count: int, block_count: int, tournament_count: int, code: str
) -> None:
    with pytest.raises(FinalStageConfigurationError) as exc_info:
        generate_tournament_plan(_request(team_count, block_count, tournament_count))

    assert exc_info.value.code == code


def test_rank_band_formula_covers_every_league_rank_once() -> None:
    plan = generate_tournament_plan(_request(24, 4, 3, resolved=False))

    assert [pool.overall_rank_range for pool in plan.pools] == [(1, 8), (9, 16), (17, 24)]
    assert [sorted({seed.block_rank for seed in pool.seeds}) for pool in plan.pools] == [
        [1, 2],
        [3, 4],
        [5, 6],
    ]
    rank_refs = [
        (seed.entry.block_id, seed.entry.rank) for pool in plan.pools for seed in pool.seeds
    ]
    assert len(rank_refs) == len(set(rank_refs)) == 24
    assert [placement.rank for pool in plan.pools for placement in pool.placements] == list(
        range(1, 25)
    )
    assert all(
        [placement.pool_rank for placement in pool.placements]
        == list(range(1, pool.participant_count + 1))
        for pool in plan.pools
    )


def test_equal_rank_draws_are_reproducible_and_audited_per_pool() -> None:
    first = generate_tournament_plan(_request(32, 8, 4, random_seed=99))
    second = generate_tournament_plan(_request(32, 8, 4, random_seed=99))

    assert first == second
    assert {draw.pool_id for draw in first.seed_draws} == {
        "placement-1",
        "placement-2",
        "placement-3",
        "placement-4",
    }
    assert all(draw.random_seed == 99 for draw in first.seed_draws)
    assert all(set(draw.candidates) == set(draw.decided_order) for draw in first.seed_draws)


def test_same_block_avoidance_is_applied_to_every_pool() -> None:
    plan = generate_tournament_plan(_request(32, 8, 4, resolved=False))

    assert all(pool.evaluation.first_match_same_block_count == 0 for pool in plan.pools)
    assert plan.warnings == ()


def test_provisional_and_resolved_plans_keep_the_same_structure() -> None:
    provisional = generate_tournament_plan(_request(16, 4, 2, resolved=False, random_seed=101))
    resolved = generate_tournament_plan(_request(16, 4, 2, resolved=True, random_seed=101))

    assert provisional.participant_resolution is ParticipantResolution.PROVISIONAL
    assert resolved.participant_resolution is ParticipantResolution.RESOLVED
    assert all(seed.team_id is None for pool in provisional.pools for seed in pool.seeds)
    assert all(seed.team_id is not None for pool in resolved.pools for seed in pool.seeds)
    for before, after in zip(provisional.pools, resolved.pools, strict=True):
        assert [seed.entry for seed in before.seeds] == [seed.entry for seed in after.seeds]
        assert before.matches == after.matches
        assert before.placements == after.placements
        assert before.logical_layout == after.logical_layout


def test_opening_matches_keep_higher_seed_home() -> None:
    pool = generate_tournament_plan(_request(32, 8, 4, resolved=False)).pools[0]
    seed_no = {(seed.entry.block_id, seed.entry.rank): seed.seed_no for seed in pool.seeds}
    opening = [match for match in pool.matches if match.rank_range == pool.overall_rank_range]

    assert len(opening) == pool.participant_count // 2
    for match in opening:
        assert isinstance(match.home, LeagueRankRef)
        assert isinstance(match.away, LeagueRankRef)
        assert seed_no[(match.home.block_id, match.home.rank)] <= pool.participant_count // 2
        assert seed_no[(match.away.block_id, match.away.rank)] > pool.participant_count // 2


def test_plan_json_round_trip_is_stable() -> None:
    plan = generate_tournament_plan(_request(24, 8, 3))

    assert TournamentPlan.model_validate(plan.model_dump(mode="json")) == plan


def test_seed_rejects_partial_concrete_team_binding() -> None:
    with pytest.raises(ValidationError, match="同時に指定"):
        TournamentSeed.model_validate(
            {
                "seed_no": 1,
                "team_id": "T1",
                "block_id": "B1",
                "block_rank": 1,
                "entry": {"type": "league_rank", "block_id": "B1", "rank": 1},
            }
        )


def test_odd_split_policy_is_not_part_of_schema_0_2() -> None:
    request = _request(8, 2, 2)
    request["odd_split_policy"] = "upper"

    with pytest.raises(ValidationError):
        generate_tournament_plan(request)
