import { expect, test, type Page } from "@playwright/test";

import { tournamentFixture } from "./fixtures";
import { importDocument, mockExternalServices, openApp } from "./helpers";

async function fillValidTournament(page: Page, courts = "Aコート\nBコート"): Promise<void> {
  await page.locator("#tournament-name").fill("入力誘導確認大会");
  await page.locator("#teams").fill("青空FC\nみどりSC\n中央キッカーズ\n海浜ユナイテッド");
  await page.locator("#courts").fill(courts);
  await page.locator("#tab-schedule-settings").click();
  await page.locator("#block-count").selectOption("2");
  await page.locator("#final-stage-format").selectOption("same_rank_league");
  await expect(page.getByTestId("turnstile-widget-mock")).toBeVisible();
  await expect(page.getByRole("button", { name: "日程を生成する" })).toBeEnabled();
}

async function expectGuidedTo(page: Page, fieldId: string, step: 1 | 2): Promise<void> {
  const field = page.locator(`#${fieldId}`);
  await expect(page.locator(`.step[data-step="${step}"]`)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toHaveAttribute("aria-describedby", `${fieldId}-error`);
  await expect(field.locator("xpath=ancestor::*[contains(@class, 'field')][1]"))
    .toHaveClass(/field-has-error/u);
  await expect(page.locator(`#${fieldId}-error`)).toHaveAttribute("data-error-active", "true");
  await expect.poll(async () => field.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  })).toBe(true);
}

test("共通設定は初期・再読込み・JSON読込み後に閉じ、名称と保存値を維持する", async ({
  page,
}) => {
  await mockExternalServices(page);
  await openApp(page);
  await page.locator("#tab-schedule-settings").click();
  await expect(page.locator("#common-settings-heading")).toHaveText("共通設定");
  await expect(page.locator("#common-advanced-settings summary")).toHaveText("詳細設定を表示");
  await expect(page.locator("#common-advanced-settings")).not.toHaveAttribute("open", "");

  await page.locator("#common-advanced-settings summary").click();
  await page.locator("#organizer-capacity").fill("3");
  await expect(page.locator("#save-state")).toHaveText("この端末に保存済み");
  await page.reload();
  await page.locator("#tab-schedule-settings").click();
  await expect(page.locator("#common-advanced-settings")).not.toHaveAttribute("open", "");
  await expect(page.locator("#organizer-capacity")).toHaveValue("3");

  const imported = tournamentFixture();
  imported.tournament.input.referees.organizer_capacity = 2;
  imported.tournament.input.random_seed = 17;
  await importDocument(page, imported);
  await page.locator("#tab-schedule-settings").click();
  await expect(page.locator("#common-advanced-settings")).not.toHaveAttribute("open", "");
  await expect(page.locator("#organizer-capacity")).toHaveValue("2");
  await expect(page.locator("#random-seed")).toHaveValue("17");
});

test("通常のタブ移動では現在のscroll位置を維持する", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await page.setViewportSize({ width: 768, height: 500 });
  await page.locator("#tab-schedule-settings").click();
  const before = await page.evaluate(() => {
    window.scrollTo(0, 120);
    return window.scrollY;
  });
  await page.locator("#tab-tournament").evaluate((button: HTMLButtonElement) => button.click());
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
});

test("決勝方式とブロック数の不足はタブ2の先頭対象へfocusする", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await page.locator("#tournament-name").fill("入力誘導確認大会");
  await page.locator("#teams").fill("青空FC\nみどりSC\n中央キッカーズ\n海浜ユナイテッド");
  await page.locator("#courts").fill("Aコート");
  await page.locator("#tab-schedule-settings").click();
  await page.locator("#block-count").selectOption("2");
  await page.getByRole("button", { name: "日程を生成する" }).click();
  await expectGuidedTo(page, "final-stage-format", 2);
  await expect(page.locator("#final-stage-format-error")).toContainText("決勝方式を選択");

  await page.locator("#final-stage-format").selectOption("same_rank_league");
  await page.locator("#block-count").selectOption("");
  await page.getByRole("button", { name: "日程を生成する" }).click();
  await expectGuidedTo(page, "block-count", 2);
});

test("使用コート不足はタブ1へ戻し、表示範囲内のコート欄へfocusする", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await fillValidTournament(page, "");
  await page.getByRole("button", { name: "日程を生成する" }).click();
  await expectGuidedTo(page, "courts", 1);
  await expect(page.locator("#courts-error")).toContainText("1つ以上");
});

test("共通設定内部の不備だけが閉じたdetailsを開いてfocusする", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await fillValidTournament(page);
  const commonDetails = page.locator("#common-advanced-settings");
  await commonDetails.locator("summary").click();
  await page.locator("#organizer-capacity").fill("");
  await page.locator("#block-count").selectOption("");
  await commonDetails.locator("summary").click();
  await expect(commonDetails).not.toHaveAttribute("open", "");

  await page.getByRole("button", { name: "日程を生成する" }).click();

  await expect(commonDetails).toHaveAttribute("open", "");
  await expectGuidedTo(page, "organizer-capacity", 2);
  await expect(page.locator("#organizer-capacity-error")).toContainText("0以上の整数");
  await expect(page.locator("#block-count-error")).toContainText("選択してください");
});
