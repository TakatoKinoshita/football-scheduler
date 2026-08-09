import {
  DOCUMENT_TYPE,
  LEGACY_SCHEMA_VERSION,
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  type JsonObject,
  type TournamentDocument,
} from "./types";
import { isDay1LeagueInput, normalizeDocument } from "./day1-form";
import {
  analyzeManualBlocks,
  manualBlocksFromUnknown,
  type ManualBlockInput,
} from "./manual-blocks";
import {
  previewTournamentStandings,
  resolveTournamentProgress,
  TournamentProgressError,
} from "./tournament-results";
import {
  analyzeDay2FinalPlacement,
  Day2FinalPlacementError,
} from "./day2-finals";
import {
  readTournamentLogicalLayout,
  TournamentLogicalLayoutError,
} from "./tournament-logical-layout";

export const MAX_JSON_BYTES = 1_000_000;
export const LIMITS = {
  teams: 32,
  courts: 16,
  matches: 512,
  sections: 128,
} as const;

function isSupportedSchemaVersion(value: unknown): boolean {
  return (SUPPORTED_SCHEMA_VERSIONS as readonly unknown[]).includes(value);
}

function validateNestedSchemaVersions(value: unknown, expected: string, path = "tournament"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateNestedSchemaVersions(item, expected, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const object = value as JsonObject;
  if (object.schema_version !== undefined && object.schema_version !== expected) {
    throw new ImportValidationError(
      "SCHEMA_VERSION_UNSUPPORTED",
      `保存ファイル内（${path}）に異なる版のデータが混在しています。書き出したファイルを選び直してください。`,
    );
  }
  for (const [key, item] of Object.entries(object)) {
    validateNestedSchemaVersions(item, expected, `${path}.${key}`);
  }
}

export class ImportValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ImportValidationError";
  }
}

function objectValue(value: unknown, message: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ImportValidationError("INVALID_DOCUMENT", message);
  }
  return value as JsonObject;
}

function arrayValue(value: unknown, fieldName: string, maximum: number): JsonObject[] {
  if (!Array.isArray(value)) {
    throw new ImportValidationError(
      "INVALID_DOCUMENT",
      `${fieldName}の一覧を読み取れませんでした。書き出したファイルを選び直してください。`,
    );
  }
  if (value.length > maximum) {
    throw new ImportValidationError(
      "LIMIT_EXCEEDED",
      `${fieldName}は${maximum}件までです。現在は${value.length}件あります。`,
    );
  }
  return value.map((entry) => objectValue(entry, `${fieldName}に不正な項目があります。`));
}

function uniqueIds(items: JsonObject[], label: string): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (typeof item.id !== "string" || item.id.length === 0) {
      throw new ImportValidationError("INVALID_REFERENCE", `${label}IDが空の項目があります。`);
    }
    if (ids.has(item.id)) {
      throw new ImportValidationError(
        "DUPLICATE_ID",
        `${label}ID「${item.id}」が重複しています。`,
      );
    }
    ids.add(item.id);
  }
  return ids;
}

function validateReferences(input: JsonObject, teams: JsonObject[], matches: JsonObject[]): void {
  const teamIds = uniqueIds(teams, "チーム");
  const matchIds = uniqueIds(matches, "試合");
  for (const match of matches) {
    const referencedTeams = [
      ...(Array.isArray(match.possible_home_team_ids) ? match.possible_home_team_ids : []),
      ...(Array.isArray(match.possible_away_team_ids) ? match.possible_away_team_ids : []),
      ...(typeof match.home_team_id === "string" ? [match.home_team_id] : []),
      ...(typeof match.away_team_id === "string" ? [match.away_team_id] : []),
    ];
    for (const teamId of referencedTeams) {
      if (typeof teamId !== "string" || !teamIds.has(teamId)) {
        throw new ImportValidationError(
          "INVALID_REFERENCE",
          `試合「${String(match.id)}」が登録されていないチームを参照しています。`,
        );
      }
    }
    const prerequisites = Array.isArray(match.prerequisite_match_ids)
      ? match.prerequisite_match_ids
      : [];
    for (const matchId of prerequisites) {
      if (typeof matchId !== "string" || !matchIds.has(matchId)) {
        throw new ImportValidationError(
          "INVALID_REFERENCE",
          `試合「${String(match.id)}」が登録されていない前提試合を参照しています。`,
        );
      }
    }
  }

  const day = input.day;
  if (typeof day === "object" && day !== null && !Array.isArray(day)) {
    const maxSections = (day as JsonObject).max_sections;
    if (typeof maxSections === "number" && maxSections > LIMITS.sections) {
      throw new ImportValidationError(
        "LIMIT_EXCEEDED",
        `セクション数は${LIMITS.sections}までです。現在は${maxSections}です。`,
      );
    }
  }
  const topLevelMaxSections = input.max_sections;
  if (typeof topLevelMaxSections === "number" && topLevelMaxSections > LIMITS.sections) {
    throw new ImportValidationError(
      "LIMIT_EXCEEDED",
      `セクション数は${LIMITS.sections}までです。現在は${topLevelMaxSections}です。`,
    );
  }
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ImportValidationError(
      "INVALID_DOCUMENT",
      `${label}を読み取れませんでした。日程を再生成してください。`,
    );
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ImportValidationError(
      "INVALID_DOCUMENT",
      `${label}は0以上の整数である必要があります。`,
    );
  }
  return value;
}

function validateDay2Settings(input: JsonObject): JsonObject | undefined {
  if (input.day2 === undefined) return undefined;
  const day = objectValue(input.day2, "2日目設定を読み取れませんでした。");
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
  if (
    day.id !== "day2" ||
    typeof day.start_time !== "string" ||
    !timePattern.test(day.start_time) ||
    typeof day.game_duration_minutes !== "number" ||
    !Number.isInteger(day.game_duration_minutes) ||
    day.game_duration_minutes < 1 ||
    typeof day.margin_minutes !== "number" ||
    !Number.isInteger(day.margin_minutes) ||
    day.margin_minutes < 0 ||
    (day.end_time !== undefined &&
      day.end_time !== null &&
      (typeof day.end_time !== "string" || !timePattern.test(day.end_time))) ||
    (day.max_sections !== undefined &&
      day.max_sections !== null &&
      (!Number.isInteger(day.max_sections) ||
        Number(day.max_sections) < 1 ||
        Number(day.max_sections) > LIMITS.sections))
  ) {
    throw new ImportValidationError("INVALID_DOCUMENT", "2日目の時刻設定が不正です。");
  }
  const breaks = arrayValue(day.breaks ?? [], "2日目の休憩", LIMITS.sections);
  const sections = new Set<number>();
  for (const item of breaks) {
    const afterSection = nonNegativeInteger(item.after_section, "休憩前のセクション");
    const duration = nonNegativeInteger(item.duration_minutes, "休憩時間");
    if (
      afterSection < 1 ||
      afterSection > LIMITS.sections ||
      duration < 1 ||
      sections.has(afterSection)
    ) {
      throw new ImportValidationError("INVALID_DOCUMENT", "2日目の休憩設定が不正です。");
    }
    sections.add(afterSection);
  }
  return day;
}

function validateDay1ScheduleSettings(input: JsonObject): JsonObject {
  const day = objectValue(input.day, "1日目の時刻設定を読み取れませんでした。");
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
  if (
    day.id !== "day1" ||
    typeof day.start_time !== "string" ||
    !timePattern.test(day.start_time) ||
    typeof day.game_duration_minutes !== "number" ||
    !Number.isInteger(day.game_duration_minutes) ||
    day.game_duration_minutes < 1 ||
    typeof day.margin_minutes !== "number" ||
    !Number.isInteger(day.margin_minutes) ||
    day.margin_minutes < 0 ||
    (day.end_time !== undefined &&
      day.end_time !== null &&
      (typeof day.end_time !== "string" || !timePattern.test(day.end_time))) ||
    (day.max_sections !== undefined &&
      day.max_sections !== null &&
      (!Number.isInteger(day.max_sections) ||
        Number(day.max_sections) < 1 ||
        Number(day.max_sections) > LIMITS.sections))
  ) {
    throw new ImportValidationError("INVALID_DOCUMENT", "1日目の時刻設定が不正です。");
  }
  const breaks = arrayValue(day.breaks ?? [], "1日目の休憩", LIMITS.sections);
  const sections = new Set<number>();
  for (const item of breaks) {
    const afterSection = nonNegativeInteger(item.after_section, "1日目の休憩前セクション");
    const duration = nonNegativeInteger(item.duration_minutes, "1日目の休憩時間");
    if (
      afterSection < 1 ||
      afterSection > LIMITS.sections ||
      duration < 1 ||
      sections.has(afterSection)
    ) {
      throw new ImportValidationError("INVALID_DOCUMENT", "1日目の休憩設定が不正です。");
    }
    sections.add(afterSection);
  }
  return day;
}

