"""2日目同順位リーグの結果検証と総合順位計算。"""

from __future__ import annotations

from collections import defaultdict
from hashlib import sha256
from typing import Annotated, Literal

from pydantic import Field

from football_scheduler.models import ContractModel, Identifier
from football_scheduler.same_rank_league import (
    SameRankGroup,
    SameRankLeaguePlan,
)
from football_scheduler.tournament import LeagueRankRef, ParticipantResolution


class SameRankMatchResultInput(ContractModel):
    match_id: Identifier
    home_team_id: Identifier
    away_team_id: Identifier
    regular_score_home: Annotated[int, Field(ge=0)]
    regular_score_away: Annotated[int, Field(ge=0)]
    penalty_score_home: Annotated[int, Field(ge=0)] | None = None
    penalty_score_away: Annotated[int, Field(ge=0)] | None = None


class SameRankResultsRequest(ContractModel):
    schema_version: Literal["0.2.0"] = "0.2.0"
    request_kind: Literal["same_rank_league_results"]
    same_rank_plan: SameRankLeaguePlan
    results: tuple[SameRankMatchResultInput, ...]


class SameRankMatchResult(ContractModel):
    match_id: Identifier
    home_team_id: Identifier
    away_team_id: Identifier
    regular_score_home: Annotated[int, Field(ge=0)]
    regular_score_away: Annotated[int, Field(ge=0)]
    outcome: Literal["home_win", "away_win", "draw"]


class SameRankTieBreakMetrics(ContractModel):
    points: Annotated[int, Field(ge=0)]
    goal_difference: int
    goals_for: Annotated[int, Field(ge=0)]


class SameRankDrawCandidate(ContractModel):
    team_id: Identifier
    head_to_head: SameRankTieBreakMetrics


class SameRankDrawRecord(ContractModel):
    group_id: Identifier
    candidates: tuple[Identifier, ...]
    decided_order: tuple[Identifier, ...]
    random_seed: int
    candidate_values: tuple[SameRankDrawCandidate, ...]


class SameRankStanding(ContractModel):
    rank: Annotated[int, Field(gt=0)]
    group_id: Identifier
    group_rank: Annotated[int, Field(gt=0)]
    team_id: Identifier
    entry: LeagueRankRef
    played: Annotated[int, Field(ge=0)]
    wins: Annotated[int, Field(ge=0)]
    draws: Annotated[int, Field(ge=0)]
    losses: Annotated[int, Field(ge=0)]
    goals_for: Annotated[int, Field(ge=0)]
    goals_against: Annotated[int, Field(ge=0)]
    goal_difference: int
    points: Annotated[int, Field(ge=0)]
    tie_break: str
    head_to_head: SameRankTieBreakMetrics | None = None
    automatic: bool = False


class SameRankStandings(ContractModel):
    schema_version: Literal["0.2.0"] = "0.2.0"
    status: Literal["COMPLETE"] = "COMPLETE"
    match_results: tuple[SameRankMatchResult, ...]
    standings: tuple[SameRankStanding, ...]
    draws: tuple[SameRankDrawRecord, ...]


class SameRankResultsError(ValueError):
    """利用者が修正できる同順位リーグ結果エラー。"""

    def __init__(self, code: str, message: str, **details: object) -> None:
        super().__init__(message)
        self.code, self.message, self.details = code, message, details


