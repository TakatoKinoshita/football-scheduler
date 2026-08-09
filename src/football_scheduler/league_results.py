"""リーグ戦の結果検証と順位計算。"""

from __future__ import annotations

from collections import defaultdict
from hashlib import sha256
from typing import Annotated, Literal

from pydantic import Field

from football_scheduler.league import LeaguePlan
from football_scheduler.models import ContractModel, Identifier, MatchSpec


class LeagueMatchResult(ContractModel):
    match_id: Identifier
    home_score: Annotated[int, Field(ge=0)]
    away_score: Annotated[int, Field(ge=0)]


class LeagueStandingsRequest(ContractModel):
    schema_version: Literal["0.2.0"] = "0.2.0"
    request_kind: Literal["league_standings"]
    league_plan: LeaguePlan
    results: tuple[LeagueMatchResult, ...]
    random_seed: int = 20260803


class Standing(ContractModel):
    block_id: Identifier
    rank: Annotated[int, Field(gt=0)]
    team_id: Identifier
    played: Annotated[int, Field(ge=0)]
    wins: Annotated[int, Field(ge=0)]
    draws: Annotated[int, Field(ge=0)]
    losses: Annotated[int, Field(ge=0)]
    goals_for: Annotated[int, Field(ge=0)]
    goals_against: Annotated[int, Field(ge=0)]
    goal_difference: int
    points: Annotated[int, Field(ge=0)]
    tie_break: str
    head_to_head: TieBreakMetrics | None = None


class TieBreakMetrics(ContractModel):
    points: Annotated[int, Field(ge=0)]
    goal_difference: int
    goals_for: Annotated[int, Field(ge=0)]


class DrawCandidate(ContractModel):
    team_id: Identifier
    head_to_head: TieBreakMetrics


class DrawRecord(ContractModel):
    block_id: Identifier
    candidates: tuple[Identifier, ...]
    decided_order: tuple[Identifier, ...]
    random_seed: int
    candidate_values: tuple[DrawCandidate, ...]


class LeagueStandings(ContractModel):
    schema_version: Literal["0.2.0"] = "0.2.0"
    status: Literal["COMPLETE"] = "COMPLETE"
    standings: tuple[Standing, ...]
    draws: tuple[DrawRecord, ...]


class LeagueResultsError(ValueError):
    def __init__(self, code: str, message: str, **details: object) -> None:
        super().__init__(message)
        self.code, self.message, self.details = code, message, details


def calculate_league_standings(
    request: LeagueStandingsRequest | dict[str, object],
) -> LeagueStandings:
    data = (
        request
        if isinstance(request, LeagueStandingsRequest)
        else LeagueStandingsRequest.model_validate(request)
    )
    match_to_block = _validate_plan(data.league_plan)
    matches = {match.id: match for match in data.league_plan.matches}
    supplied = [result.match_id for result in data.results]
    duplicates = sorted(match_id for match_id in set(supplied) if supplied.count(match_id) > 1)
    if duplicates:
        raise LeagueResultsError(
            "DUPLICATE_LEAGUE_RESULT", "同じ試合の結果が重複しています。", match_ids=duplicates
        )
    unknown = sorted(set(supplied) - set(matches))
    if unknown:
        raise LeagueResultsError(
            "UNKNOWN_LEAGUE_MATCH",
            "日程にないリーグ試合の結果が含まれています。",
            match_ids=unknown,
        )
    missing = sorted(set(matches) - set(supplied))
    if missing:
        raise LeagueResultsError(
            "LEAGUE_RESULTS_INCOMPLETE",
            "すべてのリーグ試合の結果を入力してから順位を確定してください。",
            missing_match_ids=missing,
            missing_count=len(missing),
        )
    result_by_match = {result.match_id: result for result in data.results}
    standings: list[Standing] = []
    draws: list[DrawRecord] = []
    for block in data.league_plan.blocks:
        block_matches = [
            match for match in data.league_plan.matches if match_to_block[match.id] == block.id
        ]
        stats = {team_id: _empty_stats() for team_id in block.team_ids}
        for match in block_matches:
            result = result_by_match[match.id]
            home, away = match.possible_home_team_ids[0], match.possible_away_team_ids[0]
            _record(stats[home], stats[away], result.home_score, result.away_score)
        ordered, block_draws, reasons, head_to_head = _rank_block(
            block.id, block.team_ids, stats, block_matches, result_by_match, data.random_seed
        )
        draws.extend(block_draws)
        for rank, team_id in enumerate(ordered, 1):
            stat = stats[team_id]
            standings.append(
                Standing(
                    block_id=block.id,
                    rank=rank,
                    team_id=team_id,
                    goal_difference=stat["gf"] - stat["ga"],
                    tie_break=reasons[team_id],
                    head_to_head=head_to_head.get(team_id),
                    **_public_stats(stat),
                )
            )
    return LeagueStandings(standings=tuple(standings), draws=tuple(draws))


def _invalid_plan(reason: str, **details: object) -> LeagueResultsError:
    return LeagueResultsError(
        "LEAGUE_PLAN_INVALID",
        "リーグ日程とブロック情報の対応を確認できませんでした。日程を再生成してください。",
        reason=reason,
        **details,
    )


