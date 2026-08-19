import {
  DOCUMENT_TYPE,
  LEGACY_SCHEMA_VERSION,
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  placementTournamentPools,
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
  assertNewDay2FinalPlacement,
  Day2FinalPlacementError,
} from "./day2-finals";
import {
  readTournamentLogicalLayout,
  TournamentLogicalLayoutError,
} from "./tournament-logical-layout";
import { sameRankRoleSequenceViolation } from "./same-rank-role-policy";

export const MAX_JSON_BYTES = 1_000_000;
export const LIMITS = {
  teams: 32,
  courts: 16,
  matches: 512,
  slots: 2_048,
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

function validateDay1ArrivalPreferences(input: JsonObject, teams: JsonObject[]): void {
  if (input.day1_arrival_preferences === undefined) return;
  const preferences = arrayValue(
    input.day1_arrival_preferences,
    "開始セクションへ配慮するチーム",
    LIMITS.teams,
  );
  const teamIds = new Set(teams.map((team) => String(team.id)));
  const seen = new Set<string>();
  for (const preference of preferences) {
    if (
      typeof preference.team_id !== "string" ||
      !teamIds.has(preference.team_id) ||
      seen.has(preference.team_id) ||
      typeof preference.earliest_section !== "number" ||
      !Number.isInteger(preference.earliest_section) ||
      preference.earliest_section < 2 ||
      preference.earliest_section > LIMITS.sections
    ) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "開始セクションへ配慮するチームまたは希望セクションが不正です。",
      );
    }
    seen.add(preference.team_id);
  }
}

