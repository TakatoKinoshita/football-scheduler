import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { tournamentFixture } from "./fixtures";
import { importDocument, mockExternalServices, openApp } from "./helpers";

test("自動保存後の再読み込みで入力を復元する", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await page.locator("#tournament-name").fill("自動保存大会");
  await page.locator("#teams").fill("青空FC\nみどりSC");
  await page.getByRole("button", { name: "次へ：ブロック・会場" }).click();
  await page.locator("#block-count").selectOption("1");
  await page.locator("#courts").fill("Aコート");
  await expect(page.locator("#save-state")).toHaveText("この端末に保存済み");

  await page.reload();

  await expect(page.locator("#tournament-name")).toHaveValue("自動保存大会");
  await expect(page.locator("#teams")).toHaveValue("青空FC\nみどりSC");
  await expect(page.locator("#courts")).toHaveValue("Aコート");
});

test("直前確定状態への復元と削除取消しができる", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  const name = page.locator("#tournament-name");

  await name.fill("第1版");
  await page.getByRole("button", { name: "現在の内容を確定" }).click();
  await expect(page.locator("#save-state")).toHaveText("現在の内容を確定しました");
  await name.fill("第2版");
  await page.getByRole("button", { name: "現在の内容を確定" }).click();
  await expect(page.locator("#save-state")).toHaveText("現在の内容を確定しました");

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "ひとつ前の状態へ戻す" }).click();
  await expect(name).toHaveValue("第1版");

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "この端末から削除" }).click();
  await expect(name).toHaveValue("第1版");

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "この端末から削除" }).click();
  await expect(name).toHaveValue("");
  await expect(page.locator("#backup-status")).toContainText("取り消せます");

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "ひとつ前の状態へ戻す" }).click();
  await expect(name).toHaveValue("第1版");
});

test("JSONを書き出し、別の有効な大会を読み込める", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await page.locator("#tournament-name").fill("書き出し大会");
  await page.locator("#teams").fill("青空FC\nみどりSC");
  await page.getByRole("button", { name: "次へ：ブロック・会場" }).click();
  await page.locator("#block-count").selectOption("1");
  await page.locator("#courts").fill("Aコート");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "ファイルへ保存" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("書き出し大会.json");
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const exported = JSON.parse(await readFile(downloadPath!, "utf8")) as {
    tournament: { name: string };
  };
  expect(exported.tournament.name).toBe("書き出し大会");

  await importDocument(page, tournamentFixture({ name: "読込み大会", withResult: true }));
  await expect(page.locator("#tournament-name")).toHaveValue("読込み大会");
  await expect(page.locator("#result-summary")).toContainText("配置済み 1試合");
});

test("不正JSONでは現在の大会を変更しない", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await page.locator("#tournament-name").fill("変更前の大会");
  await expect(page.locator("#save-state")).toHaveText("この端末に保存済み");

  await page.locator("#import").setInputFiles({
    name: "壊れた.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"途中":'),
  });

  await expect(page.locator("#backup-status")).toContainText("ファイルを読み取れませんでした");
  await expect(page.locator("#tournament-name")).toHaveValue("変更前の大会");
});