function validateManualLeagueSettings(
  input: JsonObject,
  teams: JsonObject[],
  requireComplete: boolean,
): ManualBlockInput[] | undefined {
  if (!isDay1LeagueInput(input)) return undefined;
  const league = objectValue(input.league, "リーグ設定を読み取れませんでした。");
  const hasManualDraft = league.manual_blocks !== undefined;
  if (league.assignment_mode !== "manual" && !hasManualDraft) return undefined;
  if (
    typeof league.block_count !== "number" ||
    !Number.isInteger(league.block_count) ||
    league.block_count < 1 ||
    league.block_count > teams.length
  ) {
    throw new ImportValidationError(
      "INVALID_DOCUMENT",
      "手動割当てのブロック数が参加チーム数と一致しません。",
    );
  }
  const rawBlocks = arrayValue(
    league.manual_blocks,
    "手動ブロック割当て",
    LIMITS.teams,
  );
  for (const block of rawBlocks) {
    if (typeof block.id !== "string" || block.id.length === 0) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "手動割当てにIDがないブロックがあります。",
      );
    }
    stringArray(block.team_ids, `${block.id}ブロックの手動割当て`);
  }
  const blocks = manualBlocksFromUnknown(rawBlocks);
  const teamIds = teams.flatMap((team) => typeof team.id === "string" ? [team.id] : []);
  const analysis = analyzeManualBlocks(blocks, teamIds, league.block_count);
  if (analysis.duplicateBlockIds.length > 0) {
    throw new ImportValidationError(
      "DUPLICATE_ID",
      `手動割当てのブロックID「${analysis.duplicateBlockIds[0]}」が重複しています。`,
    );
  }
  if (analysis.missingBlockIds.length > 0 || analysis.unknownBlockIds.length > 0) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "手動割当てに存在しないブロック、または不足しているブロックがあります。",
    );
  }
  if (analysis.unknownTeamIds.length > 0) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      `手動割当てが登録されていないチーム「${analysis.unknownTeamIds[0]}」を参照しています。`,
    );
  }
  if (analysis.duplicateTeamIds.length > 0) {
    throw new ImportValidationError(
      "DUPLICATE_ID",
      `チーム「${analysis.duplicateTeamIds[0]}」が複数の手動ブロックに登録されています。`,
    );
  }
  if (
    requireComplete &&
    !analysis.completionPossible
  ) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "生成済み日程の手動割当てを有効な人数構成へ自動補完できません。",
    );
  }
  return blocks;
}

function clockMinutes(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{2}):(\d{2})(?::[0-5]\d)?$/.exec(value);
  if (match === null) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : undefined;
}

function validateDay1ScheduleResult(
  result: JsonObject,
  input: JsonObject,
  teams: JsonObject[],
  courts: JsonObject[],
  matches: JsonObject[],
): void {
  const courtIds = new Set(courts.map((court) => String(court.id)));
  const teamIds = new Set(teams.map((team) => String(team.id)));
  const matchIds = new Set(matches.map((match) => String(match.id)));
  if (result.slots === undefined) {
    if (
      result.section_timings !== undefined ||
      result.status === "OPTIMAL" ||
      result.status === "FEASIBLE"
    ) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "1日目日程の試合配置を読み取れませんでした。日程を再生成してください。",
      );
    }
    return;
  }
  const currentDay1Format = isDay1LeagueInput(input);
  let day = currentDay1Format
    ? validateDay1ScheduleSettings(input)
    : objectValue(input.day, "1日目の時刻設定を読み取れませんでした。");
  const slots = arrayValue(
    result.slots,
    "1日目スロット",
    LIMITS.sections * LIMITS.courts,
  );
  const positions = new Set<string>();
  const assignedMatches = new Set<string>();
  const slotSections = new Set<number>();
  const maximum = day.max_sections;

  for (const slot of slots) {
    const section = nonNegativeInteger(slot.section_no, "1日目セクション番号");
    const courtId = slot.court_id;
    const position = `${section}:${String(courtId)}`;
    if (
      slot.day_id !== "day1" ||
      section < 1 ||
      section > LIMITS.sections ||
      (typeof maximum === "number" && section > maximum) ||
      typeof courtId !== "string" ||
      !courtIds.has(courtId) ||
      positions.has(position)
    ) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "1日目スロットの日時またはコート位置が不正です。",
      );
    }
    positions.add(position);
    slotSections.add(section);

    if (slot.match_id === null) {
      if (slot.referee_assignment !== null) {
        throw new ImportValidationError(
          "INVALID_REFERENCE",
          "1日目の空きスロットに審判が設定されています。",
        );
      }
      continue;
    }
    if (
      typeof slot.match_id !== "string" ||
      !matchIds.has(slot.match_id) ||
      assignedMatches.has(slot.match_id)
    ) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "1日目の試合配置に未知または重複した試合があります。",
      );
    }
    assignedMatches.add(slot.match_id);
    const referee = objectValue(
      slot.referee_assignment,
      "1日目の審判割当てを読み取れませんでした。",
    );
    const kind = referee.kind ?? referee.type;
    if (
      (kind === "organizer" &&
        (referee.team_id !== undefined && referee.team_id !== null ||
          referee.source_match_id !== undefined && referee.source_match_id !== null)) ||
      (kind === "team" &&
        (typeof referee.team_id !== "string" ||
          !teamIds.has(referee.team_id) ||
          referee.source_match_id !== undefined && referee.source_match_id !== null)) ||
      (kind !== "organizer" && kind !== "team")
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "1日目の審判割当てが不正です。");
    }
  }
  if (assignedMatches.size !== matchIds.size) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "1日目日程に配置されていないリーグ試合があります。",
    );
  }

  if (result.section_timings === undefined) return;
  if (!currentDay1Format) day = validateDay1ScheduleSettings(input);
  const timings = arrayValue(result.section_timings, "1日目時刻", LIMITS.sections);
  const timingSections = new Set<number>();
  const timingBySection = new Map<number, JsonObject>();
  for (const timing of timings) {
    const section = nonNegativeInteger(timing.section_no, "1日目時刻のセクション");
    if (
      timing.day_id !== "day1" ||
      section < 1 ||
      section > LIMITS.sections ||
      timingSections.has(section) ||
      clockMinutes(timing.start_time) === undefined ||
      clockMinutes(timing.match_end_time) === undefined
    ) {
      throw new ImportValidationError("INVALID_DOCUMENT", "1日目のセクション時刻が不正です。");
    }
    nonNegativeInteger(timing.break_after_minutes ?? 0, "1日目の休憩時間");
    timingSections.add(section);
    timingBySection.set(section, timing);
  }
  if (
    timingSections.size !== slotSections.size ||
    [...slotSections].some((section) => !timingSections.has(section))
  ) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "1日目の時刻一覧が日程のセクションをすべて含んでいません。",
    );
  }

  const startMinutes = clockMinutes(day.start_time);
  const duration = day.game_duration_minutes;
  const margin = day.margin_minutes;
  const rawBreaks = day.breaks as JsonObject[] | undefined;
  if (startMinutes === undefined || typeof duration !== "number" || typeof margin !== "number") {
    throw new ImportValidationError("INVALID_DOCUMENT", "1日目の時刻設定が不正です。");
  }
  const breaks = new Map<number, number>();
  for (const item of rawBreaks ?? []) {
    breaks.set(Number(item.after_section), Number(item.duration_minutes));
  }
  for (const section of timingSections) {
    const timing = timingBySection.get(section)!;
    const expectedStart =
      startMinutes +
      (section - 1) * (duration + margin) +
      [...breaks]
        .filter(([afterSection]) => afterSection < section)
        .reduce((total, [, minutes]) => total + minutes, 0);
    if (
      clockMinutes(timing.start_time) !== expectedStart ||
      clockMinutes(timing.match_end_time) !== expectedStart + duration ||
      Number(timing.break_after_minutes ?? 0) !== (breaks.get(section) ?? 0)
    ) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "1日目のセクション時刻が大会設定と一致しません。",
      );
    }
  }
}