function validateDay1ArrivalAudit(
  result: JsonObject,
  input: JsonObject,
  matches: JsonObject[],
  slots: JsonObject[],
): void {
  if (input.day1_arrival_preferences === undefined) return;
  const preferences = arrayValue(
    input.day1_arrival_preferences,
    "開始セクションへ配慮するチーム",
    LIMITS.teams,
  );
  if (preferences.length === 0) return;
  const metrics = objectValue(result.metrics, "1日目日程の監査値を読み取れませんでした。");
  const slotByMatch = new Map(
    slots.flatMap((slot) =>
      typeof slot.match_id === "string" ? [[slot.match_id, slot] as const] : []
    ),
  );
  const expectedMetrics = [...preferences]
    .sort((left, right) => {
      const leftId = String(left.team_id);
      const rightId = String(right.team_id);
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    })
    .map((preference) => {
      const teamId = String(preference.team_id);
      const earliestSection = Number(preference.earliest_section);
      const relevantMatches = matches
        .filter((match) => [
          ...(Array.isArray(match.possible_home_team_ids) ? match.possible_home_team_ids : []),
          ...(Array.isArray(match.possible_away_team_ids) ? match.possible_away_team_ids : []),
        ].includes(teamId))
        .sort((left, right) => {
          const leftId = String(left.id);
          const rightId = String(right.id);
          return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
        });
      const earlyMatches = relevantMatches.flatMap((match) => {
        const slot = slotByMatch.get(String(match.id));
        const sectionNo = Number(slot?.section_no);
        return Number.isInteger(sectionNo) && sectionNo < earliestSection
          ? [{
              match_id: String(match.id),
              section_no: sectionNo,
              section_shortfall: earliestSection - sectionNo,
            }]
          : [];
      });
      const earlyRefereeCount = slots.filter((slot) => {
        const assignment = typeof slot.referee_assignment === "object"
            && slot.referee_assignment !== null
            && !Array.isArray(slot.referee_assignment)
          ? slot.referee_assignment as JsonObject
          : undefined;
        return Number(slot.section_no) < earliestSection
          && (assignment?.kind ?? assignment?.type) === "team"
          && assignment?.team_id === teamId;
      }).length;
      return {
        team_id: teamId,
        earliest_section: earliestSection,
        match_count: relevantMatches.length,
        early_match_count: earlyMatches.length,
        early_referee_count: earlyRefereeCount,
        total_section_shortfall: earlyMatches.reduce(
          (total, match) => total + match.section_shortfall,
          0,
        ),
        early_matches: earlyMatches,
        satisfied: earlyMatches.length === 0 && earlyRefereeCount === 0,
      };
    });
  const uniqueEarlyMatches = new Set(
    expectedMetrics.flatMap((preference) => preference.early_matches.map((match) => match.match_id)),
  );
  const expectedScalars = {
    day1_arrival_early_match_count: uniqueEarlyMatches.size,
    day1_arrival_total_section_shortfall: expectedMetrics.reduce(
      (total, preference) => total + preference.total_section_shortfall,
      0,
    ),
    day1_arrival_early_referee_count: expectedMetrics.reduce(
      (total, preference) => total + preference.early_referee_count,
      0,
    ),
  };
  if (
    JSON.stringify(metrics.day1_arrival_preference_metrics) !== JSON.stringify(expectedMetrics) ||
    Object.entries(expectedScalars).some(([key, value]) => metrics[key] !== value)
  ) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "開始セクションへの配慮に関する監査値が日程と一致しません。日程を再生成してください。",
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

function validateFinalStageImportInput(input: JsonObject, teams: JsonObject[]): void {
  if (input.schema_version !== SCHEMA_VERSION) return;
  if (input.final_stage === undefined || input.final_stage === null) return;
  const league = objectValue(input.league, "リーグ設定を読み取れませんでした。");
  const blockCount = nonNegativeInteger(league.block_count, "ブロック数");
  const teamCount = teams.length;
  const finalStage = objectValue(input.final_stage, "決勝方式を読み取れませんでした。");
  if (finalStage.format === "placement_tournament") {
    const tournamentCount = nonNegativeInteger(finalStage.tournament_count, "トーナメント数");
    const tournamentNames = finalStage.tournament_names === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(finalStage.tournament_names) || finalStage.tournament_names.length > 4) {
            throw new ImportValidationError(
              "INVALID_DOCUMENT",
              "トーナメント名の一覧を読み取れませんでした。",
            );
          }
          return finalStage.tournament_names.map((name) => {
            if (
              typeof name !== "string" || name.trim() !== name || name.length === 0 ||
              name.length > 200
            ) {
              throw new ImportValidationError(
                "INVALID_DOCUMENT",
                "トーナメント名は1文字以上200文字以内で入力してください。",
              );
            }
            return name;
          });
        })();
    const allowedBlocks = new Map<string, readonly number[]>([
      ["8:2", [2, 4]],
      ["16:2", [2, 4, 8]],
      ["24:3", [2, 4, 8]],
      ["32:2", [2, 4, 8, 16]],
      ["32:4", [2, 4, 8]],
    ]).get(`${String(teamCount)}:${String(tournamentCount)}`);
    if (
      allowedBlocks === undefined || !allowedBlocks.includes(blockCount) ||
      teamCount % blockCount !== 0 || (teamCount / blockCount) % tournamentCount !== 0 ||
      finalStage.uneven_policy !== undefined ||
      (tournamentNames !== undefined && tournamentNames.length !== tournamentCount)
    ) {
      throw new ImportValidationError("INVALID_DOCUMENT", "順位決定トーナメントの参加数、トーナメント数、ブロック数が非対応です。");
    }
    return;
  }
  if (finalStage.format === "same_rank_league") {
    const remainder = teamCount % blockCount;
    const policy = finalStage.uneven_policy;
    if (
      teamCount < 4 || teamCount > 32 || blockCount < 2 || blockCount > Math.floor(teamCount / 2) ||
      (policy !== "strict_same_rank" && policy !== "merge_bottom") ||
      (remainder === 0 && policy !== "strict_same_rank") ||
      finalStage.tournament_count !== undefined ||
      finalStage.tournament_names !== undefined ||
      (remainder > 0 && policy === "merge_bottom" && blockCount + remainder > LIMITS.teams)
    ) {
      throw new ImportValidationError("INVALID_DOCUMENT", "同順位リーグの参加数、ブロック数、端数処理方針が不正です。");
    }
    return;
  }
  throw new ImportValidationError("INVALID_DOCUMENT", "決勝方式を読み取れませんでした。");
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

  validateDay1ArrivalAudit(result, input, matches, slots);

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
  const planPools = placementTournamentPools(tournamentPlan);
  const planMatches = planPools.flatMap((pool) =>
    arrayValue(pool.data.matches, `${pool.displayName}試合`, LIMITS.matches)
  );
  const expectedMatchIds = new Set(planMatches.map((match) => String(match.id)));
  const validRankKeys = new Set(
    planPools.flatMap((pool) =>
      arrayValue(pool.data.seeds, `${pool.displayName}シード`, LIMITS.teams)
    ).map((seed) => `${String(seed.block_id)}:${String(seed.block_rank)}`),
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
  for (const field of ["non_primary_final_max_gap", "non_primary_final_sum_gap"]) {
    if (metrics[field] !== undefined && metrics[field] !== null) {
      nonNegativeInteger(metrics[field], `2日目監査値${field}`);
    }
  }
  for (const final of arrayValue(
    metrics.placement_tournament_finals ?? [],
    "順位帯別決勝監査値",
    4,
  )) {
    if (typeof final.pool_id !== "string") {
      throw new ImportValidationError("INVALID_DOCUMENT", "順位帯別決勝監査値が不正です。");
    }
    nonNegativeInteger(final.section_no, "決勝セクション");
    nonNegativeInteger(final.final_section_gap, "決勝セクション差");
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
    if (input.schema_version === SCHEMA_VERSION) {
      assertNewDay2FinalPlacement(schedule, tournamentPlan);
    } else {
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

function leagueRankKey(value: unknown): string {
  const entry = objectValue(value, "同順位リーグの順位枠を読み取れませんでした。");
  if (
    entry.type !== "league_rank" ||
    typeof entry.block_id !== "string" ||
    !Number.isInteger(entry.rank) ||
    Number(entry.rank) < 1
  ) {
    throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグの順位枠が不正です。");
  }
  return `${entry.block_id}:${String(entry.rank)}`;
}

function validateSameRankDay2Schedule(
  result: JsonObject,
  input: JsonObject,
  plan: JsonObject,
  expectedMatches: ReadonlyMap<string, JsonObject>,
  validRankKeys: ReadonlySet<string>,
  teamByRank: ReadonlyMap<string, string>,
  resolution: "provisional" | "resolved",
): void {
  const schedule = objectValue(result.day2_schedule, "同順位リーグ日程を読み取れませんでした。");
  const day = validateDay2Settings(input);
  if (day === undefined) {
    throw new ImportValidationError("INVALID_REFERENCE", "2日目設定がないため同順位リーグ日程を復元できません。");
  }
  if (
    schedule.schema_version !== SCHEMA_VERSION ||
    schedule.schedule_scope !== "day2_same_rank_league" ||
    schedule.participant_resolution !== resolution ||
    !new Set(["OPTIMAL", "FEASIBLE"]).has(String(schedule.status))
  ) {
    throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグ日程の状態が計画と一致しません。");
  }
  const scheduledMatches = arrayValue(
    schedule.same_rank_matches,
    "日程内の同順位リーグ試合",
    LIMITS.matches,
  );
  const expectedMatchList = [...expectedMatches.values()];
  if (JSON.stringify(scheduledMatches) !== JSON.stringify(expectedMatchList)) {
    throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグ計画と日程の対戦構造が一致しません。");
  }
  const courts = arrayValue(input.courts, "コート", LIMITS.courts);
  const courtIds = new Set(courts.map((court) => String(court.id)));
  const referees = objectValue(input.referees, "審判設定を読み取れませんでした。");
  const organizerCapacity = nonNegativeInteger(referees.organizer_capacity, "主催者審判能力");
  const fallback = referees.day2_fallback;
  if (fallback !== "organizer" && fallback !== "strict") {
    throw new ImportValidationError("INVALID_DOCUMENT", "2日目の審判フォールバック設定が不正です。");
  }
  const metrics = objectValue(schedule.metrics, "同順位リーグ日程の監査値を読み取れませんでした。");
  const usedSections = nonNegativeInteger(metrics.used_sections, "同順位リーグ使用セクション数");
  if (usedSections > LIMITS.sections) {
    throw new ImportValidationError("LIMIT_EXCEEDED", "同順位リーグの使用セクション数が上限を超えています。");
  }
  const slots = arrayValue(schedule.slots, "同順位リーグ日程スロット", LIMITS.slots);
  const positions = new Set<string>();
  const assignedMatches = new Set<string>();
  const organizerBySection = new Map<number, number>();
  const refereeCounts = new Map([...validRankKeys].map((key) => [key, 0]));
  const matchSections = new Map<string, number[]>();
  const occupiedSlots: Array<{ section: number; court: string; match: JsonObject; refereeRank?: string }> = [];
  const courtMatchCounts = new Map([...courtIds].map((court) => [court, 0]));
  let organizerCount = 0;
  let fallbackCount = 0;
  const roles = new Map<string, Array<{ section: number; court: string; role: "match" | "referee"; matchId: string }>>();
  const expectedRoutes = new Set<string>();
  const pushRole = (
    rankKey: string,
    section: number,
    court: string,
    role: "match" | "referee",
    matchId: string,
  ): void => {
    const entries = roles.get(rankKey) ?? [];
    entries.push({ section, court, role, matchId });
    roles.set(rankKey, entries);
    expectedRoutes.add(`${rankKey}|${role}|${matchId}|${String(section)}|${court}`);
  };
  for (const slot of slots) {
    const section = nonNegativeInteger(slot.section_no, "同順位リーグのセクション番号");
    const court = typeof slot.court_id === "string" ? slot.court_id : "";
    const position = `${String(section)}:${court}`;
    if (
      slot.day_id !== "day2" || section < 1 || section > usedSections ||
      !courtIds.has(court) || positions.has(position)
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグ日程のスロット位置が不正です。");
    }
    positions.add(position);
    if (slot.match_id === null) {
      if (slot.referee_assignment !== null) {
        throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグの空きスロットに審判があります。");
      }
      continue;
    }
    const matchId = typeof slot.match_id === "string" ? slot.match_id : "";
    const match = expectedMatches.get(matchId);
    if (match === undefined || assignedMatches.has(matchId)) {
      throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグの試合配置が重複または不明です。");
    }
    assignedMatches.add(matchId);
    const home = leagueRankKey(match.home);
    const away = leagueRankKey(match.away);
    pushRole(home, section, court, "match", matchId);
    pushRole(away, section, court, "match", matchId);
    matchSections.set(home, [...(matchSections.get(home) ?? []), section]);
    matchSections.set(away, [...(matchSections.get(away) ?? []), section]);
    courtMatchCounts.set(court, (courtMatchCounts.get(court) ?? 0) + 1);
    const assignment = objectValue(slot.referee_assignment, "同順位リーグの審判割当てを読み取れませんでした。");
    if (assignment.kind === "organizer") {
      organizerCount += 1;
      organizerBySection.set(section, (organizerBySection.get(section) ?? 0) + 1);
      const first = section === 1;
      if (
        assignment.rank_ref != null || assignment.team_id != null ||
        (first && assignment.organizer_reason !== "first_section") ||
        (!first &&
          (fallback !== "organizer" || assignment.organizer_reason !== "fallback" ||
            !Array.isArray(assignment.fallback_reasons) || assignment.fallback_reasons.length === 0 ||
            assignment.fallback_reasons.some((reason) => typeof reason !== "string")))
      ) {
        throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグの主催者審判理由が不正です。");
      }
      if (!first) fallbackCount += 1;
    } else if (assignment.kind === "team") {
      const refereeRank = leagueRankKey(assignment.rank_ref);
      const expectedTeam = teamByRank.get(refereeRank);
      if (
        section === 1 || !validRankKeys.has(refereeRank) || refereeRank === home || refereeRank === away ||
        assignment.organizer_reason != null ||
        !Array.isArray(assignment.fallback_reasons) || assignment.fallback_reasons.length > 0 ||
        (resolution === "provisional" && assignment.team_id != null) ||
        (resolution === "resolved" && assignment.team_id !== expectedTeam)
      ) {
        throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグのチーム審判参照が不正です。");
      }
      pushRole(refereeRank, section, court, "referee", matchId);
      refereeCounts.set(refereeRank, (refereeCounts.get(refereeRank) ?? 0) + 1);
      occupiedSlots.push({ section, court, match, refereeRank });
      continue;
    } else {
      throw new ImportValidationError("INVALID_DOCUMENT", "同順位リーグの審判種別が不正です。");
    }
    occupiedSlots.push({ section, court, match });
  }
  const expectedPositions = new Set(
    Array.from({ length: usedSections }, (_, index) => index + 1).flatMap((section) =>
      [...courtIds].map((court) => `${String(section)}:${court}`)
    ),
  );
  if (
    positions.size !== expectedPositions.size ||
    [...expectedPositions].some((position) => !positions.has(position)) ||
    assignedMatches.size !== expectedMatches.size ||
    [...expectedMatches.keys()].some((matchId) => !assignedMatches.has(matchId))
  ) {
    throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグのスロット格子または試合配置に不足があります。");
  }
  if ([...organizerBySection.values()].some((count) => count > organizerCapacity)) {
    throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグの主催者審判数が能力上限を超えています。");
  }
  for (const entries of roles.values()) {
    const ordered = [...entries].sort((left, right) => left.section - right.section);
    const sectionCounts = new Map<number, number>();
    for (const entry of ordered) {
      sectionCounts.set(entry.section, (sectionCounts.get(entry.section) ?? 0) + 1);
    }
    if ([...sectionCounts.values()].some((count) => count > 1)) {
      throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグで同じ順位枠の役割が同一セクションに重複しています。");
    }
    const violation = sameRankRoleSequenceViolation(ordered);
    if (violation === "consecutive_match") {
      throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグで同じ順位枠の試合が連続しています。");
    }
    if (violation === "match_to_referee_court_change") {
      throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグの試合直後の審判が別コートに配置されています。");
    }
    if (violation === "consecutive_referee") {
      throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグで審判担当が連続しています。");
    }
    if (violation === "referee_source_invalid") {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "同順位リーグのチーム審判が直前セクションの同じコートの試合から供給されていません。",
      );
    }
  }
  const routes = arrayValue(schedule.team_schedules, "同順位リーグ順位枠別予定", LIMITS.matches * LIMITS.teams);
  const actualRoutes = new Set<string>();
  for (const route of routes) {
    const rankKey = leagueRankKey(route.rank_ref);
    const role = route.role;
    const routeKey = `${rankKey}|${String(role)}|${String(route.match_id)}|${String(route.section_no)}|${String(route.court_id)}`;
    if (
      !validRankKeys.has(rankKey) || (role !== "match" && role !== "referee") ||
      actualRoutes.has(routeKey) || !expectedRoutes.has(routeKey) ||
      (resolution === "provisional" && route.team_id != null) ||
      (resolution === "resolved" && route.team_id !== teamByRank.get(rankKey))
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグの順位枠別予定が不正です。");
    }
    actualRoutes.add(routeKey);
  }
  if (
    actualRoutes.size !== expectedRoutes.size ||
    [...expectedRoutes].some((route) => !actualRoutes.has(route))
  ) {
    throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグの順位枠別予定に不足があります。");
  }
  const timings = arrayValue(schedule.section_timings, "同順位リーグのセクション時刻", LIMITS.sections);
  const timingBySection = new Map<number, JsonObject>();
  for (const timing of timings) {
    const section = nonNegativeInteger(timing.section_no, "同順位リーグ時刻のセクション");
    if (timing.day_id !== "day2" || timingBySection.has(section)) {
      throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグのセクション時刻が重複しています。");
    }
    timingBySection.set(section, timing);
  }
  const start = clockMinutes(day.start_time);
  const duration = Number(day.game_duration_minutes);
  const margin = Number(day.margin_minutes);
  const breaks = new Map(
    arrayValue(day.breaks ?? [], "2日目の休憩", LIMITS.sections).map((item) => [
      Number(item.after_section), Number(item.duration_minutes),
    ]),
  );
  if (timings.length !== usedSections || start === undefined) {
    throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグの時刻一覧が日程と一致しません。");
  }
  for (let section = 1; section <= usedSections; section += 1) {
    const expectedStart = start + (section - 1) * (duration + margin) + [...breaks]
      .filter(([after]) => after < section)
      .reduce((total, [, minutes]) => total + minutes, 0);
    const timing = timingBySection.get(section);
    if (
      timing === undefined || clockMinutes(timing.start_time) !== expectedStart ||
      clockMinutes(timing.match_end_time) !== expectedStart + duration ||
      Number(timing.break_after_minutes ?? 0) !== (breaks.get(section) ?? 0)
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグの時刻が2日目設定と一致しません。");
    }
  }
  const expectedEnd = usedSections === 0 ? undefined : clockMinutes(timingBySection.get(usedSections)?.match_end_time);
  if (
    (usedSections === 0 && schedule.expected_end_time !== null) ||
    (usedSections > 0 && clockMinutes(schedule.expected_end_time) !== expectedEnd) ||
    (typeof day.max_sections === "number" && usedSections > day.max_sections) ||
    (clockMinutes(day.end_time) !== undefined && expectedEnd !== undefined && expectedEnd > clockMinutes(day.end_time)!)
  ) {
    throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグの日程が2日目の時間上限と一致しません。");
  }
  if (
    metrics.organizer_referee_count !== organizerCount ||
    metrics.fallback_count !== fallbackCount ||
    metrics.unused_slot_count !== slots.length - assignedMatches.size
  ) {
    throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグの日程監査値が配置と一致しません。");
  }
  const recordedRefereeCounts = arrayValue(
    metrics.referee_counts,
    "同順位リーグの審判回数監査値",
    LIMITS.teams,
  );
  const recordedRankKeys = new Set<string>();
  for (const item of recordedRefereeCounts) {
    const rankKey = leagueRankKey(item.rank_ref);
    if (
      recordedRankKeys.has(rankKey) || !validRankKeys.has(rankKey) ||
      item.count !== refereeCounts.get(rankKey) ||
      (resolution === "provisional" && item.team_id != null) ||
      (resolution === "resolved" && item.team_id !== teamByRank.get(rankKey))
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグの審判回数監査値が配置と一致しません。");
    }
    recordedRankKeys.add(rankKey);
  }
  if (
    recordedRankKeys.size !== validRankKeys.size ||
    [...validRankKeys].some((rankKey) => !recordedRankKeys.has(rankKey))
  ) {
    throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグの審判回数監査値に順位枠の不足があります。");
  }
  const refereeCountValues = [...refereeCounts.values()];
  const refereeCountMin = Math.min(...refereeCountValues);
  const refereeCountMax = Math.max(...refereeCountValues);
  let maximumWait = 0;
  for (const sections of matchSections.values()) {
    const ordered = [...sections].sort((left, right) => left - right);
    for (let index = 1; index < ordered.length; index += 1) {
      maximumWait = Math.max(maximumWait, ordered[index]! - ordered[index - 1]! - 1);
    }
  }
  let refereeThenMatch = 0;
  let gapCourtChanges = 0;
  for (const entries of roles.values()) {
    const ordered = [...entries].sort((left, right) => left.section - right.section);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1]!;
      const current = ordered[index]!;
      if (previous.role === "referee" && current.role === "match" && current.section === previous.section + 1) {
        refereeThenMatch += 1;
      }
      if (current.section - previous.section > 1 && current.court !== previous.court) {
        gapCourtChanges += 1;
      }
    }
  }
  let previousSameCourtReferees = 0;
  for (const occupied of occupiedSlots) {
    if (occupied.refereeRank === undefined) continue;
    const previous = occupiedSlots
      .filter((candidate) => candidate.court === occupied.court && candidate.section < occupied.section)
      .sort((left, right) => right.section - left.section)[0];
    if (previous === undefined) continue;
    const priorRanks = new Set([leagueRankKey(previous.match.home), leagueRankKey(previous.match.away)]);
    if (priorRanks.has(occupied.refereeRank)) previousSameCourtReferees += 1;
  }
  const courtUsage = [...courtMatchCounts.values()];
  const metricValues: Record<string, number> = {
    used_sections: usedSections,
    referee_count_difference: refereeCountMax - refereeCountMin,
    maximum_team_wait_sections: maximumWait,
    referee_then_match_count: refereeThenMatch,
    previous_same_court_referee_count: previousSameCourtReferees,
    gap_court_change_count: gapCourtChanges,
    court_usage_difference: Math.max(...courtUsage) - Math.min(...courtUsage),
  };
  if (
    metrics.referee_count_min !== refereeCountMin ||
    metrics.referee_count_max !== refereeCountMax ||
    metrics.referee_count_difference !== metricValues.referee_count_difference ||
    metrics.maximum_team_wait_sections !== maximumWait ||
    metrics.referee_then_match_count !== refereeThenMatch ||
    metrics.previous_same_court_referee_count !== previousSameCourtReferees ||
    metrics.gap_court_change_count !== gapCourtChanges ||
    metrics.court_usage_difference !== metricValues.court_usage_difference
  ) {
    throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグの日程監査値が配置と一致しません。");
  }
  const objectives = [
    "used_sections", "referee_count_difference", "maximum_team_wait_sections",
    "gap_court_change_count", "court_usage_difference",
  ];
  const optimizedObjectives = metrics.optimized_objectives;
  if (
    !Array.isArray(optimizedObjectives) || optimizedObjectives.length > objectives.length ||
    optimizedObjectives.some((objective) => typeof objective !== "string")
  ) {
    throw new ImportValidationError("INVALID_DOCUMENT", "同順位リーグの最適化目的を読み取れませんでした。");
  }
  const stages = arrayValue(metrics.objective_stages, "同順位リーグの目的別監査値", objectives.length);
  if (
    JSON.stringify(optimizedObjectives) !== JSON.stringify(objectives) || stages.length !== objectives.length ||
    stages.some((stage, index) =>
      stage.objective !== objectives[index] || stage.value !== metricValues[objectives[index]!] ||
      typeof stage.optimality_proven !== "boolean"
    ) ||
    typeof metrics.optimality_proven !== "boolean" ||
    metrics.optimality_proven !== stages.every((stage) => stage.optimality_proven === true) ||
    (schedule.status === "OPTIMAL") !== metrics.optimality_proven
  ) {
    throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグの目的別監査値が配置と一致しません。");
  }
  const validation = objectValue(schedule.validation, "同順位リーグ日程の独立検証を読み取れませんでした。");
  const validationSummary = objectValue(validation.summary, "同順位リーグ日程の検証集計を読み取れませんでした。");
  if (
    validation.valid !== true || !Array.isArray(validation.diagnostics) || validation.diagnostics.length > 0 ||
    validationSummary.expected_match_count !== expectedMatches.size ||
    validationSummary.scheduled_match_count !== assignedMatches.size ||
    validationSummary.used_sections !== usedSections ||
    validationSummary.organizer_referee_count !== organizerCount ||
    validationSummary.fallback_count !== fallbackCount || validationSummary.error_count !== 0
  ) {
    throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグ日程の独立検証が配置と一致しません。");
  }
  const integrated = objectValue(schedule.integrated_validation, "同順位リーグの統合検証を読み取れませんでした。");
  const integratedSummary = objectValue(integrated.summary, "同順位リーグの統合検証集計を読み取れませんでした。");
  if (
    integrated.valid !== true || !Array.isArray(integrated.diagnostics) || integrated.diagnostics.length > 0 ||
    JSON.stringify(integratedSummary.day2) !== JSON.stringify(validationSummary) ||
    integratedSummary.error_count !== 0 ||
    result.integrated_validation === undefined ||
    JSON.stringify(result.integrated_validation) !== JSON.stringify(schedule.integrated_validation)
  ) {
    throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグの統合検証結果が一致しません。");
  }
  void plan;
}

