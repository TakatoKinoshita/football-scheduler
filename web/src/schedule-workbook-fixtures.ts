import tournamentDocumentJson from "../e2e/fixtures/issue75-eight-team-document.json";
import manifestJson from "./fixtures/schedule-workbook/manifest.json";
import sameRankDocumentJson from "./fixtures/python-same-rank-document.json";
import type { ScheduleWorkbookScope } from "./schedule-workbook-model";
import type { TournamentDocument } from "./types";

export const SCHEDULE_WORKBOOK_PREVIEW_MARKER = "SCHEDULE_WORKBOOK_PREVIEW_V1";

export interface ScheduleWorkbookFixture {
  id: string;
  description: string;
  scope: ScheduleWorkbookScope;
  document: TournamentDocument;
}

const documents: Readonly<Record<string, TournamentDocument>> = {
  "issue75-eight-team-document": tournamentDocumentJson as unknown as TournamentDocument,
  "python-same-rank-document": sameRankDocumentJson as unknown as TournamentDocument,
};

function loadFixtures(): ScheduleWorkbookFixture[] {
  if (manifestJson.fixtureVersion !== "1.0.0") {
    throw new Error("Excel fixture manifestのversionに対応していません。");
  }
  return manifestJson.fixtures.map((entry) => {
    const document = documents[entry.source];
    if (document === undefined || (entry.scope !== "day1" && entry.scope !== "day2")) {
      throw new Error(`Excel fixture「${entry.id}」の参照が不正です。`);
    }
    return {
      id: entry.id,
      description: entry.description,
      scope: entry.scope,
      document,
    };
  });
}

export const scheduleWorkbookFixtures = loadFixtures();

export function scheduleWorkbookFixture(id: string): ScheduleWorkbookFixture | undefined {
  return scheduleWorkbookFixtures.find((fixture) => fixture.id === id);
}
