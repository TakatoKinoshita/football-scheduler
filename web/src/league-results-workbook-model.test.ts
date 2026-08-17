import { describe, expect, it } from "vitest";

import {
  LEAGUE_RESULTS_WORKBOOK_FIXTURE_VERSION,
  leagueResultsWorkbookFixture,
  leagueResultsWorkbookFixtures,
} from "./league-results-workbook-fixtures";
import {
  buildLeagueResultsWorkbook,
  LeagueResultsWorkbookError,
} from "./league-results-workbook-model";
import type { JsonObject, TournamentDocument } from "./types";
import type { WorkbookCell, WorkbookSheet } from "./workbook";

function requiredFixture(id: string): TournamentDocument {
  const fixture = leagueResultsWorkbookFixture(id);
  if (fixture === undefined) throw new Error(`fixture「${id}」がありません。`);
  return fixture.document;
}

function values(sheet: WorkbookSheet): Array<Array<string | number | null>> {
  return sheet.rows.map((row) => row.map((cell) => cell?.value ?? null));
}

function clone(document: TournamentDocument): TournamentDocument {
  return structuredClone(document);
}

function result(document: TournamentDocument): JsonObject {
  if (document.tournament.result === undefined) throw new Error("結果がありません。");
  return document.tournament.result;
}

function plan(document: TournamentDocument): JsonObject {
  return result(document).league_plan as JsonObject;
}

function standings(document: TournamentDocument): JsonObject {
  return result(document).league_standings as JsonObject;
}

function standingRows(document: TournamentDocument): JsonObject[] {
  return standings(document).standings as JsonObject[];
}

function leagueResults(document: TournamentDocument): JsonObject[] {
  return result(document).league_results as JsonObject[];
}

function rowForTeam(sheet: WorkbookSheet, teamName: string): Array<string | number | null> {
  const row = values(sheet).find((candidate) => candidate[0] === teamName);
  if (row === undefined) throw new Error(`チーム「${teamName}」の行がありません。`);
  return row;
}