function validateDay2ScheduleResult(
  result: JsonObject,
  input: JsonObject,
  teams: JsonObject[],
  tournamentPlan: JsonObject,
  standings: JsonObject[] | undefined,
): void {
  if (result.day2_schedule === undefined) {
    if (result.integrated_validation !== undefined) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "2日目日程がないため、統合検証結果を復元できませんでした。",
      );
    }
    return;
  }
  const day = validateDay2Settings(input);
  if (day === undefined) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "2日目設定がないため、2日目日程を復元できませんでした。",
    );
  }
  const schedule = objectValue(result.day2_schedule, "2日目日程を読み取れませんでした。");
  const legacySchedule = schedule.participant_resolution === undefined;
  const scheduleResolution = legacySchedule ? "resolved" : schedule.participant_resolution;
  const planResolution = tournamentPlan.participant_resolution === undefined
    ? "resolved"
    : tournamentPlan.participant_resolution;
  if (
    !isSupportedSchemaVersion(schedule.schema_version) ||
    schedule.schedule_scope !== "day2_tournament" ||
    !new Set(["OPTIMAL", "FEASIBLE"]).has(String(schedule.status)) ||
    (scheduleResolution !== "provisional" && scheduleResolution !== "resolved") ||
    scheduleResolution !== planResolution ||
    (scheduleResolution === "resolved") !== (standings !== undefined)
  ) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "2日目日程の仮・確定状態がトーナメント表やリーグ順位と一致しません。",
    );
  }
  const planMatches = [
    ...arrayValue(objectValue(tournamentPlan.upper, "上位トーナメントが不正です。").matches, "上位試合", LIMITS.matches),
    ...arrayValue(objectValue(tournamentPlan.lower, "下位トーナメントが不正です。").matches, "下位試合", LIMITS.matches),
  ];
  const expectedMatchIds = new Set(planMatches.map((match) => String(match.id)));
  const validRankKeys = new Set(
    [
      ...arrayValue(objectValue(tournamentPlan.upper, "上位トーナメントが不正です。").seeds, "上位シード", LIMITS.teams),
      ...arrayValue(objectValue(tournamentPlan.lower, "下位トーナメントが不正です。").seeds, "下位シード", LIMITS.teams),
    ].map((seed) => `${String(seed.block_id)}:${String(seed.block_rank)}`),
  );
  const teamByRank = new Map(
    (standings ?? []).map((row) => [
      `${String(row.block_id)}:${String(row.rank)}`,
      String(row.team_id),
    ]),
  );
  const scheduledMatches = arrayValue(
    schedule.tournament_matches,
    "2日目トーナメント試合",
    LIMITS.matches,
  );
  const scheduledMatchIds = uniqueIds(scheduledMatches, "2日目トーナメント試合");
  if (
    scheduledMatchIds.size !== expectedMatchIds.size ||
    [...scheduledMatchIds].some((matchId) => !expectedMatchIds.has(matchId))
  ) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "2日目日程の試合とトーナメント表が一致しません。",
    );
  }
  const rankKeysByMatch = new Map<string, string[]>();
  for (const match of scheduledMatches) {
    const rankRefs = match.possible_rank_refs === undefined
      ? []
      : arrayValue(match.possible_rank_refs, `試合「${String(match.id)}」の順位枠`, LIMITS.teams);
    const rankKeys = rankRefs.map((ref) => {
      if (
        ref.type !== "league_rank" ||
        typeof ref.block_id !== "string" ||
        !Number.isInteger(ref.rank)
      ) {
        throw new ImportValidationError("INVALID_REFERENCE", "2日目日程の順位枠が不正です。");
      }
      return `${ref.block_id}:${String(ref.rank)}`;
    });
    const possibleTeamIds = stringArray(match.possible_team_ids ?? [], "2日目試合の参加候補");
    if (
      (!legacySchedule && rankKeys.length === 0) ||
      new Set(rankKeys).size !== rankKeys.length ||
      rankKeys.some((rank) => !validRankKeys.has(rank)) ||
      new Set(possibleTeamIds).size !== possibleTeamIds.length ||
      (scheduleResolution === "provisional" && possibleTeamIds.length > 0) ||
      (scheduleResolution === "resolved" &&
        ((!legacySchedule && possibleTeamIds.length !== rankKeys.length) ||
          possibleTeamIds.some((teamId) => !teams.some((team) => team.id === teamId)) ||
          (!legacySchedule &&
            possibleTeamIds.some((teamId, index) => teamByRank.get(rankKeys[index]!) !== teamId))))
    ) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        `試合「${String(match.id)}」の順位枠またはチーム注記が不正です。`,
      );
    }
    rankKeysByMatch.set(String(match.id), rankKeys);
  }
  const courtIds = new Set(
    arrayValue(input.courts, "コート", LIMITS.courts).map((court) => String(court.id)),
  );
  const slots = arrayValue(
    schedule.slots,
    "2日目スロット",
    LIMITS.sections * LIMITS.courts,
  );
  const positions = new Set<string>();
  const assignedMatches = new Set<string>();
  for (const slot of slots) {
    const section = nonNegativeInteger(slot.section_no, "2日目セクション番号");
    const position = `${section}:${String(slot.court_id)}`;
    if (
      slot.day_id !== "day2" ||
      section < 1 ||
      section > LIMITS.sections ||
      typeof slot.court_id !== "string" ||
      !courtIds.has(slot.court_id) ||
      positions.has(position)
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "2日目スロットの位置が不正です。");
    }
    positions.add(position);
    if (slot.match_id === null) {
      if (slot.referee_assignment !== null) {
        throw new ImportValidationError("INVALID_REFERENCE", "空きスロットに審判が設定されています。");
      }
      continue;
    }
    if (
      typeof slot.match_id !== "string" ||
      !expectedMatchIds.has(slot.match_id) ||
      assignedMatches.has(slot.match_id)
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "2日目の試合配置が重複または不足しています。");
    }
    assignedMatches.add(slot.match_id);
    const referee = objectValue(slot.referee_assignment, "2日目の審判割当てを読み取れませんでした。");
    if (referee.kind === "team") {
      if (
        typeof referee.source_match_id !== "string" ||
        !expectedMatchIds.has(referee.source_match_id) ||
        referee.source_match_id === slot.match_id ||
        referee.team_id !== null && referee.team_id !== undefined
      ) {
        throw new ImportValidationError("INVALID_REFERENCE", "2日目の審判供給元が不正です。");
      }
    } else if (referee.kind === "organizer") {
      if (
        !new Set(["first_section", "tournament_final", "fallback"]).has(
          String(referee.organizer_reason),
        ) ||
        !Array.isArray(referee.fallback_reasons) ||
        referee.fallback_reasons.some((reason) => typeof reason !== "string")
      ) {
        throw new ImportValidationError("INVALID_REFERENCE", "主催者審判の理由が不正です。");
      }
    } else {
      throw new ImportValidationError("INVALID_DOCUMENT", "2日目の審判種別が不正です。");
    }
  }
  if (assignedMatches.size !== expectedMatchIds.size) {
    throw new ImportValidationError("INVALID_REFERENCE", "2日目日程に不足している試合があります。");
  }
  const timings = arrayValue(schedule.section_timings, "2日目時刻", LIMITS.sections);
  const timingSections = new Set<number>();
  const timingBySection = new Map<number, JsonObject>();
  for (const timing of timings) {
    const section = nonNegativeInteger(timing.section_no, "2日目時刻のセクション");
    if (
      timing.day_id !== "day2" ||
      section < 1 ||
      timingSections.has(section) ||
      typeof timing.start_time !== "string" ||
      typeof timing.match_end_time !== "string"
    ) {
      throw new ImportValidationError("INVALID_DOCUMENT", "2日目のセクション時刻が不正です。");
    }
    timingSections.add(section);
    timingBySection.set(section, timing);
  }
  const usedSections = Math.max(
    0,
    ...slots
      .filter((slot) => typeof slot.match_id === "string")
      .map((slot) => Number(slot.section_no)),
  );
  const startMinutes = clockMinutes(day.start_time);
  const duration = Number(day.game_duration_minutes);
  const margin = Number(day.margin_minutes);
  const breakMinutes = new Map(
    arrayValue(day.breaks ?? [], "2日目の休憩", LIMITS.sections).map((item) => [
      Number(item.after_section),
      Number(item.duration_minutes),
    ]),
  );
  if (timings.length !== usedSections || startMinutes === undefined) {
    throw new ImportValidationError("INVALID_REFERENCE", "2日目の時刻一覧が日程と一致しません。");
  }
  for (let section = 1; section <= usedSections; section += 1) {
    const expectedStart =
      startMinutes +
      (section - 1) * (duration + margin) +
      [...breakMinutes]
        .filter(([afterSection]) => afterSection < section)
        .reduce((total, [, minutes]) => total + minutes, 0);
    const timing = timingBySection.get(section);
    if (
      timing === undefined ||
      clockMinutes(timing.start_time) !== expectedStart ||
      clockMinutes(timing.match_end_time) !== expectedStart + duration ||
      Number(timing.break_after_minutes ?? 0) !== (breakMinutes.get(section) ?? 0)
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "2日目のセクション時刻が設定と一致しません。");
    }
  }
  const expectedEnd =
    usedSections === 0
      ? undefined
      : clockMinutes(timingBySection.get(usedSections)?.match_end_time);
  if (
    (usedSections === 0 && schedule.expected_end_time !== null) ||
    (usedSections > 0 && clockMinutes(schedule.expected_end_time) !== expectedEnd)
  ) {
    throw new ImportValidationError("INVALID_REFERENCE", "2日目の終了予定時刻が不正です。");
  }
  if (
    (typeof day.max_sections === "number" && usedSections > day.max_sections) ||
    (clockMinutes(day.end_time) !== undefined &&
      expectedEnd !== undefined &&
      expectedEnd > clockMinutes(day.end_time)!)
  ) {
    throw new ImportValidationError("INVALID_REFERENCE", "2日目日程が設定した上限を超えています。");
  }
  const teamIds = new Set(teams.map((team) => String(team.id)));
  const teamRoutes = arrayValue(
    schedule.team_schedules,
    "2日目チーム経路",
    LIMITS.matches * LIMITS.teams,
  );
  const coveredMatchRanks = new Set<string>();
  for (const route of teamRoutes) {
    const rankRef = route.rank_ref === undefined || route.rank_ref === null
      ? undefined
      : objectValue(route.rank_ref, "2日目のチーム経路にある順位枠が不正です。");
    const rankKey = rankRef === undefined
      ? undefined
      : `${String(rankRef.block_id)}:${String(rankRef.rank)}`;
    const teamId = typeof route.team_id === "string" ? route.team_id : undefined;
    if (
      (!legacySchedule &&
        (rankRef?.type !== "league_rank" ||
          typeof rankRef.block_id !== "string" ||
          !Number.isInteger(rankRef.rank) ||
          rankKey === undefined ||
          !validRankKeys.has(rankKey))) ||
      (scheduleResolution === "provisional" && teamId !== undefined) ||
      (scheduleResolution === "resolved" &&
        (teamId === undefined ||
          !teamIds.has(teamId) ||
          (!legacySchedule && teamByRank.get(rankKey!) !== teamId))) ||
      typeof route.match_id !== "string" ||
      !expectedMatchIds.has(route.match_id) ||
      !courtIds.has(String(route.court_id)) ||
      !new Set(["match", "referee"]).has(String(route.role)) ||
      !Array.isArray(route.conditions) ||
      route.conditions.some((condition) => typeof condition !== "string")
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "2日目のチーム経路が不正です。");
    }
    if (route.role === "match" && rankKey !== undefined) {
      coveredMatchRanks.add(`${route.match_id}|${rankKey}`);
    }
  }
  if (!legacySchedule) {
    const expectedMatchRanks = new Set(
      [...rankKeysByMatch].flatMap(([matchId, rankKeys]) =>
        rankKeys.map((rankKey) => `${matchId}|${rankKey}`)
      ),
    );
    if (
      coveredMatchRanks.size !== expectedMatchRanks.size ||
      [...coveredMatchRanks].some((entry) => !expectedMatchRanks.has(entry))
    ) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "2日目のチーム別経路に必要な順位枠注記が不足または矛盾しています。",
      );
    }
  }
  const metrics = objectValue(schedule.metrics, "2日目の監査値を読み取れませんでした。");
  for (const field of [
    "used_sections",
    "maximum_team_wait_sections",
    "referee_then_match_count",
    "adjacent_assignment_court_change_count",
    "team_court_change_count",
    "court_usage_difference",
    "organizer_referee_count",
    "tournament_team_referee_count",
    "tournament_referee_fallback_count",
    "unused_slot_count",
  ]) {
    if (metrics[field] !== undefined) nonNegativeInteger(metrics[field], `2日目監査値${field}`);
  }
  for (const field of [
    "upper_tournament_final_section",
    "lower_tournament_final_section",
    "lower_tournament_final_section_gap",
  ]) {
    if (metrics[field] !== undefined && metrics[field] !== null) {
      nonNegativeInteger(metrics[field], `2日目監査値${field}`);
    }
  }
  for (const stage of arrayValue(metrics.objective_stages ?? [], "目的別監査値", 16)) {
    if (
      typeof stage.objective !== "string" ||
      stage.objective.length === 0 ||
      typeof stage.optimality_proven !== "boolean"
    ) {
      throw new ImportValidationError("INVALID_DOCUMENT", "目的別監査値が不正です。");
    }
    nonNegativeInteger(stage.value, `目的${stage.objective}の値`);
  }
  const integrated = objectValue(
    schedule.integrated_validation,
    "2日間の統合検証を読み取れませんでした。",
  );
  if (
    integrated.valid !== true ||
    !Array.isArray(integrated.diagnostics ?? integrated.issues)
  ) {
    throw new ImportValidationError("INVALID_DOCUMENT", "2日間の統合検証に合格していません。");
  }
  if (
    result.integrated_validation === undefined ||
    JSON.stringify(result.integrated_validation) !== JSON.stringify(schedule.integrated_validation)
  ) {
    throw new ImportValidationError("INVALID_REFERENCE", "保存された統合検証結果が一致しません。");
  }
  try {
    const finalPlacement = analyzeDay2FinalPlacement(schedule, tournamentPlan);
    if (
      finalPlacement.hasFinalPlacementAudit
      && (!finalPlacement.finalPlacementAuditMatches || !finalPlacement.primaryFinalIsLast)
    ) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "2日目日程の決勝配置が現行ルールまたは監査値と一致しません。",
      );
    }
  } catch (error) {
    if (error instanceof ImportValidationError) throw error;
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      error instanceof Day2FinalPlacementError
        ? error.message
        : "2日目日程の決勝配置を読み取れませんでした。",
    );
  }
}

