import {
  type PrintParticipant,
  type PrintPreviewFixture,
  type PrintPreviewGroup,
  type PrintPreviewMatch,
  type PrintPreviewSlot,
  type PrintReferee,
} from "./print-preview-fixtures";
import { buildPrintPreviewModel, type PrintPreviewModel } from "./print-preview-model";
import { placementTournamentPools, type JsonObject, type TournamentDocument } from "./types";

export type ProductionPrintScope = "day1" | "day2" | "bracket";

export class ProductionPrintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionPrintError";
  }
}

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function objects(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.map(object).filter((item): item is JsonObject => item !== undefined)
    : [];
}

function participant(value: unknown): PrintParticipant | undefined {
  const entry = object(value);
  if (entry?.type === "concrete_team" && typeof entry.team_id === "string") {
    return { type: "concrete_team", team_id: entry.team_id };
  }
  if (
    entry?.type === "league_rank"
    && typeof entry.block_id === "string"
    && Number.isInteger(entry.rank)
    && Number(entry.rank) > 0
  ) {
    return { type: "league_rank", block_id: entry.block_id, rank: Number(entry.rank) };
  }
  if (
    (entry?.type === "winner_of" || entry?.type === "loser_of")
    && typeof entry.match_id === "string"
  ) {
    return { type: entry.type, match_id: entry.match_id };
  }
  return undefined;
}

function rankKey(value: PrintParticipant): string | undefined {
  return value.type === "league_rank"
    ? `${value.block_id}:${String(value.rank)}`
    : undefined;
}

function rankedTeams(result: JsonObject): ReadonlyMap<string, string> {
  const standings = object(result.league_standings);
  return new Map(
    objects(standings?.standings)
      .filter(
        (row) =>
          typeof row.block_id === "string"
          && Number.isInteger(row.rank)
          && typeof row.team_id === "string",
      )
      .map((row) => [`${String(row.block_id)}:${String(row.rank)}`, String(row.team_id)]),
  );
}

function resolveParticipant(
  value: PrintParticipant,
  resolution: "provisional" | "resolved",
  teamsByRank: ReadonlyMap<string, string>,
): PrintParticipant {
  const key = rankKey(value);
  const teamId = key === undefined ? undefined : teamsByRank.get(key);
  return resolution === "resolved" && teamId !== undefined
    ? { type: "concrete_team", team_id: teamId }
    : value;
}

function matchParticipant(
  match: JsonObject,
  side: "home" | "away",
  resolution: "provisional" | "resolved",
  teamsByRank: ReadonlyMap<string, string>,
): PrintParticipant {
  const concrete = participant(match[`${side}_team`]);
  if (concrete !== undefined) return concrete;
  const directTeamId = match[`${side}_team_id`];
  if (typeof directTeamId === "string") {
    return { type: "concrete_team", team_id: directTeamId };
  }
  const possibleTeamIds = match[`possible_${side}_team_ids`];
  if (
    Array.isArray(possibleTeamIds)
    && possibleTeamIds.length === 1
    && typeof possibleTeamIds[0] === "string"
  ) {
    return { type: "concrete_team", team_id: possibleTeamIds[0] };
  }
  const entry = participant(match[side]);
  if (entry !== undefined) return resolveParticipant(entry, resolution, teamsByRank);
  throw new ProductionPrintError(`試合「${String(match.id ?? "不明") }」の${side === "home" ? "左側" : "右側"}チームを読み取れません。`);
}

function referee(
  assignmentValue: unknown,
  resolution: "provisional" | "resolved",
  teamsByRank: ReadonlyMap<string, string>,
): PrintReferee {
  const assignment = object(assignmentValue);
  const kind = assignment?.kind ?? assignment?.type;
  if (kind === "organizer") return { kind: "organizer" };
  if (kind === "previous_match_winner" && typeof assignment?.match_id === "string") {
    return { kind: "previous_match_winner", match_id: assignment.match_id };
  }
  if (kind === "team") {
    if (typeof assignment?.source_match_id === "string") {
      return { kind: "previous_match_winner", match_id: assignment.source_match_id };
    }
    if (typeof assignment?.team_id === "string") {
      return { kind: "team", team: { type: "concrete_team", team_id: assignment.team_id } };
    }
    const team = participant(assignment?.team) ?? participant(assignment?.rank_ref);
    if (team !== undefined) {
      return { kind: "team", team: resolveParticipant(team, resolution, teamsByRank) };
    }
  }
  throw new ProductionPrintError("審判割当てを読み取れません。");
}

