import {
  DOCUMENT_TYPE,
  SCHEMA_VERSION,
  type JsonObject,
  type TournamentDocument,
} from "./types";
import { isDay1LeagueInput, normalizeDocument } from "./day1-form";

export const MAX_JSON_BYTES = 1_000_000;
export const LIMITS = {
  teams: 32,
  courts: 16,
  matches: 512,
  sections: 128,
} as const;

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

function validateLeagueResult(result: JsonObject, teams: JsonObject[]): void {
  const planValue = result.league_plan;
  if (planValue === undefined) {
    if (result.league_results !== undefined || result.league_standings !== undefined) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "リーグ日程がないため、試合結果と順位を復元できませんでした。",
      );
    }
    return;
  }
  const plan = objectValue(planValue, "リーグ日程を読み取れませんでした。");
  const blocks = arrayValue(plan.blocks, "リーグブロック", LIMITS.teams);
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

  if (result.league_standings === undefined) return;
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
  if (root.schemaVersion !== SCHEMA_VERSION) {
    throw new ImportValidationError(
      "UNSUPPORTED_SCHEMA_VERSION",
      `このファイルの版「${String(root.schemaVersion)}」には対応していません。アプリを更新してから再度お試しください。`,
    );
  }

  const tournament = objectValue(root.tournament, "大会情報を読み取れませんでした。");
  if (typeof tournament.name !== "string" || tournament.name.trim().length === 0) {
    throw new ImportValidationError("INVALID_DOCUMENT", "大会名が入力されていません。");
  }
  const input = objectValue(tournament.input, "大会の入力内容を読み取れませんでした。");
  if (input.schema_version !== SCHEMA_VERSION) {
    throw new ImportValidationError(
      "UNSUPPORTED_SCHEMA_VERSION",
      "大会設定の版に対応していません。アプリを更新してから再度お試しください。",
    );
  }
  const teams = arrayValue(input.teams, "チーム", LIMITS.teams);
  const courts = arrayValue(input.courts, "コート", LIMITS.courts);
  uniqueIds(courts, "コート");
  const matches = isDay1LeagueInput(input)
    ? []
    : arrayValue(input.matches, "試合", LIMITS.matches);
  validateReferences(input, teams, matches);
  if (tournament.result !== undefined) {
    validateLeagueResult(
      objectValue(tournament.result, "生成結果を読み取れませんでした。"),
      teams,
    );
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