function validateLeagueResult(result: JsonObject, teams: JsonObject[], input: JsonObject): void {
  const planValue = result.league_plan;
  if (planValue === undefined) {
    if (
      result.league_results !== undefined ||
      result.league_standings !== undefined ||
      result.tournament_plan !== undefined ||
      result.day2_schedule !== undefined ||
      result.integrated_validation !== undefined ||
      result.tournament_results !== undefined ||
      result.final_standings !== undefined
    ) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "リーグ日程がないため、試合結果と順位を復元できませんでした。",
      );
    }
    return;
  }
  const plan = objectValue(planValue, "リーグ日程を読み取れませんでした。");
  const blocks = arrayValue(plan.blocks, "リーグブロック", LIMITS.teams);
  if (blocks.length === 0) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "生成済みリーグにブロックがありません。",
    );
  }
  const blockIds = uniqueIds(blocks, "ブロック");
  const teamIds = new Set(
    teams.filter((team) => typeof team.id === "string").map((team) => team.id as string),
  );
  const teamToBlock = new Map<string, string>();
  for (const block of blocks) {
    const blockId = block.id as string;
    for (const teamId of stringArray(block.team_ids, `${blockId}ブロックのチーム一覧`)) {
      if (!teamIds.has(teamId)) {
        throw new ImportValidationError(
          "INVALID_REFERENCE",
          `${blockId}ブロックが登録されていないチームを参照しています。`,
        );
      }
      if (teamToBlock.has(teamId)) {
        throw new ImportValidationError(
          "INVALID_REFERENCE",
          `チーム「${teamId}」が複数のブロックに登録されています。`,
        );
      }
      teamToBlock.set(teamId, blockId);
    }
  }
  if (teamToBlock.size !== teamIds.size) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "生成済みリーグのブロックに所属していないチームがあります。",
    );
  }
  const minimumBlockSize = Math.floor(teamIds.size / blocks.length);
  const maximumLargeBlockCount = teamIds.size % blocks.length;
  const maximumBlockSize = minimumBlockSize + (maximumLargeBlockCount > 0 ? 1 : 0);
  const generatedBlockSizes = blocks.map((block) =>
    stringArray(block.team_ids, `${String(block.id)}ブロックのチーム一覧`).length
  );
  if (
    generatedBlockSizes.some(
      (size) => size < minimumBlockSize || size > maximumBlockSize,
    ) ||
    generatedBlockSizes.filter((size) => size === maximumBlockSize).length !==
      (maximumLargeBlockCount > 0 ? maximumLargeBlockCount : blocks.length)
  ) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "生成済みリーグのブロック人数が均等ではありません。",
    );
  }
  const manualBlocks = validateManualLeagueSettings(input, teams, true);
  const league = objectValue(input.league, "リーグ設定を読み取れませんでした。");
  if (
    manualBlocks !== undefined &&
    league.assignment_mode === "manual"
  ) {
    const generatedBlocks = blocks.map((block) => ({
      id: String(block.id),
      team_ids: stringArray(block.team_ids, `${String(block.id)}ブロックのチーム一覧`),
    }));
    if (plan.manual_completion === undefined) {
      if (JSON.stringify(generatedBlocks) !== JSON.stringify(manualBlocks)) {
        throw new ImportValidationError(
          "INVALID_REFERENCE",
          "生成済みリーグの所属が保存された手動割当てと一致しません。",
        );
      }
    } else {
      const completion = objectValue(
        plan.manual_completion,
        "手動割当ての自動配置情報を読み取れませんでした。",
      );
      const actualAssignments = arrayValue(
        completion.automatic_assignments,
        "手動割当ての自動配置情報",
        LIMITS.teams,
      ).map((assignment) => {
        if (typeof assignment.team_id !== "string" || typeof assignment.block_id !== "string") {
          throw new ImportValidationError(
            "INVALID_REFERENCE",
            "手動割当ての自動配置情報に不正な参照があります。",
          );
        }
        return { team_id: assignment.team_id, block_id: assignment.block_id };
      });
      const expectedAssignments: Array<{ team_id: string; block_id: string }> = [];
      for (const manualBlock of manualBlocks) {
        const generatedBlock = generatedBlocks.find((block) => block.id === manualBlock.id);
        if (
          generatedBlock === undefined ||
          JSON.stringify(
            generatedBlock.team_ids.slice(0, manualBlock.team_ids.length),
          ) !== JSON.stringify(manualBlock.team_ids)
        ) {
          throw new ImportValidationError(
            "INVALID_REFERENCE",
            "生成済みリーグで手動指定されたチームの所属または順序が変更されています。",
          );
        }
        expectedAssignments.push(
          ...generatedBlock.team_ids.slice(manualBlock.team_ids.length).map((teamId) => ({
            team_id: teamId,
            block_id: manualBlock.id,
          })),
        );
      }
      if (JSON.stringify(actualAssignments) !== JSON.stringify(expectedAssignments)) {
        throw new ImportValidationError(
          "INVALID_REFERENCE",
          "手動割当ての自動配置情報が確定したブロック所属と一致しません。",
        );
      }
    }
  } else if (plan.manual_completion !== undefined) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "自動方式のリーグ日程に手動割当ての自動配置情報があります。",
    );
  }

  if (manualBlocks !== undefined && league.assignment_mode === "manual") {
    const generatedBlockIds = blocks.map((block) => String(block.id));
    if (JSON.stringify(generatedBlockIds) !== JSON.stringify(manualBlocks.map((block) => block.id))) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "生成済みリーグのブロック順が保存された手動割当てと一致しません。",
      );
    }
  }

  const matches = arrayValue(plan.matches, "リーグ試合", LIMITS.matches);
  const matchIds = uniqueIds(matches, "試合");
  for (const match of matches) {
    if (match.phase !== "league") {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        `試合「${String(match.id)}」はリーグ試合ではありません。`,
      );
    }
    const home = stringArray(
      match.possible_home_team_ids,
      `試合「${String(match.id)}」のホームチーム`,
    );
    const away = stringArray(
      match.possible_away_team_ids,
      `試合「${String(match.id)}」のアウェーチーム`,
    );
    if (home.length !== 1 || away.length !== 1 || !teamIds.has(home[0]!) || !teamIds.has(away[0]!)) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        `試合「${String(match.id)}」の対戦チームを確認できませんでした。`,
      );
    }
  }

  const rounds = arrayValue(plan.logical_rounds, "論理ラウンド", LIMITS.matches);
  const scheduledMatches = new Set<string>();
  for (const round of rounds) {
    if (typeof round.block_id !== "string" || !blockIds.has(round.block_id)) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "論理ラウンドが登録されていないブロックを参照しています。",
      );
    }
    for (const matchId of stringArray(round.match_ids, "論理ラウンドの試合一覧")) {
      if (!matchIds.has(matchId) || scheduledMatches.has(matchId)) {
        throw new ImportValidationError(
          "INVALID_REFERENCE",
          `試合「${matchId}」のラウンド参照が不正です。`,
        );
      }
      scheduledMatches.add(matchId);
      const match = matches.find((candidate) => candidate.id === matchId)!;
      const home = (match.possible_home_team_ids as string[])[0]!;
      const away = (match.possible_away_team_ids as string[])[0]!;
      if (teamToBlock.get(home) !== round.block_id || teamToBlock.get(away) !== round.block_id) {
        throw new ImportValidationError(
          "INVALID_REFERENCE",
          `試合「${matchId}」のチームとブロックが一致しません。`,
        );
      }
    }
  }
  if (scheduledMatches.size !== matches.length) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "ラウンドに所属していないリーグ試合があります。",
    );
  }

  const leagueResults =
    result.league_results === undefined
      ? []
      : arrayValue(result.league_results, "リーグ結果", LIMITS.matches);
  const resultMatchIds = new Set<string>();
  for (const matchResult of leagueResults) {
    if (typeof matchResult.match_id !== "string" || !matchIds.has(matchResult.match_id)) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "リーグ結果が日程にない試合を参照しています。",
      );
    }
    if (resultMatchIds.has(matchResult.match_id)) {
      throw new ImportValidationError(
        "DUPLICATE_ID",
        `試合「${matchResult.match_id}」の結果が重複しています。`,
      );
    }
    resultMatchIds.add(matchResult.match_id);
    nonNegativeInteger(matchResult.home_score, "ホーム得点");
    nonNegativeInteger(matchResult.away_score, "アウェー得点");
  }

  if (result.league_standings === undefined) {
    if (result.tournament_plan !== undefined) {
      const { oddSplitPolicy, tournamentCount } = tournamentPlanValidationContext(input);
      const rankSets = tournamentRankSets(blocks, oddSplitPolicy);
      const tournamentPlan = objectValue(
        result.tournament_plan,
        "2日目トーナメントを読み取れませんでした。",
      );
      validateTournamentPlan(
        tournamentPlan,
        undefined,
        teamIds,
        oddSplitPolicy,
        rankSets,
        tournamentCount,
      );
      validateDay2ScheduleResult(result, input, teams, tournamentPlan, undefined);
      validateTournamentResultsState(result, tournamentPlan);
    } else if (result.day2_schedule !== undefined || result.integrated_validation !== undefined) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "トーナメント表がないため、2日目日程を復元できませんでした。",
      );
    }
    return;
  }
  if (resultMatchIds.size !== matches.length) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "全試合の結果が揃っていないため、確定順位を復元できませんでした。",
    );
  }
  const standings = objectValue(result.league_standings, "確定順位を読み取れませんでした。");
  if (standings.status !== "COMPLETE") {
    throw new ImportValidationError("INVALID_DOCUMENT", "確定順位の状態を読み取れませんでした。");
  }
  const rows = arrayValue(standings.standings, "順位表", LIMITS.teams);
  const rankedTeams = new Set<string>();
  const rankedPlaces = new Set<string>();
  for (const row of rows) {
    if (
      typeof row.team_id !== "string" ||
      !teamIds.has(row.team_id) ||
      typeof row.block_id !== "string" ||
      !blockIds.has(row.block_id) ||
      teamToBlock.get(row.team_id) !== row.block_id
    ) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "順位表が登録されていないチームまたはブロックを参照しています。",
      );
    }
    const rank = nonNegativeInteger(row.rank, "順位");
    if (rank === 0 || rankedTeams.has(row.team_id) || rankedPlaces.has(`${row.block_id}:${rank}`)) {
      throw new ImportValidationError("DUPLICATE_ID", "順位表に重複した順位があります。");
    }
    rankedTeams.add(row.team_id);
    rankedPlaces.add(`${row.block_id}:${rank}`);
  }
  if (rankedTeams.size !== teamToBlock.size) {
    throw new ImportValidationError("INVALID_REFERENCE", "順位表に不足しているチームがあります。");
  }
  const draws = arrayValue(standings.draws, "抽選記録", LIMITS.teams);
  for (const draw of draws) {
    if (typeof draw.block_id !== "string" || !blockIds.has(draw.block_id)) {
      throw new ImportValidationError("INVALID_REFERENCE", "抽選記録のブロックが不正です。");
    }
    const candidates = stringArray(draw.candidates, "抽選候補");
    const decidedOrder = stringArray(draw.decided_order, "抽選確定順");
    if (
      new Set(candidates).size !== candidates.length ||
      new Set(decidedOrder).size !== decidedOrder.length ||
      candidates.length !== decidedOrder.length ||
      candidates.some((teamId) => teamToBlock.get(teamId) !== draw.block_id) ||
      decidedOrder.some((teamId) => !candidates.includes(teamId)) ||
      typeof draw.random_seed !== "number" ||
      !Number.isInteger(draw.random_seed)
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "抽選記録の内容が不正です。");
    }
  }
  if (result.tournament_plan !== undefined) {
    const { oddSplitPolicy, tournamentCount } = tournamentPlanValidationContext(input);
    const rankSets = tournamentRankSets(blocks, oddSplitPolicy);
    const tournamentPlan = objectValue(
      result.tournament_plan,
      "2日目トーナメントを読み取れませんでした。",
    );
    validateTournamentPlan(
      tournamentPlan,
      rows,
      teamIds,
      oddSplitPolicy,
      rankSets,
      tournamentCount,
    );
    validateDay2ScheduleResult(result, input, teams, tournamentPlan, rows);
    validateTournamentResultsState(result, tournamentPlan);
  } else if (
    result.day2_schedule !== undefined ||
    result.integrated_validation !== undefined ||
    result.tournament_results !== undefined ||
    result.final_standings !== undefined
  ) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "トーナメント表がないため、2日目日程を復元できませんでした。",
    );
  }
}

