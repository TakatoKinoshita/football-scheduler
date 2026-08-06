import type { JsonObject } from "./types";

export type Day2ParticipantResolution = "provisional" | "resolved";

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function asObjects(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.map(asObject).filter((entry): entry is JsonObject => entry !== undefined)
    : [];
}

function rankKey(entry: JsonObject | undefined): string | undefined {
  return entry?.type === "league_rank" &&
    typeof entry.block_id === "string" &&
    Number.isInteger(entry.rank)
    ? `${entry.block_id}:${String(entry.rank)}`
    : undefined;
}

function standingsMaps(standings: JsonObject): {
  teamsByRank: Map<string, string>;
  ranksByTeam: Map<string, JsonObject>;
} {
  const teamsByRank = new Map<string, string>();
  const ranksByTeam = new Map<string, JsonObject>();
  for (const row of asObjects(standings.standings)) {
    if (
      typeof row.block_id !== "string" ||
      !Number.isInteger(row.rank) ||
      typeof row.team_id !== "string"
    ) {
      continue;
    }
    const ref: JsonObject = {
      type: "league_rank",
      block_id: row.block_id,
      rank: row.rank,
    };
    teamsByRank.set(`${row.block_id}:${String(row.rank)}`, row.team_id);
    ranksByTeam.set(row.team_id, ref);
  }
  return { teamsByRank, ranksByTeam };
}

function teamIdsForRankRefs(refs: JsonObject[], teamsByRank: Map<string, string>): string[] {
  return refs.map((ref) => {
    const key = rankKey(ref);
    const teamId = key === undefined ? undefined : teamsByRank.get(key);
    if (teamId === undefined) throw new Error("順位枠に対応するチームがありません");
    return teamId;
  });
}

function rankRefsForTeamIds(teamIds: unknown, ranksByTeam: Map<string, JsonObject>): JsonObject[] {
  if (!Array.isArray(teamIds)) return [];
  return teamIds.map((teamId) => {
    const ref = typeof teamId === "string" ? ranksByTeam.get(teamId) : undefined;
    if (ref === undefined) throw new Error("チームに対応する順位枠がありません");
    return structuredClone(ref);
  });
}

export function day2ParticipantResolution(schedule: JsonObject): Day2ParticipantResolution {
  if (schedule.participant_resolution === "provisional") return "provisional";
  if (schedule.participant_resolution === "resolved") return "resolved";
  // 0.1.0の従来文書は解決状態を持たず、具体チームを正本としていた。
  return "resolved";
}

export function bindDay2ScheduleParticipants(
  schedule: JsonObject,
  standings: JsonObject,
): JsonObject {
  const bound = structuredClone(schedule);
  const { teamsByRank, ranksByTeam } = standingsMaps(standings);
  for (const match of asObjects(bound.tournament_matches)) {
    let refs = asObjects(match.possible_rank_refs);
    if (refs.length === 0) {
      refs = rankRefsForTeamIds(match.possible_team_ids, ranksByTeam);
      match.possible_rank_refs = refs;
    }
    match.possible_team_ids = teamIdsForRankRefs(refs, teamsByRank);
  }
  for (const route of asObjects(bound.team_schedules)) {
    let ref = asObject(route.rank_ref);
    if (ref === undefined && typeof route.team_id === "string") {
      ref = ranksByTeam.get(route.team_id);
      if (ref !== undefined) route.rank_ref = structuredClone(ref);
    }
    const key = rankKey(ref);
    const teamId = key === undefined ? undefined : teamsByRank.get(key);
    if (teamId === undefined) throw new Error("順位枠に対応するチームがありません");
    route.team_id = teamId;
  }
  bound.participant_resolution = "resolved";
  return bound;
}

export function unbindDay2ScheduleParticipants(
  schedule: JsonObject,
  standings?: JsonObject,
): JsonObject {
  const unbound = structuredClone(schedule);
  const ranksByTeam = standings === undefined
    ? new Map<string, JsonObject>()
    : standingsMaps(standings).ranksByTeam;
  for (const match of asObjects(unbound.tournament_matches)) {
    if (asObjects(match.possible_rank_refs).length === 0) {
      match.possible_rank_refs = rankRefsForTeamIds(match.possible_team_ids, ranksByTeam);
    }
    match.possible_team_ids = [];
  }
  for (const route of asObjects(unbound.team_schedules)) {
    if (asObject(route.rank_ref) === undefined) {
      const ref = typeof route.team_id === "string" ? ranksByTeam.get(route.team_id) : undefined;
      if (ref === undefined) throw new Error("チームに対応する順位枠がありません");
      route.rank_ref = structuredClone(ref);
    }
    route.team_id = null;
  }
  unbound.participant_resolution = "provisional";
  return unbound;
}
