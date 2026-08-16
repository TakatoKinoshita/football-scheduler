import { expect, test, type Page } from "@playwright/test";

const leagueFixtures = [
  "day1-league-16",
  "day2-same-rank-16-provisional",
  "day2-same-rank-16-resolved",
] as const;
const tournamentFixtures = [
  "day2-tournament-16-provisional",
  "day2-tournament-16-resolved",
] as const;

async function openPreview(page: Page, fixture: string): Promise<void> {
  await page.goto(`/print-preview.html?fixture=${encodeURIComponent(fixture)}`);
  await page.locator('body[data-preview-ready="true"]').waitFor();
}

for (const fixture of leagueFixtures) {
  test(`${fixture}は配布順でセクションを表示する`, async ({ page }) => {
    await openPreview(page, fixture);
    await expect(page.locator("body")).toHaveAttribute("data-preview-status", "ready");
    await expect(page.locator("#print-preview-error")).toBeEmpty();
    expect(await page.locator("[data-print-section]").evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.printSection)
    )).toEqual(["metadata", "groups", "schedule", "team-schedules"]);
    await expect(page.locator("[data-print-court]")).toHaveCount(3);
    await expect(page.locator("[data-participant-key]")).toHaveCount(16);
    await expect(page.locator('[data-print-section="schedule"] h2'))
      .toHaveText(fixture === "day1-league-16" ? "1日目の日程表" : "2日目の日程表");
  });
}

for (const fixture of tournamentFixtures) {
  test(`${fixture}はメタ情報、各トーナメント表、日程表の順で表示する`, async ({ page }) => {
    await openPreview(page, fixture);
    await expect(page.locator("body")).toHaveAttribute("data-preview-status", "ready");
    expect(await page.locator("[data-print-section]").evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.printSection)
    )).toEqual(["metadata", "tournament-pool", "tournament-pool", "schedule"]);
    await expect(page.locator('[data-print-section="tournament-pool"]')).toHaveCount(2);
    await expect(page.locator(".tournament-bracket-svg")).toHaveCount(2);
    await expect(page.locator('[data-print-section="schedule"] h2')).toHaveText("2日目の日程表");
  });
}

test("仮参照と順位確定後チーム名を同じ表示モデル経路で切り替える", async ({ page }) => {
  await openPreview(page, "day2-same-rank-16-provisional");
  await expect(page.locator('[data-group-id="rank-1"]')).toContainText("Aブロック 1位");
  await expect(page.locator('[data-print-court="court-a"]')).toContainText("ブロック");

  await openPreview(page, "day2-same-rank-16-resolved");
  await expect(page.locator('[data-group-id="rank-1"]'))
    .toContainText("北町ジュニアフットボールクラブ");
  await expect(page.locator('[data-print-court="court-a"]')).not.toContainText("Aブロック 1位");
});

test("印刷時は操作部と不要な監査文言を出さず、コート表を分割禁止にする", async ({ page }) => {
  await openPreview(page, "day1-league-16");
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".print-preview-controls")).toBeHidden();
  await expect(page.locator("#print-preview-output")).not.toContainText("独立チェック");
  await expect(page.locator("#print-preview-output")).not.toContainText("最適性");
  for (const court of await page.locator("[data-print-court]").all()) {
    expect(await court.evaluate((element) => getComputedStyle(element).breakInside)).toBe("avoid");
  }
});

test("存在しないfixtureは日本語エラーを示して印刷内容を生成しない", async ({ page }) => {
  await openPreview(page, "does-not-exist");
  await expect(page.locator("body")).toHaveAttribute("data-preview-status", "error");
  await expect(page.locator("#print-preview-output")).toHaveCount(0);
  await expect(page.locator("#print-preview-error")).toContainText("存在しません");
  await expect(page.locator("#print-preview-error")).toContainText("出力を中止しました");
});
