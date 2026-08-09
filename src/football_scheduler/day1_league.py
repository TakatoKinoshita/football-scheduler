"""1日目リーグ設定を既存スケジューラー入力へ変換する境界。"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from math import ceil
from typing import Annotated, Literal

from pydantic import Field

from football_scheduler.final_stage import FinalStageConfig
from football_scheduler.league import (
    AssignmentMode,
    LeagueGenerationError,
    LeaguePlan,
    LeaguePlanRequest,
    LeagueTeam,
    ManualBlock,
    generate_league_plan,
)
from football_scheduler.models import (
    ContractModel,
    Court,
    DaySettings,
    Identifier,
    RefereeSettings,
    ScheduleRequest,
    SolverSettings,
    Team,
)


class Day1ManualBlock(ContractModel):
    """通常画面の入力途中では空ブロックも保持できる手動割当て。"""

    id: Identifier
    team_ids: tuple[Identifier, ...] = ()


class Day1LeagueSettings(ContractModel):
    """画面から指定できる1日目リーグ設定。"""

    block_count: Annotated[int, Field(ge=1, le=32)]
    assignment_mode: Literal[
        AssignmentMode.RANDOM,
        AssignmentMode.SEEDED_SNAKE,
        AssignmentMode.MANUAL,
    ] = AssignmentMode.RANDOM
    manual_blocks: tuple[Day1ManualBlock, ...] = ()


class Day1LeagueScheduleRequest(ContractModel):
    """対戦生成前の1日目リーグ日程リクエスト。"""

    schema_version: Literal["0.2.0"] = "0.2.0"
    request_kind: Literal["day1_league"]
    teams: Annotated[tuple[LeagueTeam, ...], Field(min_length=2, max_length=32)]
    courts: Annotated[tuple[Court, ...], Field(min_length=1, max_length=16)]
    league: Day1LeagueSettings
    final_stage: FinalStageConfig
    day: DaySettings
    referees: RefereeSettings
    random_seed: int = 20260803
    solver: SolverSettings = SolverSettings()


@dataclass(frozen=True, slots=True)
class PreparedDay1LeagueSchedule:
    """ソルバー入力と、画面表示に使うリーグ計画。"""

    request: ScheduleRequest
    league_plan: LeaguePlan
    fallback_request: ScheduleRequest | None = None


def prepare_day1_league_schedule(
    request: Day1LeagueScheduleRequest | Mapping[str, object],
) -> PreparedDay1LeagueSchedule:
    """大会設定からリーグ対戦を生成し、既存ソルバー入力へ変換する。"""

    normalized = (
        request
        if isinstance(request, Day1LeagueScheduleRequest)
        else Day1LeagueScheduleRequest.model_validate(request)
    )
    manual_blocks = _validated_manual_blocks(normalized)
    league_plan = generate_league_plan(
        LeaguePlanRequest(
            teams=normalized.teams,
            block_count=normalized.league.block_count,
            assignment_mode=normalized.league.assignment_mode,
            manual_blocks=manual_blocks,
            random_seed=normalized.random_seed,
        )
    )
    block_by_team = {
        team_id: block.id for block in league_plan.blocks for team_id in block.team_ids
    }
    base_request = ScheduleRequest(
        teams=tuple(
            Team(id=team.id, name=team.name, block_id=block_by_team[team.id])
            for team in normalized.teams
        ),
        courts=normalized.courts,
        matches=league_plan.matches,
        day=normalized.day,
        referees=normalized.referees,
        random_seed=normalized.random_seed,
        solver=normalized.solver,
    )
    schedule_request = base_request
    fallback_request = None
    if normalized.day.max_sections is None:
        # 既存fixtureと同じく、必要スロット数の2倍を初期探索範囲にする。
        # この範囲で配置不能と証明された場合は、application境界で従来の
        # 広い探索範囲へ戻し、暗黙のハード制約にはしない。
        initial_horizon = 2 * ceil(len(league_plan.matches) / len(normalized.courts))
        schedule_request = base_request.model_copy(
            update={"day": normalized.day.model_copy(update={"max_sections": initial_horizon})}
        )
        fallback_request = base_request
    return PreparedDay1LeagueSchedule(
        request=schedule_request,
        league_plan=league_plan,
        fallback_request=fallback_request,
    )


def _validated_manual_blocks(
    request: Day1LeagueScheduleRequest,
) -> tuple[ManualBlock, ...]:
    blocks = request.league.manual_blocks
    if request.league.assignment_mode != AssignmentMode.MANUAL:
        if blocks:
            raise LeagueGenerationError(
                "MANUAL_BLOCKS_NOT_ALLOWED",
                "手動以外の分け方ではmanual_blocksを指定しないでください。",
            )
        return ()
    if not blocks:
        raise LeagueGenerationError(
            "MANUAL_BLOCKS_REQUIRED",
            "手動で分ける場合は各ブロックのチームを指定してください。",
        )
    if len(blocks) != request.league.block_count:
        raise LeagueGenerationError(
            "MANUAL_BLOCK_COUNT_MISMATCH",
            "手動ブロックの数を指定したブロック数と同じにしてください。",
            block_count=request.league.block_count,
            manual_block_count=len(blocks),
        )

    block_ids = [block.id for block in blocks]
    duplicate_block_ids = sorted(
        block_id for block_id in set(block_ids) if block_ids.count(block_id) > 1
    )
    if duplicate_block_ids:
        raise LeagueGenerationError(
            "DUPLICATE_BLOCK_ID",
            "ブロックIDは大会内で重複しない値にしてください。",
            block_ids=duplicate_block_ids,
        )
    expected_block_ids = [_day1_block_id(index) for index in range(request.league.block_count)]
    missing_block_ids = sorted(set(expected_block_ids) - set(block_ids))
    unknown_block_ids = sorted(set(block_ids) - set(expected_block_ids))
    if missing_block_ids or unknown_block_ids:
        raise LeagueGenerationError(
            "MANUAL_BLOCK_REFERENCE_INVALID",
            "手動割当てのブロックが、選択したブロック数と一致しません。",
            expected_block_ids=expected_block_ids,
            missing_block_ids=missing_block_ids,
            unknown_block_ids=unknown_block_ids,
        )

    known_team_ids = {team.id for team in request.teams}
    assigned_team_ids = [team_id for block in blocks for team_id in block.team_ids]
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
    minimum_size, maximum_large_block_count = divmod(len(request.teams), request.league.block_count)
    maximum_size = minimum_size + (1 if maximum_large_block_count > 0 else 0)
    block_sizes = {block.id: len(block.team_ids) for block in blocks}
    over_capacity_block_ids = [block.id for block in blocks if len(block.team_ids) > maximum_size]
    large_block_ids = [block.id for block in blocks if len(block.team_ids) > minimum_size]
    excess_large_block_ids = large_block_ids[maximum_large_block_count:]
    if over_capacity_block_ids or excess_large_block_ids:
        raise LeagueGenerationError(
            "MANUAL_BLOCK_SIZE_IMBALANCE",
            "手動指定された人数が多すぎるブロックがあります。対象チームを未割当てへ戻してください。",
            block_sizes=block_sizes,
            minimum_size=minimum_size,
            maximum_size=maximum_size,
            maximum_large_block_count=maximum_large_block_count,
            over_capacity_block_ids=over_capacity_block_ids,
            excess_large_block_ids=excess_large_block_ids,
        )
    block_by_id = {block.id: block for block in blocks}
    return tuple(
        ManualBlock(id=block_id, team_ids=block_by_id[block_id].team_ids)
        for block_id in expected_block_ids
    )


def _day1_block_id(index: int) -> str:
    result = ""
    value = index + 1
    while value > 0:
        value, remainder = divmod(value - 1, 26)
        result = chr(ord("A") + remainder) + result
    return result
