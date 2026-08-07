import { expect, test } from "@playwright/test";

import {
  scheduleResult,
  scheduleViewTournamentFixture,
  standingsResult,
  tournamentFixture,
} from "./fixtures";
import { importDocument, mockExternalServices, openApp } from "./helpers";

async function openScheduleViewFixture(page: import("@playwright/test").Page): Promise<void> {
  const fixture = scheduleViewTournamentFixture();
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, fixture);
}

test("1日目は時間順を既定にし、コート別への切替を再読込み後も保持する", async ({
  page,
}) => {
  await openScheduleViewFixture(page);
  await page.locator('.step[data-step="4"]').click();

  const toggle = page.locator("#day1-schedule-view-toggle");
  await expect(toggle.getByLabel("時間順")).toBeChecked();
  await expect(page.locator('#result-content [data-schedule-view="time"]')).toBeVisible();

  await toggle.getByLabel("コート別").check();
  await expect(page.locator('#result-content [data-schedule-view="court"]')).toBeVisible();
  await expect(page.locator("#result-content .court-schedule-card")).toHaveCount(2);
  await expect(
    page.locator('#result-content .court-schedule-card[data-court-id="court-a"]'),
  ).toContainText("A①");
  const courtA = page.locator(
    '#result-content .court-schedule-card[data-court-id="court-a"]',
  );
  await expect(courtA.locator("table")).toHaveAttribute("aria-label", "Aコートの日程");
  await expect(courtA.locator("tbody tr").nth(0)).toContainText("第1");
  await expect(courtA.locator("tbody tr").nth(1)).toContainText("第3");
  await expect(page.locator("#result-content .match-display-number")).toHaveCount(4);
  await expect(page.getByLabel("青空FC 対 みどりSC・青空FCの得点")).toHaveCount(1);

  await page.emulateMedia({ media: "print" });
  await expect(toggle).toBeHidden();
  await expect(page.locator('#result-content [data-schedule-view="court"]')).toBeVisible();
  await expect(page.locator('#result-content [data-schedule-view="time"]')).toBeHidden();
  await page.emulateMedia({ media: "screen" });

  await expect(page.locator("#save-state")).toContainText("この端末に保存済み");
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.locator("#save-state")).not.toHaveText("読み込み中…");
  await page.locator('.step[data-step="4"]').click();
  await expect(page.locator("#day1-schedule-view-toggle").getByLabel("コート別")).toBeChecked();
  await expect(page.locator('#result-content [data-schedule-view="court"]')).toBeVisible();
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await page.context().setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#save-state")).not.toHaveText("読み込み中…");
  await page.locator('.step[data-step="4"]').click();
  await expect(page.locator("#day1-schedule-view-toggle").getByLabel("コート別")).toBeChecked();
  await expect(page.locator('#result-content [data-schedule-view="court"]')).toBeVisible();
});

test("表示切替後もリーグ得点入力を一組だけ保存し、確定順位を一度だけ失効する", async ({
  page,
}) => {
  await mockExternalServices(page);
  await openApp(page);
  const base = tournamentFixture({ withResult: true });
  await importDocument(page, {
    ...base,
    tournament: {
      ...base.tournament,
      result: {
        ...scheduleResult,
        league_results: [{ match_id: "LG-A-M1", home_score: 2, away_score: 1 }],
        league_standings: standingsResult,
      },
    },
  });

  const homeScore = page.getByLabel("青空FC 対 みどりSC・青空FCの得点");
  const awayScore = page.getByLabel("青空FC 対 みどりSC・みどりSCの得点");
  await expect(homeScore).toHaveCount(1);
  await page.locator("#day1-schedule-view-toggle").getByLabel("コート別").check();
  await page.locator("#day1-schedule-view-toggle").getByLabel("時間順").check();
  await expect(homeScore).toHaveCount(1);
  await expect(awayScore).toHaveCount(1);

  await homeScore.fill("3");
  await expect(page.locator("#standings-status")).toContainText("確定順位を取り消しました");
  await expect(page.getByText("確定順位を取り消しました", { exact: false })).toHaveCount(1);
  await expect(page.locator("#save-state")).toContainText("この端末に保存済み");
  await expect(homeScore).toHaveValue("3");
  await expect(awayScore).toHaveValue("1");
});

