import { expect, test, type Page } from "@playwright/test";

import { scheduleViewTournamentFixture } from "./fixtures";
import { importDocument, mockExternalServices, openApp } from "./helpers";

function teamNames(count: number): string {
  return Array.from({ length: count }, (_, index) => `チーム${String(index + 1)}`).join("\n");
}

async function setTeamCount(page: Page, count: number): Promise<void> {
  await page.locator("#tab-tournament").click();
  await page.locator("#teams").fill(teamNames(count));
  await page.locator("#tab-schedule-settings").click();
}

async function restoreBrowserDraft(page: Page, document: unknown): Promise<void> {
  await page.evaluate(async (draft) => {
    await new Promise<void>((resolve, reject) => {
      const openRequest = indexedDB.open("football-scheduler", 2);
      openRequest.addEventListener("error", () => reject(openRequest.error));
      openRequest.addEventListener("success", () => {
        const database = openRequest.result;
        const transaction = database.transaction("documents", "readwrite");
        transaction.objectStore("documents").put({ key: "draft", document: draft });
        transaction.addEventListener("complete", () => {
          database.close();
          resolve();
        });
        transaction.addEventListener("error", () => reject(transaction.error));
      });
    });
  }, document);
  await page.reload();
  await expect(page.locator("#save-state")).not.toHaveText("読み込み中…");
}

test("対応境界に応じて順位決定トーナメントの選択可否と説明を更新する", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);

  const format = page.locator("#final-stage-format");
  const placementOption = format.locator('option[value="placement_tournament"]');
  await expect(format).toHaveAttribute("aria-describedby", "final-stage-format-guidance");

  for (const [teamCount, supported] of [
    [7, false],
    [8, true],
    [9, false],
    [15, false],
    [16, true],
    [17, false],
    [23, false],
    [24, true],
    [25, false],
    [31, false],
    [32, true],
  ] as const) {
    await setTeamCount(page, teamCount);
    expect(await placementOption.evaluate((option: HTMLOptionElement) => option.disabled)).toBe(
      !supported,
    );
    if (supported) {
      await format.selectOption("placement_tournament");
      await expect(format).toHaveValue("placement_tournament");
      await format.selectOption("");
    } else {
      await expect(page.locator("#final-stage-format-guidance")).toContainText(
        "順位決定トーナメントは8、16、24、32チームで利用できます",
      );
    }
  }

  await setTeamCount(page, 7);
  expect(
    await format.locator('option[value="same_rank_league"]').evaluate(
      (option: HTMLOptionElement) => option.disabled,
    ),
  ).toBe(false);
  await format.selectOption("same_rank_league");
  await expect(format).toHaveValue("same_rank_league");
});

test("選択済みトーナメントを非対応チーム数へ変更すると従属入力と生成結果を取り消す", async ({
  page,
}) => {
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, scheduleViewTournamentFixture());
  await page.locator("#tab-schedule-settings").click();
  await expect(page.locator("#final-stage-format")).toHaveValue("placement_tournament");
  await expect(page.locator("#tournament-count")).toHaveValue("2");
  await page.locator("#tournament-name-1").fill("カスタム上位");

  await setTeamCount(page, 9);

  await expect(page.locator("#final-stage-format")).toHaveValue("");
  await expect(page.locator('option[value="placement_tournament"]')).toHaveAttribute(
    "disabled",
    "",
  );
  await expect(page.locator("#tournament-count")).toHaveValue("");
  await expect(page.locator("#tournament-count-field")).toBeHidden();
  await expect(page.locator("#tournament-names-field")).toBeHidden();
  await expect(page.locator("#tournament-name-1")).toHaveValue("第1順位決定トーナメント");
  await expect(page.locator("#generation-status")).toContainText("以前の生成結果を取り消しました");
  await page.locator("#tab-day1").click();
  await expect(page.locator("#result-summary")).toHaveText("まだ生成結果はありません。");
});

test("非対応の保存データを復元すると決勝方式と生成結果をクリアして再選択を促す", async ({
  page,
}) => {
  await mockExternalServices(page);
  await openApp(page);
  const document = scheduleViewTournamentFixture();
  document.tournament.input.teams = document.tournament.input.teams.slice(0, 7);

  await restoreBrowserDraft(page, document);
  await expect(page.locator("#save-state")).toContainText(
    "非対応の順位決定トーナメントと以前の生成結果を取り消しました",
  );
  await page.locator("#tab-schedule-settings").click();

  await expect(page.locator("#final-stage-format")).toHaveValue("");
  await expect(page.locator('option[value="placement_tournament"]')).toHaveAttribute(
    "disabled",
    "",
  );
  await page.locator("#final-stage-format").selectOption("same_rank_league");
  await expect(page.locator("#final-stage-format")).toHaveValue("same_rank_league");
  await page.locator("#tab-day1").click();
  await expect(page.locator("#result-summary")).toHaveText("まだ生成結果はありません。");
});
