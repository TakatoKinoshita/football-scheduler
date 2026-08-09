import type { JsonObject } from "./types";

export type ParticipantResolution = "provisional" | "resolved";

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function objects(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.map(object).filter((item): item is JsonObject => item !== undefined)
    : [];
}

function rankKey(value: unknown): string | undefined {
  const entry = object(value);
  return entry?.type === "league_rank" &&
    typeof entry.block_id === "string" &&
    Number.isInteger(entry.rank)
    ? `${entry.block_id}:${String(entry.rank)}`
    : undefined;
}

function teamsByRank(standings: JsonObject): Map<string, string> {
  return new Map(
    objects(standings.standings)
      .filter(
        (row) =>
          typeof row.block_id === "string" &&
          Number.isInteger(row.rank) &&
          typeof row.team_id === "string",
      )
      .map((row) => [`${String(row.block_id)}:${String(row.rank)}`, String(row.team_id)]),
  );
}

function teamFor(entry: unknown, mapping: ReadonlyMap<string, string>): JsonObject {
  const key = rankKey(entry);
  const teamId = key === undefined ? undefined : mapping.get(key);
  if (teamId === undefined) throw new Error("順位枠に対応するチームがありません。");
  return { type: "concrete_team", team_id: teamId };
}

export function sameRankGroups(plan: JsonObject): JsonObject[] {
  return objects(plan.groups);
}

export function sameRankMatches(plan: JsonObject): JsonObject[] {
  return sameRankGroups(plan).flatMap((group) => objects(group.matches));
}

export function sameRankParticipantResolution(plan: JsonObject): ParticipantResolution {
  if (plan.participant_resolution === "resolved") return "resolved";
  return "provisional";
}

export function bindSameRankPlan(plan: JsonObject, standings: JsonObject): JsonObject {
  const bound = structuredClone(plan);
  const mapping = teamsByRank(standings);
  for (const group of sameRankGroups(bound)) {
    for (const participant of objects(group.participants)) {
      participant.team = teamFor(participant.entry, mapping);
    }
    for (const match of objects(group.matches)) {
      match.home_team = teamFor(match.home, mapping);
      match.away_team = teamFor(match.away, mapping);
    }
  }
  for (const standing of objects(bound.automatic_standings)) {
    standing.team = teamFor(standing.entry, mapping);
  }
  bound.participant_resolution = "resolved";
  return bound;
}

export function unbindSameRankPlan(plan: JsonObject): JsonObject {
  const unbound = structuredClone(plan);
  for (const group of sameRankGroups(unbound)) {
    for (const participant of objects(group.participants)) participant.team = null;
    for (const match of objects(group.matches)) {
      match.home_team = null;
      match.away_team = null;
    }
  }
  for (const standing of objects(unbound.automatic_standings)) standing.team = null;
  unbound.participant_resolution = "provisional";
  return unbound;
}

export function bindSameRankSchedule(
  schedule: JsonObject,
  standings: JsonObject,
): JsonObject {
  const bound = structuredClone(schedule);
  const mapping = teamsByRank(standings);
  for (const match of objects(bound.same_rank_matches)) {
    match.home_team = teamFor(match.home, mapping);
    match.away_team = teamFor(match.away, mapping);
  }
  for (const slot of objects(bound.slots)) {
    const assignment = object(slot.referee_assignment);
    if (assignment?.kind === "team") {
      assignment.team_id = teamFor(assignment.rank_ref, mapping).team_id;
    }
  }
  for (const route of objects(bound.team_schedules)) {
    route.team_id = teamFor(route.rank_ref, mapping).team_id;
  }
  const metrics = object(bound.metrics);
  for (const count of objects(metrics?.referee_counts)) {
    count.team_id = teamFor(count.rank_ref, mapping).team_id;
  }
  bound.participant_resolution = "resolved";
  return bound;
}

export function unbindSameRankSchedule(schedule: JsonObject): JsonObject {
  const unbound = structuredClone(schedule);
  for (const match of objects(unbound.same_rank_matches)) {
    match.home_team = null;
    match.away_team = null;
  }
  for (const slot of objects(unbound.slots)) {
    const assignment = object(slot.referee_assignment);
    if (assignment?.kind === "team") assignment.team_id = null;
  }
  for (const route of objects(unbound.team_schedules)) route.team_id = null;
  const metrics = object(unbound.metrics);
  for (const count of objects(metrics?.referee_counts)) count.team_id = null;
  unbound.participant_resolution = "provisional";
  return unbound;
}

export interface SameRankProgress {
  total: number;
  entered: number;
  complete: boolean;
}

export function sameRankProgress(
  plan: JsonObject,
  results: readonly JsonObject[],
): SameRankProgress {
  const matches = new Map(
    sameRankMatches(plan)
      .filter((match) => typeof match.id === "string")
      .map((match) => [String(match.id), match]),
  );
  const seen = new Set<string>();
  for (const result of results) {
    const matchId = typeof result.match_id === "string" ? result.match_id : "";
    const match = matches.get(matchId);
    const home = object(match?.home_team);
    const away = object(match?.away_team);
    if (match === undefined || seen.has(matchId)) {
      throw new Error("同順位リーグの試合結果に重複または不明な試合があります。");
    }
    if (
      result.home_team_id !== home?.team_id ||
      result.away_team_id !== away?.team_id ||
      !Number.isInteger(result.regular_score_home) ||
      Number(result.regular_score_home) < 0 ||
      !Number.isInteger(result.regular_score_away) ||
      Number(result.regular_score_away) < 0 ||
      result.penalty_score_home != null ||
      result.penalty_score_away != null
    ) {
      throw new Error("同順位リーグの対戦チームまたは得点が不正です。PKは入力できません。");
    }
    seen.add(matchId);
  }
  return { total: matches.size, entered: seen.size, complete: seen.size === matches.size };
}

export function sameRankEntryLabel(
  entry: unknown,
  team: unknown,
  teamNames: ReadonlyMap<string, string>,
): string {
  const concrete = object(team);
  if (typeof concrete?.team_id === "string") {
    return teamNames.get(concrete.team_id) ?? concrete.team_id;
  }
  const rank = object(entry);
  return rank?.type === "league_rank" &&
    typeof rank.block_id === "string" &&
    Number.isInteger(rank.rank)
    ? `${rank.block_id}ブロック ${String(rank.rank)}位`
    : "順位枠未確定";
}
