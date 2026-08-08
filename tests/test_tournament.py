from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest
from pydantic import ValidationError

from football_scheduler.league import LeaguePlan, generate_league_plan
from football_scheduler.league_results import LeagueStandings, Standing
from football_scheduler.tournament import (
    ConcreteTeamRef,
    LeagueRankRef,
    LoserOfRef,
    TournamentGenerationError,
    TournamentPlan,
    TournamentPoolPlan,
    TournamentSeed,
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
    block_sizes: tuple[int, ...],
    *,
    policy: str = "upper",
    seed: int = 17,
    with_standings: bool = True,
) -> dict[str, object]:
    plan, standings = _source(block_sizes, seed=seed)
    request: dict[str, object] = {
        "request_kind": "tournament_plan",
        "league_plan": plan.model_dump(mode="json"),
        "odd_split_policy": policy,
        "random_seed": seed,
    }
    if with_standings:
        request["league_standings"] = standings.model_dump(mode="json")
    return request


def _dependency_graph(pool: TournamentPoolPlan) -> tuple[object, ...]:
    """直接参加枠の値を除外し、試合IDと勝敗参照だけを正規化する。"""

    def entry_key(
        entry: ConcreteTeamRef | LeagueRankRef | WinnerOfRef | LoserOfRef,
    ) -> tuple[str, str] | tuple[str]:
        if isinstance(entry, WinnerOfRef):
            return ("winner_of", entry.match_id)
        if isinstance(entry, LoserOfRef):
            return ("loser_of", entry.match_id)
        return ("direct",)

    return (
        tuple(
            (
                match.id,
                match.rank_range,
                match.round_no,
                entry_key(match.home),
                entry_key(match.away),
            )
            for match in pool.matches
        ),
        tuple((placement.rank, entry_key(placement.entry)) for placement in pool.placements),
    )


@pytest.mark.parametrize(
    ("participant_count", "expected_matches"),
    [(2, 1), (4, 4), (8, 12), (16, 32)],
)
def test_power_of_two_complete_placement_tables(
    participant_count: int, expected_matches: int
) -> None:
    result = generate_tournament_plan(_request((participant_count * 2,), with_standings=False))

    assert result.upper.participant_count == participant_count
    assert len(result.upper.matches) == expected_matches
    assert [placement.rank for placement in result.upper.placements] == list(
        range(1, participant_count + 1)
    )
    assert result.upper.byes == ()


@pytest.mark.parametrize("participant_count", [2, 4, 8, 16])
def test_power_of_two_tables_include_complete_logical_layout(
    participant_count: int,
) -> None:
    pool = generate_tournament_plan(_request((participant_count * 2,), with_standings=False)).upper

    layout = pool.logical_layout
    assert layout is not None
    assert layout.layout_version == "1"
    assert {position.match_id for position in layout.match_positions} == {
        match.id for match in pool.matches
    }
    assert len(layout.opening_entry_order) == participant_count
    assert set(layout.opening_entry_order) == {seed.entry for seed in pool.seeds}
    assert len(layout.branch_alignments) == participant_count // 2 - 1
    assert layout.symmetry == "mirrored"
    assert all(alignment.status == "mirrored" for alignment in layout.branch_alignments)
    assert all(
        alignment.loser_to_winner_permutation
        == tuple(range(1, len(alignment.winner_source_order) + 1))
        for alignment in layout.branch_alignments
    )
    for rank_range in {position.rank_range for position in layout.match_positions}:
        orders = sorted(
            position.order
            for position in layout.match_positions
            if position.rank_range == rank_range
        )
        assert orders == list(range(1, len(orders) + 1))


@pytest.mark.parametrize("participant_count", [3, 5, 6, 7, 9, 10])
def test_non_power_of_two_tables_do_not_publish_logical_layout(
    participant_count: int,
) -> None:
    pool = generate_tournament_plan(_request((participant_count * 2,), with_standings=False)).upper

    assert pool.logical_layout is None


@pytest.mark.parametrize("participant_count", [2, 4, 8, 16])
def test_power_of_two_dependency_graph_depends_only_on_participant_count(
    participant_count: int,
) -> None:
    one_block = generate_tournament_plan(
        _request((participant_count * 2,), seed=17, with_standings=False)
    ).upper
    separate_blocks = generate_tournament_plan(
        _request((2,) * participant_count, seed=20260803, with_standings=False)
    ).upper

    assert _dependency_graph(one_block) == _dependency_graph(separate_blocks)


