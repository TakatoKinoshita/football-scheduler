import type { TournamentDocument } from "./types";
import { sanitizeWorkbookFileName, type WorkbookFile } from "./workbook";

export class SameRankResultsWorkbookDownloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SameRankResultsWorkbookDownloadError";
  }
}

export interface SameRankResultsWorkbookDownloadResult {
  fileName: string;
  size: number;
}

export interface SameRankResultsWorkbookDownloadDependencies {
  build: (document: TournamentDocument) => WorkbookFile;
  createBlob: (workbook: WorkbookFile) => Promise<Blob>;
  download: (blob: Blob, fileName: string) => void;
}

async function loadDefaultDependencies(): Promise<SameRankResultsWorkbookDownloadDependencies> {
  const [model, xlsx] = await Promise.all([
    import("./same-rank-results-workbook-model"),
    import("./xlsx-workbook"),
  ]);
  return {
    build: model.buildSameRankResultsWorkbook,
    createBlob: xlsx.createWorkbookBlob,
    download: xlsx.downloadWorkbookBlob,
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function plannedMatchIds(plan: Record<string, unknown>): Set<string> | undefined {
  if (!Array.isArray(plan.groups) || plan.groups.length === 0) return undefined;
  const ids = new Set<string>();
  for (const rawGroup of plan.groups) {
    const group = object(rawGroup);
    if (group === undefined || !Array.isArray(group.matches)) return undefined;
    for (const rawMatch of group.matches) {
      const id = object(rawMatch)?.id;
      if (typeof id !== "string" || id.length === 0 || ids.has(id)) return undefined;
      ids.add(id);
    }
  }
  return ids;
}

function completeResults(planned: ReadonlySet<string>, value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const entered = new Set<string>();
  for (const raw of value) {
    const result = object(raw);
    const matchId = result?.match_id;
    if (
      typeof matchId !== "string"
      || !planned.has(matchId)
      || entered.has(matchId)
      || typeof result?.home_team_id !== "string"
      || typeof result.away_team_id !== "string"
      || !Number.isInteger(result.regular_score_home)
      || Number(result.regular_score_home) < 0
      || !Number.isInteger(result.regular_score_away)
      || Number(result.regular_score_away) < 0
      || result.penalty_score_home != null
      || result.penalty_score_away != null
    ) return false;
    entered.add(matchId);
  }
  return entered.size === planned.size;
}

export function sameRankResultsWorkbookAvailable(document: TournamentDocument): boolean {
  if (document.schemaVersion !== "0.2.0") return false;
  const finalStage = object(document.tournament.input.final_stage);
  const result = object(document.tournament.result);
  const plan = object(result?.same_rank_plan);
  const standings = object(result?.same_rank_standings);
  if (
    finalStage?.format !== "same_rank_league"
    || plan?.schema_version !== "0.2.0"
    || plan.format !== "same_rank_league"
    || plan.status !== "COMPLETE"
    || plan.participant_resolution !== "resolved"
    || standings?.schema_version !== "0.2.0"
    || standings.status !== "COMPLETE"
    || !Array.isArray(standings.standings)
    || !Array.isArray(standings.match_results)
  ) return false;
  const planned = plannedMatchIds(plan);
  return planned !== undefined && completeResults(planned, result?.same_rank_league_results);
}

export function sameRankResultsWorkbookDownloadFileName(tournamentName: string): string {
  return sanitizeWorkbookFileName(
    `${tournamentName.trim() || "名称未設定"}_2日目同順位リーグ結果.xlsx`,
  );
}

export async function downloadSameRankResultsWorkbook(
  document: TournamentDocument,
  dependencies?: SameRankResultsWorkbookDownloadDependencies,
): Promise<SameRankResultsWorkbookDownloadResult> {
  try {
    const activeDependencies = dependencies ?? await loadDefaultDependencies();
    const workbook = activeDependencies.build(document);
    const fileName = sameRankResultsWorkbookDownloadFileName(document.tournament.name);
    const blob = await activeDependencies.createBlob({ ...workbook, fileName });
    activeDependencies.download(blob, fileName);
    return { fileName, size: blob.size };
  } catch (error) {
    const message = error instanceof Error && (
      error.name === "SameRankResultsWorkbookError"
      || error.name === "LeagueResultsWorkbookError"
    )
      ? error.message
      : "保存済みの同順位リーグ結果と総合最終順位からExcelを作成できませんでした。";
    throw new SameRankResultsWorkbookDownloadError(message, { cause: error });
  }
}

export class SameRankResultsWorkbookDownloadGuard {
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
