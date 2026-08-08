import { expect, test } from "@playwright/test";

import {
  horizontalBracketTournamentFixture,
  scheduleViewDay2ScheduleResult,
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
  await expect(page.locator("#day1-schedule-view .legacy-schedule-warning")).toHaveCount(0);

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

test("旧ルールの1日目日程を保持して警告し、2日目の再作成だけを無効化する", async ({
  page,
}) => {
  const fixture = structuredClone(scheduleViewTournamentFixture());
  const result = fixture.tournament.result as Record<string, unknown>;
  const slots = result.slots as Array<Record<string, unknown>>;
  const secondSection = slots.find(
    (slot) => slot.section_no === 2 && slot.court_id === "court-b",
  );
  expect(secondSection).toBeDefined();
  secondSection!.referee_assignment = { kind: "team", team_id: "team-01" };

  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, fixture);
  await page.locator('.step[data-step="4"]').click();

  const day1Warning = page.locator("#result-content .legacy-schedule-warning");
  await expect(day1Warning).toContainText("旧ルールの日程");
  await expect(day1Warning).toContainText("1件");
  await expect(page.locator("#day1-schedule-view")).toBeVisible();
  await expect(page.locator("#generate-day2")).toBeDisabled();
  await expect(page.locator("#day2-review")).toContainText("1日目日程を再作成");

  await page.emulateMedia({ media: "print" });
  await expect(day1Warning).toBeVisible();
  await page.emulateMedia({ media: "screen" });
  await page.locator('.step[data-step="5"]').click();
  await expect(page.locator("#day2-schedule-view")).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(
    page.locator("#day2-schedule-view .legacy-schedule-warning").filter({
      hasText: "元になった1日目は旧ルールの日程",
    }),
  ).toBeVisible();
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

  const legacyFinalWarning = page.locator(
    "#day2-schedule-view .legacy-schedule-warning",
  );
  await expect(legacyFinalWarning).toContainText("決勝より後に別の試合");

  const brackets = page.locator("#tournament-plan-view .tournament-bracket");
  await expect(brackets).toHaveCount(2);
  const upperBracket = page.locator(
    '#tournament-plan-view .tournament-bracket[data-pool="upper"]',
  );
  await expect(upperBracket).toBeVisible();
  await expect(upperBracket.locator(".tournament-bracket-sheet")).toHaveCount(1);
  await expect(upperBracket.locator(".bracket-entry-slot")).toHaveCount(4);
  await expect(upperBracket.locator(".bracket-match-node")).toHaveCount(4);
  await expect(upperBracket.locator(".bracket-connector")).toHaveCount(4);
  await expect(upperBracket.locator("path").first()).not.toHaveAttribute("d", /[CQ]/);
  await expect(page.locator("#tournament-plan-view .tournament-bracket figcaption").first())
    .toHaveText("上位トーナメント表（仮）");
  await expect(page.getByRole("button", { name: "トーナメント表だけ印刷" })).toBeEnabled();
  await expect(page.locator("#tournament-plan-view table")).toHaveCount(2);

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
  const semifinalNode = upperBracket.locator(
    '.bracket-match-node[data-match-id="UT-SF1"]',
  );
  await expect(semifinalNode).toContainText("A①");
  await expect(semifinalNode).toContainText("09:30〜10:05 Aコート");
  await expect(courtA.locator("table")).toHaveAttribute("aria-label", "Aコートの日程");

  await toggle.getByLabel("時間順").check();
  await expect(page.locator('#day2-schedule-view [data-schedule-view="time"]')).toBeVisible();
  await expect(courtView).toBeHidden();
  await page.context().setOffline(true);
  await page.reload();
  await expect(page.locator("#day2-schedule-view-toggle").getByLabel("時間順")).toBeChecked();
  await expect(page.locator("#tournament-plan-view .tournament-bracket")).toHaveCount(2);
  await expect(page.locator("#day2-schedule-view .legacy-schedule-warning")).toContainText(
    "決勝より後に別の試合",
  );

  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#day1-results-panel")).toBeHidden();
  await expect(page.locator("#day2-results-panel")).toBeVisible();
  await expect(page.locator("#day2-schedule-view-toggle")).toBeHidden();
  await expect(page.locator('#day2-schedule-view [data-schedule-view="time"]')).toBeVisible();
  await expect(page.locator('#day2-schedule-view [data-schedule-view="court"]')).toBeHidden();
  await expect(page.locator("#day2-schedule-view .legacy-schedule-warning")).toBeVisible();
});