@pytest.mark.parametrize("participant_count", [2, 4, 8, 16])
def test_power_of_two_opening_matches_keep_higher_seed_home(
    participant_count: int,
) -> None:
    pool = generate_tournament_plan(
        _request((2,) * participant_count, seed=20260803, with_standings=False)
    ).upper
    seed_by_slot = {(seed.entry.block_id, seed.entry.rank): seed.seed_no for seed in pool.seeds}
    opening_matches = [
        match for match in pool.matches if match.rank_range == (1, participant_count)
    ]

    assert len(opening_matches) == participant_count // 2
    for match in opening_matches:
        assert isinstance(match.home, LeagueRankRef)
        assert isinstance(match.away, LeagueRankRef)
        assert seed_by_slot[(match.home.block_id, match.home.rank)] <= participant_count // 2
        assert seed_by_slot[(match.away.block_id, match.away.rank)] > participant_count // 2


@pytest.mark.parametrize(
    ("participant_count", "expected_matches", "expected_byes"),
    [(3, 2, 1), (5, 5, 3), (6, 7, 2), (7, 9, 2), (9, 13, 7), (10, 15, 6)],
)
def test_arbitrary_size_tables_cover_every_rank_without_bye_matches(
    participant_count: int, expected_matches: int, expected_byes: int
) -> None:
    result = generate_tournament_plan(_request((participant_count * 2,), with_standings=False))
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
    assert set(first.seed_draws[0].candidate_rank_refs) == set(
        first.seed_draws[0].decided_rank_refs
    )
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


def test_provisional_plan_uses_only_rank_slots() -> None:
    result = generate_tournament_plan(_request((4, 4, 4, 4), seed=99, with_standings=False))

    assert result.participant_resolution == "provisional"
    assert all(
        seed.team_id is None and seed.team is None
        for pool in (result.upper, result.lower)
        for seed in pool.seeds
    )
    assert result.seed_draws
    assert all(
        not draw.candidates
        and not draw.decided_order
        and draw.candidate_rank_refs
        and draw.decided_rank_refs
        for draw in result.seed_draws
    )


def test_resolving_rank_slots_does_not_change_bracket_structure() -> None:
    request = _request((4, 4, 4, 4), seed=101)
    provisional_request = {
        key: value for key, value in request.items() if key != "league_standings"
    }

    provisional = generate_tournament_plan(provisional_request)
    resolved = generate_tournament_plan(request)

    assert provisional.participant_resolution == "provisional"
    assert resolved.participant_resolution == "resolved"
    for provisional_pool, resolved_pool in (
        (provisional.upper, resolved.upper),
        (provisional.lower, resolved.lower),
    ):
        assert [seed.seed_no for seed in provisional_pool.seeds] == [
            seed.seed_no for seed in resolved_pool.seeds
        ]
        assert [seed.entry for seed in provisional_pool.seeds] == [
            seed.entry for seed in resolved_pool.seeds
        ]
        assert provisional_pool.matches == resolved_pool.matches
        assert provisional_pool.byes == resolved_pool.byes
        assert provisional_pool.placements == resolved_pool.placements
        assert provisional_pool.evaluation == resolved_pool.evaluation
        assert provisional_pool.logical_layout == resolved_pool.logical_layout
    assert [draw.decided_rank_refs for draw in provisional.seed_draws] == [
        draw.decided_rank_refs for draw in resolved.seed_draws
    ]


def test_rank_slot_draw_does_not_depend_on_assigned_team_ids() -> None:
    request = _request((4, 4, 4, 4), seed=303)
    swapped = _request((4, 4, 4, 4), seed=303)
    rows = swapped["league_standings"]["standings"]
    rows[0]["team_id"], rows[1]["team_id"] = rows[1]["team_id"], rows[0]["team_id"]

    first = generate_tournament_plan(request)
    second = generate_tournament_plan(swapped)

    assert first.upper.matches == second.upper.matches
    assert first.lower.matches == second.lower.matches
    assert [draw.decided_rank_refs for draw in first.seed_draws] == [
        draw.decided_rank_refs for draw in second.seed_draws
    ]


def test_seed_rejects_partial_concrete_team_binding() -> None:
    with pytest.raises(ValidationError, match="同時に指定"):
        TournamentSeed.model_validate(
            {
                "seed_no": 1,
                "team_id": "T1",
                "block_id": "A",
                "block_rank": 1,
                "entry": {"type": "league_rank", "block_id": "A", "rank": 1},
            }
        )


def test_explicit_resolution_rejects_incomplete_rank_draw_audit() -> None:
    result = generate_tournament_plan(_request((4, 4, 4, 4), seed=404))
    document = result.model_dump(mode="json")
    document["seed_draws"][0]["candidate_rank_refs"] = []

    with pytest.raises(ValidationError, match="順位枠候補"):
        TournamentPlan.model_validate(document)


