import { readFile } from "node:fs/promises";

import { expect, test, type Download, type Page } from "@playwright/test";
import readXlsxFile from "read-excel-file/node";

import {
  legacyTournamentFixture,
  sameRankWebFixture,
  scheduleViewTournamentFixture,
  tournamentFixture,
} from "./fixtures";
import { importDocument, mockExternalServices, openApp } from "./helpers";

const expectedSheets = ["時間順日程表", "コート別日程表", "チーム別予定"];

async function workbookValues(download: Download): Promise<{
  sheets: Awaited<ReturnType<typeof readXlsxFile>>;
  values: unknown[];
}> {
  const path = await download.path();
  if (path === null) throw new Error("downloadしたExcelのpathを取得できませんでした。");
  const sheets = await readXlsxFile(await readFile(path));
  return { sheets, values: sheets.flatMap((sheet) => sheet.data.flat()) };
}

async function downloadFromPanel(page: Page, panel: "day1" | "day2"): Promise<Download> {
  const button = page.locator(`#${panel}-results-panel`).getByRole("button", {
    name: "エクセルに出力",
  });
  const downloadPromise = page.waitForEvent("download");
  await button.click();
  return downloadPromise;
}

test("日程がない間は両日のExcel出力を無効にする", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await expect(page.locator("#excel-day1")).toBeDisabled();
  await expect(page.locator("#excel-day2")).toBeDisabled();
});

test("タブ3から1日目の3sheetをAPIやTurnstile追加初期化なしでdownloadする", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, tournamentFixture({ withResult: true, name: "地区/夏季:大会" }));
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/")) requests.push(request.url());
  });
  const widgetCount = await page.getByTestId("turnstile-widget-mock").count();

  const download = await downloadFromPanel(page, "day1");
  expect(download.suggestedFilename()).toBe("地区_夏季_大会_1日目日程.xlsx");
  const workbook = await workbookValues(download);
  expect(workbook.sheets.map((sheet) => sheet.sheet)).toEqual(expectedSheets);
  expect(workbook.sheets[0]?.data[4]).toEqual([
    null,
    "開始時刻",
    "コート",
    "試合番号",
    "対戦チーム",
    null,
    null,
    "主審",
  ]);
  expect(workbook.values).toContain("青空FC");
  await expect(page.locator("#day1-excel-status")).toContainText("Excelを出力しました");
  await expect(page.locator("#day1-results-panel").getByRole("button", { name: "エクセルに出力" }))
    .toBeEnabled();
  expect(requests).toEqual([]);
  expect(await page.getByTestId("turnstile-widget-mock").count()).toBe(widgetCount);
});

test("保存済み2日目トーナメントを再読込み後offlineでdownloadする", async ({ context, page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, scheduleViewTournamentFixture());
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#save-state")).not.toHaveText("読み込み中…");

  const download = await downloadFromPanel(page, "day2");
  expect(download.suggestedFilename()).toBe("表示切替大会_2日目日程.xlsx");
  const workbook = await workbookValues(download);
  expect(workbook.sheets.map((sheet) => sheet.sheet)).toEqual(expectedSheets);
  const scheduleValues = workbook.sheets[0]!.data.flat();
  expect(scheduleValues).toContain("A①勝");
  expect(scheduleValues).not.toContain("前の試合結果で決定");
  await expect(page.locator("#day2-excel-status")).toContainText("Excelを出力しました");
});

for (const resolved of [false, true]) {
  test(`2日目同順位リーグ${resolved ? "確定" : "仮"}日程をExcelへ出力する`, async ({ page }) => {
    await mockExternalServices(page);
    await openApp(page);
    await importDocument(page, sameRankWebFixture(16, { resolved }));

    const workbook = await workbookValues(await downloadFromPanel(page, "day2"));
    expect(workbook.sheets.map((sheet) => sheet.sheet)).toEqual(expectedSheets);
    if (resolved) {
      expect(workbook.values).toContain("チーム1");
      expect(workbook.values).not.toContain("Aブロック1位");
    } else {
      expect(workbook.values).toContain("Aブロック1位");
    }
  });
}

test("schema 0.1.0の閲覧用1日目日程もExcelへ出力する", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, legacyTournamentFixture({ withResult: true }));

  const workbook = await workbookValues(await downloadFromPanel(page, "day1"));
  expect(workbook.sheets.map((sheet) => sheet.sheet)).toEqual(expectedSheets);
  expect(workbook.values).toContain("青空FC");
});