function validateSameRankState(
  result: JsonObject,
  input: JsonObject,
  teams: JsonObject[],
  blocks: JsonObject[],
  standings: JsonObject[] | undefined,
): void {
  const plan = objectValue(result.same_rank_plan, "同順位リーグ計画を読み取れませんでした。");
  const finalStage = objectValue(input.final_stage, "決勝方式を読み取れませんでした。");
  const teamCount = teams.length;
  const blockCount = blocks.length;
  const q = Math.floor(teamCount / blockCount);
  const r = teamCount % blockCount;
  const policy = finalStage.uneven_policy;
  if (
    finalStage.format !== "same_rank_league" ||
    (policy !== "strict_same_rank" && policy !== "merge_bottom") ||
    (r === 0 && policy !== "strict_same_rank") ||
    plan.schema_version !== SCHEMA_VERSION ||
    plan.format !== "same_rank_league" ||
    plan.status !== "COMPLETE" ||
    plan.team_count !== teamCount ||
    plan.block_count !== blockCount ||
    plan.uneven_policy !== policy ||
    !Number.isInteger(plan.random_seed)
  ) {
    throw new ImportValidationError("INVALID_DOCUMENT", "同順位リーグの構成が大会設定と一致しません。");
  }
  const resolution = plan.participant_resolution;
  if (
    (resolution !== "provisional" && resolution !== "resolved") ||
    (resolution === "resolved") !== (standings !== undefined)
  ) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "同順位リーグの仮・確定状態が予選順位と一致しません。",
    );
  }
  const blockSizes = new Map(
    blocks.map((block) => [
      String(block.id),
      stringArray(block.team_ids, `${String(block.id)}ブロックのチーム一覧`).length,
    ]),
  );
  const validRankKeys = new Set(
    [...blockSizes].flatMap(([blockId, size]) =>
      Array.from({ length: size }, (_, index) => `${blockId}:${String(index + 1)}`)
    ),
  );
  const teamByRank = new Map(
    (standings ?? []).map((row) => [
      `${String(row.block_id)}:${String(row.rank)}`,
      String(row.team_id),
    ]),
  );
  const expectedGroups: Array<{
    id: string;
    ranks: number[];
    range: [number, number];
    size: number;
  }> = [];
  if (policy === "strict_same_rank") {
    for (let rank = 1; rank <= q; rank += 1) {
      expectedGroups.push({
        id: `same-rank-${String(rank)}`,
        ranks: [rank],
        range: [(rank - 1) * blockCount + 1, rank * blockCount],
        size: blockCount,
      });
    }
    if (r > 0) {
      expectedGroups.push({
        id: `same-rank-${String(q + 1)}`,
        ranks: [q + 1],
        range: [q * blockCount + 1, teamCount],
        size: r,
      });
    }
  } else {
    for (let rank = 1; rank < q; rank += 1) {
      expectedGroups.push({
        id: `same-rank-${String(rank)}`,
        ranks: [rank],
        range: [(rank - 1) * blockCount + 1, rank * blockCount],
        size: blockCount,
      });
    }
    expectedGroups.push({
      id: "same-rank-bottom",
      ranks: [q, q + 1],
      range: [(q - 1) * blockCount + 1, teamCount],
      size: blockCount + r,
    });
  }
  const groups = arrayValue(plan.groups, "同順位グループ", LIMITS.teams);
  if (groups.length !== expectedGroups.length) {
    throw new ImportValidationError("INVALID_REFERENCE", "同順位グループ数が端数処理方針と一致しません。");
  }
  const allEntries = new Set<string>();
  const allMatches = new Map<string, JsonObject>();
  for (const [index, group] of groups.entries()) {
    const expected = expectedGroups[index]!;
    const range = Array.isArray(group.overall_rank_range) ? group.overall_rank_range : [];
    const sourceRanks = Array.isArray(group.source_block_ranks)
      ? group.source_block_ranks.map(Number)
      : [];
    const participants = arrayValue(group.participants, "同順位グループ参加枠", LIMITS.teams);
    if (
      group.id !== expected.id ||
      typeof group.display_name !== "string" ||
      group.display_name.length === 0 ||
      JSON.stringify(sourceRanks) !== JSON.stringify(expected.ranks) ||
      JSON.stringify(range) !== JSON.stringify(expected.range) ||
      participants.length !== expected.size
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "同順位グループの順位範囲または人数が不正です。");
    }
    const groupEntries = new Set<string>();
    for (const participant of participants) {
      const key = leagueRankKey(participant.entry);
      const team = participant.team == null ? undefined : objectValue(participant.team, "参加チーム参照が不正です。");
      if (
        !validRankKeys.has(key) ||
        groupEntries.has(key) ||
        allEntries.has(key) ||
        !expected.ranks.includes(Number(key.split(":").at(-1))) ||
        (resolution === "provisional" && team !== undefined) ||
        (resolution === "resolved" &&
          (team?.type !== "concrete_team" || teamByRank.get(key) !== team.team_id))
      ) {
        throw new ImportValidationError("INVALID_REFERENCE", "同順位グループの参加順位枠が不正です。");
      }
      groupEntries.add(key);
      allEntries.add(key);
    }
    const matches = arrayValue(group.matches, "同順位リーグ試合", LIMITS.matches);
    if (matches.length !== expected.size * (expected.size - 1) / 2) {
      throw new ImportValidationError("INVALID_REFERENCE", "同順位グループの総当たり試合数が不正です。");
    }
    const pairs = new Set<string>();
    const groupMatchIds = new Set<string>();
    for (const match of matches) {
      const home = leagueRankKey(match.home);
      const away = leagueRankKey(match.away);
      const pair = [home, away].sort().join("|");
      if (
        typeof match.id !== "string" || allMatches.has(match.id) ||
        match.phase !== "same_rank_league" || match.group_id !== group.id || home === away ||
        !groupEntries.has(home) || !groupEntries.has(away) || pairs.has(pair)
      ) {
        throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグの対戦参照が不正です。");
      }
      pairs.add(pair);
      allMatches.set(match.id, match);
      groupMatchIds.add(match.id);
    }
    const rounds = arrayValue(group.logical_rounds, "同順位リーグ論理ラウンド", LIMITS.matches);
    const roundMatches = rounds.flatMap((round) => {
      if (round.group_id !== group.id || !Number.isInteger(round.round_no)) {
        throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグの論理ラウンドが不正です。");
      }
      return stringArray(round.match_ids, "同順位リーグ論理ラウンドの試合");
    });
    if (
      new Set(roundMatches).size !== matches.length ||
      roundMatches.some((id) => !groupMatchIds.has(id))
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグの論理ラウンドに重複または欠落があります。");
    }
  }
  if (allEntries.size !== teamCount || [...validRankKeys].some((key) => !allEntries.has(key))) {
    throw new ImportValidationError("INVALID_REFERENCE", "同順位グループが全参加順位枠を覆っていません。");
  }
  const warningCodes = arrayValue(plan.warnings, "同順位リーグ警告", LIMITS.teams).map((warning) => {
    if (
      !new Set(["SAME_RANK_UNEVEN_BLOCKS", "SAME_RANK_SINGLETON_GROUP"]).has(String(warning.code)) ||
      typeof warning.message !== "string"
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグ警告が不正です。");
    }
    return String(warning.code);
  });
  const expectedWarnings = [
    ...(r > 0 ? ["SAME_RANK_UNEVEN_BLOCKS"] : []),
    ...(policy === "strict_same_rank" && r === 1 ? ["SAME_RANK_SINGLETON_GROUP"] : []),
  ];
  if (JSON.stringify(warningCodes) !== JSON.stringify(expectedWarnings)) {
    throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグ警告が端数構成と一致しません。");
  }
  const automatic = arrayValue(plan.automatic_standings, "自動確定順位", LIMITS.teams);
  if (automatic.length !== (policy === "strict_same_rank" && r === 1 ? 1 : 0)) {
    throw new ImportValidationError("INVALID_REFERENCE", "1チームグループの自動順位が不正です。");
  }

  if (result.day2_schedule !== undefined) {
    validateSameRankDay2Schedule(
      result,
      input,
      plan,
      allMatches,
      validRankKeys,
      teamByRank,
      resolution,
    );
  } else if (result.integrated_validation !== undefined) {
    throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグ日程なしでは統合検証を復元できません。");
  }

  const rawResults = result.same_rank_league_results === undefined
    ? []
    : arrayValue(result.same_rank_league_results, "同順位リーグ結果", LIMITS.matches);
  const resultIds = new Set<string>();
  for (const matchResult of rawResults) {
    const match = allMatches.get(String(matchResult.match_id));
    const homeTeam = match === undefined || match.home_team == null
      ? undefined
      : objectValue(match.home_team, "同順位リーグのホームチームが不正です。");
    const awayTeam = match === undefined || match.away_team == null
      ? undefined
      : objectValue(match.away_team, "同順位リーグのアウェーチームが不正です。");
    if (
      match === undefined || resultIds.has(String(matchResult.match_id)) ||
      resolution !== "resolved" || matchResult.home_team_id !== homeTeam?.team_id ||
      matchResult.away_team_id !== awayTeam?.team_id ||
      matchResult.penalty_score_home != null || matchResult.penalty_score_away != null
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグ結果の対戦またはPK項目が不正です。");
    }
    nonNegativeInteger(matchResult.regular_score_home, "同順位リーグのホーム得点");
    nonNegativeInteger(matchResult.regular_score_away, "同順位リーグのアウェー得点");
    resultIds.add(String(matchResult.match_id));
  }
  if (result.same_rank_standings !== undefined) {
    if (resultIds.size !== allMatches.size) {
      throw new ImportValidationError("INVALID_REFERENCE", "全試合結果がないため同順位リーグ順位を復元できません。");
    }
    const final = objectValue(result.same_rank_standings, "同順位リーグ順位を読み取れませんでした。");
    const rows = arrayValue(final.standings, "同順位リーグ順位", LIMITS.teams);
    const ranks = rows.map((row) => nonNegativeInteger(row.rank, "同順位リーグ総合順位"));
    const rankedTeams = rows.map((row) => String(row.team_id));
    if (
      final.schema_version !== SCHEMA_VERSION || final.status !== "COMPLETE" ||
      rows.some((row, index) => row.rank !== index + 1) ||
      JSON.stringify([...ranks].sort((a, b) => a - b)) !==
        JSON.stringify(Array.from({ length: teamCount }, (_, index) => index + 1)) ||
      new Set(rankedTeams).size !== teamCount || rankedTeams.some((id) => !teams.some((team) => team.id === id))
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグの総合順位に重複または欠落があります。");
    }
    const savedResults = new Map(rawResults.map((matchResult) => [String(matchResult.match_id), matchResult]));
    const canonicalMatchResults = arrayValue(final.match_results, "検証済み同順位リーグ結果", LIMITS.matches);
    const canonicalIds = new Set<string>();
    if (canonicalMatchResults.length !== rawResults.length) {
      throw new ImportValidationError("INVALID_REFERENCE", "検証済み同順位リーグ結果に不足があります。");
    }
    for (const canonical of canonicalMatchResults) {
      const saved = savedResults.get(String(canonical.match_id));
      const home = Number(saved?.regular_score_home);
      const away = Number(saved?.regular_score_away);
      const outcome = home > away ? "home_win" : home < away ? "away_win" : "draw";
      if (
        saved === undefined || canonicalIds.has(String(canonical.match_id)) ||
        canonical.home_team_id !== saved.home_team_id ||
        canonical.away_team_id !== saved.away_team_id || canonical.regular_score_home !== home ||
        canonical.regular_score_away !== away || canonical.outcome !== outcome
      ) {
        throw new ImportValidationError("INVALID_REFERENCE", "検証済み同順位リーグ結果が入力結果と一致しません。");
      }
      canonicalIds.add(String(canonical.match_id));
    }
    type SameRankStat = {
      played: number; wins: number; draws: number; losses: number;
      goalsFor: number; goalsAgainst: number; points: number;
    };
    const stat = (): SameRankStat => ({
      played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, points: 0,
    });
    const rowByTeam = new Map(rows.map((row) => [String(row.team_id), row]));
    for (const group of groups) {
      const participants = arrayValue(group.participants, "同順位グループ参加枠", LIMITS.teams);
      const teamIds = participants.map((participant) => {
        const team = objectValue(participant.team, "同順位リーグ参加チームを読み取れませんでした。");
        return String(team.team_id);
      });
      const entryByTeam = new Map(
        participants.map((participant) => [
          String(objectValue(participant.team, "同順位リーグ参加チームを読み取れませんでした。").team_id),
          leagueRankKey(participant.entry),
        ]),
      );
      const stats = new Map(teamIds.map((teamId) => [teamId, stat()]));
      for (const match of arrayValue(group.matches, "同順位リーグ試合", LIMITS.matches)) {
        const matchResult = savedResults.get(String(match.id));
        if (matchResult === undefined) {
          throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグ順位に必要な試合結果が不足しています。");
        }
        const homeId = String(matchResult.home_team_id);
        const awayId = String(matchResult.away_team_id);
        const home = stats.get(homeId);
        const away = stats.get(awayId);
        if (home === undefined || away === undefined) {
          throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグ結果のグループ参照が不正です。");
        }
        const homeScore = Number(matchResult.regular_score_home);
        const awayScore = Number(matchResult.regular_score_away);
        home.played += 1;
        away.played += 1;
        home.goalsFor += homeScore;
        home.goalsAgainst += awayScore;
        away.goalsFor += awayScore;
        away.goalsAgainst += homeScore;
        if (homeScore > awayScore) {
          home.wins += 1;
          home.points += 3;
          away.losses += 1;
        } else if (awayScore > homeScore) {
          away.wins += 1;
          away.points += 3;
          home.losses += 1;
        } else {
          home.draws += 1;
          away.draws += 1;
          home.points += 1;
          away.points += 1;
        }
      }
      const range = Array.isArray(group.overall_rank_range) ? group.overall_rank_range.map(Number) : [];
      const groupRows = teamIds.map((teamId) => rowByTeam.get(teamId));
      if (groupRows.some((row) => row === undefined)) {
        throw new ImportValidationError("INVALID_REFERENCE", "同順位グループ順位に不足があります。");
      }
      const orderedRows = groupRows as JsonObject[];
      for (const row of orderedRows) {
        const teamId = String(row.team_id);
        const values = stats.get(teamId)!;
        const automatic = teamIds.length === 1;
        const headToHead = row.head_to_head == null
          ? undefined
          : objectValue(row.head_to_head, "同順位リーグの直接対戦値を読み取れませんでした。");
        if (
          row.group_id !== group.id ||
          leagueRankKey(row.entry) !== entryByTeam.get(teamId) ||
          row.rank !== Number(range[0]) + Number(row.group_rank) - 1 ||
          Number(row.rank) < Number(range[0]) || Number(row.rank) > Number(range[1]) ||
          row.played !== values.played || row.wins !== values.wins || row.draws !== values.draws ||
          row.losses !== values.losses || row.goals_for !== values.goalsFor ||
          row.goals_against !== values.goalsAgainst ||
          row.goal_difference !== values.goalsFor - values.goalsAgainst ||
          row.points !== values.points || typeof row.tie_break !== "string" || row.tie_break.length === 0 ||
          (headToHead !== undefined && (
            !Number.isInteger(headToHead.points) || Number(headToHead.points) < 0 ||
            !Number.isInteger(headToHead.goal_difference) ||
            !Number.isInteger(headToHead.goals_for) || Number(headToHead.goals_for) < 0
          )) ||
          row.automatic !== automatic
        ) {
          throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグ順位が保存済み結果と一致しません。");
        }
      }
      const sortedByGroupRank = [...orderedRows].sort(
        (left, right) => Number(left.group_rank) - Number(right.group_rank),
      );
      if (
        sortedByGroupRank.some((row, index) => row.group_rank !== index + 1) ||
        sortedByGroupRank.some((row, index) => {
          const next = sortedByGroupRank[index + 1];
          if (next === undefined) return false;
          return Number(row.points) < Number(next.points) ||
            (row.points === next.points && Number(row.goal_difference) < Number(next.goal_difference)) ||
            (row.points === next.points && row.goal_difference === next.goal_difference &&
              Number(row.goals_for) < Number(next.goals_for));
        })
      ) {
        throw new ImportValidationError("INVALID_REFERENCE", "同順位グループ順位の並びが成績と一致しません。");
      }
    }
    const draws = arrayValue(final.draws, "同順位リーグ抽選記録", LIMITS.teams);
    for (const draw of draws) {
      const candidates = stringArray(draw.candidates, "同順位リーグ抽選候補");
      const decided = stringArray(draw.decided_order, "同順位リーグ抽選確定順");
      const candidateValues = arrayValue(draw.candidate_values, "同順位リーグ抽選候補値", LIMITS.teams);
      const candidateValueTeams = new Set<string>();
      for (const candidateValue of candidateValues) {
        const teamId = String(candidateValue.team_id);
        const metrics = objectValue(candidateValue.head_to_head, "同順位リーグ抽選候補の直接対戦値を読み取れませんでした。");
        const standingMetrics = rowByTeam.get(teamId)?.head_to_head;
        if (
          candidateValueTeams.has(teamId) || !candidates.includes(teamId) ||
          JSON.stringify(metrics) !== JSON.stringify(standingMetrics)
        ) {
          throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグ抽選候補値が順位表と一致しません。");
        }
        candidateValueTeams.add(teamId);
      }
      if (
        !groups.some((group) => group.id === draw.group_id) ||
        candidates.length < 2 || new Set(candidates).size !== candidates.length ||
        candidates.some((teamId) => rowByTeam.get(teamId)?.group_id !== draw.group_id) ||
        decided.length !== candidates.length || new Set(decided).size !== candidates.length ||
        decided.some((teamId) => !candidates.includes(teamId)) ||
        candidateValueTeams.size !== candidates.length || draw.random_seed !== plan.random_seed
      ) {
        throw new ImportValidationError("INVALID_REFERENCE", "同順位リーグ抽選記録が不正です。");
      }
    }
  }
}

