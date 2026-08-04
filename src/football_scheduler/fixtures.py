"""技術検証で繰り返し使う固定入力。"""

from __future__ import annotations

from itertools import combinations

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
