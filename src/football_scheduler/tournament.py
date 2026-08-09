"""リーグ順位枠から2日目の完全順位決定トーナメントを生成する。"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from functools import cache
from hashlib import sha256
from typing import Annotated, Any, Literal, Self

from pydantic import Field, model_validator

from football_scheduler.final_stage import PlacementTournamentFinalStage
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


class ParticipantResolution(StrEnum):
    """順位枠へ具体的なチームが対応済みかを示す。"""

    PROVISIONAL = "provisional"
    RESOLVED = "resolved"


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
    schema_version: Literal["0.2.0"] = "0.2.0"
    request_kind: Literal["tournament_plan"]
    league_plan: LeaguePlan
    league_standings: LeagueStandings | None = None
    final_stage: PlacementTournamentFinalStage
    random_seed: int = 20260803


class TournamentSeed(ContractModel):
    seed_no: Annotated[int, Field(gt=0)]
    team_id: Identifier | None = None
    block_id: Identifier
    block_rank: Annotated[int, Field(gt=0)]
    entry: LeagueRankRef
    team: ConcreteTeamRef | None = None

    @model_validator(mode="after")
    def validate_references(self) -> Self:
        if self.entry.block_id != self.block_id or self.entry.rank != self.block_rank:
            raise ValueError("シードの順位枠参照が一致しません")
        if (self.team_id is None) != (self.team is None):
            raise ValueError("シードのチームIDとチーム参照は同時に指定してください")
        if self.team is not None and self.team.team_id != self.team_id:
            raise ValueError("シードのチーム参照が一致しません")
        return self


class SeedDrawRecord(ContractModel):
    pool: TournamentPool
    block_rank: Annotated[int, Field(gt=0)]
    candidates: tuple[Identifier, ...] = ()
    decided_order: tuple[Identifier, ...] = ()
    candidate_rank_refs: tuple[LeagueRankRef, ...] = ()
    decided_rank_refs: tuple[LeagueRankRef, ...] = ()
    random_seed: int

    @model_validator(mode="after")
    def validate_draw(self) -> Self:
        if len(set(self.candidates)) != len(self.candidates):
            raise ValueError("シード抽選候補が重複しています")
        if len(self.candidates) != len(self.decided_order) or set(self.candidates) != set(
            self.decided_order
        ):
            raise ValueError("シード抽選の候補と確定順が一致しません")
        candidate_keys = tuple((ref.block_id, ref.rank) for ref in self.candidate_rank_refs)
        decided_keys = tuple((ref.block_id, ref.rank) for ref in self.decided_rank_refs)
        if len(set(candidate_keys)) != len(candidate_keys):
            raise ValueError("シード抽選の順位枠候補が重複しています")
        if len(candidate_keys) != len(decided_keys) or set(candidate_keys) != set(decided_keys):
            raise ValueError("シード抽選の順位枠候補と確定順が一致しません")
        if any(ref.rank != self.block_rank for ref in self.candidate_rank_refs):
            raise ValueError("シード抽選候補のブロック順位が一致しません")
        return self


class TournamentMatch(ContractModel):
    id: Identifier
    phase: Literal["upper_tournament", "lower_tournament"]
    round: NonEmptyText
    round_no: Annotated[int, Field(gt=0)]
    home: TournamentEntry
    away: TournamentEntry
    rank_range: tuple[Annotated[int, Field(gt=0)], Annotated[int, Field(gt=0)]]


class TournamentLogicalMatchPosition(ContractModel):
    """同一順位帯の中で表示に用いる安定した試合順。"""

    match_id: Identifier
    rank_range: tuple[Annotated[int, Field(gt=0)], Annotated[int, Field(gt=0)]]
    order: Annotated[int, Field(gt=0)]


class TournamentBranchAlignment(ContractModel):
    """同じ試合群から進む勝者側・敗者側の論理順の対応。"""

    rank_range: tuple[Annotated[int, Field(gt=0)], Annotated[int, Field(gt=0)]]
    status: Literal["mirrored", "permuted"]
    winner_source_order: tuple[Identifier, ...]
    loser_source_order: tuple[Identifier, ...]
    loser_to_winner_permutation: tuple[Annotated[int, Field(gt=0)], ...]
    diagnostic_code: Literal["OUTCOME_BRANCH_ORDER_DIFFERS"] | None = None

    @model_validator(mode="after")
    def validate_permutation(self) -> Self:
        winner_count = len(self.winner_source_order)
        if winner_count < 2 or len(set(self.winner_source_order)) != winner_count:
            raise ValueError("勝者側の論理順に不足または重複があります")
        if (
            len(self.loser_source_order) != winner_count
            or len(set(self.loser_source_order)) != winner_count
            or set(self.loser_source_order) != set(self.winner_source_order)
        ):
            raise ValueError("敗者側の論理順が勝者側の試合集合と一致しません")
        winner_positions = {
            match_id: index for index, match_id in enumerate(self.winner_source_order, 1)
        }
        expected_permutation = tuple(
            winner_positions[match_id] for match_id in self.loser_source_order
        )
        if self.loser_to_winner_permutation != expected_permutation:
            raise ValueError("勝敗側の論理順と置換情報が一致しません")
        mirrored = expected_permutation == tuple(range(1, winner_count + 1))
        if mirrored != (self.status == "mirrored"):
            raise ValueError("勝敗側の論理順と対称性の状態が一致しません")
        expected_diagnostic = None if mirrored else "OUTCOME_BRANCH_ORDER_DIFFERS"
        if self.diagnostic_code != expected_diagnostic:
            raise ValueError("勝敗側の対称性と診断コードが一致しません")
        return self


class TournamentLogicalLayout(ContractModel):
    """座標へ依存しないトーナメント表の表示順契約。"""

    layout_version: Literal["1"] = "1"
    symmetry: Literal["mirrored", "permuted"]
    opening_entry_order: tuple[TournamentEntry, ...]
    match_positions: tuple[TournamentLogicalMatchPosition, ...]
    branch_alignments: tuple[TournamentBranchAlignment, ...]

    @model_validator(mode="after")
    def validate_symmetry(self) -> Self:
        expected = (
            "permuted"
            if any(alignment.status == "permuted" for alignment in self.branch_alignments)
            else "mirrored"
        )
        if self.symmetry != expected:
            raise ValueError("分岐ごとの状態とトーナメント全体の対称性が一致しません")
        return self


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
    logical_layout: TournamentLogicalLayout | None = None

    @model_validator(mode="after")
    def validate_logical_layout(self) -> Self:
        layout = self.logical_layout
        if layout is None:
            return self
        if self.participant_count < 2 or self.participant_count & (self.participant_count - 1):
            raise ValueError("論理配置は2のべき乗の参加数にだけ指定できます")

        match_by_id = {match.id: match for match in self.matches}
        if len(match_by_id) != len(self.matches):
            raise ValueError("論理配置の検証対象となる試合IDが重複しています")
        position_by_id = {position.match_id: position for position in layout.match_positions}
        if len(position_by_id) != len(layout.match_positions) or set(position_by_id) != set(
            match_by_id
        ):
            raise ValueError("論理配置の試合位置に不足、重複または未知の参照があります")

        positions_by_range: dict[tuple[int, int], list[TournamentLogicalMatchPosition]] = {}
        for position in layout.match_positions:
            match = match_by_id[position.match_id]
            if position.rank_range != match.rank_range:
                raise ValueError("論理配置の順位帯が試合と一致しません")
            positions_by_range.setdefault(position.rank_range, []).append(position)
        for positions in positions_by_range.values():
            orders = sorted(position.order for position in positions)
            if orders != list(range(1, len(positions) + 1)):
                raise ValueError("同一順位帯の論理順に不足または重複があります")

        def ordered_matches(rank_range: tuple[int, int]) -> list[TournamentMatch]:
            return [
                match_by_id[position.match_id]
                for position in sorted(
                    positions_by_range.get(rank_range, []), key=lambda item: item.order
                )
            ]

        root_range = (1, self.participant_count)
        expected_opening_entries = tuple(
            entry for match in ordered_matches(root_range) for entry in (match.home, match.away)
        )
        if layout.opening_entry_order != expected_opening_entries:
            raise ValueError("初戦参加枠の論理順が試合位置と一致しません")
        if len(set(layout.opening_entry_order)) != self.participant_count:
            raise ValueError("初戦参加枠の論理順に不足または重複があります")

        alignment_by_range = {
            alignment.rank_range: alignment for alignment in layout.branch_alignments
        }
        if len(alignment_by_range) != len(layout.branch_alignments):
            raise ValueError("勝敗分岐の論理対応に順位帯の重複があります")
        expected_ranges = {
            rank_range
            for rank_range in positions_by_range
            if rank_range[1] - rank_range[0] + 1 >= 4
        }
        if set(alignment_by_range) != expected_ranges:
            raise ValueError("勝敗分岐の論理対応に不足または未知の順位帯があります")

        for rank_range, alignment in alignment_by_range.items():
            rank_start, rank_end = rank_range
            half = (rank_end - rank_start + 1) // 2
            source_ids = frozenset(match.id for match in ordered_matches(rank_range))

            def source_order(
                child_range: tuple[int, int],
                reference_type: type[WinnerOfRef] | type[LoserOfRef],
                allowed_source_ids: frozenset[str],
            ) -> tuple[str, ...]:
                result: list[str] = []
                for match in ordered_matches(child_range):
                    for entry in (match.home, match.away):
                        if (
                            not isinstance(entry, reference_type)
                            or entry.match_id not in allowed_source_ids
                        ):
                            raise ValueError("勝敗分岐が親順位帯の試合を正しく参照していません")
                        result.append(entry.match_id)
                return tuple(result)

            expected_winner_order = source_order(
                (rank_start, rank_start + half - 1), WinnerOfRef, source_ids
            )
            expected_loser_order = source_order(
                (rank_start + half, rank_end), LoserOfRef, source_ids
            )
            if (
                alignment.winner_source_order != expected_winner_order
                or alignment.loser_source_order != expected_loser_order
            ):
                raise ValueError("勝敗分岐の論理順が実際の試合参照と一致しません")
        return self


class TournamentWarning(ContractModel):
    code: Identifier
    message: NonEmptyText
    pool: TournamentPool
    match_ids: tuple[Identifier, ...] = ()


class TournamentPlan(ContractModel):
    schema_version: Literal["0.2.0"] = "0.2.0"
    format: Literal["placement_tournament"] = "placement_tournament"
    status: Literal["COMPLETE"] = "COMPLETE"
    participant_resolution: ParticipantResolution = ParticipantResolution.RESOLVED
    tournament_count: Annotated[int, Field(gt=0)]
    random_seed: int
    upper: TournamentPoolPlan
    lower: TournamentPoolPlan
    seed_draws: tuple[SeedDrawRecord, ...]
    warnings: tuple[TournamentWarning, ...]

    @model_validator(mode="after")
    def validate_resolution(self) -> Self:
        seeds = (*self.upper.seeds, *self.lower.seeds)
        resolved = [seed.team_id is not None for seed in seeds]
        explicit_resolution = "participant_resolution" in self.model_fields_set
        if self.participant_resolution is ParticipantResolution.PROVISIONAL:
            if any(resolved):
                raise ValueError("仮トーナメントに具体的なチームを指定できません")
            if any(draw.candidates or draw.decided_order for draw in self.seed_draws):
                raise ValueError("仮トーナメントの抽選記録に具体的なチームを指定できません")
            if any(
                not draw.candidate_rank_refs or not draw.decided_rank_refs
                for draw in self.seed_draws
            ):
                raise ValueError("仮トーナメントの抽選記録に順位枠が不足しています")
        elif not all(resolved):
            raise ValueError("確定トーナメントの参加チームが不足しています")
        for draw in self.seed_draws:
            pool = self.upper if draw.pool is TournamentPool.UPPER else self.lower
            draw_seeds = [seed for seed in pool.seeds if seed.block_rank == draw.block_rank]
            expected_rank_keys = {(seed.block_id, seed.block_rank) for seed in draw_seeds}
            candidate_rank_keys = {
                (entry.block_id, entry.rank) for entry in draw.candidate_rank_refs
            }
            if explicit_resolution or candidate_rank_keys:
                if candidate_rank_keys != expected_rank_keys:
                    raise ValueError("シード抽選の順位枠候補がシードと一致しません")
                if len(draw.decided_rank_refs) != len(expected_rank_keys):
                    raise ValueError("シード抽選の順位枠確定順が不足しています")
            if self.participant_resolution is ParticipantResolution.RESOLVED:
                expected_team_ids = {
                    seed.team_id for seed in draw_seeds if seed.team_id is not None
                }
                if set(draw.candidates) != expected_team_ids:
                    raise ValueError("シード抽選候補が確定チームと一致しません")
                if draw.decided_rank_refs and any(
                    pool_seed.team_id != team_id
                    for entry, team_id in zip(
                        draw.decided_rank_refs, draw.decided_order, strict=True
                    )
                    for pool_seed in draw_seeds
                    if pool_seed.entry == entry
                ):
                    raise ValueError("シード抽選の順位枠順とチーム順が一致しません")
        return self


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


@dataclass(frozen=True)
class _PlacementNode:
    """初戦ペアを固定ブラケット位置へ割り当てるための配置木ノード。"""

    block_ids: frozenset[str]
    opening_pair_index: int | None = None
    left: _PlacementNode | None = None
    right: _PlacementNode | None = None


@dataclass(frozen=True)
class _RankSlot:
    block_id: str
    rank: int
    team_id: str | None = None

    @property
    def entry(self) -> LeagueRankRef:
        return LeagueRankRef(block_id=self.block_id, rank=self.rank)


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
        if len(entries) >= 2 and len(entries) & (len(entries) - 1) == 0:
            positioned_entries = self._position_power_of_two_entries(entries)
            self._build_canonical_power_of_two(positioned_entries, 1, 1)
            return
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

    def _position_power_of_two_entries(self, entries: list[_EntryState]) -> list[_EntryState]:
        """競技上の最適化を初戦位置へ閉じ込めた固定エントリー順を返す。"""

        count = len(entries)
        half = count // 2
        higher_entries = entries[:half]
        lower_entries = entries[half:]
        assignment = _best_pair_assignment(
            higher_entries,
            lower_entries,
            f"{self.random_seed}:{self.pool}:RANK:1:{count}:1",
        )
        opening_pairs = [
            (home, lower_entries[lower_index])
            for home, lower_index in zip(higher_entries, assignment, strict=True)
        ]
        nodes = [
            _PlacementNode(
                block_ids=home.block_ids | away.block_ids,
                opening_pair_index=index,
            )
            for index, (home, away) in enumerate(opening_pairs)
        ]
        positioned_nodes = _position_opening_nodes(
            nodes,
            f"{self.random_seed}:{self.pool}:canonical:{count}",
        )
        positioned_pairs: list[tuple[_EntryState, _EntryState]] = []
        for node in positioned_nodes:
            if node.opening_pair_index is None:
                raise RuntimeError("初戦配置木の葉に対戦情報がありません")
            positioned_pairs.append(opening_pairs[node.opening_pair_index])
        return [home for home, _away in positioned_pairs] + [
            away for _home, away in positioned_pairs
        ]

    def _build_canonical_power_of_two(
        self, entries: list[_EntryState], rank_start: int, round_no: int
    ) -> None:
        """勝者側と敗者側に同一の位置対応を使う正規ブラケットを生成する。"""

        count = len(entries)
        if count == 1:
            self.placements.append(TournamentPlacement(rank=rank_start, entry=entries[0].ref))
            return
        rank_end = rank_start + count - 1
        label = (
            "優勝決定戦"
            if rank_start == 1 and count == 2
            else f"{rank_start}位決定戦"
            if count == 2
            else f"{rank_start}〜{rank_end}位 順位決定"
        )
        winners, losers = self._play_fixed_matches(entries, rank_start, rank_end, round_no, label)
        half = count // 2
        self._build_canonical_power_of_two(winners, rank_start, round_no + 1)
        self._build_canonical_power_of_two(losers, rank_start + half, round_no + 1)

    def _play_fixed_matches(
        self,
        entries: list[_EntryState],
        rank_start: int,
        rank_end: int,
        round_no: int,
        label: str,
    ) -> tuple[list[_EntryState], list[_EntryState]]:
        """入力の前半と後半を同じ添字で結び、再配置せずに試合を作る。"""

        if len(entries) % 2:
            raise RuntimeError("対戦生成対象は偶数である必要があります")
        half = len(entries) // 2
        winners: list[_EntryState] = []
        losers: list[_EntryState] = []
        for index in range(half):
            winner, loser = self._record_match(
                entries[index],
                entries[index + half],
                rank_start,
                rank_end,
                round_no,
                "RANK",
                label,
            )
            winners.append(winner)
            losers.append(loser)
        return winners, losers

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
            winner, loser = self._record_match(
                home, away, rank_start, rank_end, round_no, kind, label
            )
            winners.append(winner)
            losers.append(loser)
        if kind == "RANK" and len(winners) >= 2:
            order = _best_next_round_order(
                winners,
                f"{self.random_seed}:{self.pool}:{rank_start}:{rank_end}:{round_no}:next",
            )
            winners = [winners[index] for index in order]
            losers = [losers[index] for index in order]
        return winners, losers

    def _record_match(
        self,
        home: _EntryState,
        away: _EntryState,
        rank_start: int,
        rank_end: int,
        round_no: int,
        kind: str,
        label: str,
    ) -> tuple[_EntryState, _EntryState]:
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
        return (
            _EntryState(
                ref=WinnerOfRef(match_id=match_id),
                block_ids=possible_blocks,
                has_played=True,
            ),
            _EntryState(
                ref=LoserOfRef(match_id=match_id),
                block_ids=possible_blocks,
                has_played=True,
            ),
        )

    def _next_id(self, kind: str, rank_start: int, rank_end: int) -> str:
        key = (kind, rank_start, rank_end)
        number = self._id_counts.get(key, 0) + 1
        self._id_counts[key] = number
        return f"{self.prefix}-{kind}-{rank_start}-{rank_end}-M{number}"


def generate_tournament_plan(
    request: TournamentPlanRequest | dict[str, object],
) -> TournamentPlan:
    """順位枠を上下へ分け、1位から最下位まで決まる表を返す。"""

    data = (
        request
        if isinstance(request, TournamentPlanRequest)
        else TournamentPlanRequest.model_validate(request)
    )
    slots_by_block = _validate_source(data.league_plan, data.league_standings)
    upper_rows, lower_rows = _split_rank_slots(
        data.league_plan, slots_by_block, OddSplitPolicy.UPPER
    )
    upper_seeds, upper_draws = _seed_pool(TournamentPool.UPPER, upper_rows, data.random_seed)
    lower_seeds, lower_draws = _seed_pool(TournamentPool.LOWER, lower_rows, data.random_seed)
    upper, upper_warnings = _generate_pool(TournamentPool.UPPER, upper_seeds, data.random_seed)
    lower, lower_warnings = _generate_pool(TournamentPool.LOWER, lower_seeds, data.random_seed)
    return TournamentPlan(
        participant_resolution=(
            ParticipantResolution.RESOLVED
            if data.league_standings is not None
            else ParticipantResolution.PROVISIONAL
        ),
        tournament_count=data.final_stage.tournament_count,
        random_seed=data.random_seed,
        upper=upper,
        lower=lower,
        seed_draws=(*upper_draws, *lower_draws),
        warnings=(*upper_warnings, *lower_warnings),
    )


def _validate_source(
    plan: LeaguePlan, standings: LeagueStandings | None
) -> dict[str, list[_RankSlot]]:
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

    slots_by_block = {
        block.id: [
            _RankSlot(block_id=block.id, rank=rank) for rank in range(1, len(block.team_ids) + 1)
        ]
        for block in plan.blocks
    }
    if standings is None:
        return slots_by_block

    teams_by_rank: dict[tuple[str, int], str] = {}
    seen_teams: set[str] = set()
    for row in standings.standings:
        if row.block_id not in slots_by_block:
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
        key = (row.block_id, row.rank)
        if key in teams_by_rank:
            raise _source_error("duplicate_block_rank", block_id=row.block_id, rank=row.rank)
        teams_by_rank[key] = row.team_id

    missing = sorted(set(team_to_block) - seen_teams)
    if missing:
        raise _source_error("team_missing_from_standings", team_ids=missing)
    for block in plan.blocks:
        actual_ranks = sorted(rank for block_id, rank in teams_by_rank if block_id == block.id)
        expected_ranks = list(range(1, len(block.team_ids) + 1))
        if actual_ranks != expected_ranks:
            raise _source_error(
                "invalid_block_ranks",
                block_id=block.id,
                expected_ranks=expected_ranks,
                actual_ranks=actual_ranks,
            )
        slots_by_block[block.id] = [
            _RankSlot(block_id=block.id, rank=rank, team_id=teams_by_rank[(block.id, rank)])
            for rank in expected_ranks
        ]
    return slots_by_block


def _source_error(reason: str, **details: object) -> TournamentGenerationError:
    return TournamentGenerationError(
        "TOURNAMENT_SOURCE_INVALID",
        "リーグ計画と順位の対応を確認できませんでした。日程を再作成するか、順位を再確定してください。",
        reason=reason,
        **details,
    )


def _split_rank_slots(
    plan: LeaguePlan,
    slots_by_block: dict[str, list[_RankSlot]],
    policy: OddSplitPolicy,
) -> tuple[list[_RankSlot], list[_RankSlot]]:
    upper: list[_RankSlot] = []
    lower: list[_RankSlot] = []
    odd_index = 0
    for block in plan.blocks:
        slots = slots_by_block[block.id]
        count = len(slots)
        if count % 2 == 0:
            upper_count = count // 2
        elif policy is OddSplitPolicy.UPPER:
            upper_count = (count + 1) // 2
        elif policy is OddSplitPolicy.LOWER:
            upper_count = count // 2
        else:
            upper_count = (count + 1) // 2 if odd_index % 2 == 0 else count // 2
            odd_index += 1
        upper.extend(slots[:upper_count])
        lower.extend(slots[upper_count:])
    return upper, lower


def _seed_pool(
    pool: TournamentPool,
    rows: list[_RankSlot],
    random_seed: int,
) -> tuple[tuple[TournamentSeed, ...], tuple[SeedDrawRecord, ...]]:
    groups: dict[int, list[_RankSlot]] = {}
    for row in rows:
        groups.setdefault(row.rank, []).append(row)
    ordered: list[_RankSlot] = []
    draws: list[SeedDrawRecord] = []
    for rank in sorted(groups):
        candidates = groups[rank]
        decided = sorted(
            candidates,
            key=lambda row: (
                sha256(
                    f"{random_seed}:seed:{pool.value}:{rank}:{row.block_id}:{row.rank}".encode()
                ).digest(),
                row.block_id,
            ),
        )
        ordered.extend(decided)
        if len(candidates) > 1:
            draws.append(
                SeedDrawRecord(
                    pool=pool,
                    block_rank=rank,
                    candidates=tuple(
                        sorted(row.team_id for row in candidates if row.team_id is not None)
                    ),
                    decided_order=tuple(row.team_id for row in decided if row.team_id is not None),
                    candidate_rank_refs=tuple(
                        row.entry for row in sorted(candidates, key=lambda row: row.block_id)
                    ),
                    decided_rank_refs=tuple(row.entry for row in decided),
                    random_seed=random_seed,
                )
            )
    seeds = tuple(
        TournamentSeed(
            seed_no=index,
            team_id=row.team_id,
            block_id=row.block_id,
            block_rank=row.rank,
            entry=row.entry,
            team=ConcreteTeamRef(team_id=row.team_id) if row.team_id is not None else None,
        )
        for index, row in enumerate(ordered, 1)
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
    matches = tuple(builder.matches)
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
        matches=matches,
        byes=builder.finalized_byes(),
        placements=tuple(sorted(builder.placements, key=lambda placement: placement.rank)),
        evaluation=evaluation,
        logical_layout=_build_logical_layout(matches, len(seeds)),
    )
    return plan, warnings


def _build_logical_layout(
    matches: tuple[TournamentMatch, ...], participant_count: int
) -> TournamentLogicalLayout | None:
    """既存の組合せを変えず、2のべき乗の表から表示順だけを導出する。"""

    if participant_count < 2 or participant_count & (participant_count - 1):
        return None

    range_counts: dict[tuple[int, int], int] = {}
    match_positions: list[TournamentLogicalMatchPosition] = []
    for match in matches:
        order = range_counts.get(match.rank_range, 0) + 1
        range_counts[match.rank_range] = order
        match_positions.append(
            TournamentLogicalMatchPosition(
                match_id=match.id,
                rank_range=match.rank_range,
                order=order,
            )
        )
    position_by_id = {position.match_id: position for position in match_positions}

    def ordered_matches(rank_range: tuple[int, int]) -> list[TournamentMatch]:
        return sorted(
            (match for match in matches if match.rank_range == rank_range),
            key=lambda match: position_by_id[match.id].order,
        )

    root_range = (1, participant_count)
    opening_entry_order = tuple(
        entry for match in ordered_matches(root_range) for entry in (match.home, match.away)
    )

    branch_alignments: list[TournamentBranchAlignment] = []
    seen_ranges: set[tuple[int, int]] = set()
    for match in matches:
        rank_range = match.rank_range
        if rank_range in seen_ranges or rank_range[1] - rank_range[0] + 1 < 4:
            continue
        seen_ranges.add(rank_range)
        rank_start, rank_end = rank_range
        half = (rank_end - rank_start + 1) // 2
        source_ids = frozenset(source.id for source in ordered_matches(rank_range))

        def source_order(
            child_range: tuple[int, int],
            reference_type: type[WinnerOfRef] | type[LoserOfRef],
            allowed_source_ids: frozenset[str],
        ) -> tuple[str, ...]:
            result: list[str] = []
            for child in ordered_matches(child_range):
                for entry in (child.home, child.away):
                    if (
                        not isinstance(entry, reference_type)
                        or entry.match_id not in allowed_source_ids
                    ):
                        raise RuntimeError("完全順位決定表の勝敗参照から論理順を導出できません")
                    result.append(entry.match_id)
            return tuple(result)

        winner_source_order = source_order(
            (rank_start, rank_start + half - 1), WinnerOfRef, source_ids
        )
        loser_source_order = source_order((rank_start + half, rank_end), LoserOfRef, source_ids)
        winner_positions = {
            match_id: index for index, match_id in enumerate(winner_source_order, 1)
        }
        permutation = tuple(winner_positions[match_id] for match_id in loser_source_order)
        mirrored = permutation == tuple(range(1, len(permutation) + 1))
        branch_alignments.append(
            TournamentBranchAlignment(
                rank_range=rank_range,
                status="mirrored" if mirrored else "permuted",
                winner_source_order=winner_source_order,
                loser_source_order=loser_source_order,
                loser_to_winner_permutation=permutation,
                diagnostic_code=None if mirrored else "OUTCOME_BRANCH_ORDER_DIFFERS",
            )
        )

    return TournamentLogicalLayout(
        symmetry=(
            "permuted"
            if any(alignment.status == "permuted" for alignment in branch_alignments)
            else "mirrored"
        ),
        opening_entry_order=opening_entry_order,
        match_positions=tuple(match_positions),
        branch_alignments=tuple(branch_alignments),
    )


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


def _position_opening_nodes(
    nodes: list[_PlacementNode], salt: str, depth: int = 1
) -> list[_PlacementNode]:
    """親の配置を先に決め、各親の左、右の順で初戦ノードを展開する。"""

    if len(nodes) <= 1:
        return nodes
    order = _best_next_round_order(nodes, f"{salt}:depth:{depth}")
    ordered_nodes = [nodes[index] for index in order]
    half = len(ordered_nodes) // 2
    parents = [
        _PlacementNode(
            block_ids=ordered_nodes[index].block_ids | ordered_nodes[index + half].block_ids,
            left=ordered_nodes[index],
            right=ordered_nodes[index + half],
        )
        for index in range(half)
    ]
    positioned_parents = _position_opening_nodes(parents, salt, depth + 1)
    left_children: list[_PlacementNode] = []
    right_children: list[_PlacementNode] = []
    for parent in positioned_parents:
        if parent.left is None or parent.right is None:
            raise RuntimeError("初戦配置木の親子関係が不足しています")
        left_children.append(parent.left)
        right_children.append(parent.right)
    return [*left_children, *right_children]


def _best_next_round_order(
    entries: list[_EntryState] | list[_PlacementNode], salt: str
) -> tuple[int, ...]:
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
