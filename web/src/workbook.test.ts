import { describe, expect, it } from "vitest";

import {
  sanitizeSheetName,
  sanitizeWorkbookFileName,
  uniqueSheetNames,
} from "./workbook";

describe("Excel名の正規化", () => {
  it("sheet名の禁止文字と31文字上限を処理する", () => {
    const name = sanitizeSheetName("'大会/結果:*?[長い名前長い名前長い名前長い名前長い名前]' ");
    expect(name).not.toMatch(/[\\/*?:[\]]/u);
    expect(Array.from(name).length).toBeLessThanOrEqual(31);
    expect(name.startsWith("'")).toBe(false);
    expect(name.endsWith("'")).toBe(false);
  });

  it("大文字小文字を無視してsheet名を一意にする", () => {
    const names = uniqueSheetNames(["Schedule", "schedule", "Schedule", ""]);
    expect(names).toEqual(["Schedule", "schedule (2)", "Schedule (3)", "Sheet 4"]);
    expect(new Set(names.map((name) => name.toLocaleLowerCase("en-US"))).size).toBe(4);
  });

  it("file名の禁止文字、予約名、長さ、拡張子を処理する", () => {
    expect(sanitizeWorkbookFileName("CON.xlsx")).toBe("_CON.xlsx");
    const fileName = sanitizeWorkbookFileName(`${"大会:*?".repeat(40)}.xlsx`);
    expect(fileName).not.toMatch(/[<>:"/\\|?*]/u);
    expect(Array.from(fileName.replace(/\.xlsx$/u, "")).length).toBeLessThanOrEqual(116);
    expect(fileName.endsWith(".xlsx")).toBe(true);
  });
});