def _validate_plan(plan: LeaguePlan) -> dict[str, str]:
    block_ids = [block.id for block in plan.blocks]
    if len(set(block_ids)) != len(block_ids):
        raise _invalid_plan("duplicate_block_id")
    known_blocks = set(block_ids)
    known_matches = {match.id: match for match in plan.matches}

    team_to_block: dict[str, str] = {}
    for block in plan.blocks:
        if len(set(block.team_ids)) != len(block.team_ids):
            raise _invalid_plan("duplicate_team_in_block", block_id=block.id)
        for team_id in block.team_ids:
            if team_id in team_to_block:
                raise _invalid_plan("team_in_multiple_blocks", team_id=team_id)
            team_to_block[team_id] = block.id

    match_to_block: dict[str, str] = {}
    for round_ in plan.logical_rounds:
        if round_.block_id not in known_blocks:
            raise _invalid_plan("unknown_round_block", block_id=round_.block_id)
        for match_id in round_.match_ids:
            if match_id not in known_matches:
                raise _invalid_plan("unknown_round_match", match_id=match_id)
            if match_id in match_to_block:
                raise _invalid_plan("match_in_multiple_rounds", match_id=match_id)
            match_to_block[match_id] = round_.block_id

    missing_matches = sorted(set(known_matches) - set(match_to_block))
    if missing_matches:
        raise _invalid_plan("match_without_round", match_ids=missing_matches)

    for match_id, match in known_matches.items():
        block_id = match_to_block[match_id]
        if match.phase != "league":
            raise _invalid_plan("non_league_match", match_id=match_id)
        if len(match.possible_home_team_ids) != 1 or len(match.possible_away_team_ids) != 1:
            raise _invalid_plan("unresolved_team_reference", match_id=match_id)
        home = match.possible_home_team_ids[0]
        away = match.possible_away_team_ids[0]
        if team_to_block.get(home) != block_id or team_to_block.get(away) != block_id:
            raise _invalid_plan("team_outside_match_block", match_id=match_id)
    return match_to_block


def _empty_stats() -> dict[str, int]:
    return {"played": 0, "wins": 0, "draws": 0, "losses": 0, "gf": 0, "ga": 0, "points": 0}


def _public_stats(stat: dict[str, int]) -> dict[str, int]:
    return {
        "played": stat["played"],
        "wins": stat["wins"],
        "draws": stat["draws"],
        "losses": stat["losses"],
        "goals_for": stat["gf"],
        "goals_against": stat["ga"],
        "points": stat["points"],
    }


def _record(home: dict[str, int], away: dict[str, int], home_score: int, away_score: int) -> None:
    for stat, scored, conceded in ((home, home_score, away_score), (away, away_score, home_score)):
        stat["played"] += 1
        stat["gf"] += scored
        stat["ga"] += conceded
    if home_score > away_score:
        home["wins"] += 1
        home["points"] += 3
        away["losses"] += 1
    elif home_score < away_score:
        away["wins"] += 1
        away["points"] += 3
        home["losses"] += 1
    else:
        home["draws"] += 1
        away["draws"] += 1
        home["points"] += 1
        away["points"] += 1


def _key(stat: dict[str, int]) -> tuple[int, int, int]:
    return (stat["points"], stat["gf"] - stat["ga"], stat["gf"])


def _tie_break_metrics(stat: dict[str, int]) -> TieBreakMetrics:
    return TieBreakMetrics(
        points=stat["points"],
        goal_difference=stat["gf"] - stat["ga"],
        goals_for=stat["gf"],
    )


def _rank_block(
    block_id: str,
    teams: tuple[str, ...],
    stats: dict[str, dict[str, int]],
    matches: list[MatchSpec],
    results: dict[str, LeagueMatchResult],
    seed: int,
) -> tuple[list[str], list[DrawRecord], dict[str, str], dict[str, TieBreakMetrics]]:
    groups: dict[tuple[int, int, int], list[str]] = defaultdict(list)
    for team in teams:
        groups[_key(stats[team])].append(team)
    ordered: list[str] = []
    draws: list[DrawRecord] = []
    reasons: dict[str, str] = {}
    head_to_head: dict[str, TieBreakMetrics] = {}
    for key in sorted(groups, reverse=True):
        group = groups[key]
        if len(group) == 1:
            reasons[group[0]] = "勝点・得失点差・総得点"
            ordered.extend(group)
            continue
        mini = {team: _empty_stats() for team in group}
        for match in matches:
            home, away = match.possible_home_team_ids[0], match.possible_away_team_ids[0]
            if home in mini and away in mini:
                value = results[match.id]
                _record(mini[home], mini[away], value.home_score, value.away_score)
        mini_groups: dict[tuple[int, int, int], list[str]] = defaultdict(list)
        for team in group:
            mini_groups[_key(mini[team])].append(team)
            head_to_head[team] = _tie_break_metrics(mini[team])
        for mini_key in sorted(mini_groups, reverse=True):
            tied = mini_groups[mini_key]
            if len(tied) == 1:
                reasons[tied[0]] = "直接対戦"
                ordered.extend(tied)
                continue
            decided = tuple(
                sorted(
                    tied,
                    key=lambda team: (
                        sha256(
                            f"{seed}:{block_id}:{','.join(sorted(tied))}:{team}".encode()
                        ).digest(),
                        team,
                    ),
                )
            )
            draws.append(
                DrawRecord(
                    block_id=block_id,
                    candidates=tuple(sorted(tied)),
                    decided_order=decided,
                    random_seed=seed,
                    candidate_values=tuple(
                        DrawCandidate(team_id=team, head_to_head=head_to_head[team])
                        for team in sorted(tied)
                    ),
                )
            )
            for team in decided:
                reasons[team] = "直接対戦後の抽選"
            ordered.extend(decided)
    return ordered, draws, reasons, head_to_head