function scheduledSlots(
  schedule: JsonObject,
  resolution: "provisional" | "resolved",
  teamsByRank: ReadonlyMap<string, string>,
): PrintPreviewSlot[] {
  return objects(schedule.slots)
    .filter(
      (slot) =>
        Number.isInteger(slot.section_no)
        && Number(slot.section_no) > 0
        && typeof slot.court_id === "string"
        && typeof slot.match_id === "string",
    )
    .map((slot) => ({
      section_no: Number(slot.section_no),
      court_id: String(slot.court_id),
      match_id: String(slot.match_id),
      referee_assignment: referee(slot.referee_assignment, resolution, teamsByRank),
    }));
}

function sectionTimings(schedule: JsonObject): NonNullable<PrintPreviewFixture["sectionTimings"]> {
  return objects(schedule.section_timings)
    .filter((timing) => Number.isInteger(timing.section_no) && Number(timing.section_no) > 0)
    .map((timing) => ({
      section_no: Number(timing.section_no),
      start_time: typeof timing.start_time === "string" ? timing.start_time : null,
      match_end: typeof timing.match_end_time === "string" ? timing.match_end_time : null,
    }));
}

function daySettings(
  input: JsonObject,
  day: "day" | "day2",
): PrintPreviewFixture["daySettings"] {
  const settings = object(input[day]);
  const fallbackMargin = day === "day" ? 5 : 10;
  return {
    start_time: typeof settings?.start_time === "string" ? settings.start_time : "09:30",
    game_duration_minutes: typeof settings?.game_duration_minutes === "number"
      ? settings.game_duration_minutes
      : 35,
    margin_minutes: typeof settings?.margin_minutes === "number"
      ? settings.margin_minutes
      : fallbackMargin,
    breaks: objects(settings?.breaks)
      .filter(
        (item) =>
          Number.isInteger(item.after_section)
          && Number(item.after_section) > 0
          && Number.isInteger(item.duration_minutes)
          && Number(item.duration_minutes) >= 0,
      )
      .map((item) => ({
        after_section: Number(item.after_section),
        duration_minutes: Number(item.duration_minutes),
      })),
  };
}

function namedEntries(value: unknown, label: string): Array<{ id: string; name: string }> {
  return objects(value).map((entry) => {
    if (typeof entry.id !== "string") {
      throw new ProductionPrintError(`${label}のIDを読み取れません。`);
    }
    return {
      id: entry.id,
      name: typeof entry.name === "string" ? entry.name : entry.id,
    };
  });
}

function matches(
  values: readonly JsonObject[],
  resolution: "provisional" | "resolved",
  teamsByRank: ReadonlyMap<string, string>,
): PrintPreviewMatch[] {
  return values.map((match) => {
    if (typeof match.id !== "string") {
      throw new ProductionPrintError("試合IDを読み取れません。");
    }
    return {
      id: match.id,
      home: matchParticipant(match, "home", resolution, teamsByRank),
      away: matchParticipant(match, "away", resolution, teamsByRank),
    };
  });
}

function day1Fixture(document: TournamentDocument, input: JsonObject, result: JsonObject): PrintPreviewFixture {
  const plan = object(result.league_plan);
  if (plan === undefined) throw new ProductionPrintError("1日目のリーグ計画がありません。");
  const groups: PrintPreviewGroup[] = objects(plan.blocks).map((block) => {
    if (typeof block.id !== "string") {
      throw new ProductionPrintError("1日目のブロックIDを読み取れません。");
    }
    const members = Array.isArray(block.team_ids)
      ? block.team_ids.map((teamId) => ({
          type: "concrete_team" as const,
          team_id: String(teamId),
        }))
      : [];
    return { id: block.id, name: `${block.id}ブロック`, members };
  });
  return {
    id: "saved-day1-league",
    description: "保存済み大会の1日目リーグ",
    scope: "day1-league",
    tournamentName: document.tournament.name || "名称未設定",
    savedAt: document.updatedAt,
    teams: namedEntries(input.teams, "チーム"),
    courts: namedEntries(input.courts, "コート"),
    daySettings: daySettings(input, "day"),
    sectionTimings: sectionTimings(result),
    groups,
    matches: matches(objects(plan.matches), "resolved", new Map()),
    slots: scheduledSlots(result, "resolved", new Map()),
    participantResolution: "resolved",
  };
}

