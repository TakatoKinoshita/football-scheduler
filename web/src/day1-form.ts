import {
  LEGACY_SCHEMA_VERSION,
  SCHEMA_VERSION,
  cloneDocument,
  type JsonObject,
  type TournamentDocument,
} from "./types";
import { analyzeManualBlocks, manualBlocksFromUnknown } from "./manual-blocks";

export type WizardStep = 1 | 2 | 3 | 4;

export interface FieldIssue {
  field: string;
  step: Exclude<WizardStep, 3 | 4>;
  message: string;
}

export interface DocumentMode {
  document: TournamentDocument;
  migrated: boolean;
  legacyCompatibility: boolean;
}

export type FinalStageFormat = "placement_tournament" | "same_rank_league";
export type SameRankUnevenPolicy = "strict_same_rank" | "merge_bottom";

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function objectArray(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is JsonObject =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
}

export function isDay1LeagueInput(input: JsonObject): boolean {
  return input.request_kind === "day1_league";
}

export function buildDay1ScheduleRequest(input: JsonObject): JsonObject {
  const league = { ...(objectValue(input.league) ?? {}) };
  if (league.assignment_mode !== "manual") delete league.manual_blocks;
  const finalStage = { ...(objectValue(input.final_stage) ?? {}) };
  const teamCount = objectArray(input.teams).length;
  const blockCount = numberValue(league.block_count);
  if (
    finalStage.format === "same_rank_league" &&
    blockCount !== undefined &&
    blockCount > 0 &&
    teamCount % blockCount === 0
  ) {
    finalStage.uneven_policy = "strict_same_rank";
  }
  return {
    schema_version: input.schema_version,
    request_kind: input.request_kind,
    teams: input.teams,
    courts: input.courts,
    league,
    final_stage: Object.keys(finalStage).length === 0 ? input.final_stage : finalStage,
    day: input.day,
    referees: input.referees,
    random_seed: input.random_seed,
    solver: input.solver,
  };
}

export function normalizeDocument(document: TournamentDocument): DocumentMode {
  if (
    document.schemaVersion === LEGACY_SCHEMA_VERSION ||
    document.tournament.input.schema_version === LEGACY_SCHEMA_VERSION
  ) {
    return { document, migrated: false, legacyCompatibility: true };
  }
  const input = document.tournament.input;
  if (isDay1LeagueInput(input)) {
    return { document, migrated: false, legacyCompatibility: false };
  }

  return { document, migrated: false, legacyCompatibility: true };
}

/** 0.1.0文書から生成結果を一切持ち込まず、編集可能な0.2.0設定を作る。 */
export function convertLegacyToEditableDocument(
  document: TournamentDocument,
  now = new Date(),
): TournamentDocument {
  const converted = createEditableDocumentFromLegacy(document, now);
  return converted;
}

function createEditableDocumentFromLegacy(
  document: TournamentDocument,
  now: Date,
): TournamentDocument {
  const source = document.tournament.input;
  const league = objectValue(source.league) ?? {};
  const referees = objectValue(source.referees) ?? {};
  const teams = structuredClone(objectArray(source.teams));
  const courts = structuredClone(objectArray(source.courts));
  const converted = cloneDocument(document);
  converted.schemaVersion = SCHEMA_VERSION;
  converted.updatedAt = now.toISOString();
  converted.tournament = {
    name: document.tournament.name,
    input: {
      schema_version: SCHEMA_VERSION,
      request_kind: "day1_league",
      teams,
      courts,
      league: {
        block_count: typeof league.block_count === "number" ? league.block_count : null,
        assignment_mode: new Set(["random", "seeded_snake", "manual"]).has(
            String(league.assignment_mode),
          )
          ? league.assignment_mode
          : "random",
        ...(league.assignment_mode === "manual" && Array.isArray(league.manual_blocks)
          ? { manual_blocks: structuredClone(league.manual_blocks) }
          : {}),
      },
      day: structuredClone(objectValue(source.day)) ?? {
        id: "day1",
        start_time: "09:30",
        game_duration_minutes: 35,
        margin_minutes: 5,
        max_sections: null,
      },
      day2: structuredClone(objectValue(source.day2)) ?? {
        id: "day2",
        start_time: "09:30",
        game_duration_minutes: 35,
        margin_minutes: 10,
        max_sections: null,
        end_time: null,
        breaks: [],
      },
      referees: {
        organizer_capacity:
          typeof referees.organizer_capacity === "number"
            ? referees.organizer_capacity
            : Math.max(1, courts.length),
        team_referees_required_after_first:
          referees.team_referees_required_after_first !== false,
        day2_fallback:
          referees.tournament_fallback === "strict" || referees.day2_fallback === "strict"
            ? "strict"
            : "organizer",
      },
      random_seed: Number.isInteger(source.random_seed) ? source.random_seed : 20260803,
      solver: structuredClone(objectValue(source.solver)) ?? { max_time_seconds: 30 },
    },
  };
  return converted;
}

