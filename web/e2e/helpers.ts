import { expect, type Page } from "@playwright/test";

import { scheduleResult } from "./fixtures";

export const TURNSTILE_SCRIPT =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
export const GENERATE_API = "**/api/v1/schedules:generate";

export async function mockExternalServices(
  page: Page,
  { completeTurnstile = true }: { completeTurnstile?: boolean } = {},
): Promise<void> {
  await page.route(TURNSTILE_SCRIPT, async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: `
        if (window.turnstile === undefined) {
          window.turnstile = {
            render: function (element, options) {
              window.__e2eTurnstileOptions = options;
              window.__e2eTurnstileOptionsById = window.__e2eTurnstileOptionsById || {};
              var widgetId = "e2e-widget-" + Object.keys(window.__e2eTurnstileOptionsById).length;
              window.__e2eTurnstileOptionsById[widgetId] = options;
              var marker = document.createElement("div");
              marker.dataset.testid = "turnstile-widget-mock";
              marker.dataset.action = options.action;
              marker.textContent = "安全確認";
              element.append(marker);
              if (${completeTurnstile}) {
                setTimeout(function () {
                  options.callback("e2e-turnstile-token");
                }, 0);
              }
              return widgetId;
            },
            reset: function (widgetId) {
              var options = window.__e2eTurnstileOptionsById[widgetId];
              setTimeout(function () {
                options.callback("e2e-turnstile-token");
              }, 0);
            }
          };
        }
      `,
    });
  });
  await page.route(GENERATE_API, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: 200,
      body: JSON.stringify(scheduleResult),
    });
  });
}

export async function openReadyApp(page: Page): Promise<void> {
  await mockExternalServices(page);
  await openApp(page);
  await page.locator("#tournament-name").fill("E2E地区大会");
  await page.locator("#teams").fill("青空FC\nみどりSC");
  await page.getByRole("button", { name: "次へ：ブロック・会場" }).click();
  await page.locator("#block-count").selectOption("1");
  await page.locator("#courts").fill("Aコート");
  await advanceToGeneration(page);
  await expect(page.getByTestId("turnstile-widget-mock")).toBeVisible();
  await expect(page.locator("#generation-status")).toContainText("安全確認が完了しました");
  await expect(page.getByRole("button", { name: "1日目の日程を生成する" })).toBeEnabled();
}

export async function openApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator("#save-state")).not.toHaveText("読み込み中…");
}

export async function advanceToGeneration(page: Page): Promise<void> {
  const stepOne = page.locator('[data-panel="1"]');
  if (await stepOne.isVisible()) {
    await page.getByRole("button", { name: "次へ：ブロック・会場" }).click();
  }
  const blockCount = page.locator("#block-count");
  if ((await blockCount.inputValue()) === "") await blockCount.selectOption("1");
  await page.getByRole("button", { name: "次へ：時刻・生成" }).click();
}

export async function importDocument(page: Page, document: unknown): Promise<void> {
  const expectedName = (document as { tournament?: { name?: unknown } }).tournament?.name;
  if (typeof expectedName !== "string") throw new Error("E2E fixtureに大会名がありません。");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#import").setInputFiles({
    name: "大会データ.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(document)),
  });
  await expect(page.locator("#tournament-name")).toHaveValue(expectedName);
  await expect(page.locator('#backup-status[data-state="imported"]')).toBeAttached();
}
