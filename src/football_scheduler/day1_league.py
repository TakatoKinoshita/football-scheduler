"""1日目リーグ設定を既存スケジューラー入力へ変換する境界。"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from math import ceil
from typing import Annotated, Literal

from pydantic import Field

from football_scheduler.league import (
    AssignmentMode,
    LeaguePlan,
    LeaguePlanRequest,
    LeagueTeam,
    generate_league_plan,
)
from football_scheduler.models import (
    ContractModel,
    Court,
    DaySettings,
    RefereeSettings,
    ScheduleRequest,
    SolverSettings,
    Team,
)


class Day1LeagueSettings(ContractModel):
    """画面から指定できる1日目リーグ設定。"""

    block_count: Annotated[int, Field(ge=1, le=32)]
    assignment_mode: Literal[
        AssignmentMode.RANDOM,
        AssignmentMode.SEEDED_SNAKE,
    ] = AssignmentMode.RANDOM


class Day1LeagueScheduleRequest(ContractModel):
    """対戦生成前の1日目リーグ日程リクエスト。"""

    schema_version: Literal["0.1.0"] = "0.1.0"
    request_kind: Literal["day1_league"]
    teams: Annotated[tuple[LeagueTeam, ...], Field(min_length=2, max_length=32)]
    courts: Annotated[tuple[Court, ...], Field(min_length=1, max_length=16)]
    league: Day1LeagueSettings
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
    league_plan = generate_league_plan(
        LeaguePlanRequest(
            teams=normalized.teams,
            block_count=normalized.league.block_count,
            assignment_mode=normalized.league.assignment_mode,
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
