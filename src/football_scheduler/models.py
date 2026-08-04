"""FaaSや画面に依存しない、検証用の最小JSON契約。"""

from __future__ import annotations

from datetime import time
from enum import StrEnum
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

SCHEMA_VERSION = "0.1.0"

Identifier = Annotated[
    str, Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
]
NonEmptyText = Annotated[str, Field(min_length=1, max_length=200)]


class ContractModel(BaseModel):
    """未知フィールドを受理しない不変の契約モデル。"""

    model_config = ConfigDict(extra="forbid", frozen=True)


class SolverStatus(StrEnum):
    """CP-SATの終了状態。"""

    OPTIMAL = "OPTIMAL"
    FEASIBLE = "FEASIBLE"
    INFEASIBLE = "INFEASIBLE"
    UNKNOWN = "UNKNOWN"


class RefereeKind(StrEnum):
    ORGANIZER = "organizer"
    TEAM = "team"


class Team(ContractModel):
    id: Identifier
    name: NonEmptyText
    block_id: Identifier | None = None


class Court(ContractModel):
    id: Identifier
    name: NonEmptyText


class MatchSpec(ContractModel):
    """配置前の試合。

    未確定の勝者・敗者参照は、各entryが取り得るチームIDの集合へ展開して保持する。
    これにより、結果未確定でも全経路に対して役割衝突を避けられる。
    """

    id: Identifier
    phase: Identifier = "league"
    round: NonEmptyText = "リーグ戦"
    possible_home_team_ids: tuple[Identifier, ...]
    possible_away_team_ids: tuple[Identifier, ...]
    prerequisite_match_ids: tuple[Identifier, ...] = ()
    organizer_referee_required: bool = False

    @model_validator(mode="after")
    def validate_possible_teams(self) -> Self:
        home = set(self.possible_home_team_ids)
        away = set(self.possible_away_team_ids)
        if not home or not away:
            raise ValueError("homeとawayの可能チーム集合は空にできません")
        if len(home) != len(self.possible_home_team_ids):
            raise ValueError("possible_home_team_idsに重複があります")
        if len(away) != len(self.possible_away_team_ids):
            raise ValueError("possible_away_team_idsに重複があります")
        if home & away:
            raise ValueError("homeとawayの可能チーム集合は重複できません")
        if self.id in self.prerequisite_match_ids:
            raise ValueError("試合自身を前提試合にはできません")
        if len(set(self.prerequisite_match_ids)) != len(self.prerequisite_match_ids):
            raise ValueError("prerequisite_match_idsに重複があります")
        return self

    @property
    def possible_team_ids(self) -> frozenset[str]:
        return frozenset((*self.possible_home_team_ids, *self.possible_away_team_ids))


class DaySettings(ContractModel):
    id: Identifier = "day1"
    start_time: time = time(9, 30)
    game_duration_minutes: Annotated[int, Field(gt=0)] = 35
    margin_minutes: Annotated[int, Field(ge=0)] = 5
    max_sections: Annotated[int, Field(gt=0)] | None = None


class RefereeSettings(ContractModel):
    organizer_capacity: Annotated[int, Field(ge=0)]
    team_referees_required_after_first: bool = True


class SolverSettings(ContractModel):
    max_time_seconds: Annotated[float, Field(gt=0, le=840)] = 30.0


class ScheduleRequest(ContractModel):
    schema_version: Literal["0.1.0"] = "0.1.0"
    teams: tuple[Team, ...]
    courts: tuple[Court, ...]
    matches: tuple[MatchSpec, ...]
    day: DaySettings
    referees: RefereeSettings
    random_seed: int = 20260803
    solver: SolverSettings = SolverSettings()

    @model_validator(mode="after")
    def validate_references(self) -> Self:
        if len(self.teams) < 2:
            raise ValueError("チーム数は2以上である必要があります")
        if not self.courts:
            raise ValueError("コートは1つ以上必要です")
        if not self.matches:
            raise ValueError("試合は1つ以上必要です")

        team_ids = [team.id for team in self.teams]
        court_ids = [court.id for court in self.courts]
        match_ids = [match.id for match in self.matches]
        if len(set(team_ids)) != len(team_ids):
            raise ValueError("チームIDは大会内で一意である必要があります")
        if len(set(court_ids)) != len(court_ids):
            raise ValueError("コートIDは大会内で一意である必要があります")
        if len(set(match_ids)) != len(match_ids):
            raise ValueError("試合IDは大会内で一意である必要があります")

        known_teams = set(team_ids)
        known_matches = set(match_ids)
        for match in self.matches:
            unknown_teams = match.possible_team_ids - known_teams
            if unknown_teams:
                unknown = ", ".join(sorted(unknown_teams))
                raise ValueError(f"試合{match.id}が未定義チームを参照しています: {unknown}")
            unknown_dependencies = set(match.prerequisite_match_ids) - known_matches
            if unknown_dependencies:
                unknown = ", ".join(sorted(unknown_dependencies))
                raise ValueError(f"試合{match.id}が未定義の前提試合を参照しています: {unknown}")
        return self


class RefereeAssignment(ContractModel):
    kind: RefereeKind
    team_id: Identifier | None = None

    @model_validator(mode="after")
    def validate_team_id(self) -> Self:
        if self.kind is RefereeKind.TEAM and self.team_id is None:
            raise ValueError("チーム審判にはteam_idが必要です")
        if self.kind is RefereeKind.ORGANIZER and self.team_id is not None:
            raise ValueError("主催者審判にteam_idは指定できません")
        return self


class Slot(ContractModel):
    day_id: Identifier
    section_no: Annotated[int, Field(gt=0)]
    court_id: Identifier
    match_id: Identifier | None
    referee_assignment: RefereeAssignment | None


class Diagnostic(ContractModel):
    code: Identifier
    message: NonEmptyText
    details: dict[str, int | float | str | bool | list[str]] = Field(default_factory=dict)


class SolverMetrics(ContractModel):
    random_seed: int
    num_search_workers: Literal[1] = 1
    max_time_seconds: float
    ortools_version: NonEmptyText
    wall_time_seconds: Annotated[float, Field(ge=0)]
    used_sections: Annotated[int, Field(ge=1)] | None = None
    objective_value: float | None = None
    best_objective_bound: float | None = None
    optimality_proven: bool


class ScheduleResult(ContractModel):
    schema_version: Literal["0.1.0"] = "0.1.0"
    status: SolverStatus
    slots: tuple[Slot, ...] = ()
    metrics: SolverMetrics
    diagnostics: tuple[Diagnostic, ...] = ()
