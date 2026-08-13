import { expect, test } from "@playwright/test";

import { scheduleViewTournamentFixture, tournamentResultsFixture } from "./fixtures";
import { importDocument, openApp, TURNSTILE_SCRIPT } from "./helpers";

function successfulTurnstileScript(options: { throwFirstStandingsRender?: boolean } = {}): string {
  return `
    window.__e2eTurnstileTokenCounter = 0;
    window.__e2eTurnstileRenderCounts = {};
    window.turnstile = {
      render: function (element, widgetOptions) {
        var action = widgetOptions.action;
        var count = (window.__e2eTurnstileRenderCounts[action] || 0) + 1;
        window.__e2eTurnstileRenderCounts[action] = count;
        if (${options.throwFirstStandingsRender === true} && action === "calculate_standings" && count === 1) {
          throw new Error("temporary render failure");
        }
        var widgetId = action + "-" + count;
        var marker = document.createElement("div");
        marker.dataset.testid = "turnstile-lifecycle-widget";
        marker.dataset.action = action;
        marker.dataset.widgetId = widgetId;
        marker.textContent = "安全確認";
        element.append(marker);
        setTimeout(function () {
          window.__e2eTurnstileTokenCounter += 1;
          widgetOptions.callback("turnstile-token-" + window.__e2eTurnstileTokenCounter);
        }, 0);
        return widgetId;
      },
      reset: function () {},
      remove: function (widgetId) {
        document.querySelector('[data-widget-id="' + widgetId + '"]')?.remove();
      }
    };
  `;
}

test("表示中のタブだけでTurnstileを初期化し各操作のactionを維持する", async ({ page }) => {
  let scriptRequests = 0;
  await page.route(TURNSTILE_SCRIPT, async (route) => {
    scriptRequests += 1;
    await route.fulfill({
      contentType: "application/javascript",
      body: successfulTurnstileScript(),
    });
  });
  await openApp(page);
  await importDocument(page, tournamentResultsFixture());

  await expect(
    page.locator(
      '#tournament-results-turnstile-widget [data-action="calculate_tournament_results"]',
    ),
  ).toBeVisible();
  await expect(page.locator("#standings-turnstile-widget [data-action]"))
    .toHaveCount(0);
  await expect(page.locator("#turnstile-widget [data-action]"))
    .toHaveCount(0);

  await page.locator("#tab-day1").click();
  await expect(
    page.locator('#standings-turnstile-widget [data-action="calculate_standings"]'),
  ).toBeVisible();
  await page.locator("#tab-schedule-settings").click();
  await expect(
    page.locator('#turnstile-widget [data-action="create_schedule"]'),
  ).toBeVisible();

  expect(scriptRequests).toBe(1);
  await expect(page.locator('[data-testid="turnstile-lifecycle-widget"]')).toHaveCount(3);
});

test("共有スクリプトの初回読込み失敗後にタブ3で再読込みする", async ({ page }) => {
  let scriptRequests = 0;
  await page.route(TURNSTILE_SCRIPT, async (route) => {
    scriptRequests += 1;
    if (scriptRequests === 1) {
      await route.abort("failed");
      return;
    }
    await route.fulfill({
      contentType: "application/javascript",
      body: successfulTurnstileScript(),
    });
  });
  await openApp(page);
  await importDocument(page, tournamentResultsFixture());
  await expect(page.locator("#tournament-results-turnstile-widget"))
    .toContainText("安全確認を読み込めませんでした");

  await page.locator("#tab-day1").click();

  await expect(
    page.locator('#standings-turnstile-widget [data-action="calculate_standings"]'),
  ).toBeVisible();
  expect(scriptRequests).toBe(2);
});

test("タブ3のrender例外後に同じ画面へ戻ると再初期化する", async ({ page }) => {
  await page.route(TURNSTILE_SCRIPT, async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: successfulTurnstileScript({ throwFirstStandingsRender: true }),
    });
  });
  await openApp(page);
  await importDocument(page, scheduleViewTournamentFixture());
  await page.locator("#tab-day1").click();
  await expect(page.locator("#standings-turnstile-widget"))
    .toContainText("安全確認を初期化できませんでした");

  await page.locator("#tab-day2").click();
  await page.locator("#tab-day1").click();

  await expect(
    page.locator('#standings-turnstile-widget [data-action="calculate_standings"]'),
  ).toBeVisible();
  const renderCount = await page.evaluate(() =>
    (window as Window & { __e2eTurnstileRenderCounts?: Record<string, number> })
      .__e2eTurnstileRenderCounts?.calculate_standings
  );
  expect(renderCount).toBe(2);
});

test("読込み中の高速なタブ移動でもscriptとwidgetを重複生成しない", async ({ page }) => {
  let scriptRequests = 0;
  await page.route(TURNSTILE_SCRIPT, async (route) => {
    scriptRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.fulfill({
      contentType: "application/javascript",
      body: successfulTurnstileScript(),
    });
  });
  await openApp(page);
  await importDocument(page, scheduleViewTournamentFixture());

  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>("#tab-day1")?.click();
    document.querySelector<HTMLButtonElement>("#tab-schedule-settings")?.click();
    document.querySelector<HTMLButtonElement>("#tab-day1")?.click();
  });

  await expect(
    page.locator('#standings-turnstile-widget [data-action="calculate_standings"]'),
  ).toBeVisible();
  expect(scriptRequests).toBe(1);
  await expect(page.locator('[data-testid="turnstile-lifecycle-widget"]')).toHaveCount(1);
});

test("オフラインで開いたタブ3をオンライン復帰時に初期化する", async ({ context, page }) => {
  let scriptRequests = 0;
  await page.route(TURNSTILE_SCRIPT, async (route) => {
    scriptRequests += 1;
    await route.fulfill({
      contentType: "application/javascript",
      body: successfulTurnstileScript(),
    });
  });
  await openApp(page);
  await importDocument(page, scheduleViewTournamentFixture());
  await context.setOffline(true);
  await page.locator("#tab-day1").click();
  await expect(page.locator("#standings-turnstile-widget"))
    .toContainText("安全確認を読み込めませんでした");
  expect(scriptRequests).toBe(0);

  await context.setOffline(false);

  await expect(
    page.locator('#standings-turnstile-widget [data-action="calculate_standings"]'),
  ).toBeVisible();
  expect(scriptRequests).toBe(1);
});
