import { describe, expect, it } from "vitest";

import tournamentDocumentJson from "../e2e/fixtures/issue75-eight-team-document.json";
import sameRankDocumentJson from "./fixtures/python-same-rank-document.json";
import { buildScheduleWorkbook } from "./schedule-workbook-model";
import type { JsonObject, TournamentDocument } from "./types";
import type { WorkbookCell, WorkbookSheet } from "./workbook";

const tournamentDocument = tournamentDocumentJson as unknown as TournamentDocument;
const sameRankDocument = sameRankDocumentJson as unknown as TournamentDocument;

function cellValue(cell: WorkbookCell | undefined): string | number | null {
  return cell === null || cell === undefined ? null : cell.value;
}

function sheet(workbook: ReturnType<typeof buildScheduleWorkbook>, name: string): WorkbookSheet {
  const result = workbook.sheets.find((candidate) => candidate.name === name);
  if (result === undefined) throw new Error(`${name}がありません。`);
  return result;
}

function rowValues(target: WorkbookSheet): Array<Array<string | number | null>> {
  return target.rows.map((row) => row.map(cellValue));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("日程Excel workbookモデル", () => {
  it("1日目を固定3sheetへ変換し、登録順のチーム別予定を作る", () => {
    const workbook = buildScheduleWorkbook(tournamentDocument, "day1");
    const input = tournamentDocument.tournament.input;
    expect(workbook.sheets.map((candidate) => candidate.name)).toEqual([
      "時間順日程表",
      "コート別日程表",
      "チーム別予定",
    ]);
    const timeRows = rowValues(sheet(workbook, "時間順日程表"));
    expect(timeRows[4]).toEqual([
      "",
      "開始時刻",
      "コート",
      "試合番号",
      "対戦チーム",
      null,
      null,
      "主審",
    ]);
    expect(timeRows[5]?.[0]).toEqual(expect.any(Number));
    expect(timeRows[5]?.[5]).toBe("-");
    expect(sheet(workbook, "時間順日程表").rows[4]?.[4]).toMatchObject({
      value: "対戦チーム",
      columnSpan: 3,
    });
    expect(sheet(workbook, "時間順日程表").rows[5]?.[4]).toMatchObject({ align: "left" });
    expect(sheet(workbook, "時間順日程表").rows[5]?.[5]).toMatchObject({ align: "center" });
    expect(sheet(workbook, "時間順日程表").rows[5]?.[6]).toMatchObject({ align: "right" });
    expect(sheet(workbook, "時間順日程表").rows[5]?.[2]).toMatchObject({ align: "center" });
    expect(sheet(workbook, "時間順日程表").rows[5]?.[7]).toMatchObject({ align: "center" });
    expect(sheet(workbook, "時間順日程表").rows[5]?.[4]).not.toHaveProperty("rightBorderStyle");
    expect(sheet(workbook, "時間順日程表").rows[5]?.[5]).not.toHaveProperty("leftBorderStyle");
    expect(sheet(workbook, "時間順日程表").rows[5]?.[5]).not.toHaveProperty("rightBorderStyle");
    expect(sheet(workbook, "時間順日程表").rows[5]?.[6]).not.toHaveProperty("leftBorderStyle");

    const courtRows = rowValues(sheet(workbook, "コート別日程表"));
    const registeredCourts = (input.courts as JsonObject[]).map((court) => String(court.name));
    const courtHeadings = courtRows
      .filter((_row, index) => {
        const cell = sheet(workbook, "コート別日程表").rows[index]?.[0];
        return cell !== undefined && cell !== null && cell.backgroundColor === "#DDECE6";
      })
      .map((row) => String(row[0]));
    expect(courtHeadings).toEqual(registeredCourts);
    expect(courtRows).toContainEqual([
      "",
      "開始時刻",
      "試合番号",
      "対戦チーム",
      null,
      null,
      "主審",
    ]);

    const teamRows = rowValues(sheet(workbook, "チーム別予定"));
    const registeredNames = (input.teams as JsonObject[]).map((team) => String(team.name));
    const groupNames = teamRows
      .filter((_row, index) => sheet(workbook, "チーム別予定").rows[index]?.[0]
        && sheet(workbook, "チーム別予定").rows[index]?.[0] !== null
        && (sheet(workbook, "チーム別予定").rows[index]![0] as Exclude<WorkbookCell, null>).backgroundColor === "#DDECE6")
      .map((row) => String(row[0]));
    expect(groupNames).toEqual(registeredNames);
    expect(teamRows.some((row) => row[2] === "試合")).toBe(true);
    expect(teamRows.some((row) => row[2] === "審判")).toBe(true);
    expect(teamRows).toContainEqual([
      "開始時刻",
      "コート",
      "役割",
      "対戦チーム",
      "試合番号",
    ]);
    const teamMatchRowIndex = teamRows.findIndex((row) => row[2] === "試合");
    expect(sheet(workbook, "チーム別予定").rows[teamMatchRowIndex]?.[3]).toMatchObject({
      align: "center",
    });
  });

  it("同順位リーグの仮順位枠を人間向け表記で残す", () => {
    const workbook = buildScheduleWorkbook(sameRankDocument, "day2");
    const allValues = workbook.sheets.flatMap((target) => rowValues(target).flat());
    expect(allValues).toContain("Aブロック1位");
    expect(allValues).toContain("Bブロック1位");
    expect(allValues).toContain("-");
    expect(allValues).not.toContain("rank:A:1");
  });

  it("順位決定トーナメントの確定チームを登録順で出力し、候補役割を保持する", () => {
    const workbook = buildScheduleWorkbook(tournamentDocument, "day2");
    const timeValues = rowValues(sheet(workbook, "時間順日程表")).flat();
    const teamRows = rowValues(sheet(workbook, "チーム別予定"));
    const groupLabels = teamRows
      .filter((_row, index) => {
        const cell = sheet(workbook, "チーム別予定").rows[index]?.[0];
        return cell !== undefined && cell !== null && cell.backgroundColor === "#DDECE6";
      })
      .map((row) => String(row[0]));
    const registeredNames = (tournamentDocument.tournament.input.teams as JsonObject[])
      .map((team) => String(team.name));
    expect(groupLabels).toEqual(registeredNames);
    expect(timeValues).not.toContain("前の試合結果で決定");
    expect(timeValues.some((value) =>
      typeof value === "string" && /の(?:勝者|敗者)$/u.test(value)
    )).toBe(false);
    expect(timeValues).toContainEqual(expect.stringMatching(/^[A-Z][①-⑳]勝$/u));
    expect(timeValues).toContainEqual(expect.stringMatching(/^[A-Z][①-⑳]負$/u));
    expect(teamRows.some((row) => row[2] === "試合")).toBe(true);
    expect(teamRows.some((row) => row[2] === "審判")).toBe(true);
    expect(teamRows.some((row) => row[3] === "前の試合結果で決定")).toBe(true);
  });

  it("未使用slotを出力せず、同じ入力から同じ行順を得る", () => {
    const document = clone(tournamentDocument);
    const result = document.tournament.result!;
    const slots = result.slots as JsonObject[];
    slots.unshift({
      day_id: "day1",
      section_no: 1,
      court_id: "court-01",
      match_id: null,
      referee_assignment: null,
    });
    const original = clone(document);
    const first = buildScheduleWorkbook(document, "day1");
    const second = buildScheduleWorkbook(document, "day1");
    expect(document).toEqual(original);
    expect(first).toEqual(second);
    const exportedMatchRows = sheet(first, "時間順日程表").rows.length - 5;
    expect(exportedMatchRows).toBe(slots.filter((slot) => typeof slot.match_id === "string").length);
  });

  it("数式に見える大会名とチーム名も文字列セルとして保持する", () => {
    const document = clone(tournamentDocument);
    document.tournament.name = "=HYPERLINK(\"https://example.invalid\",\"大会\")";
    const teams = document.tournament.input.teams as JsonObject[];
    teams[0]!.name = "+SUM(1,1)";
    const workbook = buildScheduleWorkbook(document, "day1");
    const dangerous = workbook.sheets
      .flatMap((target) => target.rows.flat())
      .filter((cell): cell is Exclude<WorkbookCell, null> => cell !== null)
      .filter((cell) => typeof cell.value === "string" && /^[=+\-@]/u.test(cell.value));
    expect(dangerous.length).toBeGreaterThan(0);
    expect(dangerous.every((cell) => cell.kind === "text")).toBe(true);
  });
});

function maximumDocument(): TournamentDocument {
  const teams = Array.from({ length: 32 }, (_, index) => ({
    id: `team-${String(index + 1).padStart(2, "0")}`,
    name: `チーム${String(index + 1)}`,
  }));
  const courts = Array.from({ length: 16 }, (_, index) => ({
    id: `court-${String(index + 1).padStart(2, "0")}`,
    name: `第${String(index + 1)}コート`,
  }));
  const matches = Array.from({ length: 512 }, (_, index) => ({
    id: `LG-M${String(index + 1)}`,
    block_id: String.fromCharCode("A".charCodeAt(0) + index % 8),
    home: { type: "concrete_team", team_id: teams[index % teams.length]!.id },
    away: { type: "concrete_team", team_id: teams[(index + 1) % teams.length]!.id },
  }));
  const slots = matches.map((match, index) => ({
    day_id: "day1",
    section_no: Math.floor(index / 4) + 1,
    court_id: courts[index % 16]!.id,
    match_id: match.id,
    referee_assignment: index < 4
      ? { kind: "organizer" }
      : { kind: "team", team_id: teams[(index + 2) % teams.length]!.id },
  }));
  return {
    documentType: "football-scheduler-tournament",
    schemaVersion: "0.2.0",
    updatedAt: "2026-08-17T06:00:00.000Z",
    tournament: {
      name: "最大規模性能fixture",
      input: {
        teams,
        courts,
        day: {
          start_time: "08:00",
          game_duration_minutes: 10,
          margin_minutes: 0,
          breaks: [],
        },
      },
      result: {
        league_plan: {
          blocks: Array.from({ length: 8 }, (_, index) => ({
            id: String.fromCharCode("A".charCodeAt(0) + index),
            team_ids: teams.slice(index * 4, index * 4 + 4).map((team) => team.id),
          })),
          matches,
        },
        slots,
      },
    },
  };
}

describe("日程Excel最大規模", () => {
  it("32チーム・16コート・512試合・128セクションを実用時間内で構築する", () => {
    const started = performance.now();
    const workbook = buildScheduleWorkbook(maximumDocument(), "day1");
    expect(sheet(workbook, "時間順日程表").rows.length).toBe(517);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
