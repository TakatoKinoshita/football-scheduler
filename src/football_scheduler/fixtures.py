"""技術検証で繰り返し使う固定入力。"""

from __future__ import annotations

from itertools import combinations
from typing import Any

from football_scheduler.models import (
    Court,
    DaySettings,
    MatchSpec,
    RefereeSettings,
    ScheduleRequest,
    SolverSettings,
    Team,
)


def make_smoke_request() -> ScheduleRequest:
    """FaaS疎通確認向けの、ごく小さい実行可能入力を返す。"""

    teams = tuple(Team(id=f"team-{number:02d}", name=f"チーム{number}") for number in range(1, 5))
    return ScheduleRequest(
        teams=teams,
        courts=(Court(id="court-a", name="Aコート"), Court(id="court-b", name="Bコート")),
        matches=(
            MatchSpec(
                id="LG-A-M1",
                possible_home_team_ids=(teams[0].id,),
                possible_away_team_ids=(teams[1].id,),
            ),
            MatchSpec(
                id="LG-A-M2",
                possible_home_team_ids=(teams[2].id,),
                possible_away_team_ids=(teams[3].id,),
            ),
        ),
        day=DaySettings(max_sections=2),
        referees=RefereeSettings(organizer_capacity=2),
        random_seed=20260803,
        solver=SolverSettings(max_time_seconds=10),
    )


def make_representative_request() -> ScheduleRequest:
    """16チーム・4ブロック・3コートのリーグ戦24試合を返す。"""

    block_ids = ("A", "B", "C", "D")
    teams = tuple(
        Team(
            id=f"team-{index + 1:02d}",
            name=f"チーム{index + 1}",
            block_id=block_ids[index // 4],
        )
        for index in range(16)
    )
    matches: list[MatchSpec] = []
    for block_id in block_ids:
        block_teams = [team for team in teams if team.block_id == block_id]
        for match_no, (home, away) in enumerate(combinations(block_teams, 2), start=1):
            matches.append(
                MatchSpec(
                    id=f"LG-{block_id}-M{match_no}",
                    phase="league",
                    round=f"{block_id}ブロック",
                    possible_home_team_ids=(home.id,),
                    possible_away_team_ids=(away.id,),
                )
            )

    return ScheduleRequest(
        teams=teams,
        courts=tuple(
            Court(id=f"court-{letter.lower()}", name=f"{letter}コート")
            for letter in ("A", "B", "C")
        ),
        matches=tuple(matches),
        day=DaySettings(max_sections=16),
        referees=RefereeSettings(organizer_capacity=3),
        random_seed=20260803,
        solver=SolverSettings(max_time_seconds=30),
    )


def make_maximum_mvp_request() -> ScheduleRequest:
    """MVP上限の32チームを使う、本番経路検証用のリーグ戦48試合を返す。"""

    block_ids = tuple(chr(ord("A") + index) for index in range(8))
    teams = tuple(
        Team(
            id=f"team-{index + 1:02d}",
            name=f"チーム{index + 1}",
            block_id=block_ids[index // 4],
        )
        for index in range(32)
    )
    matches: list[MatchSpec] = []
    for block_id in block_ids:
        block_teams = [team for team in teams if team.block_id == block_id]
        for match_no, (home, away) in enumerate(combinations(block_teams, 2), start=1):
            matches.append(
                MatchSpec(
                    id=f"LG-{block_id}-M{match_no}",
                    phase="league",
                    round=f"{block_id}ブロック",
                    possible_home_team_ids=(home.id,),
                    possible_away_team_ids=(away.id,),
                )
            )

    return ScheduleRequest(
        teams=teams,
        courts=tuple(
            Court(id=f"court-{letter.lower()}", name=f"{letter}コート")
            for letter in ("A", "B", "C", "D")
        ),
        matches=tuple(matches),
        day=DaySettings(max_sections=24),
        referees=RefereeSettings(organizer_capacity=4),
        random_seed=20260803,
        solver=SolverSettings(max_time_seconds=20),
    )


def make_maximum_schedule_creation_request() -> dict[str, Any]:
    """32チーム・2トーナメントを両日生成する本番経路検証入力を返す。"""

    return {
        "schema_version": "0.2.0",
        "request_kind": "schedule_creation",
        "generation_scope": "all",
        "teams": [
            {"id": f"team-{index + 1:02d}", "name": f"チーム{index + 1}"} for index in range(32)
        ],
        "courts": [
            {"id": f"court-{letter.lower()}", "name": f"{letter}コート"}
            for letter in ("A", "B", "C", "D")
        ],
        "league": {"block_count": 8, "assignment_mode": "random"},
        "final_stage": {"format": "placement_tournament", "tournament_count": 2},
        "day": {
            "id": "day1",
            "start_time": "09:30",
            "game_duration_minutes": 35,
            "margin_minutes": 5,
            "max_sections": 24,
        },
        "day2": {
            "id": "day2",
            "start_time": "09:30",
            "game_duration_minutes": 35,
            "margin_minutes": 10,
            "max_sections": 40,
        },
        "referees": {
            "organizer_capacity": 4,
            "team_referees_required_after_first": False,
            "day2_fallback": "organizer",
        },
        "random_seed": 20260803,
        "solver": {"max_time_seconds": 20},
    }


def make_sixteen_team_schedule_creation_request() -> dict[str, Any]:
    """16チーム・2トーナメントの対象catalogを通る本番経路検証入力を返す。"""

    return {
        "schema_version": "0.2.0",
        "request_kind": "schedule_creation",
        "generation_scope": "all",
        "teams": [
            {"id": f"team-{index + 1:02d}", "name": f"チーム{index + 1}"}
            for index in range(16)
        ],
        "courts": [
            {"id": f"court-{letter.lower()}", "name": f"{letter}コート"}
            for letter in ("A", "B", "C", "D")
        ],
        "league": {"block_count": 4, "assignment_mode": "random"},
        "final_stage": {"format": "placement_tournament", "tournament_count": 2},
        "day": {
            "id": "day1",
            "start_time": "09:30",
            "game_duration_minutes": 35,
            "margin_minutes": 5,
            "max_sections": 16,
        },
        "day2": {
            "id": "day2",
            "start_time": "09:30",
            "game_duration_minutes": 35,
            "margin_minutes": 10,
            "max_sections": 20,
        },
        "referees": {
            "organizer_capacity": 4,
            "team_referees_required_after_first": False,
            "day2_fallback": "organizer",
        },
        "random_seed": 20260803,
        "solver": {"max_time_seconds": 20},
    }
