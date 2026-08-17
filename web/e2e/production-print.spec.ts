import { expect, test, type Page } from "@playwright/test";

import {
  legacyTournamentFixture,
  sameRankWebFixture,
  scheduleViewTournamentFixture,
  tournamentFixture,
} from "./fixtures";
import { importDocument, mockExternalServices, openApp } from "./helpers";

async function openWithPrintStub(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.print = () => {
      document.body.dataset.printInvoked = "true";
    };
  });
  await mockExternalServices(page);
  await openApp(page);
}

async function finishPrint(page: Page): Promise<void> {
  await page.emulateMedia({ media: "screen" });
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
}

test("1日目印刷は保存snapshotだけを専用DOMへ描画し、終了後にdraft・開閉・focusを保つ", async ({
  page,
}) => {
  await openWithPrintStub(page);
  await importDocument(page, tournamentFixture({ withResult: true }));
  const score = page.locator('#league-results-input [data-match-id="LG-A-M1"] input').first();
  await score.fill("7");
  const disclosuresBefore = await page.locator(".result-disclosure").evaluateAll((items) =>
    items.map((item) => (item as HTMLDetailsElement).open)
  );

  const button = page.getByRole("button", { name: "1日目を印刷" });
  await button.focus();
  await button.click();
  await page.emulateMedia({ media: "print" });

  await expect(page.locator("body")).toHaveAttribute("data-production-print-ready", "true");
  await expect(page.locator("#production-print-host")).toBeVisible();
  expect(await page.locator("#production-print-host [data-print-section]").evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.printSection)
  )).toEqual(["metadata", "league-overview", "schedule", "team-schedules"]);
  await expect(page.locator("#production-print-host")).toContainText("1日目の組合せ概要");
  await expect(page.locator("#production-print-host")).toContainText("青空FC 対 みどりSC");
  await expect(page.locator("#production-print-host input, #production-print-host button")).toHaveCount(0);
  await expect(page.locator("#production-print-host details")).toHaveCount(0);
  await expect(page.locator("#production-print-host")).not.toContainText("独立チェック");

  await finishPrint(page);
  await expect(page.locator("#production-print-host")).toBeEmpty();
  await expect(score).toHaveValue("7");
  expect(await page.locator(".result-disclosure").evaluateAll((items) =>
    items.map((item) => (item as HTMLDetailsElement).open)
  )).toEqual(disclosuresBefore);
  await expect(button).toBeFocused();
});

test("2日目トーナメントはofflineでも全体印刷と表だけ印刷を保存状態から構築する", async ({
  context,
  page,
}) => {
  await openWithPrintStub(page);
  await importDocument(page, scheduleViewTournamentFixture());
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#save-state")).not.toHaveText("読み込み中…");
  await expect(page.locator("#day2-result-summary")).toContainText("2日目");

  await page.getByRole("button", { name: "2日目を印刷" }).click();
  await page.emulateMedia({ media: "print" });
  const host = page.locator("#production-print-host");
  expect(await host.locator("[data-print-section]").evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.printSection)
  )).toEqual([
    "metadata",
    "tournament-overview",
    "tournament-pool",
    "tournament-pool",
    "schedule",
  ]);
  await expect(host.locator("[data-summary-pool-id] li")).toHaveCount(8);
  await expect(host.locator("[data-summary-pool-id] li").first()).toContainText("ブロック");
  await expect(host.locator(".tournament-bracket")).toHaveCount(2);
  await expect(host.locator("[data-print-court]")).toHaveCount(2);
  await finishPrint(page);

  await page.getByRole("button", { name: "トーナメント表だけ印刷" }).click();
  await page.emulateMedia({ media: "print" });
  await expect(host.locator(".print-document")).toHaveAttribute("data-print-mode", "bracket-only");
  expect(await host.locator("[data-print-section]").evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.printSection)
  )).toEqual(["tournament-pool", "tournament-pool"]);
  await expect(host.locator("[data-print-section='metadata']")).toHaveCount(0);
  await expect(host.locator("[data-print-section='schedule']")).toHaveCount(0);
});

for (const resolution of ["provisional", "resolved"] as const) {
  test(`2日目同順位リーグ${resolution === "resolved" ? "確定" : "仮"}版を組合せ概要で印刷する`, async ({ page }) => {
    await openWithPrintStub(page);
    await importDocument(page, sameRankWebFixture(16, { resolved: resolution === "resolved" }));
    await page.getByRole("button", { name: "2日目を印刷" }).click();
    await page.emulateMedia({ media: "print" });
    const host = page.locator("#production-print-host");
    await expect(host).toContainText("2日目の組合せ概要");
    await expect(host.locator("[data-summary-group-id]")).toHaveCount(4);
    await expect(host.locator("[data-summary-group-id] li")).toHaveCount(16);
    if (resolution === "resolved") {
      await expect(host.locator("[data-summary-group-id] li").first()).toContainText("チーム");
      await expect(host.locator("[data-summary-group-id] li").first()).not.toContainText("ブロック");
    } else {
      await expect(host.locator("[data-summary-group-id] li").first()).toContainText("ブロック 1位");
    }
  });
}

test("schema 0.1.0の閲覧専用大会も1日目の採用レイアウトで印刷する", async ({ page }) => {
  await openWithPrintStub(page);
  await importDocument(page, legacyTournamentFixture({ withResult: true }));
  await page.getByRole("button", { name: "1日目を印刷" }).click();
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#production-print-host")).toContainText("1日目の組合せ概要");
  await expect(page.locator("#production-print-host [data-summary-group-id]")).toHaveCount(2);
  await expect(page.locator("#production-print-host [data-print-court]")).toHaveCount(1);
});
