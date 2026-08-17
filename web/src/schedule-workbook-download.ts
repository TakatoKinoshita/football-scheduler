import type { TournamentDocument } from "./types";
import { sanitizeWorkbookFileName, type WorkbookFile } from "./workbook";

export type ScheduleWorkbookDownloadScope = "day1" | "day2";

export class ScheduleWorkbookDownloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ScheduleWorkbookDownloadError";
  }
}

export interface ScheduleWorkbookDownloadResult {
  fileName: string;
  size: number;
}

interface ScheduleWorkbookDownloadDependencies {
  build: (document: TournamentDocument, scope: ScheduleWorkbookDownloadScope) => WorkbookFile;
  createBlob: (workbook: WorkbookFile) => Promise<Blob>;
  download: (blob: Blob, fileName: string) => void;
}

async function loadDefaultDependencies(): Promise<ScheduleWorkbookDownloadDependencies> {
  const [model, xlsx] = await Promise.all([
    import("./schedule-workbook-model"),
    import("./xlsx-workbook"),
  ]);
  return {
    build: model.buildScheduleWorkbook,
    createBlob: xlsx.createWorkbookBlob,
    download: xlsx.downloadWorkbookBlob,
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasScheduledMatch(value: unknown): boolean {
  return Array.isArray(object(value)?.slots)
    && (object(value)!.slots as unknown[]).some((slot) =>
      typeof object(slot)?.match_id === "string"
    );
}

export function scheduleWorkbookAvailable(
  document: TournamentDocument,
  scope: ScheduleWorkbookDownloadScope,
): boolean {
  const result = object(document.tournament.result);
  if (result === undefined) return false;
  if (scope === "day1") {
    return object(result.league_plan) !== undefined && hasScheduledMatch(result);
  }
  return (
    object(result.day2_schedule) !== undefined
    && (object(result.same_rank_plan) !== undefined || object(result.tournament_plan) !== undefined)
    && hasScheduledMatch(result.day2_schedule)
  );
}

export function scheduleWorkbookDownloadFileName(
  tournamentName: string,
  scope: ScheduleWorkbookDownloadScope,
): string {
  const name = tournamentName.trim() || "名称未設定";
  return sanitizeWorkbookFileName(`${name}_${scope === "day1" ? "1日目" : "2日目"}日程.xlsx`);
}

export async function downloadScheduleWorkbook(
  document: TournamentDocument,
  scope: ScheduleWorkbookDownloadScope,
  dependencies?: ScheduleWorkbookDownloadDependencies,
): Promise<ScheduleWorkbookDownloadResult> {
  try {
    const activeDependencies = dependencies ?? await loadDefaultDependencies();
    const workbook = activeDependencies.build(document, scope);
    const fileName = scheduleWorkbookDownloadFileName(document.tournament.name, scope);
    const blob = await activeDependencies.createBlob({ ...workbook, fileName });
    activeDependencies.download(blob, fileName);
    return { fileName, size: blob.size };
  } catch (error) {
    const message = error instanceof Error && error.name === "ScheduleWorkbookError"
      ? error.message
      : "保存済み日程からExcelを作成できませんでした。";
    throw new ScheduleWorkbookDownloadError(message, { cause: error });
  }
}
