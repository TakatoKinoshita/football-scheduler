import { expect, test } from "@playwright/test";

import { tournamentFixture } from "./fixtures";
import {
  GENERATE_API,
  importDocument,
  mockExternalServices,
  openReadyApp,
  TURNSTILE_SCRIPT,
} from "./helpers";

test("初回online表示後はofflineでも保存済み結果と印刷内容を確認できる", async ({
  context,
  page,
}) => {
  await openReadyApp(page);
  await importDocument(page, tournamentFixture());
  await page.getByRole("button", { name: "日程を生成する" }).click();
  await expect(page.locator("#generation-status")).toContainText("この端末へ保存しました");
  await expect(page.locator("#result-summary")).toContainText("配置済み 1試合");

  await page.evaluate(async () => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.locator("#result-summary")).toContainText("配置済み 1試合");
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  await page.unroute(TURNSTILE_SCRIPT);
  await page.unroute(GENERATE_API);
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });

  await expect(page.locator("#result-summary")).toContainText("配置済み 1試合");
  await expect(page.locator("#result-content")).toContainText("青空FC 対 みどりSC");
  await expect(page.locator("#result-content")).toContainText("チーム別予定");
  await expect(page.locator("#turnstile")).toContainText("安全確認を読み込めませんでした");
  await page.getByRole("button", { name: "日程を生成する" }).click();
  await expect(page.locator("#generation-status")).toContainText("安全確認を完了してから");
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
  await expect(page.getByRole("button", { name: "印刷する" })).toBeHidden();
  await expect(page.locator(".panel.results")).toBeVisible();
  await expect(page.locator("#result-content")).toContainText("青空FC 対 みどりSC");
});