function tournamentPlanValidationContext(input: JsonObject): {
  oddSplitPolicy: "upper" | "lower" | "alternate";
  tournamentCount?: number;
} {
  if (input.schema_version === SCHEMA_VERSION) {
    const finalStage = objectValue(input.final_stage, "決勝方式を読み取れませんでした。");
    if (
      finalStage.format !== "placement_tournament" ||
      typeof finalStage.tournament_count !== "number" ||
      !Number.isInteger(finalStage.tournament_count) ||
      finalStage.tournament_count < 1
    ) {
      throw new ImportValidationError(
        "INVALID_DOCUMENT",
        "順位決定トーナメントの設定を読み取れませんでした。",
      );
    }
    return { oddSplitPolicy: "upper", tournamentCount: finalStage.tournament_count };
  }
  const leagueSettings = objectValue(input.league, "リーグ設定を読み取れませんでした。");
  return { oddSplitPolicy: validateOddSplitPolicy(leagueSettings.odd_split_policy) };
}

function validateTournamentResultsState(result: JsonObject, plan: JsonObject): void {
  if (result.tournament_results === undefined) {
    if (result.final_standings !== undefined) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "2日目の試合結果がないため、総合最終順位を復元できませんでした。",
      );
    }
    return;
  }
  const rawResults = arrayValue(
    result.tournament_results,
    "2日目試合結果",
    LIMITS.matches,
  );
  let progress;
  try {
    progress = resolveTournamentProgress(plan, rawResults);
  } catch (error) {
    throw new ImportValidationError(
      error instanceof TournamentProgressError ? error.code : "INVALID_REFERENCE",
      error instanceof Error
        ? error.message
        : "2日目の試合結果をトーナメント表へ対応させられませんでした。",
    );
  }
  if (result.final_standings === undefined) return;
  if (!progress.complete) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "2日目の全試合結果が揃っていないため、総合最終順位を復元できませんでした。",
    );
  }
  const finalStandings = objectValue(
    result.final_standings,
    "総合最終順位を読み取れませんでした。",
  );
  if (!isSupportedSchemaVersion(finalStandings.schema_version) || finalStandings.status !== "COMPLETE") {
    throw new ImportValidationError(
      "INVALID_DOCUMENT",
      "総合最終順位の状態を読み取れませんでした。",
    );
  }
  const expectedStandings = previewTournamentStandings(plan, progress);
  const actualStandings = arrayValue(
    finalStandings.standings,
    "総合最終順位",
    LIMITS.teams,
  );
  if (
    actualStandings.length !== expectedStandings.length ||
    expectedStandings.some((expected, index) => {
      const actual = actualStandings[index];
      return actual === undefined ||
        actual.rank !== expected.rank ||
        actual.pool !== expected.pool ||
        actual.pool_rank !== expected.pool_rank ||
        actual.team_id !== expected.team_id ||
        JSON.stringify(actual.entry) !== JSON.stringify(expected.entry);
    })
  ) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "総合最終順位が2日目の試合結果と一致しません。",
    );
  }
  const canonicalResults = arrayValue(
    finalStandings.match_results,
    "検証済み2日目試合結果",
    LIMITS.matches,
  );
  const canonicalByMatch = new Map(
    canonicalResults.map((matchResult) => [String(matchResult.match_id), matchResult]),
  );
  if (
    canonicalResults.length !== progress.orderedMatches.length ||
    canonicalByMatch.size !== progress.orderedMatches.length ||
    progress.orderedMatches.some((match) => {
      const canonical = canonicalByMatch.get(match.matchId);
      const raw = match.result;
      if (canonical === undefined || raw === undefined) return true;
      const penaltyHome = canonical.penalty_score_home ?? undefined;
      const penaltyAway = canonical.penalty_score_away ?? undefined;
      return canonical.home_team_id !== raw.home_team_id ||
        canonical.away_team_id !== raw.away_team_id ||
        canonical.regular_score_home !== raw.regular_score_home ||
        canonical.regular_score_away !== raw.regular_score_away ||
        penaltyHome !== raw.penalty_score_home ||
        penaltyAway !== raw.penalty_score_away ||
        canonical.winner !== match.winner ||
        canonical.winner_team_id !== match.winnerTeamId ||
        canonical.loser_team_id !== match.loserTeamId ||
        canonical.decision !== match.decision;
    })
  ) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "検証済みの2日目試合結果が入力内容と一致しません。",
    );
  }
}

