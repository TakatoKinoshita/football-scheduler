import { expect, test } from "@playwright/test";

import { minimumSameRankScheduleResult, tournamentFixture } from "./fixtures";
import {
  GENERATE_API,
  advanceToGeneration,
  importDocument,
  mockExternalServices,
  openReadyApp,
  scheduleCreationResponse,
  TURNSTILE_SCRIPT,
} from "./helpers";

test("初回online表示後はofflineでも保存済み結果と印刷内容を確認できる", async ({
  context,
  page,
}) => {
  await openReadyApp(page);
  await page.unroute(GENERATE_API);
  await page.route(GENERATE_API, async (route) => {
    const request = route.request().postDataJSON() as {
      teams: Array<{ id: string }>;
      courts: Array<{ id: string }>;
    };
    const response = structuredClone(minimumSameRankScheduleResult);
    const teamIds = request.teams.map((team) => team.id);
    const courtId = request.courts[0]!.id;
    response.league_plan.blocks = [
      { id: "A", team_ids: teamIds.slice(0, 2) },
      { id: "B", team_ids: teamIds.slice(2, 4) },
    ];
    response.league_plan.matches[0]!.possible_home_team_ids = [teamIds[0]!];
    response.league_plan.matches[0]!.possible_away_team_ids = [teamIds[1]!];
    response.league_plan.matches[1]!.possible_home_team_ids = [teamIds[2]!];
    response.league_plan.matches[1]!.possible_away_team_ids = [teamIds[3]!];
    response.slots[0]!.court_id = courtId;
    response.slots[1]!.court_id = courtId;
    response.slots[1]!.referee_assignment = { kind: "team", team_id: teamIds[0]! };
    await route.fulfill({
      contentType: "application/json",
      status: 200,
      body: JSON.stringify(scheduleCreationResponse(response)),
    });
  });
  await page.getByRole("button", { name: "日程を生成する" }).click();
  await expect(page.locator("#generation-status")).toContainText("この端末へ保存しました");
  await expect(page.locator("#result-summary")).toContainText("配置済み 2試合");

  await page.evaluate(async () => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.locator("#result-summary")).toContainText("配置済み 2試合");
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  await page.unroute(TURNSTILE_SCRIPT);
  await page.unroute(GENERATE_API);
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });

  await expect(page.locator("#result-summary")).toContainText("配置済み 2試合");
  await expect(page.locator("#result-content")).toContainText("青空FC 対 みどりSC");
  await expect(page.locator("#result-content")).toContainText("チーム別予定");
  await page.getByRole("button", { name: "設定へ戻る" }).click();
  await expect(page.locator("#turnstile-widget")).toContainText(
    "安全確認を読み込めませんでした",
  );
  await expect(page.locator("#generation-status")).toContainText(
    "安全確認を読み込めませんでした",
  );
  await expect(page.getByRole("button", { name: "日程を生成する" })).toBeDisabled();
});

test("Turnstile APIの読込み中は生成できず、安全確認後だけ生成できる", async ({ page }) => {
  await mockExternalServices(page, { completeTurnstile: false });
  await page.goto("/");
  await page.locator("#tournament-name").fill("安全確認大会");
  await page.locator("#teams").fill("青空FC\nみどりSC\n中央キッカーズ\n海浜ユナイテッド");
  await page.locator("#courts").fill("Aコート");
  await page.getByRole("button", { name: "次へ：日程設定・生成" }).click();
  await page.locator("#block-count").selectOption("2");
  await advanceToGeneration(page);

  await expect(page.getByTestId("turnstile-widget-mock")).toBeVisible();
  await expect(page.getByRole("button", { name: "日程を生成する" })).toBeDisabled();
  await page.evaluate(() => {
    const options = (
      window as Window & {
        __e2eTurnstileOptions?: { callback: (token: string) => void };
      }
    ).__e2eTurnstileOptions;
    if (options === undefined) throw new Error("Turnstile E2E options are unavailable");
    options.callback("e2e-turnstile-token");
  });
  await expect(page.locator("#generation-status")).toContainText("安全確認が完了しました");
  await expect(page.getByRole("button", { name: "日程を生成する" })).toBeEnabled();
});

test("Turnstile APIを初期化できない場合は日本語で案内して生成を無効にする", async ({
  page,
}) => {
  await page.route(TURNSTILE_SCRIPT, async (route) => {
    await route.fulfill({ contentType: "application/javascript", body: "window.turnstile = {};" });
  });
  await page.goto("/");
  await page.locator("#tournament-name").fill("安全確認大会");
  await page.locator("#teams").fill("青空FC\nみどりSC\n中央キッカーズ\n海浜ユナイテッド");
  await page.locator("#courts").fill("Aコート");
  await page.getByRole("button", { name: "次へ：日程設定・生成" }).click();
  await page.locator("#block-count").selectOption("2");
  await advanceToGeneration(page);

  await expect(page.locator("#turnstile-widget")).toContainText("安全確認を初期化できませんでした");
  await expect(page.locator("#generation-status")).toContainText(
    "安全確認を初期化できませんでした",
  );
  await expect(page.getByRole("button", { name: "日程を生成する" })).toBeDisabled();
});

test("安全確認の期限が切れたら生成を無効にして再確認を案内する", async ({ page }) => {
  await openReadyApp(page);
  await page.evaluate(() => {
    const options = (
      window as Window & {
        __e2eTurnstileOptions?: { "expired-callback": () => void };
      }
    ).__e2eTurnstileOptions;
    if (options === undefined) throw new Error("Turnstile E2E options are unavailable");
    options["expired-callback"]();
  });

  await expect(page.locator("#generation-status")).toContainText("安全確認の期限が切れました");
  await expect(page.getByRole("button", { name: "日程を生成する" })).toBeDisabled();
});

for (const viewport of [
  { name: "smartphone", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "PC", width: 1280, height: 900 },
]) {
  test(`${viewport.name}幅で主要操作が可能で横方向へはみ出さない`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openReadyApp(page);

    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);

    for (const control of await page.locator("button:visible, .file-button:visible").all()) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });
}

test("印刷mediaでは操作を隠して保存済み結果を表示する", async ({ page }) => {
  await mockExternalServices(page);
  await page.goto("/");
  await importDocument(page, tournamentFixture({ withResult: true }));
  await page.emulateMedia({ media: "print" });

  await expect(page.locator(".site-header")).toBeHidden();
  await expect(page.getByRole("button", { name: "1日目を印刷" })).toBeHidden();
  await expect(page.locator("#day1-results-panel")).toBeVisible();
  await expect(page.locator("#day2-results-panel")).toBeHidden();
  await expect(page.locator("#result-content")).toContainText("青空FC 対 みどりSC");
});
