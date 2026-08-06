import type { JsonObject } from "./types";

export type ParticipantResolution = "provisional" | "resolved";

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

function pools(plan: JsonObject): JsonObject[] {
  return [asObject(plan.upper), asObject(plan.lower)].filter(
    (pool): pool is JsonObject => pool !== undefined,
  );
}

function seeds(plan: JsonObject): JsonObject[] {
  return pools(plan).flatMap((pool) => asObjects(pool.seeds));
}

function rankKey(entry: JsonObject): string | undefined {
  return entry.type === "league_rank" &&
    typeof entry.block_id === "string" &&
    Number.isInteger(entry.rank)
    ? `${entry.block_id}:${String(entry.rank)}`
    : undefined;
}

export function tournamentParticipantResolution(plan: JsonObject): ParticipantResolution {
  if (plan.participant_resolution === "provisional") return "provisional";
  if (plan.participant_resolution === "resolved") return "resolved";
  const tournamentSeeds = seeds(plan);
  return tournamentSeeds.length > 0 &&
    tournamentSeeds.every(
      (seed) => typeof seed.team_id === "string" && asObject(seed.team)?.type === "concrete_team",
    )
    ? "resolved"
    : "provisional";
}

function standingTeams(standings: JsonObject): Map<string, string> {
  return new Map(
    asObjects(standings.standings)
      .filter(
        (row) =>
          typeof row.block_id === "string" &&
          Number.isInteger(row.rank) &&
          typeof row.team_id === "string",
      )
      .map((row) => [
        `${String(row.block_id)}:${String(row.rank)}`,
        String(row.team_id),
      ]),
  );
}

function resolvedTeamIds(refs: unknown, teamsByRank: Map<string, string>): string[] {
  return asObjects(refs).map((ref) => {
    const key = rankKey(ref);
    const teamId = key === undefined ? undefined : teamsByRank.get(key);
    if (teamId === undefined) throw new Error("順位枠に対応するチームがありません");
    return teamId;
  });
}

export function bindTournamentParticipants(plan: JsonObject, standings: JsonObject): JsonObject {
  const bound = structuredClone(plan);
  const teamsByRank = standingTeams(standings);
  for (const seed of seeds(bound)) {
    const entry = asObject(seed.entry);
    const key = entry === undefined ? undefined : rankKey(entry);
    const teamId = key === undefined ? undefined : teamsByRank.get(key);
    if (teamId === undefined) throw new Error("順位枠に対応するチームがありません");
    seed.team_id = teamId;
    seed.team = { type: "concrete_team", team_id: teamId };
  }
  for (const draw of asObjects(bound.seed_draws)) {
    if (asObjects(draw.candidate_rank_refs).length > 0) {
      draw.candidates = resolvedTeamIds(draw.candidate_rank_refs, teamsByRank).sort();
      draw.decided_order = resolvedTeamIds(draw.decided_rank_refs, teamsByRank);
    }
  }
  bound.participant_resolution = "resolved";
  return bound;
}

function rankRefsByTeam(plan: JsonObject): Map<string, JsonObject> {
  const entries = new Map<string, JsonObject>();
  for (const seed of seeds(plan)) {
    const entry = asObject(seed.entry);
    if (typeof seed.team_id === "string" && entry !== undefined && rankKey(entry) !== undefined) {
      entries.set(seed.team_id, structuredClone(entry));
    }
  }
  return entries;
}

function rankRefs(teamIds: unknown, entriesByTeam: Map<string, JsonObject>): JsonObject[] {
  if (!Array.isArray(teamIds)) return [];
  return teamIds.map((teamId) => {
    const entry = typeof teamId === "string" ? entriesByTeam.get(teamId) : undefined;
    if (entry === undefined) throw new Error("抽選記録に対応する順位枠がありません");
    return structuredClone(entry);
  });
}

export function unbindTournamentParticipants(plan: JsonObject): JsonObject {
  const unbound = structuredClone(plan);
  const entriesByTeam = rankRefsByTeam(unbound);
  for (const draw of asObjects(unbound.seed_draws)) {
    if (asObjects(draw.candidate_rank_refs).length === 0) {
      draw.candidate_rank_refs = rankRefs(draw.candidates, entriesByTeam).sort((left, right) =>
        `${String(left.block_id)}:${String(left.rank)}`.localeCompare(
          `${String(right.block_id)}:${String(right.rank)}`,
        ),
      );
      draw.decided_rank_refs = rankRefs(draw.decided_order, entriesByTeam);
    }
    draw.candidates = [];
    draw.decided_order = [];
  }
  for (const seed of seeds(unbound)) {
    seed.team_id = null;
    seed.team = null;
  }
  unbound.participant_resolution = "provisional";
  return unbound;
}
