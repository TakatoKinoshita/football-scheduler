"""確定したリーグ順位から2日目の完全順位決定トーナメントを生成する。"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from functools import cache
from hashlib import sha256
from typing import Annotated, Any, Literal

from pydantic import Field

from football_scheduler.league import LeaguePlan
from football_scheduler.league_results import LeagueStandings
from football_scheduler.models import ContractModel, Identifier, NonEmptyText


class OddSplitPolicy(StrEnum):
    """奇数人数ブロックの中央順位をどちらへ振り分けるか。"""

    UPPER = "upper"
    LOWER = "lower"
    ALTERNATE = "alternate"


class TournamentPool(StrEnum):
    UPPER = "upper"
    LOWER = "lower"


class ConcreteTeamRef(ContractModel):
    type: Literal["concrete_team"] = "concrete_team"
    team_id: Identifier


class LeagueRankRef(ContractModel):
    type: Literal["league_rank"] = "league_rank"
    block_id: Identifier
    rank: Annotated[int, Field(gt=0)]


class WinnerOfRef(ContractModel):
    type: Literal["winner_of"] = "winner_of"
    match_id: Identifier


class LoserOfRef(ContractModel):
    type: Literal["loser_of"] = "loser_of"
    match_id: Identifier


TournamentEntry = Annotated[
    ConcreteTeamRef | LeagueRankRef | WinnerOfRef | LoserOfRef,
    Field(discriminator="type"),
]


class TournamentPlanRequest(ContractModel):
    schema_version: Literal["0.1.0"] = "0.1.0"
    request_kind: Literal["tournament_plan"]
    league_plan: LeaguePlan
    league_standings: LeagueStandings
    odd_split_policy: OddSplitPolicy = OddSplitPolicy.UPPER
    random_seed: int = 20260803


class TournamentSeed(ContractModel):
    seed_no: Annotated[int, Field(gt=0)]
    team_id: Identifier
    block_id: Identifier
    block_rank: Annotated[int, Field(gt=0)]
    entry: LeagueRankRef
    team: ConcreteTeamRef


class SeedDrawRecord(ContractModel):
    pool: TournamentPool
    block_rank: Annotated[int, Field(gt=0)]
    candidates: tuple[Identifier, ...]
    decided_order: tuple[Identifier, ...]
    random_seed: int


class TournamentMatch(ContractModel):
    id: Identifier
    phase: Literal["upper_tournament", "lower_tournament"]
    round: NonEmptyText
    round_no: Annotated[int, Field(gt=0)]
    home: TournamentEntry
    away: TournamentEntry
    rank_range: tuple[Annotated[int, Field(gt=0)], Annotated[int, Field(gt=0)]]


class ByeAdvance(ContractModel):
    entry: TournamentEntry
    result: Literal["advance_by_bye"] = "advance_by_bye"
    next_match_id: Identifier


class TournamentPlacement(ContractModel):
    rank: Annotated[int, Field(gt=0)]
    entry: TournamentEntry


class TournamentEvaluation(ContractModel):
    first_match_same_block_count: Annotated[int, Field(ge=0)]
    possible_same_block_match_count: Annotated[int, Field(ge=0)]
    earliest_possible_same_block_round: Annotated[int, Field(gt=0)] | None = None


class TournamentPoolPlan(ContractModel):
    pool: TournamentPool
    participant_count: Annotated[int, Field(ge=0)]
    seeds: tuple[TournamentSeed, ...]
    matches: tuple[TournamentMatch, ...]
    byes: tuple[ByeAdvance, ...]
    placements: tuple[TournamentPlacement, ...]
    evaluation: TournamentEvaluation


class TournamentWarning(ContractModel):
    code: Identifier
    message: NonEmptyText
    pool: TournamentPool
    match_ids: tuple[Identifier, ...] = ()


class TournamentPlan(ContractModel):
    schema_version: Literal["0.1.0"] = "0.1.0"
    status: Literal["COMPLETE"] = "COMPLETE"
    odd_split_policy: OddSplitPolicy
    random_seed: int
    upper: TournamentPoolPlan
    lower: TournamentPoolPlan
    seed_draws: tuple[SeedDrawRecord, ...]
    warnings: tuple[TournamentWarning, ...]


class TournamentGenerationError(ValueError):
    """利用者が修正できるトーナメント生成エラー。"""

    def __init__(self, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.code, self.message, self.details = code, message, details


@dataclass(frozen=True)
class _EntryState:
    ref: TournamentEntry
    block_ids: frozenset[str]
    has_played: bool


@dataclass(frozen=True)
class _MatchAudit:
    match_id: str
    round_no: int
    first_same_block: bool
    possible_same_block: bool


class _BracketBuilder:
    def __init__(self, pool: TournamentPool, random_seed: int) -> None:
        self.pool = pool
        self.random_seed = random_seed
        self.prefix = "UT" if pool is TournamentPool.UPPER else "LT"
        self.phase: Literal["upper_tournament", "lower_tournament"] = (
            "upper_tournament" if pool is TournamentPool.UPPER else "lower_tournament"
        )
        self.matches: list[TournamentMatch] = []
        self.placements: list[TournamentPlacement] = []
        self.bye_entries: list[TournamentEntry] = []
        self.audits: list[_MatchAudit] = []
        self._id_counts: dict[tuple[str, int, int], int] = {}

    def build(self, entries: list[_EntryState]) -> None:
        self._build_group(entries, 1, 1)

    def finalized_byes(self) -> tuple[ByeAdvance, ...]:
        byes: list[ByeAdvance] = []
        for entry in self.bye_entries:
            next_match = next(
                (match.id for match in self.matches if match.home == entry or match.away == entry),
                None,
            )
            if next_match is None:
                raise RuntimeError("不戦通過の接続先を特定できません")
            byes.append(ByeAdvance(entry=entry, next_match_id=next_match))
        return tuple(byes)

    def _build_group(self, entries: list[_EntryState], rank_start: int, round_no: int) -> None:
        count = len(entries)
        if count == 0:
            return
        if count == 1:
            self.placements.append(TournamentPlacement(rank=rank_start, entry=entries[0].ref))
            return
        if count & (count - 1) == 0:
            self._build_power_of_two(entries, rank_start, round_no)
            return

        main_size = 1 << (count.bit_length() - 1)
        preliminary_count = count - main_size
        bye_count = count - 2 * preliminary_count
        bye_entries = entries[:bye_count]
        preliminary_entries = entries[bye_count:]
        for entry in bye_entries:
            self.bye_entries.append(entry.ref)

        winners, losers = self._play_opening_matches(
            preliminary_entries,
            rank_start,
            rank_start + count - 1,
            round_no,
            "PRELIM",
            "予備戦",
        )
        self._build_group([*bye_entries, *winners], rank_start, round_no + 1)
        self._build_group(
            losers,
            rank_start + main_size,
            round_no + 1,
        )

    def _build_power_of_two(
        self, entries: list[_EntryState], rank_start: int, round_no: int
    ) -> None:
        count = len(entries)
        rank_end = rank_start + count - 1
        label = (
            "優勝決定戦"
            if rank_start == 1 and count == 2
            else f"{rank_start}位決定戦"
            if count == 2
            else f"{rank_start}〜{rank_end}位 順位決定"
        )
        winners, losers = self._play_opening_matches(
            entries, rank_start, rank_end, round_no, "RANK", label
        )
        half = count // 2
        self._build_group(winners, rank_start, round_no + 1)
        self._build_group(losers, rank_start + half, round_no + 1)

    def _play_opening_matches(
        self,
        entries: list[_EntryState],
        rank_start: int,
        rank_end: int,
        round_no: int,
        kind: str,
        label: str,
    ) -> tuple[list[_EntryState], list[_EntryState]]:
        if len(entries) % 2:
            raise RuntimeError("対戦生成対象は偶数である必要があります")
        half = len(entries) // 2
        left = entries[:half]
        right = entries[half:]
        assignment = _best_pair_assignment(
            left,
            right,
            f"{self.random_seed}:{self.pool}:{kind}:{rank_start}:{rank_end}:{round_no}",
        )
        winners: list[_EntryState] = []
        losers: list[_EntryState] = []
        for home, right_index in zip(left, assignment, strict=True):
            away = right[right_index]
            match_id = self._next_id(kind, rank_start, rank_end)
            self.matches.append(
                TournamentMatch(
                    id=match_id,
                    phase=self.phase,
                    round=label,
                    round_no=round_no,
                    home=home.ref,
                    away=away.ref,
                    rank_range=(rank_start, rank_end),
                )
            )
            common_blocks = home.block_ids & away.block_ids
            first_same_block = bool(common_blocks) and not home.has_played and not away.has_played
            self.audits.append(
                _MatchAudit(
                    match_id=match_id,
                    round_no=round_no,
                    first_same_block=first_same_block,
                    possible_same_block=bool(common_blocks),
                )
            )
            possible_blocks = home.block_ids | away.block_ids
            winners.append(
                _EntryState(
                    ref=WinnerOfRef(match_id=match_id),
                    block_ids=possible_blocks,
                    has_played=True,
                )
            )
            losers.append(
                _EntryState(
                    ref=LoserOfRef(match_id=match_id),
                    block_ids=possible_blocks,
                    has_played=True,
                )
            )
        if kind == "RANK" and len(winners) >= 2:
            order = _best_next_round_order(
                winners,
                f"{self.random_seed}:{self.pool}:{rank_start}:{rank_end}:{round_no}:next",
            )
            winners = [winners[index] for index in order]
            losers = [losers[index] for index in order]
        return winners, losers

    def _next_id(self, kind: str, rank_start: int, rank_end: int) -> str:
        key = (kind, rank_start, rank_end)
        number = self._id_counts.get(key, 0) + 1
        self._id_counts[key] = number
        return f"{self.prefix}-{kind}-{rank_start}-{rank_end}-M{number}"


def generate_tournament_plan(
    request: TournamentPlanRequest | dict[str, object],
) -> TournamentPlan:
    """確定済み順位を上下へ分け、1位から最下位まで決まる表を返す。"""

    data = (
        request
        if isinstance(request, TournamentPlanRequest)
        else TournamentPlanRequest.model_validate(request)
    )
    standings_by_block = _validate_source(data.league_plan, data.league_standings)
    upper_rows, lower_rows = _split_standings(
        data.league_plan, standings_by_block, data.odd_split_policy
    )
    upper_seeds, upper_draws = _seed_pool(TournamentPool.UPPER, upper_rows, data.random_seed)
    lower_seeds, lower_draws = _seed_pool(TournamentPool.LOWER, lower_rows, data.random_seed)
    upper, upper_warnings = _generate_pool(TournamentPool.UPPER, upper_seeds, data.random_seed)
    lower, lower_warnings = _generate_pool(TournamentPool.LOWER, lower_seeds, data.random_seed)
    return TournamentPlan(
        odd_split_policy=data.odd_split_policy,
        random_seed=data.random_seed,
        upper=upper,
        lower=lower,
        seed_draws=(*upper_draws, *lower_draws),
        warnings=(*upper_warnings, *lower_warnings),
    )


def _validate_source(
    plan: LeaguePlan, standings: LeagueStandings
) -> dict[str, list[tuple[int, str]]]:
    block_ids = [block.id for block in plan.blocks]
    if len(set(block_ids)) != len(block_ids):
        raise _source_error("duplicate_block_id")
    team_to_block: dict[str, str] = {}
    for block in plan.blocks:
        if len(set(block.team_ids)) != len(block.team_ids):
            raise _source_error("duplicate_team_in_block", block_id=block.id)
        for team_id in block.team_ids:
            if team_id in team_to_block:
                raise _source_error("team_in_multiple_blocks", team_id=team_id)
            team_to_block[team_id] = block.id

    rows_by_block: dict[str, list[tuple[int, str]]] = {block_id: [] for block_id in block_ids}
    seen_teams: set[str] = set()
    for row in standings.standings:
        if row.block_id not in rows_by_block:
            raise _source_error("unknown_standings_block", block_id=row.block_id)
        if team_to_block.get(row.team_id) != row.block_id:
            raise _source_error(
                "team_outside_standings_block",
                block_id=row.block_id,
                team_id=row.team_id,
            )
        if row.team_id in seen_teams:
            raise _source_error("duplicate_team_in_standings", team_id=row.team_id)
        seen_teams.add(row.team_id)
        rows_by_block[row.block_id].append((row.rank, row.team_id))

    missing = sorted(set(team_to_block) - seen_teams)
    if missing:
        raise _source_error("team_missing_from_standings", team_ids=missing)
    for block in plan.blocks:
        rows = rows_by_block[block.id]
        actual_ranks = sorted(rank for rank, _team_id in rows)
        expected_ranks = list(range(1, len(block.team_ids) + 1))
        if actual_ranks != expected_ranks:
            raise _source_error(
                "invalid_block_ranks",
                block_id=block.id,
                expected_ranks=expected_ranks,
                actual_ranks=actual_ranks,
            )
        rows.sort()
    return rows_by_block


def _source_error(reason: str, **details: object) -> TournamentGenerationError:
    return TournamentGenerationError(
        "TOURNAMENT_SOURCE_INVALID",
        "リーグ順位とブロック情報の対応を確認できませんでした。順位を再確定してください。",
        reason=reason,
        **details,
    )


def _split_standings(
    plan: LeaguePlan,
    rows_by_block: dict[str, list[tuple[int, str]]],
    policy: OddSplitPolicy,
) -> tuple[list[tuple[int, str, str]], list[tuple[int, str, str]]]:
    upper: list[tuple[int, str, str]] = []
    lower: list[tuple[int, str, str]] = []
    odd_index = 0
    for block in plan.blocks:
        rows = rows_by_block[block.id]
        count = len(rows)
        if count % 2 == 0:
            upper_count = count // 2
        elif policy is OddSplitPolicy.UPPER:
            upper_count = (count + 1) // 2
        elif policy is OddSplitPolicy.LOWER:
            upper_count = count // 2
        else:
            upper_count = (count + 1) // 2 if odd_index % 2 == 0 else count // 2
            odd_index += 1
        upper.extend((rank, block.id, team_id) for rank, team_id in rows[:upper_count])
        lower.extend((rank, block.id, team_id) for rank, team_id in rows[upper_count:])
    return upper, lower


def _seed_pool(
    pool: TournamentPool,
    rows: list[tuple[int, str, str]],
    random_seed: int,
) -> tuple[tuple[TournamentSeed, ...], tuple[SeedDrawRecord, ...]]:
    groups: dict[int, list[tuple[int, str, str]]] = {}
    for row in rows:
        groups.setdefault(row[0], []).append(row)
    ordered: list[tuple[int, str, str]] = []
    draws: list[SeedDrawRecord] = []
    for rank in sorted(groups):
        candidates = groups[rank]
        decided = sorted(
            candidates,
            key=lambda row: (
                sha256(f"{random_seed}:seed:{pool.value}:{rank}:{row[2]}".encode()).digest(),
                row[2],
            ),
        )
        ordered.extend(decided)
        if len(candidates) > 1:
            draws.append(
                SeedDrawRecord(
                    pool=pool,
                    block_rank=rank,
                    candidates=tuple(sorted(row[2] for row in candidates)),
                    decided_order=tuple(row[2] for row in decided),
                    random_seed=random_seed,
                )
            )
    seeds = tuple(
        TournamentSeed(
            seed_no=index,
            team_id=team_id,
            block_id=block_id,
            block_rank=rank,
            entry=LeagueRankRef(block_id=block_id, rank=rank),
            team=ConcreteTeamRef(team_id=team_id),
        )
        for index, (rank, block_id, team_id) in enumerate(ordered, 1)
    )
    return seeds, tuple(draws)


def _generate_pool(
    pool: TournamentPool,
    seeds: tuple[TournamentSeed, ...],
    random_seed: int,
) -> tuple[TournamentPoolPlan, tuple[TournamentWarning, ...]]:
    builder = _BracketBuilder(pool, random_seed)
    entries = [
        _EntryState(ref=seed.entry, block_ids=frozenset({seed.block_id}), has_played=False)
        for seed in seeds
    ]
    builder.build(entries)
    first_conflicts = tuple(audit.match_id for audit in builder.audits if audit.first_same_block)
    possible_conflicts = [audit for audit in builder.audits if audit.possible_same_block]
    evaluation = TournamentEvaluation(
        first_match_same_block_count=len(first_conflicts),
        possible_same_block_match_count=len(possible_conflicts),
        earliest_possible_same_block_round=min(
            (audit.round_no for audit in possible_conflicts), default=None
        ),
    )
    warnings: tuple[TournamentWarning, ...] = ()
    if first_conflicts:
        warnings = (
            TournamentWarning(
                code="SAME_BLOCK_FIRST_MATCH_UNAVOIDABLE",
                message="初戦の同一ブロック対戦をすべて避けられないため、対戦数が最少になる組合せを採用しました。",
                pool=pool,
                match_ids=first_conflicts,
            ),
        )
    plan = TournamentPoolPlan(
        pool=pool,
        participant_count=len(seeds),
        seeds=seeds,
        matches=tuple(builder.matches),
        byes=builder.finalized_byes(),
        placements=tuple(sorted(builder.placements, key=lambda placement: placement.rank)),
        evaluation=evaluation,
    )
    return plan, warnings


def _best_pair_assignment(
    left: list[_EntryState], right: list[_EntryState], salt: str
) -> tuple[int, ...]:
    """高位側と低位側を組ませ、初戦同ブロック、早期再戦の順に減らす。"""

    size = len(left)
    if size != len(right):
        raise RuntimeError("左右の対戦候補数が一致しません")

    def pair_cost(left_index: int, right_index: int) -> tuple[int, int, int]:
        home, away = left[left_index], right[right_index]
        common = home.block_ids & away.block_ids
        first = int(bool(common) and not home.has_played and not away.has_played)
        possible = len(common)
        digest = sha256(f"{salt}:{left_index}:{right_index}".encode()).digest()
        tie_break = int.from_bytes(digest[:8])
        return first, possible, tie_break

    @cache
    def visit(position: int, used_mask: int) -> tuple[tuple[int, int, int], tuple[int, ...]]:
        if position == size:
            return (0, 0, 0), ()
        best: tuple[tuple[int, int, int], tuple[int, ...]] | None = None
        for right_index in range(size):
            bit = 1 << right_index
            if used_mask & bit:
                continue
            remaining_cost, remaining_assignment = visit(position + 1, used_mask | bit)
            current = pair_cost(position, right_index)
            cost = (
                current[0] + remaining_cost[0],
                current[1] + remaining_cost[1],
                current[2] + remaining_cost[2],
            )
            candidate = (cost, (right_index, *remaining_assignment))
            if best is None or candidate < best:
                best = candidate
        if best is None:
            raise RuntimeError("対戦候補を割り当てられません")
        return best

    return visit(0, 0)[1]


def _best_next_round_order(entries: list[_EntryState], salt: str) -> tuple[int, ...]:
    """次ラウンドで同一ブロック由来同士が当たる時期を遅らせる並びを返す。"""

    size = len(entries)
    if size % 2:
        return tuple(range(size))

    @cache
    def visit(remaining_mask: int) -> tuple[tuple[int, int], tuple[tuple[int, int], ...]]:
        if remaining_mask == 0:
            return (0, 0), ()
        first = (remaining_mask & -remaining_mask).bit_length() - 1
        without_first = remaining_mask & ~(1 << first)
        best: tuple[tuple[int, int], tuple[tuple[int, int], ...]] | None = None
        for second in range(first + 1, size):
            second_bit = 1 << second
            if not without_first & second_bit:
                continue
            remaining_cost, remaining_pairs = visit(without_first & ~second_bit)
            overlap = len(entries[first].block_ids & entries[second].block_ids)
            digest = sha256(f"{salt}:{first}:{second}".encode()).digest()
            tie_break = int.from_bytes(digest[:8])
            cost = (overlap + remaining_cost[0], tie_break + remaining_cost[1])
            candidate = (cost, ((first, second), *remaining_pairs))
            if best is None or candidate < best:
                best = candidate
        if best is None:
            raise RuntimeError("次ラウンドの組合せ順を決定できません")
        return best

    pairs = visit((1 << size) - 1)[1]
    return tuple(first for first, _second in pairs) + tuple(second for _first, second in pairs)
