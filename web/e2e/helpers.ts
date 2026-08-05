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
              var marker = document.createElement("div");
              marker.dataset.testid = "turnstile-widget-mock";
              marker.textContent = "安全確認";
              element.append(marker);
              if (${completeTurnstile}) {
                setTimeout(function () {
                  options.callback("e2e-turnstile-token");
                }, 0);
              }
              return "e2e-widget";
            },
            reset: function () {
              setTimeout(function () {
                window.__e2eTurnstileOptions.callback("e2e-turnstile-token");
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
  await page.goto("/");
  await expect(page.locator("#save-state")).not.toHaveText("読み込み中…");
  await expect(page.getByTestId("turnstile-widget-mock")).toBeVisible();
  await expect(page.locator("#generation-status")).toContainText("安全確認が完了しました");
  await expect(page.getByRole("button", { name: "日程を生成する" })).toBeEnabled();
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
}