function expectedTournamentMatchCount(participantCount: number): number {
  if (participantCount <= 1) return 0;
  const mainSize = 2 ** Math.floor(Math.log2(participantCount));
  if (mainSize === participantCount) {
    return participantCount / 2 + 2 * expectedTournamentMatchCount(participantCount / 2);
  }
  const preliminaryCount = participantCount - mainSize;
  return (
    preliminaryCount +
    expectedTournamentMatchCount(mainSize) +
    expectedTournamentMatchCount(preliminaryCount)
  );
}

type TournamentRankSets = {
  all: Set<string>;
  upper: Set<string>;
};

function validateOddSplitPolicy(value: unknown): "upper" | "lower" | "alternate" {
  const policy = value === undefined ? "upper" : String(value);
  if (policy !== "upper" && policy !== "lower" && policy !== "alternate") {
    throw new ImportValidationError(
      "INVALID_DOCUMENT",
      "奇数人数ブロックの上下振り分けを読み取れませんでした。",
    );
  }
  return policy;
}

function tournamentRankSets(
  blocks: JsonObject[],
  policy: "upper" | "lower" | "alternate",
): TournamentRankSets {
  const all = new Set<string>();
  const upper = new Set<string>();
  let oddIndex = 0;
  for (const block of blocks) {
    const blockId = String(block.id);
    const count = Array.isArray(block.team_ids) ? block.team_ids.length : 0;
    let upperCount = count / 2;
    if (count % 2 === 1) {
      if (policy === "upper") upperCount = (count + 1) / 2;
      else if (policy === "lower") upperCount = (count - 1) / 2;
      else {
        upperCount = oddIndex % 2 === 0 ? (count + 1) / 2 : (count - 1) / 2;
        oddIndex += 1;
      }
    }
    for (let rank = 1; rank <= count; rank += 1) {
      const key = `${blockId}:${rank}`;
      all.add(key);
      if (rank <= upperCount) upper.add(key);
    }
  }
  return { all, upper };
}

function expectedTournamentByeCount(participantCount: number): number {
  if (participantCount <= 1) return 0;
  const mainSize = 2 ** Math.floor(Math.log2(participantCount));
  if (mainSize === participantCount) return 0;
  const preliminaryCount = participantCount - mainSize;
  return (
    participantCount -
    2 * preliminaryCount +
    expectedTournamentByeCount(preliminaryCount)
  );
}

function validateTournamentEntry(
  value: unknown,
  leagueRanks: Set<string>,
  teamIds: Set<string>,
  matchIds: Set<string>,
): JsonObject {
  const entry = objectValue(value, "トーナメントの参加参照を読み取れませんでした。");
  if (entry.type === "league_rank") {
    if (
      typeof entry.block_id !== "string" ||
      !Number.isInteger(entry.rank) ||
      !leagueRanks.has(`${entry.block_id}:${String(entry.rank)}`)
    ) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "トーナメントが存在しないリーグ順位を参照しています。",
      );
    }
    return entry;
  }
  if (entry.type === "concrete_team") {
    if (typeof entry.team_id !== "string" || !teamIds.has(entry.team_id)) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "トーナメントが登録されていないチームを参照しています。",
      );
    }
    return entry;
  }
  if (entry.type === "winner_of" || entry.type === "loser_of") {
    if (typeof entry.match_id !== "string" || !matchIds.has(entry.match_id)) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "トーナメントが存在しない試合結果を参照しています。",
      );
    }
    return entry;
  }
  throw new ImportValidationError(
    "INVALID_DOCUMENT",
    "トーナメントの参加参照の種類を読み取れませんでした。",
  );
}