def test_rejects_missing_or_inconsistent_final_standings() -> None:
    request = _request((4, 4))
    request["league_standings"]["standings"].pop()

    with pytest.raises(TournamentGenerationError) as error:
        generate_tournament_plan(request)

    assert error.value.code == "TOURNAMENT_SOURCE_INVALID"
    assert "順位を再確定" in error.value.message


def test_generated_json_round_trip_is_stable() -> None:
    result = generate_tournament_plan(_request((3, 4, 5), policy="alternate", with_standings=False))

    restored = TournamentPlan.model_validate_json(result.model_dump_json())

    assert restored == result


def test_legacy_and_null_logical_layouts_are_accepted() -> None:
    result = generate_tournament_plan(_request((4, 4, 4, 4), with_standings=False))
    legacy = result.model_dump(mode="json")
    for pool_name in ("upper", "lower"):
        legacy[pool_name].pop("logical_layout")

    restored_legacy = TournamentPlan.model_validate(legacy)
    null_layout = result.model_dump(mode="json")
    null_layout["upper"]["logical_layout"] = None

    assert restored_legacy.upper.logical_layout is None
    assert restored_legacy.lower.logical_layout is None
    assert TournamentPlan.model_validate(null_layout).upper.logical_layout is None


def test_legacy_permuted_logical_layout_is_accepted() -> None:
    document = generate_tournament_plan(
        _request((2,) * 4, seed=20260803, with_standings=False)
    ).model_dump(mode="json")
    upper = document["upper"]
    loser_match = next(match for match in upper["matches"] if match["rank_range"] == [3, 4])
    loser_match["home"], loser_match["away"] = loser_match["away"], loser_match["home"]
    layout = upper["logical_layout"]
    root = layout["branch_alignments"][0]
    root["status"] = "permuted"
    root["loser_source_order"] = list(reversed(root["loser_source_order"]))
    root["loser_to_winner_permutation"] = [2, 1]
    root["diagnostic_code"] = "OUTCOME_BRANCH_ORDER_DIFFERS"
    layout["symmetry"] = "permuted"

    restored = TournamentPlan.model_validate(document)

    assert restored.upper.logical_layout is not None
    assert restored.upper.logical_layout.symmetry == "permuted"


@pytest.mark.parametrize(
    "mutate",
    [
        lambda layout: layout["match_positions"].pop(),
        lambda layout: layout["match_positions"].append(layout["match_positions"][0]),
        lambda layout: layout["branch_alignments"][0]["winner_source_order"].__setitem__(
            0, "UNKNOWN"
        ),
        lambda layout: layout["branch_alignments"][0].update(
            {"loser_to_winner_permutation": [1, 2, 3, 4]}
        ),
        lambda layout: layout.update({"symmetry": "permuted"}),
    ],
)
def test_invalid_logical_layout_contract_is_rejected(
    mutate: Callable[[dict[str, Any]], object],
) -> None:
    document = generate_tournament_plan(
        _request((2,) * 16, seed=20260803, with_standings=False)
    ).model_dump(mode="json")
    layout = document["upper"]["logical_layout"]
    assert isinstance(layout, dict)
    mutate(layout)

    with pytest.raises(ValidationError):
        TournamentPlan.model_validate(document)


@pytest.mark.parametrize("participant_count", range(2, 9))
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


def test_sixteen_team_reference_dag_consumes_every_outcome_once() -> None:
    pool = generate_tournament_plan(_request((2,) * 16, seed=20260803, with_standings=False)).upper
    match_index = {match.id: index for index, match in enumerate(pool.matches)}
    outcome_counts = {
        (outcome, match.id): 0 for match in pool.matches for outcome in ("winner", "loser")
    }

    def record_reference(
        entry: ConcreteTeamRef | LeagueRankRef | WinnerOfRef | LoserOfRef,
        target_index: int,
    ) -> None:
        if isinstance(entry, WinnerOfRef):
            assert match_index[entry.match_id] < target_index
            outcome_counts[("winner", entry.match_id)] += 1
        elif isinstance(entry, LoserOfRef):
            assert match_index[entry.match_id] < target_index
            outcome_counts[("loser", entry.match_id)] += 1

    for index, match in enumerate(pool.matches):
        record_reference(match.home, index)
        record_reference(match.away, index)
    for placement in pool.placements:
        record_reference(placement.entry, len(pool.matches))

    assert set(outcome_counts.values()) == {1}
    assert [placement.rank for placement in pool.placements] == list(range(1, 17))
