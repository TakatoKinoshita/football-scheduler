import {
  SCHEMA_VERSION,
  cloneDocument,
  type JsonObject,
  type TournamentDocument,
} from "./types";

export type WizardStep = 1 | 2 | 3 | 4;

export interface FieldIssue {
  field: string;
  step: Exclude<WizardStep, 4>;
  message: string;
}

export interface DocumentMode {
  document: TournamentDocument;
  migrated: boolean;
  legacyCompatibility: boolean;
}

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
  return {
    schema_version: input.schema_version,
    request_kind: input.request_kind,
    teams: input.teams,
    courts: input.courts,
    league: input.league,
    day: input.day,
    referees: input.referees,
    random_seed: input.random_seed,
    solver: input.solver,
  };
}

export function normalizeDocument(document: TournamentDocument): DocumentMode {
  const input = document.tournament.input;
  if (isDay1LeagueInput(input)) {
    return { document, migrated: false, legacyCompatibility: false };
  }

  const matches = objectArray(input.matches);
  const day = objectValue(input.day);
  const referees = objectValue(input.referees);
  if (matches.length > 0 && day !== undefined && referees !== undefined) {
    return { document, migrated: false, legacyCompatibility: true };
  }

  if (matches.length === 0 && day === undefined && referees === undefined) {
    const migrated = cloneDocument(document);
    const teams = objectArray(input.teams);
    const courts = objectArray(input.courts);
    migrated.tournament.input = {
      schema_version: SCHEMA_VERSION,
      request_kind: "day1_league",
      teams,
      courts,
      league: { block_count: null, assignment_mode: "random" },
      day: {
        id: "day1",
        start_time: "09:30",
        game_duration_minutes: 35,
        margin_minutes: 5,
        max_sections: null,
      },
      day2: {
        id: "day2",
        start_time: "09:30",
        game_duration_minutes: 35,
        margin_minutes: 10,
        max_sections: null,
        end_time: null,
        breaks: [],
      },
      referees: {
        organizer_capacity: Math.max(1, courts.length),
        team_referees_required_after_first: true,
        tournament_fallback: "organizer",
      },
      random_seed: 20260803,
      solver: { max_time_seconds: 30 },
    };
    return { document: migrated, migrated: true, legacyCompatibility: false };
  }

  return { document, migrated: false, legacyCompatibility: true };
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
  throughStep: Exclude<WizardStep, 4> = 3,
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
  if (throughStep === 1) return issues;

  if (courtCount < 1 || courtCount > 16) {
    issues.push({
      field: "courts",
      step: 2,
      message:
        courtCount < 1
          ? "使用コートを1行に1コート、1つ以上入力してください。"
          : "使用コートは16コートまでにしてください。",
    });
  }
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
  if (!new Set(["random", "seeded_snake"]).has(String(league?.assignment_mode))) {
    issues.push({
      field: "assignment-mode",
      step: 2,
      message: "チームの分け方を選択してください。",
    });
  }
  if (
    league?.odd_split_policy !== undefined &&
    !new Set(["upper", "lower", "alternate"]).has(String(league.odd_split_policy))
  ) {
    issues.push({
      field: "odd-split-policy",
      step: 2,
      message: "奇数人数ブロックの上下振り分けを選択してください。",
    });
  }
  if (throughStep === 2) return issues;

  const day = objectValue(input.day);
  if (!validTime(day?.start_time)) {
    issues.push({
      field: "start-time",
      step: 3,
      message: "開始時刻を00:00から23:59の範囲で入力してください。",
    });
  }
  const duration = numberValue(day?.game_duration_minutes);
  if (duration === undefined || !Number.isInteger(duration) || duration <= 0) {
    issues.push({
      field: "game-duration",
      step: 3,
      message: "試合時間を1分以上の整数で入力してください。",
    });
  }
  const margin = numberValue(day?.margin_minutes);
  if (margin === undefined || !Number.isInteger(margin) || margin < 0) {
    issues.push({
      field: "margin-minutes",
      step: 3,
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
      step: 3,
      message: "最大セクション数は1から128までの整数で入力してください。",
    });
  }
  const referees = objectValue(input.referees);
  const capacity = numberValue(referees?.organizer_capacity);
  if (capacity === undefined || !Number.isInteger(capacity) || capacity < 0) {
    issues.push({
      field: "organizer-capacity",
      step: 3,
      message: "同時に担当できる主催者審判数を0以上の整数で入力してください。",
    });
  }
  if (!Number.isInteger(input.random_seed)) {
    issues.push({
      field: "random-seed",
      step: 3,
      message: "抽選番号を整数で入力してください。",
    });
  }
  return issues;
}

const API_FIELD_MAP: Array<readonly [string, string, Exclude<WizardStep, 4>, string]> = [
  ["teams", "teams", 1, "参加チーム"],
  ["courts", "courts", 2, "使用コート"],
  ["league.block_count", "block-count", 2, "ブロック数"],
  ["league.assignment_mode", "assignment-mode", 2, "チームの分け方"],
  ["league.odd_split_policy", "odd-split-policy", 2, "奇数人数の上下振り分け"],
  ["day.start_time", "start-time", 3, "開始時刻"],
  ["day.game_duration_minutes", "game-duration", 3, "試合時間"],
  ["day.margin_minutes", "margin-minutes", 3, "試合間隔"],
  ["day.max_sections", "max-sections", 3, "最大セクション数"],
  ["referees.organizer_capacity", "organizer-capacity", 3, "主催者審判能力"],
  ["referees.team_referees_required_after_first", "team-referees", 3, "チーム審判"],
  ["random_seed", "random-seed", 3, "抽選番号"],
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
