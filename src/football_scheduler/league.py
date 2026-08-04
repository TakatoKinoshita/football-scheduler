"""1日目のリーグブロックと総当たり対戦を生成するdomain機能。"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from enum import StrEnum
from hashlib import sha256
from typing import Annotated, Any, Literal

from pydantic import Field, ValidationError

from football_scheduler.models import (
    ContractModel,
    Identifier,
    MatchSpec,
    NonEmptyText,
)


class AssignmentMode(StrEnum):
    """リーグブロックの割当て方法。"""

    RANDOM = "random"
    SEEDED_SNAKE = "seeded_snake"
    MANUAL = "manual"


class LeagueTeam(ContractModel):
    """ブロック分けに必要なチーム情報。"""

    id: Identifier
    name: NonEmptyText
    seed: Annotated[int, Field(gt=0)] | None = None


class ManualBlock(ContractModel):
    """利用者が指定したブロックと所属チーム。"""

    id: Annotated[
        str,
        Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*$"),
    ]
    team_ids: Annotated[tuple[Identifier, ...], Field(min_length=1)]


class LeaguePlanRequest(ContractModel):
    """リーグ生成のJSON互換入力。"""

    schema_version: Literal["0.1.0"] = "0.1.0"
    teams: Annotated[tuple[LeagueTeam, ...], Field(min_length=2, max_length=32)]
    block_count: Annotated[int, Field(ge=1, le=32)]
    assignment_mode: AssignmentMode = AssignmentMode.RANDOM
    manual_blocks: tuple[ManualBlock, ...] = ()
    random_seed: int = 20260803


class LeagueBlock(ContractModel):
    id: Identifier
    team_ids: Annotated[tuple[Identifier, ...], Field(min_length=1)]


class LeagueRound(ContractModel):
    """実際のsectionとは独立した、総当たり生成上の論理round。"""

    block_id: Identifier
    round_no: Annotated[int, Field(gt=0)]
    match_ids: Annotated[tuple[Identifier, ...], Field(min_length=1)]


class LeaguePlan(ContractModel):
    """既存ソルバーへ渡せるMatchSpecを含むリーグ生成結果。"""

    schema_version: Literal["0.1.0"] = "0.1.0"
    assignment_mode: AssignmentMode
    random_seed: int
    blocks: tuple[LeagueBlock, ...]
    logical_rounds: tuple[LeagueRound, ...]
    matches: tuple[MatchSpec, ...]


class LeagueGenerationError(ValueError):
    """利用者が修正できるリーグ生成エラー。"""

    def __init__(self, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details

    def as_diagnostic(self) -> dict[str, object]:
        diagnostic: dict[str, object] = {"code": self.code, "message": self.message}
        if self.details:
            diagnostic["details"] = self.details
        return diagnostic


def generate_league_plan(
    request: LeaguePlanRequest | Mapping[str, object],
) -> LeaguePlan:
    """大会設定からブロックと1回総当たりの全対戦を生成する。"""

    normalized = _parse_request(request)
    _validate_team_ids(normalized)
    if normalized.block_count > len(normalized.teams):
        raise LeagueGenerationError(
            "INVALID_BLOCK_COUNT",
            "ブロック数はチーム数以下にしてください。",
            block_count=normalized.block_count,
            team_count=len(normalized.teams),
        )

    blocks = _assign_blocks(normalized)
    matches: list[MatchSpec] = []
    logical_rounds: list[LeagueRound] = []
    for block in blocks:
        block_matches, block_rounds = _round_robin(block)
        matches.extend(block_matches)
        logical_rounds.extend(block_rounds)

    return LeaguePlan(
        assignment_mode=normalized.assignment_mode,
        random_seed=normalized.random_seed,
        blocks=blocks,
        logical_rounds=tuple(logical_rounds),
        matches=tuple(matches),
    )


def _parse_request(
    request: LeaguePlanRequest | Mapping[str, object],
) -> LeaguePlanRequest:
    if isinstance(request, LeaguePlanRequest):
        return request
    try:
        return LeaguePlanRequest.model_validate(request)
    except ValidationError as exc:
        fields = [".".join(str(part) for part in error["loc"]) for error in exc.errors()]
        raise LeagueGenerationError(
            "LEAGUE_INPUT_INVALID",
            "リーグ設定に入力不備があります。表示された項目を確認してください。",
            fields=fields,
        ) from exc


def _validate_team_ids(request: LeaguePlanRequest) -> None:
    team_ids = [team.id for team in request.teams]
    duplicate_ids = sorted(team_id for team_id in set(team_ids) if team_ids.count(team_id) > 1)
    if duplicate_ids:
        raise LeagueGenerationError(
            "DUPLICATE_TEAM_ID",
            "チームIDは大会内で重複しない値にしてください。",
            team_ids=duplicate_ids,
        )


def _assign_blocks(request: LeaguePlanRequest) -> tuple[LeagueBlock, ...]:
    if request.assignment_mode is AssignmentMode.MANUAL:
        return _manual_blocks(request)
    if request.manual_blocks:
        raise LeagueGenerationError(
            "MANUAL_BLOCKS_NOT_ALLOWED",
            "手動以外の分け方ではmanual_blocksを指定しないでください。",
        )

    block_ids = tuple(_automatic_block_id(index) for index in range(request.block_count))
    if request.assignment_mode is AssignmentMode.RANDOM:
        ordered_teams = _random_order(request.teams, request.random_seed)
        quotient, remainder = divmod(len(ordered_teams), request.block_count)
        sizes = tuple(quotient + (index < remainder) for index in range(request.block_count))
        blocks: list[LeagueBlock] = []
        offset = 0
        for block_id, size in zip(block_ids, sizes, strict=True):
            blocks.append(
                LeagueBlock(
                    id=block_id,
                    team_ids=tuple(team.id for team in ordered_teams[offset : offset + size]),
                )
            )
            offset += size
        return tuple(blocks)

    ordered_teams = _seeded_order(request.teams)
    assignments: list[list[str]] = [[] for _ in block_ids]
    period = request.block_count * 2
    for index, team in enumerate(ordered_teams):
        position = index % period
        block_index = position if position < request.block_count else period - position - 1
        assignments[block_index].append(team.id)
    return tuple(
        LeagueBlock(id=block_id, team_ids=tuple(team_ids))
        for block_id, team_ids in zip(block_ids, assignments, strict=True)
    )


def _manual_blocks(request: LeaguePlanRequest) -> tuple[LeagueBlock, ...]:
    if not request.manual_blocks:
        raise LeagueGenerationError(
            "MANUAL_BLOCKS_REQUIRED",
            "手動で分ける場合は各ブロックのチームを指定してください。",
        )
    if len(request.manual_blocks) != request.block_count:
        raise LeagueGenerationError(
            "MANUAL_BLOCK_COUNT_MISMATCH",
            "手動ブロックの数を指定したブロック数と同じにしてください。",
            block_count=request.block_count,
            manual_block_count=len(request.manual_blocks),
        )

    block_ids = [block.id for block in request.manual_blocks]
    duplicate_block_ids = sorted(
        block_id for block_id in set(block_ids) if block_ids.count(block_id) > 1
    )
    if duplicate_block_ids:
        raise LeagueGenerationError(
            "DUPLICATE_BLOCK_ID",
            "ブロックIDは大会内で重複しない値にしてください。",
            block_ids=duplicate_block_ids,
        )

    known_team_ids = {team.id for team in request.teams}
    assigned_team_ids = [team_id for block in request.manual_blocks for team_id in block.team_ids]
    unknown_team_ids = sorted(set(assigned_team_ids) - known_team_ids)
    if unknown_team_ids:
        raise LeagueGenerationError(
            "UNKNOWN_TEAM_IN_MANUAL_BLOCKS",
            "手動ブロックに登録されていないチームIDがあります。",
            team_ids=unknown_team_ids,
        )
    duplicate_team_ids = sorted(
        team_id for team_id in set(assigned_team_ids) if assigned_team_ids.count(team_id) > 1
    )
    if duplicate_team_ids:
        raise LeagueGenerationError(
            "DUPLICATE_TEAM_IN_MANUAL_BLOCKS",
            "同じチームを複数の手動ブロックへ割り当てることはできません。",
            team_ids=duplicate_team_ids,
        )
    missing_team_ids = sorted(known_team_ids - set(assigned_team_ids))
    if missing_team_ids:
        raise LeagueGenerationError(
            "TEAM_MISSING_FROM_MANUAL_BLOCKS",
            "どの手動ブロックにも所属していないチームがあります。",
            team_ids=missing_team_ids,
        )
    return tuple(
        LeagueBlock(id=block.id, team_ids=block.team_ids) for block in request.manual_blocks
    )


def _random_order(teams: Sequence[LeagueTeam], random_seed: int) -> list[LeagueTeam]:
    """Pythonのrandom実装へ依存しない、seed付きの再現可能な並びを返す。"""

    def key(team: LeagueTeam) -> tuple[bytes, str]:
        digest = sha256(f"{random_seed}:{team.id}".encode()).digest()
        return digest, team.id

    return sorted(teams, key=key)


def _seeded_order(teams: Sequence[LeagueTeam]) -> list[LeagueTeam]:
    """seed昇順、同値はteam ID順、seedなしは末尾のteam ID順にする。"""

    return sorted(
        teams,
        key=lambda team: (team.seed is None, team.seed if team.seed is not None else 0, team.id),
    )


def _automatic_block_id(index: int) -> str:
    """0をA、25をZ、26をAAとする安定したブロックIDを返す。"""

    result = ""
    value = index + 1
    while value > 0:
        value, remainder = divmod(value - 1, 26)
        result = chr(ord("A") + remainder) + result
    return result


def _round_robin(
    block: LeagueBlock,
) -> tuple[tuple[MatchSpec, ...], tuple[LeagueRound, ...]]:
    if len(block.team_ids) < 2:
        return (), ()

    participants: list[str | None] = list(block.team_ids)
    if len(participants) % 2 == 1:
        participants.append(None)
    match_number = 1
    matches: list[MatchSpec] = []
    rounds: list[LeagueRound] = []
    for round_index in range(len(participants) - 1):
        round_match_ids: list[str] = []
        for pair_index in range(len(participants) // 2):
            left = participants[pair_index]
            right = participants[-pair_index - 1]
            if left is None or right is None:
                continue
            home, away = (left, right) if round_index % 2 == 0 else (right, left)
            match_id = f"LG-{block.id}-M{match_number}"
            matches.append(
                MatchSpec(
                    id=match_id,
                    phase="league",
                    round=f"{block.id}ブロック 第{round_index + 1}ラウンド",
                    possible_home_team_ids=(home,),
                    possible_away_team_ids=(away,),
                )
            )
            round_match_ids.append(match_id)
            match_number += 1
        if round_match_ids:
            rounds.append(
                LeagueRound(
                    block_id=block.id,
                    round_no=round_index + 1,
                    match_ids=tuple(round_match_ids),
                )
            )
        participants = [participants[0], participants[-1], *participants[1:-1]]
    return tuple(matches), tuple(rounds)
