from __future__ import annotations

from itertools import combinations

import pytest

from football_scheduler.final_stage import FinalStageConfigurationError
from football_scheduler.league import LeaguePlan, generate_league_plan
from football_scheduler.league_results import LeagueStandings, Standing
from football_scheduler.same_rank_league import (
    SameRankLeaguePlan,
    generate_same_rank_league_plan,
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
    rows: list[Standing] = []
    for block in plan.blocks:
        for rank, team_id in enumerate(block.team_ids, 1):
            rows.append(
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
            )
    return LeagueStandings(standings=tuple(rows), draws=())


def _generate(
    team_count: int,
    block_count: int,
    policy: str,
    *,
    resolved: bool = False,
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
            "random_seed": 29,
        }
    )


def test_18_teams_strict_groups_are_4_4_4_4_2_and_cover_every_rank() -> None:
    plan = _generate(18, 4, "strict_same_rank")

    assert [len(group.participants) for group in plan.groups] == [4, 4, 4, 4, 2]
    assert [group.overall_rank_range for group in plan.groups] == [
        (1, 4),
        (5, 8),
        (9, 12),
        (13, 16),
        (17, 18),
    ]
    assert [group.source_block_ranks for group in plan.groups] == [
        (1,),
        (2,),
        (3,),
        (4,),
        (5,),
    ]
    assert [warning.code for warning in plan.warnings] == ["SAME_RANK_UNEVEN_BLOCKS"]


def test_18_teams_merge_bottom_groups_are_4_4_4_6() -> None:
    plan = _generate(18, 4, "merge_bottom")

    assert [group.id for group in plan.groups] == [
        "same-rank-1",
        "same-rank-2",
        "same-rank-3",
        "same-rank-bottom",
    ]
    assert [len(group.participants) for group in plan.groups] == [4, 4, 4, 6]
    assert [group.overall_rank_range for group in plan.groups] == [
        (1, 4),
        (5, 8),
        (9, 12),
        (13, 18),
    ]
    assert plan.groups[-1].source_block_ranks == (4, 5)


def test_17_teams_strict_singleton_is_automatic_17th_with_two_warnings() -> None:
    plan = _generate(17, 4, "strict_same_rank", resolved=True)
    singleton = plan.groups[-1]

    assert len(singleton.participants) == 1
    assert singleton.matches == ()
    assert singleton.logical_rounds == ()
    assert singleton.overall_rank_range == (17, 17)
    assert plan.automatic_standings[0].overall_rank == 17
    assert plan.automatic_standings[0].team == singleton.participants[0].team
    assert [warning.code for warning in plan.warnings] == [
        "SAME_RANK_UNEVEN_BLOCKS",
        "SAME_RANK_SINGLETON_GROUP",
    ]


def test_divisible_groups_normalize_to_strict_without_warning() -> None:
    plan = _generate(16, 4, "strict_same_rank")

    assert plan.uneven_policy == "strict_same_rank"
    assert [len(group.participants) for group in plan.groups] == [4, 4, 4, 4]
    assert plan.warnings == ()


def test_provisional_and_resolved_plans_keep_rank_refs_matches_and_rounds_stable() -> None:
    provisional = _generate(18, 4, "merge_bottom")
    resolved = _generate(18, 4, "merge_bottom", resolved=True)

    assert provisional.participant_resolution == "provisional"
    assert resolved.participant_resolution == "resolved"
    assert [group.id for group in provisional.groups] == [group.id for group in resolved.groups]
    for before, after in zip(provisional.groups, resolved.groups, strict=True):
        assert [participant.entry for participant in before.participants] == [
            participant.entry for participant in after.participants
        ]
        assert [match.id for match in before.matches] == [match.id for match in after.matches]
        assert [(match.home, match.away) for match in before.matches] == [
            (match.home, match.away) for match in after.matches
        ]
        assert before.logical_rounds == after.logical_rounds
        assert all(participant.team is None for participant in before.participants)
        assert all(participant.team is not None for participant in after.participants)
        assert all(match.home_team is None and match.away_team is None for match in before.matches)
        assert all(
            match.home_team is not None and match.away_team is not None for match in after.matches
        )


@pytest.mark.parametrize("team_count", range(4, 33))
def test_every_valid_size_builds_complete_round_robins(team_count: int) -> None:
    for block_count in range(2, team_count // 2 + 1):
        policies = (
            ("strict_same_rank",)
            if team_count % block_count == 0
            else (
                "strict_same_rank",
                "merge_bottom",
            )
        )
        for policy in policies:
            plan = _generate(team_count, block_count, policy)
            entries = [
                (participant.entry.block_id, participant.entry.rank)
                for group in plan.groups
                for participant in group.participants
            ]
            assert len(entries) == team_count
            assert len(set(entries)) == team_count
            covered_ranks = [
                rank
                for group in plan.groups
                for rank in range(group.overall_rank_range[0], group.overall_rank_range[1] + 1)
            ]
            assert covered_ranks == list(range(1, team_count + 1))
            for group in plan.groups:
                participant_keys = {
                    (participant.entry.block_id, participant.entry.rank)
                    for participant in group.participants
                }
                actual_pairs = {
                    frozenset(
                        (
                            (match.home.block_id, match.home.rank),
                            (match.away.block_id, match.away.rank),
                        )
                    )
                    for match in group.matches
                }
                assert actual_pairs == {
                    frozenset(pair) for pair in combinations(participant_keys, 2)
                }
                assert len({match.id for match in group.matches}) == len(group.matches)
                for round_ in group.logical_rounds:
                    round_entries = [
                        entry
                        for match in group.matches
                        if match.id in round_.match_ids
                        for entry in (match.home, match.away)
                    ]
                    assert len(round_entries) == len(set(round_entries))


@pytest.mark.parametrize(
    ("team_count", "block_count"),
    [(3, 1), (8, 1), (8, 5)],
)
def test_rejects_unsupported_team_or_block_count(team_count: int, block_count: int) -> None:
    safe_block_count = max(1, min(block_count, team_count))
    league_plan = _league_plan(team_count, safe_block_count)

    with pytest.raises(FinalStageConfigurationError) as error:
        generate_same_rank_league_plan(
            {
                "request_kind": "same_rank_league_plan",
                "league_plan": league_plan.model_dump(mode="json"),
                "final_stage": {
                    "format": "same_rank_league",
                    "uneven_policy": "strict_same_rank",
                },
            }
        )

    assert error.value.code == "SAME_RANK_LEAGUE_TEAM_COUNT_UNSUPPORTED"