function count(value: unknown): number {
  return objectArray(value).length;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function validTime(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(":").map(Number);
  return hour !== undefined && minute !== undefined && hour <= 23 && minute <= 59;
}

export function validateDay1LeagueDocument(
  document: TournamentDocument,
  throughStep: Exclude<WizardStep, 3 | 4> = 2,
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const input = document.tournament.input;
  const teamCount = count(input.teams);
  const courtCount = count(input.courts);

  if (document.tournament.name.trim().length === 0) {
    issues.push({ field: "tournament-name", step: 1, message: "大会名を入力してください。" });
  }
  if (teamCount < 2 || teamCount > 32) {
    issues.push({
      field: "teams",
      step: 1,
      message:
        teamCount < 2
          ? "参加チームを1行に1チーム、2チーム以上入力してください。"
          : "参加チームは32チームまでにしてください。",
    });
  }
  if (courtCount < 1 || courtCount > 16) {
    issues.push({
      field: "courts",
      step: 1,
      message:
        courtCount < 1
          ? "使用コートを1行に1コート、1つ以上入力してください。"
          : "使用コートは16コートまでにしてください。",
    });
  }
  if (throughStep === 1) return issues;

  const league = objectValue(input.league);
  const blockCount = numberValue(league?.block_count);
  if (blockCount === undefined || !Number.isInteger(blockCount)) {
    issues.push({ field: "block-count", step: 2, message: "ブロック数を選択してください。" });
  } else if (blockCount < 1 || blockCount > teamCount) {
    issues.push({
      field: "block-count",
      step: 2,
      message: `ブロック数は1から参加チーム数（${teamCount}）までで選択してください。`,
    });
  }
  if (!new Set(["random", "seeded_snake", "manual"]).has(String(league?.assignment_mode))) {
    issues.push({
      field: "assignment-mode",
      step: 2,
      message: "チームの分け方を選択してください。",
    });
  }
  if (league?.assignment_mode === "manual" && blockCount !== undefined) {
    const teams = objectArray(input.teams);
    const teamIds = teams.flatMap((team) => typeof team.id === "string" ? [team.id] : []);
    const manualBlocks = manualBlocksFromUnknown(league.manual_blocks);
    const analysis = analyzeManualBlocks(manualBlocks, teamIds, blockCount);
    if (
      analysis.missingBlockIds.length > 0 ||
      analysis.unknownBlockIds.length > 0 ||
      analysis.duplicateBlockIds.length > 0
    ) {
      issues.push({
        field: "manual-blocks",
        step: 2,
        message: "手動割当てのブロックが現在のブロック数と一致しません。割当て先を確認してください。",
      });
    }
    if (analysis.unknownTeamIds.length > 0 || analysis.duplicateTeamIds.length > 0) {
      const affectedTeamId = analysis.duplicateTeamIds.find((teamId) => teamIds.includes(teamId));
      issues.push({
        field: affectedTeamId === undefined ? "manual-blocks" : `manual-block-team-${affectedTeamId}`,
        step: 2,
        message: analysis.duplicateTeamIds.length > 0
          ? "同じチームを複数のブロックへ割り当てることはできません。"
          : "登録されていないチームの割当てがあります。割当てを選び直してください。",
      });
    }
    if (!analysis.completionPossible) {
      const blockId = analysis.overCapacityBlockIds[0]
        ?? analysis.excessLargeBlockIds[0];
      if (blockId === undefined) return issues;
      const firstTeamId = manualBlocks.find((block) => block.id === blockId)?.team_ids[0];
      const size = analysis.blockSizes[blockId] ?? 0;
      issues.push({
        field: firstTeamId === undefined ? "manual-blocks" : `manual-block-team-${firstTeamId}`,
        step: 2,
        message: `${blockId}ブロックは${size}チーム指定済みです。自動配置後は各ブロック${analysis.minimumSize}〜${analysis.maximumSize}チームになるため、対象チームを未割当てへ戻してください。`,
      });
    }
  }
  const finalStage = objectValue(input.final_stage);
  if (finalStage === undefined) {
    issues.push({
      field: "final-stage-format",
      step: 2,
      message: "2日目の決勝方式を選択してください。",
    });
  } else if (finalStage.format === "placement_tournament") {
    const tournamentCount = numberValue(finalStage.tournament_count);
    const supportedTeamCounts = new Set([8, 16, 24, 32]);
    const supportedCounts = new Map<number, Set<number>>([
      [8, new Set([2])],
      [16, new Set([2])],
      [24, new Set([3])],
      [32, new Set([2, 4])],
    ]);
    const supportedBlocks = new Map<string, Set<number>>([
      ["8:2", new Set([2, 4])],
      ["16:2", new Set([2, 4, 8])],
      ["24:3", new Set([2, 4, 8])],
      ["32:2", new Set([2, 4, 8, 16])],
      ["32:4", new Set([2, 4, 8])],
    ]);
    if (!supportedTeamCounts.has(teamCount)) {
      issues.push({
        field: "teams",
        step: 1,
        message: "順位決定トーナメントは8、16、24、32チームの大会で利用できます。",
      });
    } else if (
      tournamentCount === undefined ||
      !Number.isInteger(tournamentCount) ||
      !supportedCounts.get(teamCount)?.has(tournamentCount)
    ) {
      issues.push({
        field: "tournament-count",
        step: 2,
        message: "参加チーム数に対応するトーナメント数を選択してください。",
      });
    } else if (
      blockCount !== undefined &&
      !supportedBlocks.get(`${teamCount}:${tournamentCount}`)?.has(blockCount)
    ) {
      issues.push({
        field: "block-count",
        step: 2,
        message: "このチーム数とトーナメント数に対応するブロック数を選択してください。",
      });
    }
  } else if (finalStage.format === "same_rank_league") {
    if (teamCount < 4 || teamCount > 32) {
      issues.push({
        field: "teams",
        step: 1,
        message: "同順位リーグは4〜32チームの大会で利用できます。",
      });
    } else if (
      blockCount !== undefined &&
      (blockCount < 2 || blockCount > Math.floor(teamCount / 2))
    ) {
      issues.push({
        field: "block-count",
        step: 2,
        message: `同順位リーグのブロック数は2から${Math.floor(teamCount / 2)}までで選択してください。`,
      });
    } else if (
      blockCount !== undefined &&
      teamCount % blockCount !== 0 &&
      !new Set(["strict_same_rank", "merge_bottom"]).has(String(finalStage.uneven_policy))
    ) {
      issues.push({
        field: "same-rank-uneven-policy",
        step: 2,
        message: "ブロック人数が揃わない場合のグループ分けを選択してください。",
      });
    }
  } else {
    issues.push({
      field: "final-stage-format",
      step: 2,
      message: "2日目の決勝方式を選択してください。",
    });
  }
  const day = objectValue(input.day);
  if (!validTime(day?.start_time)) {
    issues.push({
      field: "start-time",
      step: 2,
      message: "開始時刻を00:00から23:59の範囲で入力してください。",
    });
  }
  const duration = numberValue(day?.game_duration_minutes);
  if (duration === undefined || !Number.isInteger(duration) || duration <= 0) {
    issues.push({
      field: "game-duration",
      step: 2,
      message: "試合時間を1分以上の整数で入力してください。",
    });
  }
  const margin = numberValue(day?.margin_minutes);
  if (margin === undefined || !Number.isInteger(margin) || margin < 0) {
    issues.push({
      field: "margin-minutes",
      step: 2,
      message: "試合間隔を0分以上の整数で入力してください。",
    });
  }
  const maxSections = day?.max_sections;
  if (
    maxSections !== null &&
    maxSections !== undefined &&
    (!Number.isInteger(maxSections) || Number(maxSections) < 1 || Number(maxSections) > 128)
  ) {
    issues.push({
      field: "max-sections",
      step: 2,
      message: "最大セクション数は1から128までの整数で入力してください。",
    });
  }
  const referees = objectValue(input.referees);
  const capacity = numberValue(referees?.organizer_capacity);
  if (capacity === undefined || !Number.isInteger(capacity) || capacity < 0) {
    issues.push({
      field: "organizer-capacity",
      step: 2,
      message: "同時に担当できる主催者審判数を0以上の整数で入力してください。",
    });
  }
  if (!Number.isInteger(input.random_seed)) {
    issues.push({
      field: "random-seed",
      step: 2,
      message: "抽選番号を整数で入力してください。",
    });
  }
  return issues;
}

const API_FIELD_MAP: Array<
  readonly [string, string, Exclude<WizardStep, 3 | 4>, string]
> = [
  ["teams", "teams", 1, "参加チーム"],
  ["courts", "courts", 1, "使用コート"],
  ["league.block_count", "block-count", 2, "ブロック数"],
  ["league.assignment_mode", "assignment-mode", 2, "チームの分け方"],
  ["league.manual_blocks", "manual-blocks", 2, "手動ブロック割当て"],
  ["final_stage", "final-stage-format", 2, "2日目の決勝方式"],
  ["day.start_time", "start-time", 2, "開始時刻"],
  ["day.game_duration_minutes", "game-duration", 2, "試合時間"],
  ["day.margin_minutes", "margin-minutes", 2, "試合間隔"],
  ["day.max_sections", "max-sections", 2, "最大セクション数"],
  ["day2.start_time", "day2-start-time", 2, "2日目の開始時刻"],
  ["day2.game_duration_minutes", "day2-game-duration", 2, "2日目の試合時間"],
  ["day2.margin_minutes", "day2-margin-minutes", 2, "2日目の試合間隔"],
  ["day2.end_time", "day2-end-time", 2, "2日目の終了時刻"],
  ["day2.max_sections", "day2-max-sections", 2, "2日目の最大セクション数"],
  ["day2.breaks", "day2-breaks", 2, "2日目の休憩"],
  ["referees.organizer_capacity", "organizer-capacity", 2, "主催者審判能力"],
  ["referees.team_referees_required_after_first", "team-referees", 2, "チーム審判"],
  ["referees.day2_fallback", "day2-fallback", 2, "2日目の審判フォールバック"],
  ["random_seed", "random-seed", 2, "抽選番号"],
];

export function issuesFromApiDetails(details: JsonObject | undefined): FieldIssue[] {
  if (!Array.isArray(details?.errors)) return [];
  const issues: FieldIssue[] = [];
  for (const entry of details.errors) {
    const error = objectValue(entry);
    if (typeof error?.field !== "string") continue;
    const fieldPath = error.field;
    const field = API_FIELD_MAP.find(
      ([prefix]) => fieldPath === prefix || fieldPath.startsWith(`${prefix}.`),
    );
    if (field === undefined) continue;
    const [, elementId, step, label] = field;
    issues.push({
      field: elementId,
      step,
      message: `${label}の入力値を確認してください。`,
    });
  }
  return issues;
}