function validateLeagueResult(result: JsonObject, teams: JsonObject[], input: JsonObject): void {
  const planValue = result.league_plan;
  if (planValue === undefined) {
    if (
      result.league_results !== undefined ||
      result.league_standings !== undefined ||
      result.tournament_plan !== undefined ||
      result.same_rank_plan !== undefined ||
      result.day2_schedule !== undefined ||
      result.integrated_validation !== undefined ||
      result.tournament_results !== undefined ||
      result.final_standings !== undefined ||
      result.same_rank_league_results !== undefined ||
      result.same_rank_standings !== undefined
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
    if (result.same_rank_plan !== undefined) {
      validateSameRankState(result, input, teams, blocks, undefined);
    } else if (result.tournament_plan !== undefined) {
      const { oddSplitPolicy, tournamentCount, tournamentNames } =
        tournamentPlanValidationContext(input);
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
        tournamentNames,
      );
      validateDay2ScheduleResult(result, input, teams, tournamentPlan, undefined);
      validateTournamentResultsState(result, tournamentPlan);
    } else if (
      result.day2_schedule !== undefined ||
      result.integrated_validation !== undefined ||
      result.same_rank_league_results !== undefined ||
      result.same_rank_standings !== undefined
    ) {
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
  if (result.same_rank_plan !== undefined) {
    validateSameRankState(result, input, teams, blocks, rows);
  } else if (result.tournament_plan !== undefined) {
    const { oddSplitPolicy, tournamentCount, tournamentNames } =
      tournamentPlanValidationContext(input);
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
      tournamentNames,
    );
    validateDay2ScheduleResult(result, input, teams, tournamentPlan, rows);
    validateTournamentResultsState(result, tournamentPlan);
  } else if (
    result.day2_schedule !== undefined ||
    result.integrated_validation !== undefined ||
    result.tournament_results !== undefined ||
    result.final_standings !== undefined ||
    result.same_rank_league_results !== undefined ||
    result.same_rank_standings !== undefined
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
  tournamentNames?: string[];
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
    const tournamentNames = Array.isArray(finalStage.tournament_names)
      ? finalStage.tournament_names.map((name) => String(name))
      : undefined;
    return {
      oddSplitPolicy: "upper",
      tournamentCount: finalStage.tournament_count,
      ...(tournamentNames === undefined ? {} : { tournamentNames }),
    };
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
        (actual.pool_id ?? actual.pool) !== expected.pool ||
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

function validateCurrentTournamentPlan(
  plan: JsonObject,
  standings: JsonObject[] | undefined,
  teamIds: Set<string>,
  validLeagueRanks: Set<string>,
  expectedTournamentCount: number | undefined,
  expectedTournamentNames: readonly string[] | undefined,
): void {
  const teamCount = teamIds.size;
  const tournamentCount = expectedTournamentCount ?? 0;
  const blockIds = new Set([...validLeagueRanks].map((key) => key.slice(0, key.lastIndexOf(":"))));
  const blockCount = blockIds.size;
  const allowedBlocks = new Map<string, readonly number[]>([
    ["8:2", [2, 4]],
    ["16:2", [2, 4, 8]],
    ["24:3", [2, 4, 8]],
    ["32:2", [2, 4, 8, 16]],
    ["32:4", [2, 4, 8]],
  ]).get(`${String(teamCount)}:${String(tournamentCount)}`);
  const participantCount = tournamentCount > 0 ? teamCount / tournamentCount : 0;
  const blockSize = blockCount > 0 ? teamCount / blockCount : 0;
  const rankBandWidth = tournamentCount > 0 ? blockSize / tournamentCount : 0;
  let planTournamentNames: string[] | undefined;
  if (plan.tournament_names !== undefined) {
    if (
      !Array.isArray(plan.tournament_names) || plan.tournament_names.length > 4 ||
      plan.tournament_names.some((name) =>
        typeof name !== "string" || name.trim() !== name || name.length === 0 || name.length > 200
      )
    ) {
      throw new ImportValidationError("INVALID_DOCUMENT", "トーナメント名が不正です。");
    }
    planTournamentNames = plan.tournament_names as string[];
  }
  if (
    plan.format !== "placement_tournament"
    || plan.tournament_count !== expectedTournamentCount
    || plan.odd_split_policy !== undefined
    || !Array.isArray(plan.pools)
    || plan.pools.length !== expectedTournamentCount
    || allowedBlocks === undefined
    || !allowedBlocks.includes(blockCount)
    || !Number.isInteger(participantCount)
    || !Number.isInteger(blockSize)
    || !Number.isInteger(rankBandWidth)
    || (planTournamentNames !== undefined && planTournamentNames.length !== tournamentCount)
    || (expectedTournamentNames !== undefined && planTournamentNames !== undefined && (
      expectedTournamentNames.length !== tournamentCount ||
      planTournamentNames.some((name, index) => name !== expectedTournamentNames[index])
    ))
  ) {
    throw new ImportValidationError("INVALID_DOCUMENT", "順位決定トーナメントの構成が不正です。");
  }
  const resolution = plan.participant_resolution;
  if (
    (resolution !== "provisional" && resolution !== "resolved")
    || (resolution === "resolved") !== (standings !== undefined)
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
  const pools = placementTournamentPools(plan);
  if (pools.length !== expectedTournamentCount) {
    throw new ImportValidationError("INVALID_DOCUMENT", "順位帯の数が設定と一致しません。");
  }
  const allSeedRanks = new Set<string>();
  const allSeedTeams = new Set<string>();
  const allMatchIds = new Set<string>();
  let expectedOverallStart = 1;
  const poolAudit = new Map<string, {
    seedRanks: Set<string>;
    seedRanksByRank: Map<number, string[]>;
    matchIds: Set<string>;
    firstMatchCount: number;
  }>();

  for (const [index, poolInfo] of pools.entries()) {
    const pool = poolInfo.data;
    if (
      poolInfo.poolId !== `placement-${String(index + 1)}`
      || poolInfo.poolIndex !== index + 1
      || typeof pool.display_name !== "string"
      || pool.display_name.length === 0
      || (planTournamentNames !== undefined &&
        pool.display_name !== planTournamentNames[index])
      || (expectedTournamentNames !== undefined && planTournamentNames !== undefined &&
        pool.display_name !== expectedTournamentNames[index])
      || pool.byes !== undefined
    ) {
      throw new ImportValidationError("INVALID_DOCUMENT", "順位帯の識別情報が不正です。");
    }
    const poolParticipantCount = nonNegativeInteger(pool.participant_count, "順位帯参加数");
    if (![4, 8, 16].includes(poolParticipantCount) || poolParticipantCount !== participantCount) {
      throw new ImportValidationError("INVALID_DOCUMENT", "順位帯参加数が対応範囲外です。");
    }
    const poolRange = Array.isArray(pool.pool_rank_range) ? pool.pool_rank_range : [];
    const overallRange = Array.isArray(pool.overall_rank_range) ? pool.overall_rank_range : [];
    if (
      poolRange[0] !== 1
      || poolRange[1] !== poolParticipantCount
      || overallRange[0] !== expectedOverallStart
      || overallRange[1] !== expectedOverallStart + poolParticipantCount - 1
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "順位帯の順位範囲に欠落があります。");
    }
    expectedOverallStart += poolParticipantCount;

    const seeds = arrayValue(pool.seeds, "順位帯シード", LIMITS.teams);
    if (seeds.length !== poolParticipantCount) {
      throw new ImportValidationError("INVALID_REFERENCE", "順位帯参加数とシード数が一致しません。");
    }
    const seedRanks = new Set<string>();
    const seedRanksByRank = new Map<number, string[]>();
    const seedNumbers = new Set<number>();
    const seedTeams = new Set<string>();
    for (const seed of seeds) {
      const seedNo = nonNegativeInteger(seed.seed_no, "シード番号");
      const blockRank = nonNegativeInteger(seed.block_rank, "ブロック順位");
      const rankKey = `${String(seed.block_id)}:${String(blockRank)}`;
      const bandStart = index * rankBandWidth + 1;
      const bandEnd = (index + 1) * rankBandWidth;
      if (
        seedNo < 1 || seedNo > poolParticipantCount || seedNumbers.has(seedNo)
        || blockRank < bandStart || blockRank > bandEnd
        || seedRanks.has(rankKey) || !validLeagueRanks.has(rankKey)
        || allSeedRanks.has(rankKey)
      ) {
        throw new ImportValidationError("DUPLICATE_ID", "順位帯シードの内容が不正です。");
      }
      seedNumbers.add(seedNo);
      seedRanks.add(rankKey);
      allSeedRanks.add(rankKey);
      seedRanksByRank.set(blockRank, [...(seedRanksByRank.get(blockRank) ?? []), rankKey]);
      const entry = objectValue(seed.entry, "シード順位枠を読み取れませんでした。");
      if (entry.type !== "league_rank" || entry.block_id !== seed.block_id || entry.rank !== blockRank) {
        throw new ImportValidationError("INVALID_REFERENCE", "シード順位枠が一致しません。");
      }
      if (resolution === "provisional") {
        if (seed.team_id != null || seed.team != null) {
          throw new ImportValidationError("INVALID_REFERENCE", "仮トーナメントにチームが混在しています。");
        }
      } else {
        const team = objectValue(seed.team, "シードチーム参照を読み取れませんでした。");
        if (
          typeof seed.team_id !== "string" || seedTeams.has(seed.team_id)
          || allSeedTeams.has(seed.team_id) || teamByRank.get(rankKey) !== seed.team_id
          || team.type !== "concrete_team" || team.team_id !== seed.team_id
        ) {
          throw new ImportValidationError("INVALID_REFERENCE", "確定シードが順位と一致しません。");
        }
        seedTeams.add(seed.team_id);
        allSeedTeams.add(seed.team_id);
      }
    }
    for (const blockId of blockIds) {
      const count = [...seedRanks].filter((key) => key.startsWith(`${blockId}:`)).length;
      if (count !== rankBandWidth) {
        throw new ImportValidationError("INVALID_REFERENCE", "順位帯のブロック順位幅が不正です。");
      }
    }

    const matches = arrayValue(pool.matches, "順位帯試合", LIMITS.matches);
    if (matches.length !== expectedTournamentMatchCount(poolParticipantCount)) {
      throw new ImportValidationError("INVALID_REFERENCE", "完全順位決定に必要な試合数と一致しません。");
    }
    const matchIds = uniqueIds(matches, "順位帯試合");
    if ([...matchIds].some((id) => allMatchIds.has(id))) {
      throw new ImportValidationError("DUPLICATE_ID", "順位帯間で試合IDが重複しています。");
    }
    matchIds.forEach((id) => allMatchIds.add(id));
    for (const match of matches) {
      const range = Array.isArray(match.rank_range) ? match.rank_range : [];
      if (
        match.phase !== "placement_tournament" || match.pool_id !== poolInfo.poolId
        || typeof match.round !== "string" || !Number.isInteger(match.round_no)
        || Number(match.round_no) < 1 || range.length !== 2
        || !range.every((rank) => Number.isInteger(rank)
          && Number(rank) >= Number(overallRange[0])
          && Number(rank) <= Number(overallRange[1]))
        || Number(range[0]) > Number(range[1])
      ) {
        throw new ImportValidationError("INVALID_DOCUMENT", "順位帯試合の内容が不正です。");
      }
      validateTournamentEntry(match.home, seedRanks, seedTeams, matchIds);
      validateTournamentEntry(match.away, seedRanks, seedTeams, matchIds);
    }
    try {
      readTournamentLogicalLayout(pool);
    } catch (error) {
      if (error instanceof TournamentLogicalLayoutError) {
        throw new ImportValidationError("INVALID_DOCUMENT", error.message);
      }
      throw error;
    }
    const placements = arrayValue(pool.placements, "順位帯最終順位", LIMITS.teams);
    if (placements.length !== poolParticipantCount) {
      throw new ImportValidationError("INVALID_REFERENCE", "順位帯最終順位に不足があります。");
    }
    for (const [placementIndex, placement] of placements.entries()) {
      if (
        placement.rank !== Number(overallRange[0]) + placementIndex
        || placement.pool_rank !== placementIndex + 1
      ) {
        throw new ImportValidationError("INVALID_REFERENCE", "順位帯最終順位に欠落があります。");
      }
      validateTournamentEntry(placement.entry, seedRanks, seedTeams, matchIds);
    }
    const evaluation = objectValue(pool.evaluation, "組合せ評価を読み取れませんでした。");
    const firstMatchCount = nonNegativeInteger(
      evaluation.first_match_same_block_count,
      "初戦同一ブロック対戦数",
    );
    nonNegativeInteger(evaluation.possible_same_block_match_count, "同一ブロック対戦可能性数");
    poolAudit.set(poolInfo.poolId, { seedRanks, seedRanksByRank, matchIds, firstMatchCount });
  }
  if (
    allSeedRanks.size !== validLeagueRanks.size
    || [...validLeagueRanks].some((rank) => !allSeedRanks.has(rank))
    || (resolution === "resolved" && allSeedTeams.size !== teamIds.size)
  ) {
    throw new ImportValidationError("INVALID_REFERENCE", "順位帯の参加枠に重複または不足があります。");
  }

  const draws = arrayValue(plan.seed_draws, "シード抽選記録", LIMITS.teams * 4);
  const drawKeys = new Set<string>();
  for (const draw of draws) {
    const poolId = String(draw.pool_id ?? "");
    const audit = poolAudit.get(poolId);
    const blockRank = nonNegativeInteger(draw.block_rank, "抽選順位");
    const expectedRanks = audit?.seedRanksByRank.get(blockRank) ?? [];
    const candidateRefs = arrayValue(draw.candidate_rank_refs, "抽選順位枠候補", LIMITS.teams);
    const decidedRefs = arrayValue(draw.decided_rank_refs, "抽選順位枠確定順", LIMITS.teams);
    const candidates = stringArray(draw.candidates, "抽選候補");
    const decided = stringArray(draw.decided_order, "抽選確定順");
    const candidateKeys = candidateRefs.map((entry) => `${String(entry.block_id)}:${String(entry.rank)}`);
    const decidedKeys = decidedRefs.map((entry) => `${String(entry.block_id)}:${String(entry.rank)}`);
    const key = `${poolId}:${String(blockRank)}`;
    if (
      audit === undefined || drawKeys.has(key) || draw.random_seed !== plan.random_seed
      || candidateKeys.length !== expectedRanks.length
      || candidateKeys.some((rank) => !expectedRanks.includes(rank))
      || decidedKeys.length !== candidateKeys.length
      || decidedKeys.some((rank) => !candidateKeys.includes(rank))
      || (resolution === "provisional" && (candidates.length > 0 || decided.length > 0))
      || (resolution === "resolved" && candidates.length !== expectedRanks.length)
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "シード抽選記録が不正です。");
    }
    drawKeys.add(key);
  }
  const expectedDrawKeys = [...poolAudit].flatMap(([poolId, audit]) =>
    [...audit.seedRanksByRank]
      .filter(([, ranks]) => ranks.length > 1)
      .map(([rank]) => `${poolId}:${String(rank)}`)
  );
  if (drawKeys.size !== expectedDrawKeys.length || expectedDrawKeys.some((key) => !drawKeys.has(key))) {
    throw new ImportValidationError("INVALID_REFERENCE", "シード抽選記録に不足があります。");
  }
  const warnings = arrayValue(plan.warnings, "トーナメント警告", LIMITS.matches);
  for (const warning of warnings) {
    const audit = poolAudit.get(String(warning.pool_id ?? ""));
    if (
      audit === undefined || typeof warning.code !== "string" || typeof warning.message !== "string"
      || stringArray(warning.match_ids, "警告対象試合").some((id) => !audit.matchIds.has(id))
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "トーナメント警告が不正です。");
    }
  }
}

function validateTournamentPlan(
  plan: JsonObject,
  standings: JsonObject[] | undefined,
  teamIds: Set<string>,
  expectedPolicy: "upper" | "lower" | "alternate",
  rankSets: TournamentRankSets,
  expectedTournamentCount?: number,
  expectedTournamentNames?: readonly string[],
): void {
  const currentPlan = plan.schema_version === SCHEMA_VERSION;
  if (currentPlan) {
    if (
      plan.status !== "COMPLETE"
      || typeof plan.random_seed !== "number"
      || !Number.isInteger(plan.random_seed)
    ) {
      throw new ImportValidationError("INVALID_DOCUMENT", "2日目トーナメントの状態が不正です。");
    }
    validateCurrentTournamentPlan(
      plan,
      standings,
      teamIds,
      rankSets.all,
      expectedTournamentCount,
      expectedTournamentNames,
    );
    return;
  }
  if (
    !isSupportedSchemaVersion(plan.schema_version) ||
    plan.status !== "COMPLETE" ||
    (!new Set(["upper", "lower", "alternate"]).has(String(plan.odd_split_policy)) ||
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
  validateDay1ArrivalPreferences(input, teams);
  validateDay2Settings(input);
  validateManualLeagueSettings(input, teams, false);
  validateFinalStageImportInput(input, teams);
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
  return `${JSON.stringify(normalizeDocument(document).document, null, 2)}\n`;
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