test("現行日程は決勝配置を表示し、下位決勝が早い理由を印刷にも載せる", async ({ page }) => {
  const fixture = structuredClone(scheduleViewTournamentFixture());
  const result = fixture.tournament.result as Record<string, unknown>;
  const schedule = result.day2_schedule as Record<string, unknown>;
  const slots = schedule.slots as Array<Record<string, unknown>>;
  const upperFinal = slots.find((slot) => slot.match_id === "UT-FINAL")!;
  const lowerFinal = slots.find((slot) => slot.match_id === "LT-FINAL")!;
  upperFinal.match_id = "LT-FINAL";
  lowerFinal.match_id = "UT-FINAL";
  const metrics = schedule.metrics as Record<string, unknown>;
  metrics.upper_tournament_final_section = 5;
  metrics.lower_tournament_final_section = 4;
  metrics.lower_tournament_final_section_gap = 1;
  schedule.diagnostics = [{
    code: "LOWER_TOURNAMENT_FINAL_NOT_LAST_SECTION",
    message: "コート数と主催者審判能力の範囲では、下位決勝は第4セクションが最も遅い配置です。",
    details: { reason_codes: ["court_capacity"] },
  }];

  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, fixture);

  const day2View = page.locator("#day2-schedule-view");
  await expect(day2View).toContainText("上位決勝は第5セクション（最終）");
  await expect(day2View).toContainText("下位決勝は第4セクション");
  await expect(day2View).toContainText("下位決勝は第4セクションが最も遅い配置");
  await expect(day2View.locator(".legacy-schedule-warning")).toHaveCount(0);

  await page.emulateMedia({ media: "print" });
  await expect(day2View.getByText(/下位決勝は第4セクションが最も遅い配置/)).toBeVisible();
});

test("決勝が最終でない新しいAPI応答を保存しない", async ({ page }) => {
  const fixture = structuredClone(scheduleViewTournamentFixture());
  const result = fixture.tournament.result as Record<string, unknown>;
  delete result.day2_schedule;
  delete result.integrated_validation;
  const invalidResponse = structuredClone(scheduleViewDay2ScheduleResult) as Record<string, unknown>;
  const metrics = invalidResponse.metrics as Record<string, unknown>;
  metrics.upper_tournament_final_section = 4;
  metrics.lower_tournament_final_section = 5;
  metrics.lower_tournament_final_section_gap = 0;

  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, fixture);
  await page.unroute("**/api/v1/schedules:generate");
  await page.route("**/api/v1/schedules:generate", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(invalidResponse),
    });
  });

  await page.getByRole("button", { name: "2日目の日程を作成する" }).click();

  await expect(page.locator("#day2-status")).toContainText("保存せず");
  await expect(page.locator("#day2-status")).toContainText("日程を再作成");
  await expect(page.locator("#day2-schedule-view")).toHaveCount(0);
});

test("標準ブラケットだけを上位・下位のA4横ページとして印刷できる", async ({ page }) => {
  await openScheduleViewFixture(page);
  await page.evaluate(() => {
    window.print = () => {
      document.body.dataset.printInvoked = "true";
    };
  });
  const printButton = page.getByRole("button", { name: "トーナメント表だけ印刷" });
  await expect(printButton).toBeEnabled();
  await printButton.click();
  await expect(page.locator("body")).toHaveAttribute("data-print-scope", "bracket");
  await expect(page.locator("body")).toHaveAttribute("data-print-invoked", "true");

  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#day1-results-panel")).toBeHidden();
  await expect(page.locator("#day2-results-panel")).toBeVisible();
  await expect(page.locator("#tournament-plan-view .tournament-pool")).toHaveCount(2);
  await expect(page.locator("#tournament-plan-view .tournament-bracket")).toHaveCount(2);
  await expect(page.locator("#tournament-plan-view .tournament-bracket-sheet")).toHaveCount(2);
  expect(
    await page.locator("#tournament-plan-view .seed-list").evaluateAll(
      (lists) => lists.every((list) => getComputedStyle(list).display === "none"),
    ),
  ).toBe(true);
  await expect(page.locator("#day2-schedule-view")).toBeHidden();
  const printVisibility = await page
    .locator("#tournament-plan-view .tournament-bracket-sheet")
    .evaluateAll((sheets) => sheets.map((sheet) => ({
      page: getComputedStyle(sheet).page,
      breakAfter: getComputedStyle(sheet).breakAfter,
    })));
  expect(printVisibility.every((style) => style.page === "bracket")).toBe(true);
});

