import {
  placementTournamentPool,
  placementTournamentPools,
  type JsonObject,
} from "./types";

export type TournamentPoolName = string;
export type TournamentWinnerSide = "home" | "away";
export type TournamentDecision = "regular_time" | "penalty_shootout";

export interface TournamentResultInput {
  match_id: string;
  home_team_id: string;
  away_team_id: string;
  regular_score_home: number;
  regular_score_away: number;
  penalty_score_home?: number;
  penalty_score_away?: number;
}

export interface TournamentMatchProgress {
  matchId: string;
  pool: TournamentPoolName;
  match: JsonObject;
  homeTeamId?: string;
  awayTeamId?: string;
  result?: TournamentResultInput;
  winner?: TournamentWinnerSide;
  winnerTeamId?: string;
  loserTeamId?: string;
  decision?: TournamentDecision;
}

export interface TournamentProgress {
  orderedMatches: readonly TournamentMatchProgress[];
  matchesById: ReadonlyMap<string, TournamentMatchProgress>;
  complete: boolean;
}

export interface TournamentStandingPreview {
  rank: number;
  pool: TournamentPoolName;
  pool_rank: number;
  team_id: string;
  entry: JsonObject;
}

export class TournamentProgressError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: JsonObject = {},
  ) {
    super(message);
    this.name = "TournamentProgressError";
  }
}

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function objectArray(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.map(objectValue).filter((item): item is JsonObject => item !== undefined)
    : [];
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function parseTournamentResult(value: JsonObject): TournamentResultInput {
  const matchId = identifier(value.match_id);
  const homeTeamId = identifier(value.home_team_id);
  const awayTeamId = identifier(value.away_team_id);
  const regularHome = value.regular_score_home;
  const regularAway = value.regular_score_away;
  const penaltyHome = value.penalty_score_home;
  const penaltyAway = value.penalty_score_away;
  if (
    matchId === undefined ||
    homeTeamId === undefined ||
    awayTeamId === undefined ||
    !nonNegativeInteger(regularHome) ||
    !nonNegativeInteger(regularAway) ||
    (penaltyHome !== undefined && !nonNegativeInteger(penaltyHome)) ||
    (penaltyAway !== undefined && !nonNegativeInteger(penaltyAway))
  ) {
    throw new TournamentProgressError(
      "TOURNAMENT_RESULT_INVALID",
      "2日目の試合結果に0以上の整数を入力してください。",
      { match_id: matchId ?? null },
    );
  }
  if (regularHome !== regularAway && (penaltyHome !== undefined || penaltyAway !== undefined)) {
    throw new TournamentProgressError(
      "TOURNAMENT_RESULT_INVALID",
      "通常得点が同点でない試合にPK得点は入力できません。",
      { match_id: matchId, reason: "penalty_for_non_draw" },
    );
  }
  if (regularHome === regularAway) {
    if (penaltyHome === undefined || penaltyAway === undefined) {
      throw new TournamentProgressError(
        "TOURNAMENT_RESULT_INVALID",
        "通常得点が同点のため、両チームのPK得点を入力してください。",
        { match_id: matchId, reason: "penalty_required" },
      );
    }
    if (penaltyHome === penaltyAway) {
      throw new TournamentProgressError(
        "TOURNAMENT_RESULT_INVALID",
        "PK戦は勝敗が決まるまで入力してください。",
        { match_id: matchId, reason: "penalty_still_tied" },
      );
    }
  }
  return {
    match_id: matchId,
    home_team_id: homeTeamId,
    away_team_id: awayTeamId,
    regular_score_home: regularHome,
    regular_score_away: regularAway,
    ...(penaltyHome === undefined ? {} : { penalty_score_home: penaltyHome }),
    ...(penaltyAway === undefined ? {} : { penalty_score_away: penaltyAway }),
  };
}

function outcome(result: TournamentResultInput): {
  winner: TournamentWinnerSide;
  winnerTeamId: string;
  loserTeamId: string;
  decision: TournamentDecision;
} {
  const penalty = result.regular_score_home === result.regular_score_away;
  const homeWins = penalty
    ? result.penalty_score_home! > result.penalty_score_away!
    : result.regular_score_home > result.regular_score_away;
  return {
    winner: homeWins ? "home" : "away",
    winnerTeamId: homeWins ? result.home_team_id : result.away_team_id,
    loserTeamId: homeWins ? result.away_team_id : result.home_team_id,
    decision: penalty ? "penalty_shootout" : "regular_time",
  };
}

export function resolveTournamentProgress(
  plan: JsonObject,
  rawResults: readonly JsonObject[],
): TournamentProgress {
  if (
    plan.participant_resolution !== undefined &&
    plan.participant_resolution !== "resolved"
  ) {
    throw new TournamentProgressError(
      "TOURNAMENT_RESULTS_REQUIRE_RESOLVED_PLAN",
      "リーグ順位を確定してから2日目の試合結果を入力してください。",
    );
  }
  const matches = new Map<string, { match: JsonObject; pool: TournamentPoolName }>();
  const teamByRank = new Map<string, string>();
  for (const pool of placementTournamentPools(plan)) {
    const poolData = pool.data;
    for (const seed of objectArray(poolData.seeds)) {
      const blockId = identifier(seed.block_id);
      const rank = seed.block_rank;
      const teamId = identifier(seed.team_id);
      if (blockId === undefined || !Number.isInteger(rank) || Number(rank) < 1 || teamId === undefined) {
        throw new TournamentProgressError(
          "TOURNAMENT_RESULT_REFERENCE_INVALID",
          "確定トーナメントのシードを読み取れませんでした。",
          { pool_id: pool.poolId },
        );
      }
      const key = `${blockId}:${String(rank)}`;
      if (teamByRank.has(key) || [...teamByRank.values()].includes(teamId)) {
        throw new TournamentProgressError(
          "TOURNAMENT_RESULT_REFERENCE_INVALID",
          "確定トーナメントのシードが重複しています。",
          { pool_id: pool.poolId, block_id: blockId, rank, team_id: teamId },
        );
      }
      teamByRank.set(key, teamId);
    }
    for (const match of objectArray(poolData.matches)) {
      const matchId = identifier(match.id);
      if (matchId === undefined || matches.has(matchId)) {
        throw new TournamentProgressError(
          "TOURNAMENT_RESULT_REFERENCE_INVALID",
          "トーナメントの試合IDが重複または未設定です。",
          { match_id: matchId ?? null },
        );
      }
      matches.set(matchId, { match, pool: pool.poolId });
    }
  }

  const results = new Map<string, TournamentResultInput>();
  for (const raw of rawResults) {
    const parsed = parseTournamentResult(raw);
    if (results.has(parsed.match_id)) {
      throw new TournamentProgressError(
        "DUPLICATE_TOURNAMENT_RESULT",
        "同じトーナメント試合の結果が重複しています。",
        { match_id: parsed.match_id },
      );
    }
    if (!matches.has(parsed.match_id)) {
      throw new TournamentProgressError(
        "UNKNOWN_TOURNAMENT_MATCH",
        "日程にないトーナメント試合の結果が含まれています。",
        { match_id: parsed.match_id },
      );
    }
    results.set(parsed.match_id, parsed);
  }

  const resolved = new Map<string, TournamentMatchProgress>();
  const resolving = new Set<string>();
  const resolveMatch = (matchId: string): TournamentMatchProgress => {
    const existing = resolved.get(matchId);
    if (existing !== undefined) return existing;
    const source = matches.get(matchId);
    if (source === undefined) {
      throw new TournamentProgressError(
        "TOURNAMENT_RESULT_REFERENCE_INVALID",
        "参照先のトーナメント試合が見つかりません。",
        { match_id: matchId },
      );
    }
    if (resolving.has(matchId)) {
      throw new TournamentProgressError(
        "TOURNAMENT_DEPENDENCY_CYCLE",
        "トーナメントの試合参照が循環しています。",
        { match_id: matchId },
      );
    }
    resolving.add(matchId);
    try {
      const entryTeam = (rawEntry: unknown): string | undefined => {
        const entry = objectValue(rawEntry);
        if (entry === undefined) {
          throw new TournamentProgressError(
            "TOURNAMENT_RESULT_REFERENCE_INVALID",
            "トーナメントの参加枠を読み取れませんでした。",
            { match_id: matchId },
          );
        }
        const type = entry.type;
        if (type === "concrete_team") return identifier(entry.team_id);
        if (type === "league_rank") {
          const blockId = identifier(entry.block_id);
          const rank = entry.rank;
          if (blockId === undefined || !Number.isInteger(rank) || Number(rank) < 1) {
            throw new TournamentProgressError(
              "TOURNAMENT_RESULT_REFERENCE_INVALID",
              "リーグ順位枠を読み取れませんでした。",
              { match_id: matchId },
            );
          }
          const teamId = teamByRank.get(`${blockId}:${String(rank)}`);
          if (teamId === undefined) {
            throw new TournamentProgressError(
              "TOURNAMENT_RESULT_REFERENCE_INVALID",
              "リーグ順位枠に対応するチームが見つかりません。",
              { match_id: matchId, block_id: blockId, rank },
            );
          }
          return teamId;
        }
        if (type === "winner_of" || type === "loser_of") {
          const sourceId = identifier(entry.match_id);
          if (sourceId === undefined) {
            throw new TournamentProgressError(
              "TOURNAMENT_RESULT_REFERENCE_INVALID",
              "勝敗参照の試合IDを読み取れませんでした。",
              { match_id: matchId },
            );
          }
          const sourceMatch = resolveMatch(sourceId);
          return type === "winner_of" ? sourceMatch.winnerTeamId : sourceMatch.loserTeamId;
        }
        throw new TournamentProgressError(
          "TOURNAMENT_RESULT_REFERENCE_INVALID",
          "未対応のトーナメント参照が含まれています。",
          { match_id: matchId },
        );
      };
      const homeTeamId = entryTeam(source.match.home);
      const awayTeamId = entryTeam(source.match.away);
      const rawResult = results.get(matchId);
      const progress: TournamentMatchProgress = {
        matchId,
        pool: source.pool,
        match: source.match,
        ...(homeTeamId === undefined ? {} : { homeTeamId }),
        ...(awayTeamId === undefined ? {} : { awayTeamId }),
      };
      if (rawResult !== undefined) {
        if (
          homeTeamId === undefined ||
          awayTeamId === undefined ||
          rawResult.home_team_id !== homeTeamId ||
          rawResult.away_team_id !== awayTeamId
        ) {
          throw new TournamentProgressError(
            "TOURNAMENT_RESULT_PARTICIPANT_MISMATCH",
            "対戦チームが現在のトーナメント進行と一致しません。",
            { match_id: matchId },
          );
        }
        const resultOutcome = outcome(rawResult);
        Object.assign(progress, {
          result: rawResult,
          winner: resultOutcome.winner,
          winnerTeamId: resultOutcome.winnerTeamId,
          loserTeamId: resultOutcome.loserTeamId,
          decision: resultOutcome.decision,
        });
      }
      resolved.set(matchId, progress);
      return progress;
    } finally {
      resolving.delete(matchId);
    }
  };

  const orderedMatches = [...matches.keys()].map(resolveMatch);
  return {
    orderedMatches,
    matchesById: resolved,
    complete: orderedMatches.every((match) => match.result !== undefined),
  };
}

function matchDependencies(match: JsonObject): string[] {
  const dependencies: string[] = [];
  for (const side of ["home", "away"] as const) {
    const entry = objectValue(match[side]);
    if (entry?.type === "winner_of" || entry?.type === "loser_of") {
      const matchId = identifier(entry.match_id);
      if (matchId !== undefined) dependencies.push(matchId);
    }
  }
  return dependencies;
}

export function tournamentMatchDescendants(plan: JsonObject, sourceMatchId: string): Set<string> {
  const dependentMatches = new Map<string, Set<string>>();
  for (const pool of placementTournamentPools(plan)) {
    for (const match of objectArray(pool.data.matches)) {
      const matchId = identifier(match.id);
      if (matchId === undefined) continue;
      for (const dependency of matchDependencies(match)) {
        const dependents = dependentMatches.get(dependency) ?? new Set<string>();
        dependents.add(matchId);
        dependentMatches.set(dependency, dependents);
      }
    }
  }
  const descendants = new Set<string>();
  const pending = [...(dependentMatches.get(sourceMatchId) ?? [])];
  while (pending.length > 0) {
    const matchId = pending.pop()!;
    if (descendants.has(matchId)) continue;
    descendants.add(matchId);
    pending.push(...(dependentMatches.get(matchId) ?? []));
  }
  return descendants;
}

export function applyTournamentResultChange(
  plan: JsonObject,
  currentResults: readonly JsonObject[],
  matchId: string,
  nextResult?: JsonObject,
): { results: JsonObject[]; removedDescendantCount: number; winnerChanged: boolean } {
  const currentProgress = resolveTournamentProgress(plan, currentResults);
  const previousWinner = currentProgress.matchesById.get(matchId)?.winnerTeamId;
  const parsedNext = nextResult === undefined ? undefined : parseTournamentResult(nextResult);
  if (parsedNext !== undefined && parsedNext.match_id !== matchId) {
    throw new TournamentProgressError(
      "TOURNAMENT_RESULT_INVALID",
      "変更対象と試合結果の試合IDが一致しません。",
      { match_id: matchId },
    );
  }
  const nextWinner = parsedNext === undefined ? undefined : outcome(parsedNext).winnerTeamId;
  const nextById = new Map(
    currentResults.map((result) => [String(result.match_id), { ...result }] as const),
  );
  if (parsedNext === undefined) nextById.delete(matchId);
  else nextById.set(matchId, { ...parsedNext });

  const winnerChanged = previousWinner !== nextWinner;
  let removedDescendantCount = 0;
  if (winnerChanged) {
    for (const descendant of tournamentMatchDescendants(plan, matchId)) {
      if (nextById.delete(descendant)) removedDescendantCount += 1;
    }
  }
  const order = new Map(
    currentProgress.orderedMatches.map((match, index) => [match.matchId, index]),
  );
  return {
    results: [...nextById.values()].sort(
      (left, right) =>
        (order.get(String(left.match_id)) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(String(right.match_id)) ?? Number.MAX_SAFE_INTEGER),
    ),
    removedDescendantCount,
    winnerChanged,
  };
}

export function overallTournamentRank(
  plan: JsonObject,
  pool: TournamentPoolName,
  poolRank: number,
): number {
  const poolInfo = placementTournamentPool(plan, pool);
  const rawRange = poolInfo?.data.overall_rank_range;
  if (Array.isArray(rawRange) && Number.isInteger(rawRange[0]) && Number(rawRange[0]) > 0) {
    return Number(rawRange[0]) + poolRank - 1;
  }
  if (poolInfo?.legacyField === "upper") return poolRank;
  const upperCount = Number(placementTournamentPool(plan, "upper")?.data.participant_count);
  if (poolInfo?.legacyField !== "lower" || !Number.isInteger(upperCount) || upperCount < 0) {
    throw new TournamentProgressError(
      "TOURNAMENT_RESULT_REFERENCE_INVALID",
      "順位帯の大会全体順位範囲を読み取れませんでした。",
    );
  }
  return upperCount + poolRank;
}

export function overallTournamentRankRange(
  plan: JsonObject,
  pool: TournamentPoolName,
  rawRange: unknown,
): readonly [number, number] | undefined {
  if (
    !Array.isArray(rawRange) ||
    rawRange.length !== 2 ||
    !rawRange.every((rank) => Number.isInteger(rank) && Number(rank) > 0)
  ) {
    return undefined;
  }
  return [
    overallTournamentRank(plan, pool, Number(rawRange[0])),
    overallTournamentRank(plan, pool, Number(rawRange[1])),
  ];
}

export function previewTournamentStandings(
  plan: JsonObject,
  progress: TournamentProgress,
): TournamentStandingPreview[] {
  if (!progress.complete) {
    throw new TournamentProgressError(
      "TOURNAMENT_RESULTS_INCOMPLETE",
      "すべての2日目試合の結果を入力してください。",
    );
  }
  const teamByRank = new Map<string, string>();
  for (const pool of placementTournamentPools(plan)) {
    for (const seed of objectArray(pool.data.seeds)) {
      const blockId = identifier(seed.block_id);
      const rank = seed.block_rank;
      const teamId = identifier(seed.team_id);
      if (blockId !== undefined && Number.isInteger(rank) && teamId !== undefined) {
        teamByRank.set(`${blockId}:${String(rank)}`, teamId);
      }
    }
  }
  const entryTeam = (rawEntry: unknown): string => {
    const entry = objectValue(rawEntry);
    if (entry?.type === "concrete_team") {
      const teamId = identifier(entry.team_id);
      if (teamId !== undefined) return teamId;
    }
    if (entry?.type === "league_rank") {
      const teamId = teamByRank.get(`${String(entry.block_id)}:${String(entry.rank)}`);
      if (teamId !== undefined) return teamId;
    }
    if (entry?.type === "winner_of" || entry?.type === "loser_of") {
      const match = progress.matchesById.get(String(entry.match_id));
      const teamId = entry.type === "winner_of" ? match?.winnerTeamId : match?.loserTeamId;
      if (teamId !== undefined) return teamId;
    }
    throw new TournamentProgressError(
      "TOURNAMENT_RESULT_REFERENCE_INVALID",
      "最終順位の参照を解決できませんでした。",
    );
  };

  const standings: TournamentStandingPreview[] = [];
  for (const pool of placementTournamentPools(plan)) {
    for (const placement of objectArray(pool.data.placements)) {
      const poolRank = Number(placement.pool_rank ?? placement.rank);
      const entry = objectValue(placement.entry);
      if (!Number.isInteger(poolRank) || poolRank < 1 || entry === undefined) {
        throw new TournamentProgressError(
          "TOURNAMENT_RESULT_REFERENCE_INVALID",
          "最終順位の定義を読み取れませんでした。",
          { pool_id: pool.poolId },
        );
      }
      standings.push({
        rank: pool.legacyField === undefined
          ? Number(placement.rank)
          : overallTournamentRank(plan, pool.poolId, poolRank),
        pool: pool.poolId,
        pool_rank: poolRank,
        team_id: entryTeam(entry),
        entry,
      });
    }
  }
  return standings.sort((left, right) => left.rank - right.rank);
}

export function tournamentResultToJson(result: TournamentResultInput): JsonObject {
  return { ...result };
}
