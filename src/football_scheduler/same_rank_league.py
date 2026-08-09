"""予選ブロック順位から2日目の同順位リーグを生成する。"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from itertools import combinations
from typing import Annotated, Any, Literal, Self

from pydantic import Field, ValidationError, model_validator

from football_scheduler.final_stage import (
    FinalStageConfigurationError,
    SameRankLeagueFinalStage,
    SameRankUnevenPolicy,
    validate_final_stage_input,
)
from football_scheduler.league import LeaguePlan
from football_scheduler.league_results import LeagueStandings
from football_scheduler.models import ContractModel, Identifier, NonEmptyText
from football_scheduler.tournament import ConcreteTeamRef, LeagueRankRef, ParticipantResolution


class SameRankLeaguePlanRequest(ContractModel):
    schema_version: Literal["0.2.0"] = "0.2.0"
    request_kind: Literal["same_rank_league_plan"]
    league_plan: LeaguePlan
    league_standings: LeagueStandings | None = None
    final_stage: SameRankLeagueFinalStage
    random_seed: int = 20260803


class SameRankParticipant(ContractModel):
    """順位枠を正本とし、確定後のチームを任意の注記として保持する。"""

    entry: LeagueRankRef
    team: ConcreteTeamRef | None = None


class SameRankMatch(ContractModel):
    id: Identifier
    phase: Literal["same_rank_league"] = "same_rank_league"
    group_id: Identifier
    round: NonEmptyText
    round_no: Annotated[int, Field(gt=0)]
    home: LeagueRankRef
    away: LeagueRankRef
    home_team: ConcreteTeamRef | None = None
    away_team: ConcreteTeamRef | None = None

    @model_validator(mode="after")
    def validate_distinct_entries(self) -> Self:
        if self.home == self.away:
            raise ValueError("同じ順位枠同士の試合は作成できません")
        if (self.home_team is None) != (self.away_team is None):
            raise ValueError("対戦チームの注記はhomeとawayの両方へ指定してください")
        if self.home_team is not None and self.home_team == self.away_team:
            raise ValueError("同じチーム同士の試合は作成できません")
        return self


class SameRankLogicalRound(ContractModel):
    group_id: Identifier
    round_no: Annotated[int, Field(gt=0)]
    match_ids: Annotated[tuple[Identifier, ...], Field(min_length=1)]


class SameRankGroup(ContractModel):
    id: Identifier
    display_name: NonEmptyText
    source_block_ranks: Annotated[tuple[Annotated[int, Field(gt=0)], ...], Field(min_length=1)]
    overall_rank_range: tuple[Annotated[int, Field(gt=0)], Annotated[int, Field(gt=0)]]
    participants: Annotated[tuple[SameRankParticipant, ...], Field(min_length=1)]
    logical_rounds: tuple[SameRankLogicalRound, ...]
    matches: tuple[SameRankMatch, ...]

    @model_validator(mode="after")
    def validate_group_shape(self) -> Self:
        start, end = self.overall_rank_range
        if end < start or end - start + 1 != len(self.participants):
            raise ValueError("同順位グループの全体順位範囲が参加枠数と一致しません")
        entries = [participant.entry for participant in self.participants]
        entry_keys = [(entry.block_id, entry.rank) for entry in entries]
        if len(set(entry_keys)) != len(entry_keys):
            raise ValueError("同順位グループの参加順位枠が重複しています")
        if len(set(self.source_block_ranks)) != len(self.source_block_ranks):
            raise ValueError("同順位グループの対象順位が重複しています")
        if {entry.rank for entry in entries} != set(self.source_block_ranks):
            raise ValueError("同順位グループの対象順位と参加順位枠が一致しません")
        expected_matches = len(entries) * (len(entries) - 1) // 2
        if len(self.matches) != expected_matches:
            raise ValueError("同順位グループの総当たり試合数が正しくありません")
        match_ids = [match.id for match in self.matches]
        if len(set(match_ids)) != len(match_ids):
            raise ValueError("同順位グループの試合IDが重複しています")
        round_match_ids = [match_id for item in self.logical_rounds for match_id in item.match_ids]
        if len(round_match_ids) != len(set(round_match_ids)) or set(round_match_ids) != set(
            match_ids
        ):
            raise ValueError("同順位グループの論理ラウンドと試合が一致しません")
        pairs = {
            frozenset(
                ((match.home.block_id, match.home.rank), (match.away.block_id, match.away.rank))
            )
            for match in self.matches
        }
        expected_pairs = {frozenset(pair) for pair in combinations(entry_keys, 2)}
        if pairs != expected_pairs:
            raise ValueError("同順位グループの対戦に重複または欠落があります")
        if any(match.group_id != self.id for match in self.matches) or any(
            item.group_id != self.id for item in self.logical_rounds
        ):
            raise ValueError("同順位グループIDと試合または論理ラウンドが一致しません")
        participant_teams = [
            participant.team.team_id
            for participant in self.participants
            if participant.team is not None
        ]
        if participant_teams and len(participant_teams) != len(self.participants):
            raise ValueError("同順位グループの確定チーム注記が不足しています")
        if len(set(participant_teams)) != len(participant_teams):
            raise ValueError("同順位グループの確定チームが重複しています")
        team_by_entry = {
            (participant.entry.block_id, participant.entry.rank): participant.team
            for participant in self.participants
        }
        for match in self.matches:
            if (
                match.home_team != team_by_entry[(match.home.block_id, match.home.rank)]
                or match.away_team != team_by_entry[(match.away.block_id, match.away.rank)]
            ):
                raise ValueError("同順位グループの試合と確定チーム注記が一致しません")
        match_by_id = {match.id: match for match in self.matches}
        for item in self.logical_rounds:
            round_entries = [
                entry
                for match_id in item.match_ids
                for entry in (match_by_id[match_id].home, match_by_id[match_id].away)
            ]
            if len(round_entries) != len(set(round_entries)):
                raise ValueError("同一論理ラウンドで同じ参加順位枠が重複しています")
        return self


class SameRankAutomaticStanding(ContractModel):
    group_id: Identifier
    overall_rank: Annotated[int, Field(gt=0)]
    entry: LeagueRankRef
    team: ConcreteTeamRef | None = None


class SameRankWarning(ContractModel):
    code: Literal["SAME_RANK_UNEVEN_BLOCKS", "SAME_RANK_SINGLETON_GROUP"]
    message: NonEmptyText
    group_id: Identifier | None = None
    details: dict[str, int | str | list[str]] = Field(default_factory=dict)


class SameRankLeaguePlan(ContractModel):
    schema_version: Literal["0.2.0"] = "0.2.0"
    format: Literal["same_rank_league"] = "same_rank_league"
    status: Literal["COMPLETE"] = "COMPLETE"
    participant_resolution: ParticipantResolution
    uneven_policy: SameRankUnevenPolicy
    team_count: Annotated[int, Field(ge=4, le=32)]
    block_count: Annotated[int, Field(ge=2, le=16)]
    random_seed: int
    groups: Annotated[tuple[SameRankGroup, ...], Field(min_length=1)]
    automatic_standings: tuple[SameRankAutomaticStanding, ...] = ()
    warnings: tuple[SameRankWarning, ...] = ()

    @model_validator(mode="after")
    def validate_plan_shape(self) -> Self:
        group_ids = [group.id for group in self.groups]
        if len(set(group_ids)) != len(group_ids):
            raise ValueError("同順位グループIDが重複しています")
        participants = [participant for group in self.groups for participant in group.participants]
        match_ids = [match.id for group in self.groups for match in group.matches]
        if len(set(match_ids)) != len(match_ids):
            raise ValueError("同順位リーグ全体で試合IDが重複しています")
        entries = [participant.entry for participant in participants]
        if len({(entry.block_id, entry.rank) for entry in entries}) != self.team_count:
            raise ValueError("同順位グループが全参加順位枠を一意に覆っていません")
        ranks = [
            rank
            for group in self.groups
            for rank in range(group.overall_rank_range[0], group.overall_rank_range[1] + 1)
        ]
        if sorted(ranks) != list(range(1, self.team_count + 1)):
            raise ValueError("同順位グループの全体順位範囲に欠落または重複があります")
        resolved = [participant.team is not None for participant in participants]
        auto_resolved = [standing.team is not None for standing in self.automatic_standings]
        if self.participant_resolution is ParticipantResolution.PROVISIONAL:
            if any((*resolved, *auto_resolved)):
                raise ValueError("仮計画に具体的なチームを指定できません")
        elif not all((*resolved, *auto_resolved)):
            raise ValueError("確定計画の参加チームが不足しています")
        participant_team_ids = [
            participant.team.team_id for participant in participants if participant.team is not None
        ]
        if participant_team_ids and len(set(participant_team_ids)) != self.team_count:
            raise ValueError("確定計画の参加チームに重複があります")
        singleton_groups = [group for group in self.groups if len(group.participants) == 1]
        if len(singleton_groups) != len(self.automatic_standings):
            raise ValueError("1チームグループと自動順位確定が一致しません")
        for group, standing in zip(singleton_groups, self.automatic_standings, strict=True):
            participant = group.participants[0]
            if (
                standing.group_id != group.id
                or standing.overall_rank != group.overall_rank_range[0]
                or standing.entry != participant.entry
                or standing.team != participant.team
            ):
                raise ValueError("1チームグループの自動順位確定が参加枠と一致しません")
        return self


class SameRankGenerationError(ValueError):
    """利用者が修正できる同順位リーグ生成エラー。"""

    def __init__(self, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.code, self.message, self.details = code, message, details


def generate_same_rank_league_plan(
    request: SameRankLeaguePlanRequest | Mapping[str, object],
) -> SameRankLeaguePlan:
    """順位枠を同順位グループへ分け、各グループの総当たりを返す。"""

    data = _parse_request(request)
    slots_by_block = _validate_source(data.league_plan, data.league_standings)
    team_count = sum(len(block.team_ids) for block in data.league_plan.blocks)
    block_count = len(data.league_plan.blocks)
    validate_final_stage_input(
        data.final_stage.model_dump(mode="json"),
        team_count=team_count,
        block_count=block_count,
    )
    policy = data.final_stage.uneven_policy
    if policy is None:  # validate_final_stage_inputが拒否するため通常は到達しない。
        raise FinalStageConfigurationError(
            "SAME_RANK_UNEVEN_POLICY_REQUIRED",
            "ブロック人数が均等でないため、最下位側のまとめ方を選択してください。",
        )

    quotient, remainder = divmod(team_count, block_count)
    rank_groups = _rank_groups(slots_by_block, quotient, remainder, policy)
    resolved = data.league_standings is not None
    groups: list[SameRankGroup] = []
    automatic: list[SameRankAutomaticStanding] = []
    rank_start = 1
    for group_id, display_name, source_ranks, entries in rank_groups:
        participants = tuple(
            SameRankParticipant(
                entry=entry,
                team=(
                    ConcreteTeamRef(
                        team_id=_resolved_team_id(slots_by_block[entry.block_id][entry.rank - 1][1])
                    )
                    if resolved
                    else None
                ),
            )
            for entry in entries
        )
        rank_end = rank_start + len(participants) - 1
        matches, rounds = _round_robin(group_id, display_name, participants)
        group = SameRankGroup(
            id=group_id,
            display_name=display_name,
            source_block_ranks=source_ranks,
            overall_rank_range=(rank_start, rank_end),
            participants=participants,
            logical_rounds=rounds,
            matches=matches,
        )
        groups.append(group)
        if len(participants) == 1:
            only = participants[0]
            automatic.append(
                SameRankAutomaticStanding(
                    group_id=group_id,
                    overall_rank=rank_start,
                    entry=only.entry,
                    team=only.team,
                )
            )
        rank_start = rank_end + 1

    warnings: list[SameRankWarning] = []
    if remainder:
        warnings.append(
            SameRankWarning(
                code="SAME_RANK_UNEVEN_BLOCKS",
                message="ブロック人数が均等でないため、選択した端数処理で同順位グループを作成しました。",
                details={
                    "team_count": team_count,
                    "block_count": block_count,
                    "uneven_policy": policy.value,
                },
            )
        )
    if automatic:
        warnings.append(
            SameRankWarning(
                code="SAME_RANK_SINGLETON_GROUP",
                message="最下位グループが1チームのため、試合を行わず順位を自動確定します。",
                group_id=automatic[0].group_id,
                details={"overall_rank": automatic[0].overall_rank},
            )
        )
    return SameRankLeaguePlan(
        participant_resolution=(
            ParticipantResolution.RESOLVED if resolved else ParticipantResolution.PROVISIONAL
        ),
        uneven_policy=policy,
        team_count=team_count,
        block_count=block_count,
        random_seed=data.random_seed,
        groups=tuple(groups),
        automatic_standings=tuple(automatic),
        warnings=tuple(warnings),
    )


def _parse_request(
    request: SameRankLeaguePlanRequest | Mapping[str, object],
) -> SameRankLeaguePlanRequest:
    if isinstance(request, SameRankLeaguePlanRequest):
        return request
    try:
        return SameRankLeaguePlanRequest.model_validate(request)
    except ValidationError as exc:
        fields = [".".join(str(part) for part in error["loc"]) for error in exc.errors()]
        raise SameRankGenerationError(
            "SAME_RANK_INPUT_INVALID",
            "同順位リーグの入力に不備があります。表示された項目を確認してください。",
            fields=fields,
        ) from exc


def _source_error(reason: str, **details: object) -> SameRankGenerationError:
    return SameRankGenerationError(
        "SAME_RANK_SOURCE_INVALID",
        "予選ブロックまたは順位表を確認できませんでした。1日目から再生成してください。",
        reason=reason,
        **details,
    )


def _validate_source(
    plan: LeaguePlan,
    standings: LeagueStandings | None,
) -> dict[str, list[tuple[LeagueRankRef, str | None]]]:
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
    team_count = len(team_to_block)
    block_count = len(plan.blocks)
    if not 4 <= team_count <= 32 or not 2 <= block_count <= team_count // 2:
        raise FinalStageConfigurationError(
            "SAME_RANK_LEAGUE_TEAM_COUNT_UNSUPPORTED",
            "同順位リーグは4〜32チームで、各ブロックが2チーム以上になるブロック数を選択してください。",
            team_count=team_count,
            block_count=block_count,
        )
    quotient, remainder = divmod(team_count, block_count)
    expected_sizes = sorted([quotient + 1] * remainder + [quotient] * (block_count - remainder))
    actual_sizes = sorted(len(block.team_ids) for block in plan.blocks)
    if actual_sizes != expected_sizes:
        raise _source_error(
            "uneven_block_sizes",
            expected_block_sizes=expected_sizes,
            actual_block_sizes=actual_sizes,
        )

    slots: dict[str, list[tuple[LeagueRankRef, str | None]]] = {
        block.id: [
            (LeagueRankRef(block_id=block.id, rank=rank), None)
            for rank in range(1, len(block.team_ids) + 1)
        ]
        for block in plan.blocks
    }
    if standings is None:
        return slots
    mapping: dict[tuple[str, int], str] = {}
    seen_teams: set[str] = set()
    for row in standings.standings:
        key = (row.block_id, row.rank)
        if row.block_id not in slots:
            raise _source_error("unknown_standings_block", block_id=row.block_id)
        if not 1 <= row.rank <= len(slots[row.block_id]):
            raise _source_error("unknown_standings_rank", block_id=row.block_id, rank=row.rank)
        if key in mapping:
            raise _source_error("duplicate_standings_rank", block_id=row.block_id, rank=row.rank)
        if row.team_id in seen_teams:
            raise _source_error("duplicate_standings_team", team_id=row.team_id)
        if team_to_block.get(row.team_id) != row.block_id:
            raise _source_error(
                "team_outside_standings_block",
                block_id=row.block_id,
                team_id=row.team_id,
            )
        mapping[key] = row.team_id
        seen_teams.add(row.team_id)
    expected_keys = {
        (entry.block_id, entry.rank) for block_slots in slots.values() for entry, _ in block_slots
    }
    if set(mapping) != expected_keys or seen_teams != set(team_to_block):
        raise _source_error("incomplete_standings")
    return {
        block_id: [(entry, mapping[(entry.block_id, entry.rank)]) for entry, _ in block_slots]
        for block_id, block_slots in slots.items()
    }


def _resolved_team_id(team_id: str | None) -> str:
    if team_id is None:
        raise _source_error("incomplete_standings")
    return team_id


def _rank_groups(
    slots_by_block: dict[str, list[tuple[LeagueRankRef, str | None]]],
    quotient: int,
    remainder: int,
    policy: SameRankUnevenPolicy,
) -> list[tuple[str, str, tuple[int, ...], tuple[LeagueRankRef, ...]]]:
    block_ids = tuple(slots_by_block)

    def entries_at(rank: int) -> tuple[LeagueRankRef, ...]:
        return tuple(
            slots_by_block[block_id][rank - 1][0]
            for block_id in block_ids
            if len(slots_by_block[block_id]) >= rank
        )

    groups: list[tuple[str, str, tuple[int, ...], tuple[LeagueRankRef, ...]]] = []
    if policy is SameRankUnevenPolicy.MERGE_BOTTOM and remainder:
        for rank in range(1, quotient):
            groups.append((f"same-rank-{rank}", f"予選{rank}位リーグ", (rank,), entries_at(rank)))
        groups.append(
            (
                "same-rank-bottom",
                f"予選{quotient}・{quotient + 1}位リーグ",
                (quotient, quotient + 1),
                (*entries_at(quotient), *entries_at(quotient + 1)),
            )
        )
        return groups
    for rank in range(1, quotient + 1):
        groups.append((f"same-rank-{rank}", f"予選{rank}位リーグ", (rank,), entries_at(rank)))
    if remainder:
        groups.append(
            (
                f"same-rank-{quotient + 1}",
                f"予選{quotient + 1}位リーグ",
                (quotient + 1,),
                entries_at(quotient + 1),
            )
        )
    return groups


def _round_robin(
    group_id: str,
    display_name: str,
    participants: Sequence[SameRankParticipant],
) -> tuple[tuple[SameRankMatch, ...], tuple[SameRankLogicalRound, ...]]:
    if len(participants) < 2:
        return (), ()
    rotating: list[SameRankParticipant | None] = list(participants)
    if len(rotating) % 2:
        rotating.append(None)
    matches: list[SameRankMatch] = []
    rounds: list[SameRankLogicalRound] = []
    match_number = 1
    for round_index in range(len(rotating) - 1):
        round_match_ids: list[str] = []
        for pair_index in range(len(rotating) // 2):
            left = rotating[pair_index]
            right = rotating[-pair_index - 1]
            if left is None or right is None:
                continue
            home, away = (left, right) if round_index % 2 == 0 else (right, left)
            match_id = f"SR-{_group_id_suffix(group_id)}-M{match_number}"
            matches.append(
                SameRankMatch(
                    id=match_id,
                    group_id=group_id,
                    round=f"{display_name} 第{round_index + 1}ラウンド",
                    round_no=round_index + 1,
                    home=home.entry,
                    away=away.entry,
                    home_team=home.team,
                    away_team=away.team,
                )
            )
            round_match_ids.append(match_id)
            match_number += 1
        if round_match_ids:
            rounds.append(
                SameRankLogicalRound(
                    group_id=group_id,
                    round_no=round_index + 1,
                    match_ids=tuple(round_match_ids),
                )
            )
        rotating = [rotating[0], rotating[-1], *rotating[1:-1]]
    return tuple(matches), tuple(rounds)


def _group_id_suffix(group_id: str) -> str:
    return group_id.removeprefix("same-rank-").upper()