test("mirroredな8チームは上下とも本番水平版となり、A4縦と局所スクロールを使う", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, horizontalBracketTournamentFixture(8));

  const brackets = page.locator(
    "#tournament-plan-view .tournament-bracket.exploration.horizontal",
  );
  await expect(brackets).toHaveCount(2);
  await expect(brackets.nth(0)).toHaveAttribute("data-layout", "horizontal");
  await expect(brackets.nth(1)).toHaveAttribute("data-layout", "horizontal");
  await expect(brackets.nth(0).locator("figcaption")).toHaveText("上位トーナメント表");
  await expect(brackets.nth(1).locator("figcaption")).toHaveText("下位トーナメント表");
  await expect(brackets.nth(0).locator(".bracket-line-legend")).toContainText("実線：勝者");
  await expect(brackets.nth(0).locator("svg title").first()).toContainText("水平版");
  await expect(brackets.nth(0).locator("svg desc")).toContainText("完全な対戦・結果・順位情報");
  const accessibleMatch = brackets.nth(0).locator(".bracket-exploration-match").first();
  await expect(accessibleMatch).toHaveAttribute("aria-label", /対/u);
  await expect(accessibleMatch.locator("title")).toHaveText(/対/u);

  const visibleDiagramText = (await brackets.nth(0).locator("svg text").allTextContents()).join(" ");
  expect(visibleDiagramText).not.toMatch(/UT-/u);
  expect(visibleDiagramText).not.toMatch(/\d{2}:\d{2}/u);
  const lowerStages = await page
    .locator('#tournament-plan-view .tournament-pool:nth-of-type(2) table tbody td:nth-child(2)')
    .allTextContents();
  expect(lowerStages).toContain("決勝");
  expect(lowerStages).toContain("3位決定戦");
  expect(lowerStages.filter((stage) => stage === "準決勝")).toHaveLength(2);
  expect(lowerStages.some((stage) => /9位決定戦/u.test(stage))).toBe(false);

  const pageWidth = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(pageWidth.scroll).toBeLessThanOrEqual(pageWidth.client);
  const bracketWidth = await brackets.nth(0).locator(".tournament-bracket-scroll").evaluate(
    (element) => ({ client: element.clientWidth, scroll: element.scrollWidth }),
  );
  expect(bracketWidth.scroll).toBeGreaterThan(bracketWidth.client);

  await page.evaluate(() => {
    document.body.dataset.printScope = "bracket";
  });
  await page.emulateMedia({ media: "print" });
  expect(await brackets.evaluateAll(
    (figures) => figures.map((figure) => getComputedStyle(figure).page),
  )).toEqual(["bracket-horizontal", "bracket-horizontal"]);
  expect(await page.locator("#tournament-plan-view .tournament-pool").evaluateAll(
    (pools) => pools.map((pool) => getComputedStyle(pool).page),
  )).toEqual(["bracket-horizontal", "bracket-horizontal"]);
  await page.emulateMedia({ media: "screen" });
  await page.evaluate(() => {
    delete document.body.dataset.printScope;
  });

  await importDocument(page, horizontalBracketTournamentFixture(8, {
    withTournamentResults: true,
  }));
  const penaltyResult = page.locator(
    '#tournament-plan-view .bracket-exploration-match[aria-label*="PK 4-3"]',
  );
  await expect(penaltyResult).toHaveCount(1);
  await expect(penaltyResult).toHaveAttribute("aria-label", /勝者/u);
  await expect(page.locator(
    '#tournament-plan-view .bracket-exploration-match[aria-label*="1位確定"]',
  )).toHaveCount(2);
  expect((await page.locator(
    "#tournament-plan-view .bracket-exploration-match-label",
  ).allTextContents()).join(" ")).not.toContain("PK 4-3");

  await page.evaluate(async () => navigator.serviceWorker.ready);
  await page.context().setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(
    "#tournament-plan-view .tournament-bracket.exploration.horizontal",
  )).toHaveCount(2);
});

test("mirroredな16チームは上位・下位を独立に本番水平版へ選択する", async ({
  page,
}) => {
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, horizontalBracketTournamentFixture(16));
  const horizontal = page.locator(
    '#tournament-plan-view .tournament-bracket.exploration.horizontal[data-pool="upper"]',
  );
  await expect(horizontal).toHaveCount(1);
  await expect(horizontal).toHaveAttribute("data-participant-count", "16");
  await expect(page.locator(
    '#tournament-plan-view .tournament-bracket.exploration.horizontal[data-pool="lower"]',
  )).toHaveCount(1);
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
      const bracket = page.locator(
        '#tournament-plan-view .tournament-bracket[data-pool="upper"] .tournament-bracket-scroll',
      );
      const bracketDimensions = await bracket.evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
      expect(bracketDimensions.scrollWidth).toBeGreaterThan(bracketDimensions.clientWidth);
    }
  });
}
