import type { TournamentDocument } from "./types";
import { sanitizeWorkbookFileName, type WorkbookFile } from "./workbook";

export class LeagueResultsWorkbookDownloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LeagueResultsWorkbookDownloadError";
  }
}

export interface LeagueResultsWorkbookDownloadResult {
  fileName: string;
  size: number;
}

export interface LeagueResultsWorkbookDownloadDependencies {
  build: (document: TournamentDocument) => WorkbookFile;
  createBlob: (workbook: WorkbookFile) => Promise<Blob>;
  download: (blob: Blob, fileName: string) => void;
}

async function loadDefaultDependencies(): Promise<LeagueResultsWorkbookDownloadDependencies> {
  const [model, xlsx] = await Promise.all([
    import("./league-results-workbook-model"),
    import("./xlsx-workbook"),
  ]);
  return {
    build: model.buildLeagueResultsWorkbook,
    createBlob: xlsx.createWorkbookBlob,
    download: xlsx.downloadWorkbookBlob,
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function completeResultMatchIds(
  matches: unknown,
  results: unknown,
): { planned: Set<string>; entered: Set<string> } | undefined {
  if (!Array.isArray(matches) || matches.length === 0 || !Array.isArray(results)) return undefined;
  const planned = new Set<string>();
  for (const value of matches) {
    const matchId = object(value)?.id;
    if (typeof matchId !== "string" || matchId.length === 0 || planned.has(matchId)) return undefined;
    planned.add(matchId);
  }
  const entered = new Set<string>();
  for (const value of results) {
    const result = object(value);
    if (result === undefined) return undefined;
    const matchId = result.match_id;
    if (
      typeof matchId !== "string" ||
      !planned.has(matchId) ||
      entered.has(matchId) ||
      !Number.isInteger(result.home_score) ||
      Number(result.home_score) < 0 ||
      !Number.isInteger(result.away_score) ||
      Number(result.away_score) < 0
    ) return undefined;
    entered.add(matchId);
  }
  return { planned, entered };
}

export function leagueResultsWorkbookAvailable(document: TournamentDocument): boolean {
  if (document.schemaVersion !== "0.2.0") return false;
  const result = object(document.tournament.result);
  const plan = object(result?.league_plan);
  const standings = object(result?.league_standings);
  const matchIds = completeResultMatchIds(plan?.matches, result?.league_results);
  return (
    matchIds !== undefined &&
    matchIds.entered.size === matchIds.planned.size &&
    standings?.schema_version === "0.2.0" &&
    standings.status === "COMPLETE" &&
    Array.isArray(standings.standings)
  );
}

export function leagueResultsWorkbookDownloadFileName(tournamentName: string): string {
  const name = tournamentName.trim() || "名称未設定";
  return sanitizeWorkbookFileName(`${name}_リーグ戦結果.xlsx`);
}

export async function downloadLeagueResultsWorkbook(
  document: TournamentDocument,
  dependencies?: LeagueResultsWorkbookDownloadDependencies,
): Promise<LeagueResultsWorkbookDownloadResult> {
  try {
    const activeDependencies = dependencies ?? await loadDefaultDependencies();
    const workbook = activeDependencies.build(document);
    const fileName = leagueResultsWorkbookDownloadFileName(document.tournament.name);
    const blob = await activeDependencies.createBlob({ ...workbook, fileName });
    activeDependencies.download(blob, fileName);
    return { fileName, size: blob.size };
  } catch (error) {
    const message = error instanceof Error && error.name === "LeagueResultsWorkbookError"
      ? error.message
      : "保存済みのリーグ結果と確定順位からExcelを作成できませんでした。";
    throw new LeagueResultsWorkbookDownloadError(message, { cause: error });
  }
}

export class LeagueResultsWorkbookDownloadGuard {
  private running = false;

  get active(): boolean {
    return this.running;
  }

  async run<T>(task: () => Promise<T>): Promise<T | undefined> {
    if (this.running) return undefined;
    this.running = true;
    try {
      return await task();
    } finally {
      this.running = false;
    }
  }
}