describe("リーグ結果Excel workbookモデル", () => {
  it("version管理された全fixtureを1ブロック1sheetへ変換する", () => {
    expect(LEAGUE_RESULTS_WORKBOOK_FIXTURE_VERSION).toBe("1.1.0");
    expect(leagueResultsWorkbookFixtures).toHaveLength(9);
    for (const fixture of leagueResultsWorkbookFixtures) {
      const workbook = buildLeagueResultsWorkbook(fixture.document);
      const blocks = (plan(fixture.document).blocks as JsonObject[]);
      expect(workbook.sheets).toHaveLength(blocks.length);
      expect(workbook.fileName.endsWith("_1日目リーグ結果.xlsx")).toBe(true);
      workbook.sheets.forEach((sheet, index) => {
        const block = blocks[index]!;
        expect(values(sheet)[0]?.slice(0, 2)).toEqual(["大会名", fixture.document.tournament.name]);
        expect(values(sheet)[1]?.[1]).toBe(block.display_name ?? `${String(block.id)}ブロック`);
        expect(values(sheet)[2]?.slice(0, 2)).toEqual(["保存日時", "2026/08/17 15:00"]);
        expect(sheet.rows[0]?.[1]?.columnSpan).toBe(sheet.columns.length - 1);
        expect(sheet.rows[3]?.[0]).toMatchObject({
          value: expect.stringContaining("空欄 未実施"),
          columnSpan: sheet.columns.length,
        });
        expect(sheet.rows.length).toBeGreaterThan((block.team_ids as string[]).length + 4);
      });
    }
  });

  it("行・列を登録順で揃え、行側視点の勝敗記号と対称scoreを表示する", () => {
    const workbook = buildLeagueResultsWorkbook(requiredFixture("league-results-direct-4"));
    const sheet = workbook.sheets[0]!;
    const rows = values(sheet);
    expect(rows[4]).toEqual([]);
    expect(rows[5]?.slice(0, 5)).toEqual(["チーム", "チームA", "チームB", "チームC", "チームD"]);
    expect(rows.slice(6, 10).map((row) => row[0])).toEqual([
      "チームA", "チームB", "チームC", "チームD",
    ]);
    expect(rowForTeam(sheet, "チームA").slice(1, 5)).toEqual([
      "—", "○ 1-0", "● 0-1", "● 0-1",
    ]);
    expect(rowForTeam(sheet, "チームD").slice(1, 5)).toEqual([
      "○ 1-0", "○ 1-0", "● 0-1", "—",
    ]);
    expect(sheet.rows[6]?.[1]).toMatchObject({ backgroundColor: "#D9D9D9" });
    expect(sheet.rows[5]?.slice(0, 5).every((cell) =>
      cell?.backgroundColor === "#F2F2F2" && cell.textColor === undefined
    )).toBe(true);
    expect(sheet.rows.slice(6, 10).every((row) =>
      row[0]?.backgroundColor === "#F2F2F2" && row[0].fontWeight === "bold"
    )).toBe(true);
    expect(sheet.rows[5]?.slice(5).every((cell) =>
      cell?.backgroundColor === "#4A4A4A" && cell.textColor === "#FFFFFF"
    )).toBe(true);
    expect(rows[5]).not.toContain("試合");
  });

  it("保存済み順位を登録順のチーム行へ結合し、直接対戦値を再計算せず表示する", () => {
    const workbook = buildLeagueResultsWorkbook(requiredFixture("league-results-direct-4"));
    const sheet = workbook.sheets[0]!;
    const a = rowForTeam(sheet, "チームA");
    const c = rowForTeam(sheet, "チームC");
    expect(a.slice(5)).toEqual([1, 0, 2, 3, 1, 2, -1, 3]);
    expect(c.slice(5)).toEqual([2, 0, 1, 6, 2, 1, 1, 1]);
    expect(sheet.rows[6]?.slice(5, 13).every((cell) => cell?.kind === "number")).toBe(true);
    expect(sheet.rows[6]?.[5]).toMatchObject({ leftBorderStyle: "medium" });
    expect(sheet.rows[6]?.[8]).toMatchObject({ fontWeight: "bold" });
    expect(sheet.rows[6]?.[12]).toMatchObject({
      fontWeight: "bold",
      leftBorderStyle: "medium",
      rightBorderStyle: "medium",
    });
    expect(values(sheet)).toContainEqual([1, "チームC", "直接対戦", 3, 1, 1]);
    expect(values(sheet)).toContainEqual([3, "チームA", "直接対戦", 3, 1, 1]);
  });

  it("3チームミニリーグと残存同点群の保存済み監査値を維持する", () => {
    const mini = buildLeagueResultsWorkbook(requiredFixture("league-results-mini-league-4"));
    expect(values(mini.sheets[0]!)).toContainEqual([1, "チームC", "直接対戦", 3, 1, 3]);
    expect(values(mini.sheets[0]!)).toContainEqual([3, "チームA", "直接対戦", 3, -2, 1]);

    const residual = buildLeagueResultsWorkbook(requiredFixture("league-results-residual-draw-5"));
    expect(values(residual.sheets[0]!)).toContainEqual([
      2, "チームB", "直接対戦後の抽選", 3, 1, 5,
    ]);
    expect(values(residual.sheets[0]!)).toContainEqual([
      3, "チームD", "直接対戦後の抽選", 3, 1, 5,
    ]);
  });

  it("抽選番号・候補名・確定順を人間向けに表示し、内部digestを出力しない", () => {
    const workbook = buildLeagueResultsWorkbook(requiredFixture("league-results-all-draws-4"));
    const rows = values(workbook.sheets[0]!);
    expect(rows.some((row) => row[0] === "抽選記録")).toBe(true);
    expect(rows).toContainEqual(["抽選番号", 99]);
    expect(rows.some((row) =>
      row[0] === "候補" && row[1] === "チームA、チームB、チームC、チームD"
    )).toBe(true);
    expect(rows.some((row) =>
      row[0] === "確定順"
      && row[1] === "1. チームA → 2. チームC → 3. チームB → 4. チームD"
    )).toBe(true);
    expect(rows.flat().some((value) => typeof value === "string" && value.includes("digest"))).toBe(false);
  });

  it("sheet名を31文字・禁止文字・重複に対して安全化し、危険な名前も文字cellにする", () => {
    const workbook = buildLeagueResultsWorkbook(
      requiredFixture("league-results-multiple-blocks-long-names"),
    );
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual([
      "東地区_予選",
      "東地区_予選 (2)",
    ]);
    expect(workbook.fileName.length).toBeLessThanOrEqual(121);
    const dangerous = workbook.sheets
      .flatMap((sheet) => sheet.rows.flat())
      .filter((cell): cell is Exclude<WorkbookCell, null> =>
        cell !== null && typeof cell.value === "string" && cell.value.startsWith("=")
      );
    expect(dangerous.length).toBeGreaterThanOrEqual(2);
    expect(dangerous.every((cell) => cell.kind === "text")).toBe(true);
  });

  it("2・4・8・上限に近い16チームのmatrix寸法を保持する", () => {
    for (const [fixtureId, size] of [
      ["league-results-normal-2", 2],
      ["league-results-direct-4", 4],
      ["league-results-normal-8", 8],
      ["league-results-normal-16", 16],
    ] as const) {
      const workbook = buildLeagueResultsWorkbook(requiredFixture(fixtureId));
      const sheet = workbook.sheets[0]!;
      expect(sheet.columns).toHaveLength(1 + size + 8);
      expect(sheet.rows[5]).toHaveLength(1 + size + 8);
      expect(sheet.rows.slice(6, 6 + size)).toHaveLength(size);
      expect(sheet.stickyRowsCount).toBeUndefined();
      expect(sheet.stickyColumnsCount).toBeUndefined();
      expect(sheet).toMatchObject({
        orientation: "landscape",
        print: {
          fitToWidth: 1,
          fitToHeight: 0,
          repeatRows: [6, 6],
          repeatColumns: [1, 1],
        },
      });
    }
  });

  it("16チーム・4ブロック・3コートfixtureを4sheetへ変換する", () => {
    const document = requiredFixture("league-results-16-teams-4-blocks-3-courts");
    expect(document.tournament.input.courts).toHaveLength(3);
    expect(document.tournament.input.league).toMatchObject({ block_count: 4 });
    const workbook = buildLeagueResultsWorkbook(document);
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual([
      "Aブロック", "Bブロック", "Cブロック", "Dブロック",
    ]);
    expect(workbook.sheets.every((sheet) => sheet.columns.length === 13)).toBe(true);
  });

  it("すべての文字・背景・罫線色をグレースケールで出力する", () => {
    for (const fixture of leagueResultsWorkbookFixtures) {
      const workbook = buildLeagueResultsWorkbook(fixture.document);
      const colors: string[] = [];
      for (const cell of workbook.sheets.flatMap((sheet) => sheet.rows.flat())) {
        if (cell === null) continue;
        for (const color of [
          cell.textColor,
          cell.backgroundColor,
          cell.borderColor,
          cell.leftBorderColor,
          cell.rightBorderColor,
          cell.topBorderColor,
          cell.bottomBorderColor,
        ]) {
          if (color !== undefined) colors.push(color);
        }
      }
      expect(colors.length).toBeGreaterThan(0);
      expect(colors.every((color) => {
        const channels = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/iu.exec(color);
        return channels !== null && channels[1] === channels[2] && channels[2] === channels[3];
      })).toBe(true);
    }
  });

  it("同じ入力から同じworkbookを得て、大会データを変更しない", () => {
    const document = clone(requiredFixture("league-results-residual-draw-5"));
    const original = clone(document);
    expect(buildLeagueResultsWorkbook(document)).toEqual(buildLeagueResultsWorkbook(document));
    expect(document).toEqual(original);
  });
});