function validateTournamentPool(
  value: unknown,
  expectedPool: "upper" | "lower",
  teamByRank: Map<string, string>,
  validLeagueRanks: Set<string>,
  resolution: "provisional" | "resolved",
): {
  seedTeams: Set<string>;
  seedRanks: Set<string>;
  matchIds: Set<string>;
  seedRanksByRank: Map<number, string[]>;
  firstMatchCount: number;
} {
  const pool = objectValue(value, "トーナメント区分を読み取れませんでした。");
  if (pool.pool !== expectedPool) {
    throw new ImportValidationError("INVALID_DOCUMENT", "トーナメント区分が一致しません。");
  }
  const participantCount = nonNegativeInteger(pool.participant_count, "トーナメント参加数");
  if (participantCount > LIMITS.teams) {
    throw new ImportValidationError(
      "LIMIT_EXCEEDED",
      `トーナメント参加数は${LIMITS.teams}チームまでです。`,
    );
  }
  const seeds = arrayValue(pool.seeds, "トーナメントシード", LIMITS.teams);
  if (seeds.length !== participantCount) {
    throw new ImportValidationError("INVALID_REFERENCE", "トーナメント参加数とシード数が一致しません。");
  }
  const seedTeams = new Set<string>();
  const seedNumbers = new Set<number>();
  const poolLeagueRanks = new Set<string>();
  const seedRanksByRank = new Map<number, string[]>();
  for (const seed of seeds) {
    const seedNo = nonNegativeInteger(seed.seed_no, "シード番号");
    const rank = nonNegativeInteger(seed.block_rank, "ブロック順位");
    const rankKey = `${String(seed.block_id)}:${rank}`;
    if (
      seedNo === 0 ||
      seedNumbers.has(seedNo) ||
      rank === 0 ||
      poolLeagueRanks.has(rankKey) ||
      !validLeagueRanks.has(rankKey)
    ) {
      throw new ImportValidationError("DUPLICATE_ID", "トーナメントシードの内容が不正です。");
    }
    seedNumbers.add(seedNo);
    poolLeagueRanks.add(rankKey);
    seedRanksByRank.set(rank, [...(seedRanksByRank.get(rank) ?? []), rankKey]);
    const entry = objectValue(seed.entry, "シードのリーグ順位参照を読み取れませんでした。");
    if (
      entry.type !== "league_rank" ||
      entry.block_id !== seed.block_id ||
      entry.rank !== rank
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "シードの参照内容が一致しません。");
    }
    if (resolution === "provisional") {
      if (
        (seed.team_id !== undefined && seed.team_id !== null) ||
        (seed.team !== undefined && seed.team !== null)
      ) {
        throw new ImportValidationError(
          "INVALID_REFERENCE",
          "仮トーナメントに確定チームが混在しています。",
        );
      }
    } else {
      const team = objectValue(seed.team, "シードのチーム参照を読み取れませんでした。");
      if (
        typeof seed.team_id !== "string" ||
        seedTeams.has(seed.team_id) ||
        teamByRank.get(rankKey) !== seed.team_id ||
        team.type !== "concrete_team" ||
        team.team_id !== seed.team_id
      ) {
        throw new ImportValidationError(
          "INVALID_REFERENCE",
          "確定トーナメントのチーム参照が順位と一致しません。",
        );
      }
      seedTeams.add(seed.team_id);
    }
  }
  if (
    seedNumbers.size !== participantCount ||
    [...seedNumbers].some((number) => number < 1 || number > participantCount)
  ) {
    throw new ImportValidationError("INVALID_REFERENCE", "シード番号に欠落があります。");
  }

  const matches = arrayValue(pool.matches, "トーナメント試合", LIMITS.matches);
  if (matches.length !== expectedTournamentMatchCount(participantCount)) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "全順位を決めるために必要なトーナメント試合数と一致しません。",
    );
  }
  const matchIds = uniqueIds(matches, "トーナメント試合");
  const dependencies = new Map<string, string[]>();
  for (const match of matches) {
    if (
      match.phase !== `${expectedPool}_tournament` ||
      typeof match.round !== "string" ||
      !Number.isInteger(match.round_no) ||
      Number(match.round_no) < 1 ||
      !Array.isArray(match.rank_range) ||
      match.rank_range.length !== 2 ||
      match.rank_range.some(
        (rank) =>
          !Number.isInteger(rank) || Number(rank) < 1 || Number(rank) > participantCount,
      ) ||
      Number(match.rank_range[0]) > Number(match.rank_range[1])
    ) {
      throw new ImportValidationError("INVALID_DOCUMENT", "トーナメント試合の内容が不正です。");
    }
    const home = validateTournamentEntry(match.home, poolLeagueRanks, seedTeams, matchIds);
    const away = validateTournamentEntry(match.away, poolLeagueRanks, seedTeams, matchIds);
    dependencies.set(
      String(match.id),
      [home, away]
        .filter((entry) => entry.type === "winner_of" || entry.type === "loser_of")
        .map((entry) => String(entry.match_id)),
    );
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (matchId: string): void => {
    if (visiting.has(matchId)) {
      throw new ImportValidationError("INVALID_REFERENCE", "トーナメント試合の参照が循環しています。");
    }
    if (visited.has(matchId)) return;
    visiting.add(matchId);
    for (const dependency of dependencies.get(matchId) ?? []) visit(dependency);
    visiting.delete(matchId);
    visited.add(matchId);
  };
  for (const matchId of matchIds) visit(matchId);

  try {
    readTournamentLogicalLayout(pool);
  } catch (error) {
    if (error instanceof TournamentLogicalLayoutError) {
      throw new ImportValidationError("INVALID_DOCUMENT", error.message);
    }
    throw error;
  }

  const byes = arrayValue(pool.byes, "不戦通過記録", LIMITS.teams);
  if (byes.length !== expectedTournamentByeCount(participantCount)) {
    throw new ImportValidationError("INVALID_REFERENCE", "不戦通過記録に不足または重複があります。");
  }
  for (const bye of byes) {
    if (bye.result !== "advance_by_bye" || typeof bye.next_match_id !== "string") {
      throw new ImportValidationError("INVALID_DOCUMENT", "不戦通過記録の内容が不正です。");
    }
    const entry = validateTournamentEntry(bye.entry, poolLeagueRanks, seedTeams, matchIds);
    const nextMatch = matches.find((match) => match.id === bye.next_match_id);
    if (
      nextMatch === undefined ||
      (JSON.stringify(nextMatch.home) !== JSON.stringify(entry) &&
        JSON.stringify(nextMatch.away) !== JSON.stringify(entry))
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "不戦通過の接続先が不正です。");
    }
  }

  const placements = arrayValue(pool.placements, "最終順位参照", LIMITS.teams);
  const ranks = new Set<number>();
  for (const placement of placements) {
    const rank = nonNegativeInteger(placement.rank, "最終順位");
    if (rank === 0 || rank > participantCount || ranks.has(rank)) {
      throw new ImportValidationError("DUPLICATE_ID", "最終順位参照に重複または欠落があります。");
    }
    ranks.add(rank);
    validateTournamentEntry(placement.entry, poolLeagueRanks, seedTeams, matchIds);
  }
  if (ranks.size !== participantCount) {
    throw new ImportValidationError("INVALID_REFERENCE", "最終順位参照に不足があります。");
  }
  const evaluation = objectValue(pool.evaluation, "組合せ評価を読み取れませんでした。");
  const firstMatchCount = nonNegativeInteger(
    evaluation.first_match_same_block_count,
    "初戦同一ブロック対戦数",
  );
  const possibleMatchCount = nonNegativeInteger(
    evaluation.possible_same_block_match_count,
    "同一ブロック対戦可能性数",
  );
  if (
    firstMatchCount > possibleMatchCount ||
    (evaluation.earliest_possible_same_block_round !== null &&
      evaluation.earliest_possible_same_block_round !== undefined &&
      (!Number.isInteger(evaluation.earliest_possible_same_block_round) ||
        Number(evaluation.earliest_possible_same_block_round) < 1))
  ) {
    throw new ImportValidationError("INVALID_DOCUMENT", "組合せ評価の内容が不正です。");
  }
  return {
    seedTeams,
    seedRanks: poolLeagueRanks,
    matchIds,
    seedRanksByRank,
    firstMatchCount,
  };
}

