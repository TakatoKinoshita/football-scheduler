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
    objectValue(tournament.result, "生成結果を読み取れませんでした。");
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
