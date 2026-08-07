"""2日目トーナメント結果を検証し、総合最終順位を確定する。"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field

from football_scheduler.models import ContractModel, Identifier
from football_scheduler.tournament import (
    ConcreteTeamRef,
    LeagueRankRef,
    LoserOfRef,
    ParticipantResolution,
    TournamentEntry,
    TournamentPlan,
    TournamentPool,
    TournamentPoolPlan,
    WinnerOfRef,
)


class TournamentMatchResultInput(ContractModel):
    match_id: Identifier
    home_team_id: Identifier
    away_team_id: Identifier
    regular_score_home: Annotated[int, Field(ge=0)]
    regular_score_away: Annotated[int, Field(ge=0)]
    penalty_score_home: Annotated[int, Field(ge=0)] | None = None
    penalty_score_away: Annotated[int, Field(ge=0)] | None = None


class TournamentResultsRequest(ContractModel):
    schema_version: Literal["0.1.0"] = "0.1.0"
    request_kind: Literal["tournament_results"]
    tournament_plan: TournamentPlan
    results: tuple[TournamentMatchResultInput, ...]


class TournamentMatchResult(ContractModel):
    match_id: Identifier
    home_team_id: Identifier
    away_team_id: Identifier
    regular_score_home: Annotated[int, Field(ge=0)]
    regular_score_away: Annotated[int, Field(ge=0)]
    penalty_score_home: Annotated[int, Field(ge=0)] | None = None
    penalty_score_away: Annotated[int, Field(ge=0)] | None = None
    winner: Literal["home", "away"]
    winner_team_id: Identifier
    loser_team_id: Identifier
    decision: Literal["regular_time", "penalty_shootout"]


class FinalStanding(ContractModel):
    rank: Annotated[int, Field(gt=0)]
    pool: TournamentPool
    pool_rank: Annotated[int, Field(gt=0)]
    team_id: Identifier
    entry: TournamentEntry


class TournamentStandings(ContractModel):
    schema_version: Literal["0.1.0"] = "0.1.0"
    status: Literal["COMPLETE"] = "COMPLETE"
    match_results: tuple[TournamentMatchResult, ...]
    standings: tuple[FinalStanding, ...]


class TournamentResultsError(ValueError):
    """利用者が修正できるトーナメント結果エラー。"""

    def __init__(self, code: str, message: str, **details: object) -> None:
        super().__init__(message)
        self.code, self.message, self.details = code, message, details


def calculate_tournament_standings(
    request: TournamentResultsRequest | dict[str, object],
) -> TournamentStandings:
    """全試合結果を依存順に解決し、総合順位を返す。"""

    data = (
        request
        if isinstance(request, TournamentResultsRequest)
        else TournamentResultsRequest.model_validate(request)
    )
    plan = data.tournament_plan
    if plan.participant_resolution is not ParticipantResolution.RESOLVED:
        raise TournamentResultsError(
            "TOURNAMENT_RESULTS_REQUIRE_RESOLVED_PLAN",
            "リーグ順位を確定してから2日目の試合結果を入力してください。",
        )

    pools = (plan.upper, plan.lower)
    all_matches = [match for pool in pools for match in pool.matches]
    match_ids = [match.id for match in all_matches]
    duplicated_plan_ids = sorted(
        match_id for match_id in set(match_ids) if match_ids.count(match_id) > 1
    )
    if duplicated_plan_ids:
        raise _reference_error("duplicate_match_id", match_ids=duplicated_plan_ids)
    matches = {match.id: match for match in all_matches}

    supplied_ids = [result.match_id for result in data.results]
    duplicates = sorted(
        match_id for match_id in set(supplied_ids) if supplied_ids.count(match_id) > 1
    )
    if duplicates:
        raise TournamentResultsError(
            "DUPLICATE_TOURNAMENT_RESULT",
            "同じトーナメント試合の結果が重複しています。",
            match_ids=duplicates,
        )
    unknown = sorted(set(supplied_ids) - set(matches))
    if unknown:
        raise TournamentResultsError(
            "UNKNOWN_TOURNAMENT_MATCH",
            "日程にないトーナメント試合の結果が含まれています。",
            match_ids=unknown,
        )
    missing = sorted(set(matches) - set(supplied_ids))
    if missing:
        raise TournamentResultsError(
            "TOURNAMENT_RESULTS_INCOMPLETE",
            "すべての2日目試合の結果を入力してから最終順位を確定してください。",
            missing_match_ids=missing,
            missing_count=len(missing),
        )

    result_inputs = {result.match_id: result for result in data.results}
    team_by_rank = _team_by_rank(pools)
    resolved: dict[str, TournamentMatchResult] = {}
    resolving: set[str] = set()
    ordered_results: list[TournamentMatchResult] = []

    def resolve_entry(entry: TournamentEntry) -> str:
        if isinstance(entry, ConcreteTeamRef):
            return entry.team_id
        if isinstance(entry, LeagueRankRef):
            team_id = team_by_rank.get((entry.block_id, entry.rank))
            if team_id is None:
                raise _reference_error(
                    "unknown_league_rank",
                    block_id=entry.block_id,
                    rank=entry.rank,
                )
            return team_id
        if isinstance(entry, (WinnerOfRef, LoserOfRef)):
            source = resolve_match(entry.match_id)
            return source.winner_team_id if isinstance(entry, WinnerOfRef) else source.loser_team_id
        raise _reference_error("unsupported_entry")

    def resolve_match(match_id: str) -> TournamentMatchResult:
        existing = resolved.get(match_id)
        if existing is not None:
            return existing
        match = matches.get(match_id)
        if match is None:
            raise _reference_error("unknown_dependency", match_id=match_id)
        if match_id in resolving:
            raise TournamentResultsError(
                "TOURNAMENT_DEPENDENCY_CYCLE",
                "トーナメントの試合参照が循環しています。トーナメント表を作り直してください。",
                match_id=match_id,
            )
        resolving.add(match_id)
        try:
            home_team_id = resolve_entry(match.home)
            away_team_id = resolve_entry(match.away)
            if home_team_id == away_team_id:
                raise _reference_error(
                    "same_team_match",
                    match_id=match_id,
                    team_id=home_team_id,
                )
            supplied = result_inputs[match_id]
            if supplied.home_team_id != home_team_id or supplied.away_team_id != away_team_id:
                raise TournamentResultsError(
                    "TOURNAMENT_RESULT_PARTICIPANT_MISMATCH",
                    "対戦チームが現在のトーナメント進行と一致しません。後続試合の結果を入力し直してください。",
                    match_id=match_id,
                    expected_home_team_id=home_team_id,
                    expected_away_team_id=away_team_id,
                    supplied_home_team_id=supplied.home_team_id,
                    supplied_away_team_id=supplied.away_team_id,
                )
            canonical = _canonical_result(supplied)
            resolved[match_id] = canonical
            ordered_results.append(canonical)
            return canonical
        finally:
            resolving.discard(match_id)

    for match in all_matches:
        resolve_match(match.id)

    standings: list[FinalStanding] = []
    upper_count = plan.upper.participant_count
    for pool in pools:
        _validate_placements(pool)
        rank_offset = 0 if pool.pool is TournamentPool.UPPER else upper_count
        for placement in sorted(pool.placements, key=lambda item: item.rank):
            standings.append(
                FinalStanding(
                    rank=rank_offset + placement.rank,
                    pool=pool.pool,
                    pool_rank=placement.rank,
                    team_id=resolve_entry(placement.entry),
                    entry=placement.entry,
                )
            )

    ordered_standings = tuple(sorted(standings, key=lambda item: item.rank))
    expected_ranks = list(range(1, len(ordered_standings) + 1))
    actual_ranks = [standing.rank for standing in ordered_standings]
    team_ids = [standing.team_id for standing in ordered_standings]
    expected_teams = {
        seed.team_id for pool in pools for seed in pool.seeds if seed.team_id is not None
    }
    if (
        actual_ranks != expected_ranks
        or len(set(team_ids)) != len(team_ids)
        or set(team_ids) != expected_teams
    ):
        raise _reference_error(
            "invalid_final_standings",
            expected_ranks=expected_ranks,
            actual_ranks=actual_ranks,
        )
    return TournamentStandings(
        match_results=tuple(ordered_results),
        standings=ordered_standings,
    )


def _team_by_rank(
    pools: tuple[TournamentPoolPlan, TournamentPoolPlan],
) -> dict[tuple[str, int], str]:
    mapping: dict[tuple[str, int], str] = {}
    team_ids: set[str] = set()
    for pool in pools:
        if len(pool.seeds) != pool.participant_count:
            raise _reference_error("seed_count_mismatch", pool=pool.pool.value)
        for seed in pool.seeds:
            if seed.team_id is None:
                raise _reference_error("unresolved_seed", pool=pool.pool.value)
            key = (seed.block_id, seed.block_rank)
            if key in mapping or seed.team_id in team_ids:
                raise _reference_error(
                    "duplicate_seed",
                    block_id=seed.block_id,
                    rank=seed.block_rank,
                    team_id=seed.team_id,
                )
            mapping[key] = seed.team_id
            team_ids.add(seed.team_id)
    return mapping


def _validate_placements(pool: TournamentPoolPlan) -> None:
    ranks = sorted(placement.rank for placement in pool.placements)
    expected = list(range(1, pool.participant_count + 1))
    if ranks != expected:
        raise _reference_error(
            "invalid_pool_placements",
            pool=pool.pool.value,
            expected_ranks=expected,
            actual_ranks=ranks,
        )


def _canonical_result(result: TournamentMatchResultInput) -> TournamentMatchResult:
    regular_home = result.regular_score_home
    regular_away = result.regular_score_away
    penalty_home = result.penalty_score_home
    penalty_away = result.penalty_score_away
    if regular_home != regular_away:
        if penalty_home is not None or penalty_away is not None:
            raise TournamentResultsError(
                "TOURNAMENT_RESULT_INVALID",
                "通常得点が同点でない試合にPK得点は入力できません。",
                match_id=result.match_id,
                reason="penalty_for_non_draw",
            )
        home_wins = regular_home > regular_away
        decision: Literal["regular_time", "penalty_shootout"] = "regular_time"
    else:
        if penalty_home is None or penalty_away is None:
            raise TournamentResultsError(
                "TOURNAMENT_RESULT_INVALID",
                "通常得点が同点のため、両チームのPK得点を入力してください。",
                match_id=result.match_id,
                reason="penalty_required",
            )
        if penalty_home == penalty_away:
            raise TournamentResultsError(
                "TOURNAMENT_RESULT_INVALID",
                "PK戦は勝敗が決まるまで入力してください。",
                match_id=result.match_id,
                reason="penalty_still_tied",
            )
        home_wins = penalty_home > penalty_away
        decision = "penalty_shootout"
    return TournamentMatchResult(
        **result.model_dump(),
        winner="home" if home_wins else "away",
        winner_team_id=result.home_team_id if home_wins else result.away_team_id,
        loser_team_id=result.away_team_id if home_wins else result.home_team_id,
        decision=decision,
    )


def _reference_error(reason: str, **details: object) -> TournamentResultsError:
    return TournamentResultsError(
        "TOURNAMENT_RESULT_REFERENCE_INVALID",
        "トーナメント表の参照を解決できません。トーナメント表を作り直してください。",
        reason=reason,
        **details,
    )