test("2日目はコート別を既定にし、直前実試合の表示番号を審判と一覧で共有する", async ({
  page,
}) => {
  await openScheduleViewFixture(page);

  const toggle = page.locator("#day2-schedule-view-toggle");
  await expect(toggle.getByLabel("コート別")).toBeChecked();
  const courtView = page.locator('#day2-schedule-view [data-schedule-view="court"]');
  await expect(courtView).toBeVisible();
  const courtA = courtView.locator('.court-schedule-card[data-court-id="court-a"]');
  await expect(courtA.locator('.match-display-number[data-match-id="UT-SF1"]')).toHaveText("A①");
  await expect(courtA.locator('.match-display-number[data-match-id="UT-PLACE3"]')).toHaveText("A②");
  await expect(courtA).toContainText("A①の勝者");
  await expect(courtA).not.toContainText("UT-SF1の勝者");
  await expect(
    page.locator('#tournament-plan-view .match-display-number[data-match-id="UT-SF1"]'),
  ).toHaveText("A①");
  await expect(courtA.locator("table")).toHaveAttribute("aria-label", "Aコートの日程");

  await toggle.getByLabel("時間順").check();
  await expect(page.locator('#day2-schedule-view [data-schedule-view="time"]')).toBeVisible();
  await expect(courtView).toBeHidden();
  await page.context().setOffline(true);
  await page.reload();
  await expect(page.locator("#day2-schedule-view-toggle").getByLabel("時間順")).toBeChecked();

  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#day1-results-panel")).toBeHidden();
  await expect(page.locator("#day2-results-panel")).toBeVisible();
  await expect(page.locator("#day2-schedule-view-toggle")).toBeHidden();
  await expect(page.locator('#day2-schedule-view [data-schedule-view="time"]')).toBeVisible();
  await expect(page.locator('#day2-schedule-view [data-schedule-view="court"]')).toBeHidden();
});

test("2日目設定を変更すると日程とトーナメント一覧の派生番号をともに外す", async ({
  page,
}) => {
  await openScheduleViewFixture(page);
  await expect(
    page.locator('#tournament-plan-view .match-display-number[data-match-id="UT-SF1"]'),
  ).toHaveText("A①");

  await page.locator("#day2-margin-minutes").fill("15");
  await page.locator("#day2-margin-minutes").blur();

  await expect(page.locator("#day2-schedule-view")).toHaveCount(0);
  await expect(page.locator("#tournament-plan-view .match-display-number")).toHaveCount(0);
  await expect(page.locator("#tournament-plan-view")).toContainText("UT-SF1");
  await expect(page.locator("#day2-status")).toContainText("以前の日程を取り消しました");
});

for (const viewport of [
  { name: "smartphone", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "PC", width: 1280, height: 900 },
]) {
  test(`${viewport.name}幅のコート別日程はページ全体を横へはみ出さない`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openScheduleViewFixture(page);

    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
    const courtCards = page.locator("#day2-schedule-view .court-schedule-card");
    await expect(courtCards).toHaveCount(2);

    const courtViewBox = await page
      .locator('#day2-schedule-view [data-schedule-view="court"]')
      .boundingBox();
    const firstCourtBox = await courtCards.nth(0).boundingBox();
    const secondCourtBox = await courtCards.nth(1).boundingBox();
    expect(courtViewBox).not.toBeNull();
    expect(firstCourtBox).not.toBeNull();
    expect(secondCourtBox).not.toBeNull();
    expect(firstCourtBox!.width).toBeCloseTo(courtViewBox!.width, 0);
    expect(secondCourtBox!.width).toBeCloseTo(courtViewBox!.width, 0);
    expect(secondCourtBox!.y).toBeGreaterThanOrEqual(firstCourtBox!.y + firstCourtBox!.height);

    for (const label of await page.locator("#day2-schedule-view-toggle label").all()) {
      const box = await label.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    if (viewport.width <= 760) {
      const wrap = page
        .locator('#day2-schedule-view .court-schedule-card[data-court-id="court-a"] .table-wrap')
        .first();
      const localDimensions = await wrap.evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
      expect(localDimensions.scrollWidth).toBeGreaterThanOrEqual(localDimensions.clientWidth);
    }
  });
}