function validateTournamentPlan(
  plan: JsonObject,
  standings: JsonObject[] | undefined,
  teamIds: Set<string>,
  expectedPolicy: "upper" | "lower" | "alternate",
  rankSets: TournamentRankSets,
  expectedTournamentCount?: number,
): void {
  const currentPlan = plan.schema_version === SCHEMA_VERSION;
  if (
    !isSupportedSchemaVersion(plan.schema_version) ||
    plan.status !== "COMPLETE" ||
    (currentPlan
      ? plan.format !== "placement_tournament" ||
        plan.tournament_count !== expectedTournamentCount ||
        plan.odd_split_policy !== undefined
      : !new Set(["upper", "lower", "alternate"]).has(String(plan.odd_split_policy)) ||
        plan.odd_split_policy !== expectedPolicy) ||
    typeof plan.random_seed !== "number" ||
    !Number.isInteger(plan.random_seed)
  ) {
    throw new ImportValidationError("INVALID_DOCUMENT", "2日目トーナメントの状態が不正です。");
  }
  const legacyPlan = plan.participant_resolution === undefined;
  const resolution = legacyPlan ? "resolved" : plan.participant_resolution;
  if (
    (resolution !== "provisional" && resolution !== "resolved") ||
    (resolution === "resolved") !== (standings !== undefined)
  ) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "トーナメントの仮・確定状態とリーグ順位が一致しません。",
    );
  }
  const teamByRank = new Map(
    (standings ?? []).map((row) => [
      `${String(row.block_id)}:${String(row.rank)}`,
      String(row.team_id),
    ]),
  );
  const upper = validateTournamentPool(
    plan.upper,
    "upper",
    teamByRank,
    rankSets.all,
    resolution,
  );
  const lower = validateTournamentPool(
    plan.lower,
    "lower",
    teamByRank,
    rankSets.all,
    resolution,
  );
  const allSeeds = new Set([...upper.seedTeams, ...lower.seedTeams]);
  const allSeedRanks = new Set([...upper.seedRanks, ...lower.seedRanks]);
  if (
    allSeedRanks.size !== rankSets.all.size ||
    [...rankSets.all].some((rank) => !allSeedRanks.has(rank)) ||
    [...upper.seedRanks].some((rank) => lower.seedRanks.has(rank)) ||
    upper.seedRanks.size !== rankSets.upper.size ||
    [...upper.seedRanks].some((rank) => !rankSets.upper.has(rank)) ||
    (resolution === "resolved" &&
      (allSeeds.size !== teamIds.size ||
        [...upper.seedTeams].some((teamId) => lower.seedTeams.has(teamId))))
  ) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "上位・下位トーナメントの順位枠または参加チームに重複・不足があります。",
    );
  }
  if ([...upper.matchIds].some((matchId) => lower.matchIds.has(matchId))) {
    throw new ImportValidationError("DUPLICATE_ID", "上下のトーナメントで試合IDが重複しています。");
  }

  const draws = arrayValue(plan.seed_draws, "シード抽選記録", LIMITS.teams * 2);
  const drawKeys = new Set<string>();
  for (const draw of draws) {
    const pool = draw.pool === "upper" ? upper : draw.pool === "lower" ? lower : undefined;
    const candidates = stringArray(draw.candidates, "シード抽選候補");
    const decidedOrder = stringArray(draw.decided_order, "シード抽選確定順");
    const blockRank = nonNegativeInteger(draw.block_rank, "シード抽選のブロック順位");
    const expectedRankCandidates = pool?.seedRanksByRank.get(blockRank) ?? [];
    const candidateRankRefs =
      draw.candidate_rank_refs === undefined
        ? []
        : arrayValue(draw.candidate_rank_refs, "シード抽選の順位枠候補", LIMITS.teams);
    const decidedRankRefs =
      draw.decided_rank_refs === undefined
        ? []
        : arrayValue(draw.decided_rank_refs, "シード抽選の順位枠確定順", LIMITS.teams);
    const candidateRankKeys = candidateRankRefs.map((entry) => {
      validateTournamentEntry(entry, pool?.seedRanks ?? new Set(), new Set(), new Set());
      return `${String(entry.block_id)}:${String(entry.rank)}`;
    });
    const decidedRankKeys = decidedRankRefs.map((entry) => {
      validateTournamentEntry(entry, pool?.seedRanks ?? new Set(), new Set(), new Set());
      return `${String(entry.block_id)}:${String(entry.rank)}`;
    });
    const expectedTeams = expectedRankCandidates.map((rank) => teamByRank.get(rank));
    const drawKey = `${String(draw.pool)}:${blockRank}`;
    if (
      pool === undefined ||
      blockRank === 0 ||
      typeof draw.random_seed !== "number" ||
      !Number.isInteger(draw.random_seed) ||
      draw.random_seed !== plan.random_seed ||
      candidates.length !== decidedOrder.length ||
      new Set(candidates).size !== candidates.length ||
      decidedOrder.some((teamId) => !candidates.includes(teamId)) ||
      (resolution === "provisional" && (candidates.length > 0 || decidedOrder.length > 0)) ||
      (resolution === "resolved" &&
        (candidates.length !== expectedTeams.length ||
          candidates.some((teamId) => !expectedTeams.includes(teamId)) ||
          (!legacyPlan &&
            decidedOrder.some(
              (teamId, index) => teamByRank.get(decidedRankKeys[index] ?? "") !== teamId,
            )))) ||
      (!legacyPlan &&
        (candidateRankKeys.length !== expectedRankCandidates.length ||
          new Set(candidateRankKeys).size !== candidateRankKeys.length ||
          candidateRankKeys.some((rank) => !expectedRankCandidates.includes(rank)) ||
          decidedRankKeys.length !== candidateRankKeys.length ||
          new Set(decidedRankKeys).size !== decidedRankKeys.length ||
          decidedRankKeys.some((rank) => !candidateRankKeys.includes(rank)))) ||
      drawKeys.has(drawKey)
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "シード抽選記録の内容が不正です。");
    }
    drawKeys.add(drawKey);
  }
  const expectedDrawKeys = [
    ...[...upper.seedRanksByRank]
      .filter(([, ranks]) => ranks.length > 1)
      .map(([rank]) => `upper:${rank}`),
    ...[...lower.seedRanksByRank]
      .filter(([, ranks]) => ranks.length > 1)
      .map(([rank]) => `lower:${rank}`),
  ];
  if (
    drawKeys.size !== expectedDrawKeys.length ||
    expectedDrawKeys.some((key) => !drawKeys.has(key))
  ) {
    throw new ImportValidationError("INVALID_REFERENCE", "シード抽選記録に不足があります。");
  }

  const warnings = arrayValue(plan.warnings, "トーナメント警告", LIMITS.matches);
  for (const warning of warnings) {
    const matchIds =
      warning.pool === "upper"
        ? upper.matchIds
        : warning.pool === "lower"
          ? lower.matchIds
          : undefined;
    if (
      typeof warning.code !== "string" ||
      typeof warning.message !== "string" ||
      matchIds === undefined ||
      stringArray(warning.match_ids, "警告対象試合").some((matchId) => !matchIds.has(matchId))
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "トーナメント警告の内容が不正です。");
    }
  }
  for (const [poolName, pool] of [
    ["upper", upper],
    ["lower", lower],
  ] as const) {
    if (
      pool.firstMatchCount > 0 &&
      !warnings.some(
        (warning) =>
          warning.pool === poolName && warning.code === "SAME_BLOCK_FIRST_MATCH_UNAVOIDABLE",
      )
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "同一ブロック初戦の警告記録に不足があります。");
    }
  }
}

export function parseTournamentJson(text: string): TournamentDocument {
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
    throw new ImportValidationError(
      "FILE_TOO_LARGE",
      "ファイルが1 MBを超えています。大会を分けるか、不要な内容を減らしてください。",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportValidationError(
      "INVALID_JSON",
      "ファイルを読み取れませんでした。以前このアプリで書き出したJSONファイルか確認してください。",
    );
  }

  const root = objectValue(parsed, "大会データの形式を読み取れませんでした。");
  if (root.documentType !== DOCUMENT_TYPE) {
    throw new ImportValidationError(
      "UNKNOWN_DOCUMENT_TYPE",
      "このアプリの大会データではありません。選択したファイルを確認してください。",
    );
  }
  if (!isSupportedSchemaVersion(root.schemaVersion)) {
    throw new ImportValidationError(
      "SCHEMA_VERSION_UNSUPPORTED",
      `このファイルの版「${String(root.schemaVersion)}」には対応していません。アプリを更新してから再度お試しください。`,
    );
  }

  const tournament = objectValue(root.tournament, "大会情報を読み取れませんでした。");
  if (typeof tournament.name !== "string" || tournament.name.trim().length === 0) {
    throw new ImportValidationError("INVALID_DOCUMENT", "大会名が入力されていません。");
  }
  const input = objectValue(tournament.input, "大会の入力内容を読み取れませんでした。");
  if (input.schema_version !== root.schemaVersion) {
    throw new ImportValidationError(
      "SCHEMA_VERSION_UNSUPPORTED",
      "保存ファイルと大会設定の版が一致しません。書き出したファイルを選び直してください。",
    );
  }
  validateNestedSchemaVersions(tournament, String(root.schemaVersion));
  const teams = arrayValue(input.teams, "チーム", LIMITS.teams);
  const courts = arrayValue(input.courts, "コート", LIMITS.courts);
  uniqueIds(courts, "コート");
  const matches = isDay1LeagueInput(input)
    ? []
    : arrayValue(input.matches, "試合", LIMITS.matches);
  validateReferences(input, teams, matches);
  validateDay2Settings(input);
  validateManualLeagueSettings(input, teams, false);
  if (tournament.result !== undefined) {
    const result = objectValue(tournament.result, "生成結果を読み取れませんでした。");
    validateLeagueResult(result, teams, input);
    const leaguePlan = result.league_plan;
    const scheduleMatches = leaguePlan === undefined
      ? matches
      : arrayValue(
          objectValue(leaguePlan, "リーグ日程を読み取れませんでした。").matches,
          "リーグ試合",
          LIMITS.matches,
        );
    validateDay1ScheduleResult(result, input, teams, courts, scheduleMatches);
  }
  if (typeof root.updatedAt !== "string" || Number.isNaN(Date.parse(root.updatedAt))) {
    throw new ImportValidationError("INVALID_DOCUMENT", "保存日時を読み取れませんでした。");
  }

  const document = structuredClone(root) as unknown as TournamentDocument;
  return normalizeDocument(document).document;
}

export function serializeTournamentJson(document: TournamentDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function safeFileName(tournamentName: string): string {
  const normalized = tournamentName
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${normalized || "大会データ"}.json`;
}