describe("リーグ結果Excelの独立検証", () => {
  it("リーグ計画・結果・順位が未保存なら利用不能として案内する", () => {
    const noPlan = clone(requiredFixture("league-results-direct-4"));
    delete result(noPlan).league_plan;
    expect(() => buildLeagueResultsWorkbook(noPlan)).toThrow(expect.objectContaining({
      code: "LEAGUE_RESULTS_EXPORT_UNAVAILABLE",
      message: "1日目の日程を生成してからリーグ結果をExcelへ出力してください。",
    } satisfies Partial<LeagueResultsWorkbookError>));

    const noResults = clone(requiredFixture("league-results-direct-4"));
    delete result(noResults).league_results;
    expect(() => buildLeagueResultsWorkbook(noResults)).toThrow(expect.objectContaining({
      code: "LEAGUE_RESULTS_EXPORT_UNAVAILABLE",
      message: "全試合の結果を入力し、順位を確定してからExcelへ出力してください。",
    } satisfies Partial<LeagueResultsWorkbookError>));

    const noStandings = clone(requiredFixture("league-results-direct-4"));
    delete result(noStandings).league_standings;
    expect(() => buildLeagueResultsWorkbook(noStandings)).toThrow(expect.objectContaining({
      code: "LEAGUE_RESULTS_EXPORT_UNAVAILABLE",
    } satisfies Partial<LeagueResultsWorkbookError>));
  });

  it("未確定順位と結果不足・重複・未知試合を日本語の原因付きで拒否する", () => {
    const incomplete = clone(requiredFixture("league-results-direct-4"));
    standings(incomplete).status = "PENDING";
    expect(() => buildLeagueResultsWorkbook(incomplete)).toThrow(expect.objectContaining({
      code: "LEAGUE_RESULTS_EXPORT_UNAVAILABLE",
      message: "順位を確定してからリーグ結果をExcelへ出力してください。",
    } satisfies Partial<LeagueResultsWorkbookError>));

    const missing = clone(requiredFixture("league-results-direct-4"));
    leagueResults(missing).pop();
    expect(() => buildLeagueResultsWorkbook(missing)).toThrow(expect.objectContaining({
      code: "LEAGUE_RESULTS_EXPORT_RESULT_INVALID",
      message: "全試合の結果を入力し、順位を確定してからExcelへ出力してください。",
    } satisfies Partial<LeagueResultsWorkbookError>));

    const duplicate = clone(requiredFixture("league-results-direct-4"));
    leagueResults(duplicate).push(structuredClone(leagueResults(duplicate)[0]!));
    expect(() => buildLeagueResultsWorkbook(duplicate)).toThrow(expect.objectContaining({
      code: "LEAGUE_RESULTS_EXPORT_RESULT_INVALID",
      message: "同じリーグ試合の結果が重複しています。",
    } satisfies Partial<LeagueResultsWorkbookError>));

    const unknown = clone(requiredFixture("league-results-direct-4"));
    leagueResults(unknown)[0]!.match_id = "LG-UNKNOWN-M1";
    expect(() => buildLeagueResultsWorkbook(unknown)).toThrow(expect.objectContaining({
      code: "LEAGUE_RESULTS_EXPORT_RESULT_INVALID",
      message: "日程にないリーグ試合の結果が含まれています。",
    } satisfies Partial<LeagueResultsWorkbookError>));
  });

  it("未知チーム・block不一致・総当たり欠落を拒否する", () => {
    const unknownTeam = clone(requiredFixture("league-results-direct-4"));
    const matches = plan(unknownTeam).matches as JsonObject[];
    matches[0]!.possible_home_team_ids = ["UNKNOWN"];
    expect(() => buildLeagueResultsWorkbook(unknownTeam)).toThrow(expect.objectContaining({
      code: "LEAGUE_RESULTS_EXPORT_INPUT_INVALID",
      message: expect.stringContaining("参加チームがリーグ計画と一致しません"),
    }));

    const blockMismatch = clone(requiredFixture("league-results-multiple-blocks-long-names"));
    standingRows(blockMismatch)[0]!.block_id = "west";
    expect(() => buildLeagueResultsWorkbook(blockMismatch)).toThrow(expect.objectContaining({
      code: "LEAGUE_RESULTS_EXPORT_STANDINGS_INVALID",
      message: "順位表のブロックまたは参加チームがリーグ計画と一致しません。",
    } satisfies Partial<LeagueResultsWorkbookError>));

    const missingPair = clone(requiredFixture("league-results-direct-4"));
    (plan(missingPair).matches as JsonObject[]).pop();
    const logicalRounds = plan(missingPair).logical_rounds as JsonObject[];
    (logicalRounds.at(-1)!.match_ids as string[]).pop();
    expect(() => buildLeagueResultsWorkbook(missingPair)).toThrow(expect.objectContaining({
      code: "LEAGUE_RESULTS_EXPORT_INPUT_INVALID",
      message: expect.stringContaining("総当たり対戦を確認できませんでした"),
    }));
  });

  it("順位欠落・重複、集計・直接対戦値不一致、抽選監査値不一致を拒否する", () => {
    const rankGap = clone(requiredFixture("league-results-direct-4"));
    standingRows(rankGap)[0]!.rank = 2;
    expect(() => buildLeagueResultsWorkbook(rankGap)).toThrow(expect.objectContaining({
      code: "LEAGUE_RESULTS_EXPORT_STANDINGS_INVALID",
      message: "「Aブロック」の順位に欠落または重複があります。",
    } satisfies Partial<LeagueResultsWorkbookError>));

    const aggregate = clone(requiredFixture("league-results-direct-4"));
    standingRows(aggregate)[0]!.wins = 99;
    expect(() => buildLeagueResultsWorkbook(aggregate)).toThrow(expect.objectContaining({
      code: "LEAGUE_RESULTS_EXPORT_STANDINGS_INVALID",
      message: expect.stringContaining("集計値が試合結果と一致しません"),
    }));

    const headToHead = clone(requiredFixture("league-results-direct-4"));
    const directValue = standingRows(headToHead)[0]!.head_to_head as JsonObject;
    directValue.points = 99;
    expect(() => buildLeagueResultsWorkbook(headToHead)).toThrow(expect.objectContaining({
      code: "LEAGUE_RESULTS_EXPORT_STANDINGS_INVALID",
      message: expect.stringContaining("直接対戦値が試合結果と一致しません"),
    }));

    const draw = clone(requiredFixture("league-results-all-draws-4"));
    const records = standings(draw).draws as JsonObject[];
    records[0]!.decided_order = ["D", "C", "B", "A"];
    expect(() => buildLeagueResultsWorkbook(draw)).toThrow(expect.objectContaining({
      code: "LEAGUE_RESULTS_EXPORT_STANDINGS_INVALID",
      message: "抽選記録の確定順が保存済み順位と一致しません。",
    } satisfies Partial<LeagueResultsWorkbookError>));
  });
});
