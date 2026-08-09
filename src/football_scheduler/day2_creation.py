"""2日目のトーナメント表と日程を1回の保護された操作で作成する入力契約。"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field

from football_scheduler.day2_schedule import Day1ScheduleSource, Day2ScheduleRequest
from football_scheduler.final_stage import (
    FinalStageConfig,
    PlacementTournamentFinalStage,
    SameRankLeagueFinalStage,
)
from football_scheduler.league import LeaguePlan, LeagueTeam
from football_scheduler.league_results import LeagueStandings
from football_scheduler.models import (
    ContractModel,
    Court,
    DaySettings,
    RefereeSettings,
    SolverSettings,
)
from football_scheduler.same_rank_league import SameRankLeaguePlan, SameRankLeaguePlanRequest
from football_scheduler.same_rank_schedule import (
    SameRankDay2ScheduleRequest,
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
    final_stage: FinalStageConfig
    day1_schedule: Day1ScheduleSource
    day: DaySettings = DaySettings(id="day2", game_duration_minutes=35, margin_minutes=10)
    referees: RefereeSettings
    random_seed: int = 20260803
    solver: SolverSettings = SolverSettings()

    def tournament_request(self) -> TournamentPlanRequest:
        if not isinstance(self.final_stage, PlacementTournamentFinalStage):
            raise ValueError("順位決定トーナメント以外ではトーナメント表を生成できません")
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

    def same_rank_request(self) -> SameRankLeaguePlanRequest:
        if not isinstance(self.final_stage, SameRankLeagueFinalStage):
            raise ValueError("同順位リーグ以外では同順位グループを生成できません")
        return SameRankLeaguePlanRequest(
            request_kind="same_rank_league_plan",
            league_plan=self.league_plan,
            league_standings=self.league_standings,
            final_stage=self.final_stage,
            random_seed=self.random_seed,
        )

    def same_rank_schedule_request(
        self,
        same_rank_plan: SameRankLeaguePlan,
    ) -> SameRankDay2ScheduleRequest:
        return SameRankDay2ScheduleRequest(
            request_kind="same_rank_day2_schedule",
            teams=self.teams,
            courts=self.courts,
            league_plan=self.league_plan,
            day1_schedule=self.day1_schedule,
            same_rank_plan=same_rank_plan,
            day=self.day,
            referees=self.referees,
            random_seed=self.random_seed,
            solver=self.solver,
        )
