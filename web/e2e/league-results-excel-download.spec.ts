import { readFile } from "node:fs/promises";

import { expect, test, type Download, type Page } from "@playwright/test";
import readXlsxFile from "read-excel-file/node";

import { tournamentFixture } from "./fixtures";
import { GENERATE_API, importDocument, mockExternalServices, openApp } from "./helpers";

async function workbook(download: Download) {
  const path = await download.path();
  if (path === null) throw new Error("downloadしたExcelのpathを取得できませんでした。");
  return readXlsxFile(await readFile(path));
}

async function downloadLeagueResults(page: Page): Promise<Download> {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "リーグ結果をエクセルに出力" }).click();
  return downloadPromise;
}

async function enterResult(
  page: Page,
  homeLabel: string,
  awayLabel: string,
  homeScore: string,
  awayScore: string,
): Promise<void> {
  await page.getByLabel(homeLabel).fill(homeScore);
  await page.getByLabel(awayLabel).fill(awayScore);
  await page.getByLabel(awayLabel).press("Tab");
  const row = page.getByLabel(homeLabel).locator("xpath=ancestor::*[@data-match-id][1]");
  await expect(row.locator(".tournament-result-state-label")).toHaveAccessibleName("保存済み");
}

test("タブ3で確定済みリーグ結果をoffline出力し、得点変更時は再確定まで無効にする", async ({
  context,
  page,
}) => {
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, tournamentFixture({ withResult: true, name: "地区/夏季:大会" }));

  const exportButton = page.getByRole("button", { name: "リーグ結果をエクセルに出力" });
  await expect(exportButton).toBeDisabled();
  await expect(page.locator(".league-results-export")).toContainText(
    "1ブロックにつき1つのシート",
  );

  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/")) apiRequests.push(request.url());
  });
  const widgetCount = await page.getByTestId("turnstile-widget-mock").count();

  await enterResult(
    page,
    "青空FC 対 みどりSC・青空FCの得点",
    "青空FC 対 みどりSC・みどりSCの得点",
    "2",
    "1",
  );
  await enterResult(
    page,
    "中央キッカーズ 対 海浜ユナイテッド・中央キッカーズの得点",
    "中央キッカーズ 対 海浜ユナイテッド・海浜ユナイテッドの得点",
    "0",
    "0",
  );
  await expect(exportButton).toBeDisabled();
  await page.getByRole("button", { name: "順位を確定する" }).click();
  await expect(page.locator("#league-standings-view")).toContainText("青空FC");
  await expect(exportButton).toBeEnabled();

  const firstDownload = await downloadLeagueResults(page);
  expect(firstDownload.suggestedFilename()).toBe("地区_夏季_大会_リーグ戦結果.xlsx");
  const firstWorkbook = await workbook(firstDownload);
  expect(firstWorkbook.map((sheet) => sheet.sheet)).toEqual(["Aブロック", "Bブロック"]);
  expect(firstWorkbook[0]!.data.flat()).toContain("○ 2-1");
  expect(firstWorkbook[1]!.data.flat()).toContain("△ 0-0");
  await expect(page.locator("#league-results-excel-status")).toContainText(
    "リーグ結果Excelを出力しました",
  );
  expect(apiRequests).toEqual([]);
  expect(await page.getByTestId("turnstile-widget-mock").count()).toBe(widgetCount);

  await page.evaluate(async () => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#save-state")).not.toHaveText("読み込み中…");
  await expect(exportButton).toBeEnabled();
  const offlineDownload = await downloadLeagueResults(page);
  expect(offlineDownload.suggestedFilename()).toBe("地区_夏季_大会_リーグ戦結果.xlsx");
  expect((await workbook(offlineDownload)).map((sheet) => sheet.sheet)).toEqual([
    "Aブロック",
    "Bブロック",
  ]);

  const changedScore = page.getByLabel("青空FC 対 みどりSC・青空FCの得点");
  await changedScore.fill("3");
  await expect(exportButton).toBeDisabled();
  await changedScore.press("Tab");
  await expect(page.locator("#league-standings-view")).toHaveCount(0);
  await expect(exportButton).toBeDisabled();
  await page.getByRole("button", { name: "順位を確定する" }).click();
  await expect(exportButton).toBeEnabled();

  const updatedWorkbook = await workbook(await downloadLeagueResults(page));
  expect(updatedWorkbook[0]!.data.flat()).toContain("○ 3-1");
  expect(updatedWorkbook[0]!.data.flat()).not.toContain("○ 2-1");
  expect(apiRequests).toEqual([]);
  expect(await page.getByTestId("turnstile-widget-mock").count()).toBe(widgetCount);
});

test("リーグ結果Excelの出力は日程生成APIを呼ばない", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  const source = tournamentFixture({ withResult: true });
  if (!("result" in source.tournament)) throw new Error("E2E fixtureに生成結果がありません。");
  const sourceResult = source.tournament.result as Record<string, unknown>;
  sourceResult.league_results = [
    { match_id: "LG-A-M1", home_score: 2, away_score: 1 },
    { match_id: "LG-B-M1", home_score: 0, away_score: 0 },
  ];
  await importDocument(page, source);
  await page.getByRole("button", { name: "順位を確定する" }).click();
  await page.unroute(GENERATE_API);
  const requests: string[] = [];
  await page.route(GENERATE_API, async (route) => {
    requests.push(route.request().url());
    await route.abort("failed");
  });

  await downloadLeagueResults(page);
  expect(requests).toEqual([]);
});