def calculate_same_rank_standings(
    request: SameRankResultsRequest | dict[str, object],
) -> SameRankStandings:
    """全グループの結果を検証し、1位から参加数までを確定する。"""

    data = (
        request
        if isinstance(request, SameRankResultsRequest)
        else SameRankResultsRequest.model_validate(request)
    )
    plan = data.same_rank_plan
    if plan.participant_resolution is not ParticipantResolution.RESOLVED:
        raise SameRankResultsError(
            "SAME_RANK_RESULTS_REQUIRE_RESOLVED_PLAN",
            "予選順位を確定してから同順位リーグの結果を入力してください。",
        )
    all_matches = [match for group in plan.groups for match in group.matches]
    matches = {match.id: match for match in all_matches}
    if len(matches) != len(all_matches):
        raise _invalid_plan("duplicate_match_id")

    supplied_ids = [result.match_id for result in data.results]
    duplicates = sorted(
        match_id for match_id in set(supplied_ids) if supplied_ids.count(match_id) > 1
    )
    if duplicates:
        raise SameRankResultsError(
            "DUPLICATE_SAME_RANK_RESULT",
            "同じ同順位リーグ試合の結果が重複しています。",
            match_ids=duplicates,
        )
    unknown = sorted(set(supplied_ids) - set(matches))
    if unknown:
        raise SameRankResultsError(
            "UNKNOWN_SAME_RANK_MATCH",
            "日程にない同順位リーグ試合の結果が含まれています。",
            match_ids=unknown,
        )
    missing = sorted(set(matches) - set(supplied_ids))
    if missing:
        raise SameRankResultsError(
            "SAME_RANK_RESULTS_INCOMPLETE",
            "すべての同順位リーグ試合の結果を入力してから順位を確定してください。",
            missing_match_ids=missing,
            missing_count=len(missing),
        )

    supplied_by_match = {result.match_id: result for result in data.results}
    canonical_results: list[SameRankMatchResult] = []
    standings: list[SameRankStanding] = []
    draw_records: list[SameRankDrawRecord] = []
    for group in plan.groups:
        team_by_entry = _team_by_entry(group)
        group_results: dict[str, SameRankMatchResultInput] = {}
        for match in group.matches:
            supplied = supplied_by_match[match.id]
            expected_home = team_by_entry[(match.home.block_id, match.home.rank)]
            expected_away = team_by_entry[(match.away.block_id, match.away.rank)]
            if supplied.home_team_id != expected_home or supplied.away_team_id != expected_away:
                raise SameRankResultsError(
                    "SAME_RANK_RESULT_PARTICIPANT_MISMATCH",
                    "対戦チームが現在の同順位リーグと一致しません。結果を入力し直してください。",
                    match_id=match.id,
                    expected_home_team_id=expected_home,
                    expected_away_team_id=expected_away,
                    supplied_home_team_id=supplied.home_team_id,
                    supplied_away_team_id=supplied.away_team_id,
                )
            if supplied.penalty_score_home is not None or supplied.penalty_score_away is not None:
                raise SameRankResultsError(
                    "SAME_RANK_PENALTY_NOT_ALLOWED",
                    "同順位リーグではPK戦を行いません。通常得点だけを入力してください。",
                    match_id=match.id,
                )
            group_results[match.id] = supplied
            canonical_results.append(
                SameRankMatchResult(
                    match_id=match.id,
                    home_team_id=expected_home,
                    away_team_id=expected_away,
                    regular_score_home=supplied.regular_score_home,
                    regular_score_away=supplied.regular_score_away,
                    outcome=_outcome(supplied),
                )
            )
        group_standings, group_draws = _rank_group(
            group,
            team_by_entry,
            group_results,
            plan.random_seed,
        )
        standings.extend(group_standings)
        draw_records.extend(group_draws)

    ordered_standings = tuple(sorted(standings, key=lambda item: item.rank))
    actual_ranks = [standing.rank for standing in ordered_standings]
    team_ids = [standing.team_id for standing in ordered_standings]
    if actual_ranks != list(range(1, plan.team_count + 1)) or len(set(team_ids)) != len(team_ids):
        raise _invalid_plan(
            "invalid_final_standings",
            actual_ranks=actual_ranks,
            team_ids=team_ids,
        )
    return SameRankStandings(
        match_results=tuple(canonical_results),
        standings=ordered_standings,
        draws=tuple(draw_records),
    )


def _invalid_plan(reason: str, **details: object) -> SameRankResultsError:
    return SameRankResultsError(
        "SAME_RANK_PLAN_INVALID",
        "同順位リーグの構造を確認できませんでした。2日目の計画を作り直してください。",
        reason=reason,
        **details,
    )


def _team_by_entry(group: SameRankGroup) -> dict[tuple[str, int], str]:
    mapping: dict[tuple[str, int], str] = {}
    seen_teams: set[str] = set()
    for participant in group.participants:
        if participant.team is None:
            raise _invalid_plan("unresolved_participant", group_id=group.id)
        key = (participant.entry.block_id, participant.entry.rank)
        team_id = participant.team.team_id
        if key in mapping or team_id in seen_teams:
            raise _invalid_plan("duplicate_participant", group_id=group.id)
        mapping[key] = team_id
        seen_teams.add(team_id)
    for match in group.matches:
        expected_home = mapping.get((match.home.block_id, match.home.rank))
        expected_away = mapping.get((match.away.block_id, match.away.rank))
        if expected_home is None or expected_away is None:
            raise _invalid_plan("match_entry_outside_group", group_id=group.id, match_id=match.id)
        if (
            match.home_team is None
            or match.away_team is None
            or match.home_team.team_id != expected_home
            or match.away_team.team_id != expected_away
        ):
            raise _invalid_plan("match_team_annotation_mismatch", match_id=match.id)
    return mapping