function sameRankFixture(
  document: TournamentDocument,
  input: JsonObject,
  result: JsonObject,
  plan: JsonObject,
  schedule: JsonObject,
): PrintPreviewFixture {
  const resolution = plan.participant_resolution === "resolved" ? "resolved" : "provisional";
  const teamsByRank = rankedTeams(result);
  const groups: PrintPreviewGroup[] = objects(plan.groups).map((group, index) => ({
    id: typeof group.id === "string" ? group.id : `same-rank-${String(index + 1)}`,
    name: typeof group.display_name === "string"
      ? group.display_name
      : `${String(index + 1)}位グループ`,
    members: objects(group.participants).map((item) => {
      const concrete = participant(item.team);
      const entry = participant(item.entry);
      if (concrete !== undefined) return concrete;
      if (entry !== undefined) return resolveParticipant(entry, resolution, teamsByRank);
      throw new ProductionPrintError("同順位リーグの参加枠を読み取れません。");
    }),
  }));
  const sourceMatches = objects(schedule.same_rank_matches);
  return {
    id: "saved-day2-same-rank",
    description: "保存済み大会の2日目同順位リーグ",
    scope: "day2-same-rank",
    tournamentName: document.tournament.name || "名称未設定",
    savedAt: document.updatedAt,
    teams: namedEntries(input.teams, "チーム"),
    courts: namedEntries(input.courts, "コート"),
    daySettings: daySettings(input, "day2"),
    sectionTimings: sectionTimings(schedule),
    groups,
    matches: matches(
      sourceMatches.length > 0 ? sourceMatches : objects(plan.groups).flatMap((group) => objects(group.matches)),
      resolution,
      teamsByRank,
    ),
    slots: scheduledSlots(schedule, resolution, teamsByRank),
    participantResolution: resolution,
  };
}

function tournamentFixture(
  document: TournamentDocument,
  input: JsonObject,
  result: JsonObject,
  plan: JsonObject,
  schedule: JsonObject,
): PrintPreviewFixture {
  const resolution = plan.participant_resolution === "resolved" ? "resolved" : "provisional";
  const teamsByRank = rankedTeams(result);
  const scheduledMatches = objects(schedule.tournament_matches);
  const planMatches = placementTournamentPools(plan).flatMap((pool) => objects(pool.data.matches));
  return {
    id: "saved-day2-tournament",
    description: "保存済み大会の2日目順位決定トーナメント",
    scope: "day2-tournament",
    tournamentName: document.tournament.name || "名称未設定",
    savedAt: document.updatedAt,
    teams: namedEntries(input.teams, "チーム"),
    courts: namedEntries(input.courts, "コート"),
    daySettings: daySettings(input, "day2"),
    sectionTimings: sectionTimings(schedule),
    groups: [],
    matches: matches(scheduledMatches.length > 0 ? scheduledMatches : planMatches, resolution, teamsByRank),
    slots: scheduledSlots(schedule, resolution, teamsByRank),
    tournamentPlan: plan,
    tournamentResults: objects(result.tournament_results),
    ...(object(result.final_standings) === undefined
      ? {}
      : { finalStandings: object(result.final_standings) }),
    participantResolution: resolution,
  };
}

export function buildProductionPrintModel(
  document: TournamentDocument,
  scope: ProductionPrintScope,
): PrintPreviewModel {
  const input = object(document.tournament.input);
  const result = object(document.tournament.result);
  if (input === undefined || result === undefined) {
    throw new ProductionPrintError("印刷できる保存済み日程がありません。");
  }
  if (scope === "day1") return buildPrintPreviewModel(day1Fixture(document, input, result));
  const schedule = object(result.day2_schedule);
  if (schedule === undefined) throw new ProductionPrintError("印刷できる2日目日程がありません。");
  const sameRankPlan = object(result.same_rank_plan);
  if (sameRankPlan !== undefined) {
    if (scope === "bracket") {
      throw new ProductionPrintError("同順位リーグにはトーナメント表がありません。");
    }
    return buildPrintPreviewModel(sameRankFixture(document, input, result, sameRankPlan, schedule));
  }
  const tournamentPlan = object(result.tournament_plan);
  if (tournamentPlan === undefined) {
    throw new ProductionPrintError("印刷できる2日目の組合せがありません。");
  }
  return buildPrintPreviewModel(
    tournamentFixture(document, input, result, tournamentPlan, schedule),
  );
}
