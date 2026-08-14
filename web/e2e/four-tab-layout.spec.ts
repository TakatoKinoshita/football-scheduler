import { expect, test, type Page } from "@playwright/test";

import { mockExternalServices } from "./helpers";

const TAB_CONTRACT = [
  { id: "tab-tournament", name: "大会・チーム", panelId: "tournament-panel" },
  { id: "tab-schedule-settings", name: "日程設定・生成", panelId: "schedule-settings-panel" },
  { id: "tab-day1", name: "1日目", panelId: "day1-results-panel" },
  { id: "tab-day2", name: "2日目", panelId: "day2-results-panel" },
] as const;

async function openApp(page: Page): Promise<void> {
  await mockExternalServices(page);
  await page.goto("/");
}

test("4タブをARIA tabsとして自由に移動できる", async ({ page }) => {
  await openApp(page);

  const tablist = page.getByRole("tablist", { name: "大会運営" });
  await expect(tablist).toBeVisible();
  await expect(tablist.getByRole("tab")).toHaveCount(4);

  for (const { id, name, panelId } of TAB_CONTRACT) {
    const tab = page.locator(`#${id}`);
    const panel = page.locator(`#${panelId}`);
    await expect(tab).toHaveRole("tab");
    await expect(tab).toContainText(name);
    await expect(tab).toHaveAttribute("aria-controls", panelId);
    await expect(panel).toHaveRole("tabpanel");
    await expect(panel).toHaveAttribute("aria-labelledby", id);
  }

  const tournamentTab = page.locator("#tab-tournament");
  const settingsTab = page.locator("#tab-schedule-settings");
  const day1Tab = page.locator("#tab-day1");
  const day2Tab = page.locator("#tab-day2");

  await expect(tournamentTab).toHaveAttribute("aria-selected", "true");
  await expect(tournamentTab).toHaveAttribute("tabindex", "0");
  await expect(page.locator("#tournament-panel")).toBeVisible();

  await tournamentTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(settingsTab).toBeFocused();
  await expect(settingsTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#schedule-settings-panel")).toBeVisible();

  await page.keyboard.press("End");
  await expect(day2Tab).toBeFocused();
  await expect(day2Tab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#day2-results-panel")).toBeVisible();

  await page.keyboard.press("Home");
  await expect(tournamentTab).toBeFocused();
  await day1Tab.click();
  await expect(day1Tab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#day1-results-panel")).toBeVisible();
});

test("入力と設定区画を決められたタブと順序に配置する", async ({ page }) => {
  await openApp(page);

  const tournamentPanel = page.locator("#tournament-panel");
  await expect(tournamentPanel.locator("#tournament-name")).toBeVisible();
  await expect(tournamentPanel.locator("#teams")).toBeVisible();
  await expect(tournamentPanel.locator("#courts")).toBeVisible();

  await page.locator("#tab-schedule-settings").click();
  const settingsPanel = page.locator("#schedule-settings-panel");
  const sectionIds = await settingsPanel.locator(":scope > .settings-section").evaluateAll(
    (sections) => sections.map((section) => section.id),
  );
  expect(sectionIds).toEqual([
    "common-settings",
    "day1-settings",
    "day2-settings",
    "schedule-generation",
  ]);

  for (const id of sectionIds) {
    await expect(page.locator(`#${id}`)).toHaveAttribute("aria-labelledby", `${id}-heading`);
  }
  await expect(settingsPanel.locator("#common-settings-heading")).toHaveText("共通設定");
  await expect(settingsPanel.locator("#common-advanced-settings summary"))
    .toHaveText("詳細設定を表示");
  await expect(settingsPanel.locator("#organizer-capacity")).toBeHidden();
  await expect(settingsPanel.locator("#random-seed")).toBeHidden();
  await settingsPanel.locator("#common-advanced-settings summary").click();
  await expect(settingsPanel.locator("#organizer-capacity")).toBeVisible();
  await expect(settingsPanel.locator("#random-seed")).toBeVisible();
  await expect(settingsPanel.locator("#block-count")).toBeVisible();
  const teamReferees = settingsPanel.locator("#team-referees");
  const day1Details = teamReferees.locator("xpath=ancestor::details[1]");
  await day1Details.locator("summary").click();
  await expect(teamReferees).toBeChecked();
  await expect(settingsPanel.locator("label[for='team-referees']")).toContainText(
    "直前セクションの同じコートで試合したチームの審判を必須",
  );
  await expect(day1Details).toContainText("オフにすると主催者審判へ切り替え");
  await expect(settingsPanel.locator("#final-stage-format")).toBeVisible();
  await expect(settingsPanel.getByRole("button", { name: "日程を生成する" })).toBeVisible();

  await page.locator("#tab-day1").click();
  await expect(
    page.locator("#day1-results-panel").getByRole("button", { name: "日程を生成する" }),
  ).toHaveCount(0);
  await page.locator("#tab-day2").click();
  await expect(
    page.locator("#day2-results-panel").getByRole("button", { name: "日程を生成する" }),
  ).toHaveCount(0);
});

for (const viewport of [
  { name: "smartphone", width: 375, height: 812, rows: 2 },
  { name: "tablet", width: 768, height: 1024, rows: 1 },
  { name: "PC", width: 1280, height: 900, rows: 1 },
]) {
  test(`${viewport.name}幅でタブを${viewport.rows === 1 ? "4列" : "2×2"}表示する`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openApp(page);

    const boxes = await page
      .getByRole("tablist", { name: "大会運営" })
      .getByRole("tab")
      .evaluateAll((tabs) =>
        tabs.map((tab) => {
          const box = tab.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        }),
      );
    expect(boxes).toHaveLength(4);
    expect(new Set(boxes.map(({ y }) => Math.round(y))).size).toBe(viewport.rows);
    expect(boxes.every(({ height }) => height >= 44)).toBe(true);

    if (viewport.rows === 2) {
      expect(Math.round(boxes[0]!.y)).toBe(Math.round(boxes[1]!.y));
      expect(boxes[2]!.y).toBeGreaterThan(boxes[0]!.y);
      expect(Math.round(boxes[2]!.y)).toBe(Math.round(boxes[3]!.y));
    }

    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  });
}

test("印刷時は設定タブと設定区画を表示しない", async ({ page }) => {
  await openApp(page);
  await page.locator("#tab-schedule-settings").click();
  await page.emulateMedia({ media: "print" });

  await expect(page.getByRole("tablist", { name: "大会運営" })).toBeHidden();
  await expect(page.locator("#schedule-settings-panel")).toBeHidden();
});