def _outcome(result: SameRankMatchResultInput) -> Literal["home_win", "away_win", "draw"]:
    if result.regular_score_home > result.regular_score_away:
        return "home_win"
    if result.regular_score_home < result.regular_score_away:
        return "away_win"
    return "draw"


def _empty_stats() -> dict[str, int]:
    return {"played": 0, "wins": 0, "draws": 0, "losses": 0, "gf": 0, "ga": 0, "points": 0}


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
    return stat["points"], stat["gf"] - stat["ga"], stat["gf"]


def _metrics(stat: dict[str, int]) -> SameRankTieBreakMetrics:
    return SameRankTieBreakMetrics(
        points=stat["points"],
        goal_difference=stat["gf"] - stat["ga"],
        goals_for=stat["gf"],
    )


def _rank_group(
    group: SameRankGroup,
    team_by_entry: dict[tuple[str, int], str],
    results: dict[str, SameRankMatchResultInput],
    seed: int,
) -> tuple[list[SameRankStanding], list[SameRankDrawRecord]]:
    entry_by_team = {
        team_id: LeagueRankRef(block_id=block_id, rank=rank)
        for (block_id, rank), team_id in team_by_entry.items()
    }
    teams = tuple(
        participant.team.team_id for participant in group.participants if participant.team
    )
    stats = {team: _empty_stats() for team in teams}
    match_teams: dict[str, tuple[str, str]] = {}
    for match in group.matches:
        home = team_by_entry[(match.home.block_id, match.home.rank)]
        away = team_by_entry[(match.away.block_id, match.away.rank)]
        match_teams[match.id] = home, away
        supplied = results[match.id]
        _record(
            stats[home],
            stats[away],
            supplied.regular_score_home,
            supplied.regular_score_away,
        )

    groups: dict[tuple[int, int, int], list[str]] = defaultdict(list)
    for team in teams:
        groups[_key(stats[team])].append(team)
    ordered: list[str] = []
    reasons: dict[str, str] = {}
    head_to_head: dict[str, SameRankTieBreakMetrics] = {}
    draw_records: list[SameRankDrawRecord] = []
    for base_key in sorted(groups, reverse=True):
        tied_on_base = groups[base_key]
        if len(tied_on_base) == 1:
            reasons[tied_on_base[0]] = "勝点・得失点差・総得点"
            ordered.extend(tied_on_base)
            continue
        mini = {team: _empty_stats() for team in tied_on_base}
        for match in group.matches:
            home, away = match_teams[match.id]
            if home in mini and away in mini:
                supplied = results[match.id]
                _record(
                    mini[home],
                    mini[away],
                    supplied.regular_score_home,
                    supplied.regular_score_away,
                )
        mini_groups: dict[tuple[int, int, int], list[str]] = defaultdict(list)
        for team in tied_on_base:
            mini_groups[_key(mini[team])].append(team)
            head_to_head[team] = _metrics(mini[team])
        for mini_key in sorted(mini_groups, reverse=True):
            still_tied = mini_groups[mini_key]
            if len(still_tied) == 1:
                reasons[still_tied[0]] = "直接対戦"
                ordered.extend(still_tied)
                continue
            decided = tuple(
                sorted(
                    still_tied,
                    key=lambda team: (
                        sha256(
                            f"{seed}:{group.id}:{','.join(sorted(still_tied))}:{team}".encode()
                        ).digest(),
                        team,
                    ),
                )
            )
            draw_records.append(
                SameRankDrawRecord(
                    group_id=group.id,
                    candidates=tuple(sorted(still_tied)),
                    decided_order=decided,
                    random_seed=seed,
                    candidate_values=tuple(
                        SameRankDrawCandidate(team_id=team, head_to_head=head_to_head[team])
                        for team in sorted(still_tied)
                    ),
                )
            )
            for team in decided:
                reasons[team] = "直接対戦後の抽選"
            ordered.extend(decided)

    start = group.overall_rank_range[0]
    standings: list[SameRankStanding] = []
    for group_rank, team in enumerate(ordered, 1):
        stat = stats[team]
        standings.append(
            SameRankStanding(
                rank=start + group_rank - 1,
                group_id=group.id,
                group_rank=group_rank,
                team_id=team,
                entry=entry_by_team[team],
                played=stat["played"],
                wins=stat["wins"],
                draws=stat["draws"],
                losses=stat["losses"],
                goals_for=stat["gf"],
                goals_against=stat["ga"],
                goal_difference=stat["gf"] - stat["ga"],
                points=stat["points"],
                tie_break=reasons.get(team, "自動確定"),
                head_to_head=head_to_head.get(team),
                automatic=len(teams) == 1,
            )
        )
    return standings, draw_records
