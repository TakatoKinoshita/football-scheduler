"""2日目のトーナメント表と日程を1回の保護された操作で作成する入力契約。"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field

from football_scheduler.day2_schedule import Day1ScheduleSource, Day2ScheduleRequest
from football_scheduler.final_stage import PlacementTournamentFinalStage
from football_scheduler.league import LeaguePlan, LeagueTeam
from football_scheduler.league_results import LeagueStandings
from football_scheduler.models import (
    ContractModel,
    Court,
    DaySettings,
    RefereeSettings,
    SolverSettings,
)
from football_scheduler.tournament import TournamentPlan, TournamentPlanRequest


class Day2CreationRequest(ContractModel):
    """トーナメント生成と2日目配置に共通する利用者入力。"""

    schema_version: Literal["0.2.0"] = "0.2.0"
    request_kind: Literal["day2_creation"]
    teams: Annotated[tuple[LeagueTeam, ...], Field(min_length=2, max_length=32)]
    courts: Annotated[tuple[Court, ...], Field(min_length=1, max_length=16)]
    league_plan: LeaguePlan
    league_standings: LeagueStandings | None = None
    final_stage: PlacementTournamentFinalStage
    day1_schedule: Day1ScheduleSource
    day: DaySettings = DaySettings(id="day2", game_duration_minutes=35, margin_minutes=10)
    referees: RefereeSettings
    random_seed: int = 20260803
    solver: SolverSettings = SolverSettings()

    def tournament_request(self) -> TournamentPlanRequest:
        return TournamentPlanRequest(
            request_kind="tournament_plan",
            league_plan=self.league_plan,
            league_standings=self.league_standings,
            final_stage=self.final_stage,
            random_seed=self.random_seed,
        )

    def schedule_request(self, tournament_plan: TournamentPlan) -> Day2ScheduleRequest:
        return Day2ScheduleRequest(
            request_kind="day2_schedule",
            teams=self.teams,
            courts=self.courts,
            league_plan=self.league_plan,
            day1_schedule=self.day1_schedule,
            tournament_plan=tournament_plan,
            day=self.day,
            referees=self.referees,
            random_seed=self.random_seed,
            solver=self.solver,
        )
