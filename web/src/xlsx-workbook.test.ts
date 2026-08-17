// @vitest-environment node

import { unzipSync } from "fflate";
import readXlsxFile from "read-excel-file/node";
import { describe, expect, it } from "vitest";

import tournamentDocumentJson from "../e2e/fixtures/issue75-eight-team-document.json";
import { buildScheduleWorkbook } from "./schedule-workbook-model";
import type { JsonObject, TournamentDocument } from "./types";
import { XLSX_MIME_TYPE, numberCell, textCell, type WorkbookFile } from "./workbook";
import { createWorkbookBlob } from "./xlsx-workbook";

const document = tournamentDocumentJson as unknown as TournamentDocument;

describe("ブラウザ内xlsx生成", () => {
  it("3sheetを生成し、readerで名前・行・数値型を再読込みできる", async () => {
    const workbook = buildScheduleWorkbook(document, "day1");
    const blob = await createWorkbookBlob(workbook);
    expect(blob.type).toBe(XLSX_MIME_TYPE);
    const bytes = Buffer.from(await blob.arrayBuffer());
    const sheets = await readXlsxFile(bytes);
    expect(sheets.map((sheet) => sheet.sheet)).toEqual([
      "時間順日程表",
      "コート別日程表",
      "チーム別予定",
    ]);
    expect(sheets[0]?.data[4]).toEqual([
      null,
      "開始時刻",
      "コート",
      "試合番号",
      "対戦チーム",
      null,
      null,
      "主審",
    ]);
    expect(typeof sheets[0]?.data[5]?.[0]).toBe("number");
    const files = unzipSync(new Uint8Array(bytes));
    const firstSheetXml = new TextDecoder().decode(files["xl/worksheets/sheet1.xml"]!);
    expect(firstSheetXml).toContain('<mergeCell ref="E5:G5"/>');
  });

  it("数式・macro・外部linkを生成せず、危険な接頭辞を文字列として再読込みする", async () => {
    const input = structuredClone(document);
    input.tournament.name = `=1+1 ${"長い大会名".repeat(30)}`;
    (input.tournament.input.teams as JsonObject[])[0]!.name = `@SUM(1,1) ${"長いチーム名".repeat(30)}`;
    const workbook = buildScheduleWorkbook(input, "day1");
    const blob = await createWorkbookBlob(workbook);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const sheets = await readXlsxFile(Buffer.from(bytes));
    const values = sheets.flatMap((sheet) => sheet.data.flat());
    expect(values).toContain(input.tournament.name);
    expect(values).toContain((input.tournament.input.teams as JsonObject[])[0]!.name);

    const files = unzipSync(bytes);
    const paths = Object.keys(files);
    expect(paths.some((path) => /vbaProject\.bin|externalLinks/iu.test(path))).toBe(false);
    const relationshipXml = paths
      .filter((path) => path.endsWith(".rels"))
      .map((path) => new TextDecoder().decode(files[path]!))
      .join("\n");
    expect(relationshipXml).not.toMatch(/TargetMode=["']External["']|relationships\/hyperlink/iu);
    const worksheetXml = paths
      .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(path))
      .map((path) => new TextDecoder().decode(files[path]!))
      .join("\n");
    expect(worksheetXml).not.toMatch(/<f(?:\s|>)/u);
    expect(worksheetXml).not.toContain("<hyperlink");
  });

  it("最大規模相当の行数を実用時間内でBlobへ変換する", async () => {
    const dataRows = Array.from({ length: 2_048 }, (_, index) => [
      numberCell(index % 128 + 1),
      textCell(`${String(8 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}`),
      textCell(`第${String(index % 16 + 1)}コート`),
      textCell(`チーム${String(index % 32 + 1)} 対 チーム${String((index + 1) % 32 + 1)}`),
    ]);
    const workbook: WorkbookFile = {
      fileName: "最大規模.xlsx",
      sheets: ["時間順日程表", "コート別日程表", "チーム別予定"].map((name) => ({
        name,
        columns: [{ width: 10 }, { width: 12 }, { width: 18 }, { width: 42 }],
        rows: dataRows,
      })),
    };
    const started = performance.now();
    const blob = await createWorkbookBlob(workbook);
    expect(blob.size).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 15_000);
});
