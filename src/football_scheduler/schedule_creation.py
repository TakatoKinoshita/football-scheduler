"""1回の保護された操作で両日の日程を作成する公開入力契約。"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Self

from pydantic import Field, model_validator

from football_scheduler.day1_league import Day1LeagueScheduleRequest, Day1LeagueSettings
from football_scheduler.final_stage import FinalStageConfig
from football_scheduler.league import LeagueTeam
from football_scheduler.models import (
    ContractModel,
    Court,
    Day1ArrivalPreference,
    DaySettings,
    RefereeSettings,
    SolverSettings,
)


class ScheduleCreationRequest(ContractModel):
    """保存中の大会入力と、必要なら既存結果を受け取る一括生成要求。"""

    schema_version: Literal["0.2.0"] = "0.2.0"
    request_kind: Literal["schedule_creation"]
    generation_scope: Literal["all", "day2_only"]
    teams: Annotated[tuple[LeagueTeam, ...], Field(min_length=2, max_length=32)]
    courts: Annotated[tuple[Court, ...], Field(min_length=1, max_length=16)]
    league: Day1LeagueSettings
    final_stage: FinalStageConfig
    day: DaySettings
    day2: DaySettings
    referees: RefereeSettings
    day1_arrival_preferences: tuple[Day1ArrivalPreference, ...] = ()
    random_seed: int = 20260803
    solver: SolverSettings = SolverSettings()
    existing_result: dict[str, Any] | None = None

    @model_validator(mode="after")
    def validate_generation_scope(self) -> Self:
        if self.generation_scope == "all" and self.existing_result is not None:
            raise ValueError("allではexisting_resultを指定できません")
        if self.generation_scope == "day2_only" and self.existing_result is None:
            raise ValueError("day2_onlyではexisting_resultが必要です")
        if self.day.id != "day1" or self.day2.id != "day2":
            raise ValueError("dayにはday1、day2にはday2の設定を指定してください")
        return self

    def day1_request(self) -> Day1LeagueScheduleRequest:
        return Day1LeagueScheduleRequest(
            request_kind="day1_league",
            teams=self.teams,
            courts=self.courts,
            league=self.league,
            final_stage=self.final_stage,
            day=self.day,
            referees=self.referees,
            day1_arrival_preferences=self.day1_arrival_preferences,
            random_seed=self.random_seed,
            solver=self.solver,
        )
