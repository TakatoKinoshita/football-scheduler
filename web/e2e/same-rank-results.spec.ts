import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

import { sameRankWebFixture } from "./fixtures";
import {
  GENERATE_API,
  importDocument,
  mockExternalServices,
  openApp,
  scheduleCreationResponse,
} from "./helpers";

function sameRankScheduleIdentity(schedule: Record<string, unknown>): unknown {
  return {
    matches: (schedule.same_rank_matches as Array<Record<string, unknown>>).map((match) => ({
      id: match.id, group_id: match.group_id, home: match.home, away: match.away,
    })),
    slots: (schedule.slots as Array<Record<string, unknown>>).map((slot) => {
      const assignment = slot.referee_assignment as Record<string, unknown> | null;
      return {
        match_id: slot.match_id,
        section_no: slot.section_no,
        court_id: slot.court_id,
        referee: assignment === null ? null : {
          kind: assignment.kind,
          rank_ref: assignment.rank_ref,
          organizer_reason: assignment.organizer_reason,
          fallback_reasons: assignment.fallback_reasons,
        },
      };
    }),
  };
}

test("16チーム4ブロックの同順位リーグを再表示し、引き分け結果から総合順位を確定する", async ({
  page,
}) => {
  const fixture = sameRankWebFixture(16);
  await mockExternalServices(page);
  await page.route(GENERATE_API, async (route) => {
    const request = route.request().postDataJSON() as {
      request_kind?: string;
      same_rank_plan?: {
        groups: Array<{
          id: string;
          participants: Array<{ entry: unknown; team: { team_id: string } }>;
        }>;
      };
      results?: Array<Record<string, unknown>>;
    };
    if (request.request_kind !== "same_rank_league_results" || request.same_rank_plan === undefined) {
      await route.fallback();
      return;
    }
    expect(route.request().headers()["x-turnstile-action"]).toBe("calculate_same_rank_results");
    const standings = request.same_rank_plan.groups.flatMap((group) =>
      group.participants.map((participant, index) => ({
        rank: request.same_rank_plan!.groups
          .slice(0, request.same_rank_plan!.groups.indexOf(group))
          .reduce((total, item) => total + item.participants.length, 0) + index + 1,
        group_id: group.id,
        group_rank: index + 1,
        team_id: participant.team.team_id,
        entry: participant.entry,
        played: 3,
        wins: 0,
        draws: 3,
        losses: 0,
        goals_for: 3,
        goals_against: 3,
        goal_difference: 0,
        points: 3,
        tie_break: "抽選",
        head_to_head: null,
        automatic: false,
      })),
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schema_version: "0.2.0",
        status: "COMPLETE",
        match_results: request.results,
        standings,
        draws: [],
      }),
    });
  });
  await openApp(page);
  await importDocument(page, fixture);

  await expect(page.locator("#same-rank-plan-view .same-rank-group-card")).toHaveCount(4);
  await expect(page.locator("#same-rank-plan-view .notice")).toHaveCount(0);
  const headers = await page
    .getByRole("table", { name: "同順位リーグの試合結果入力" })
    .locator("thead th")
    .allTextContents();
  expect(headers).toEqual(["試合", "時間", "コート", "対戦", "結果"]);
  await expect(
    page.locator('[data-testid="turnstile-widget-mock"][data-action="calculate_same_rank_results"]'),
  ).toBeVisible();

  const result = (fixture as { tournament: { result: Record<string, unknown> } }).tournament.result;
  const plan = result.same_rank_plan as { groups: Array<{ matches: Array<{ id: string }> }> };
  const matchIds = plan.groups.flatMap((group) => group.matches.map((match) => match.id));
  for (const matchId of matchIds) {
    const row = page.locator(`#same-rank-results-input tr[data-match-id="${matchId}"]`);
    await row.locator("input").evaluateAll((inputs) => {
      for (const input of inputs) (input as HTMLInputElement).value = "1";
      inputs.at(-1)!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(
      page.locator(
        `#same-rank-results-input tr[data-match-id="${matchId}"] .tournament-result-state-label`,
      ),
    ).toHaveAccessibleName("保存済み");
    await expect(row.locator("input").first()).toBeEnabled();
  }

  await expect(page.locator("#confirm-tournament-results")).toBeEnabled();
  await page.locator("#confirm-tournament-results").click();
  await expect(page.locator("#same-rank-standings-view")).toBeVisible();
  await expect(page.getByRole("table", { name: "同順位リーグの総合最終順位" }).locator("tbody tr"))
    .toHaveCount(16);

  const firstRow = page.locator(`#same-rank-results-input tr[data-match-id="${matchIds[0]}"]`);
  const regularHome = firstRow.locator('input[data-score-field="regularHome"]');
  await regularHome.fill("01");
  await expect(firstRow.locator(".tournament-result-state-label")).toHaveText("入力中");
  await expect(page.locator("#same-rank-standings-view")).toBeVisible();
  await regularHome.press("Tab");
  await expect(firstRow.locator(".tournament-result-state-label"))
    .toHaveAccessibleName("保存済み");
  await expect(regularHome).toHaveValue("1");
  await expect(page.locator("#same-rank-standings-view")).toBeVisible();

  await expect(regularHome).toBeEnabled();
  await regularHome.fill("2");
  await regularHome.focus();
  await expect(regularHome).toBeFocused();
  const scrollBefore = await regularHome.evaluate((input: HTMLInputElement) => {
    window.scrollTo(0, input.getBoundingClientRect().top + window.scrollY - 120);
    input.focus();
    input.setSelectionRange(1, 1);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return window.scrollY;
  });
  await expect(regularHome).toBeFocused();
  await expect.poll(() =>
    regularHome.evaluate((input: HTMLInputElement) => input.selectionStart)
  ).toBe(1);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  await expect(page.locator("#same-rank-standings-view")).toHaveCount(0);
  await expect(page.locator("#tournament-results-status")).toContainText(
    "以前の総合最終順位を取り消しました",
  );
});

test("同順位リーグ結果入力は狭幅カードと広幅5列表を切り替え、ラベル・Tab順・44pxを保つ", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, sameRankWebFixture(16));

  const section = page.locator("#same-rank-results-input");
  const content = page.locator("#day2-result-content");
  for (const width of [375, 768, 899, 900, 1002, 1280]) {
    await content.evaluate((element, nextWidth) => {
      element.style.width = `${String(nextWidth)}px`;
      element.style.padding = "0";
    }, width);
    await expect(section).toHaveAttribute(
      "data-responsive-presentation",
      width < 900 ? "cards" : "table",
    );
  }
  await content.evaluate((element) => { element.style.width = "899px"; });
  await expect(section).toHaveAttribute("data-responsive-presentation", "cards");
  await expect(section.getByRole("table", { name: "同順位リーグの試合結果入力" }))
    .toHaveCount(0);
  const firstCard = section.locator(".result-input-card").first();
  const inputs = firstCard.locator("input.score-input");
  await expect(inputs).toHaveCount(2);
  await expect(inputs.nth(0)).toHaveAttribute("aria-label", /の得点$/);
  await expect(inputs.nth(1)).toHaveAttribute("aria-label", /の得点$/);
  const targetSizes = await inputs.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    })
  );
  for (const size of targetSizes) {
    expect(size.width).toBeGreaterThanOrEqual(44);
    expect(size.height).toBeGreaterThanOrEqual(44);
  }
  await inputs.nth(0).focus();
  await inputs.nth(0).press("Tab");
  await expect(inputs.nth(1)).toBeFocused();

  await inputs.nth(0).fill("12");
  await inputs.nth(0).evaluate((input: HTMLInputElement) => {
    input.focus();
    input.setSelectionRange(1, 1);
  });
  await content.evaluate((element) => { element.style.width = "1280px"; });
  await expect(section).toHaveAttribute("data-responsive-presentation", "table");
  const table = section.getByRole("table", { name: "同順位リーグの試合結果入力" });
  await expect(table.locator("thead th")).toHaveCount(5);
  const restored = table.locator('input[data-score-field="regularHome"]').first();
  await expect(restored).toHaveValue("12");
});

test("同順位リーグの部分draftを再読込み後も復元する", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, sameRankWebFixture(16));

  const firstRow = page.locator("#same-rank-results-input .result-input-entry").first();
  await firstRow.locator('input[data-score-field="regularHome"]').fill("3");
  await expect(firstRow.locator(".tournament-result-state-label")).toHaveText("入力中");
  await expect(page.locator("#tournament-results-progress")).toContainText("0 / 24試合");
  await page.waitForTimeout(50);
  await page.reload();

  const restoredRow = page.locator("#same-rank-results-input .result-input-entry").first();
  await expect(restoredRow.locator('input[data-score-field="regularHome"]')).toHaveValue("3");
  await expect(restoredRow.locator('input[data-score-field="regularAway"]')).toHaveValue("");
  await expect(restoredRow.locator(".tournament-result-state-label")).toHaveText("入力中");
  await expect(page.locator("#tournament-results-progress")).toContainText("0 / 24試合");
});

test("同順位リーグの正式結果保存に失敗しても以前の引き分けとdraftをatomicに保持する", async ({
  page,
}) => {
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, sameRankWebFixture(16));

  const firstRow = page.locator("#same-rank-results-input .result-input-entry").first();
  const matchId = await firstRow.getAttribute("data-match-id");
  expect(matchId).not.toBeNull();
  const regularHome = firstRow.locator('input[data-score-field="regularHome"]');
  const regularAway = firstRow.locator('input[data-score-field="regularAway"]');
  await regularHome.fill("1");
  await regularAway.fill("1");
  await regularAway.press("Tab");
  await expect(firstRow.locator(".tournament-result-state-label"))
    .toHaveAccessibleName("保存済み");

  await page.evaluate((targetMatchId) => {
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey): IDBRequest {
      const stored = value as { key?: unknown; document?: {
        tournament?: { result?: { same_rank_league_results?: Array<{
          match_id?: unknown;
          regular_score_home?: unknown;
        }> } };
      } };
      const targetResult = stored.document?.tournament?.result?.same_rank_league_results?.find(
        (result) => result.match_id === targetMatchId,
      );
      if (
        this.name === "documents" &&
        stored.key === "draft" &&
        targetResult?.regular_score_home === 2
      ) {
        throw new DOMException("test quota", "QuotaExceededError");
      }
      return key === undefined
        ? originalPut.call(this, value)
        : originalPut.call(this, value, key);
    };
  }, matchId);

  await regularHome.fill("2");
  await regularHome.press("Tab");
  await expect(page.locator("#tournament-results-status")).toContainText(
    "入力途中の変更と以前の結果は保持されています",
  );
  await expect(regularHome).toHaveValue("2");
  await expect(regularAway).toHaveValue("1");
  await expect(firstRow.locator(".tournament-result-state-label")).toHaveText("入力中");
  await expect(page.locator("#tournament-results-progress")).toContainText("1 / 24試合");
  await page.reload();

  const restoredRow = page.locator(
    `#same-rank-results-input .result-input-entry[data-match-id="${matchId!}"]`,
  );
  await expect(restoredRow.locator('input[data-score-field="regularHome"]')).toHaveValue("2");
  await expect(restoredRow.locator('input[data-score-field="regularAway"]')).toHaveValue("1");
  await expect(restoredRow.locator(".tournament-result-state-label")).toHaveText("入力中");
  await restoredRow.getByRole("button", { name: "変更を取り消す" }).click();
  await expect(restoredRow.locator('input[data-score-field="regularHome"]')).toHaveValue("1");
  await expect(restoredRow.locator('input[data-score-field="regularAway"]')).toHaveValue("1");
  await expect(restoredRow.locator(".tournament-result-state-label"))
    .toHaveAccessibleName("保存済み");
});

test("17チーム4ブロックの1チーム群と2種類の警告を再表示する", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, sameRankWebFixture(17));

  await expect(page.locator("#same-rank-plan-view .same-rank-group-card")).toHaveCount(5);
  await expect(page.locator("#same-rank-plan-view .notice")).toHaveCount(2);
  await expect(page.locator("#same-rank-plan-view")).toContainText("ブロック人数に端数があります");
  await expect(page.locator("#same-rank-plan-view")).toContainText("1チームの順位を自動確定します");
  await expect(page.locator("#same-rank-plan-view")).toContainText("試合を行わず順位を自動確定します");
});

for (const policy of ["strict_same_rank", "merge_bottom"] as const) {
  test(`18チーム4ブロックの${policy === "strict_same_rank" ? "厳密" : "最下位統合"}グループを再表示する`, async ({ page }) => {
    await mockExternalServices(page);
    await openApp(page);
    await importDocument(page, sameRankWebFixture(18, { policy }));

    const cards = page.locator("#same-rank-plan-view .same-rank-group-card");
    const expectedSizes = policy === "strict_same_rank" ? [4, 4, 4, 4, 2] : [4, 4, 4, 6];
    await expect(cards).toHaveCount(expectedSizes.length);
    for (let index = 0; index < expectedSizes.length; index += 1) {
      await expect(cards.nth(index)).toContainText(`${String(expectedSizes[index])}チーム`);
    }
    await expect(page.locator("#same-rank-plan-view .notice")).toHaveCount(1);
    await expect(page.locator("#same-rank-plan-view")).toContainText("ブロック人数に端数があります");
  });
}

test("18チーム4ブロックは端数方針未選択のまま進めず、16チーム4ブロックは厳密方式へ正規化する", async ({
  page,
}) => {
  await mockExternalServices(page);
  await openApp(page);
  await page.locator("#tournament-name").fill("端数方針確認大会");
  await page.locator("#teams").fill(
    Array.from({ length: 18 }, (_, index) => `チーム${String(index + 1)}`).join("\n"),
  );
  await page.locator("#courts").fill("Aコート\nBコート");
  await page.getByRole("button", { name: "次へ：日程設定・生成" }).click();
  await page.locator("#block-count").selectOption("4");
  await page.locator("#final-stage-format").selectOption("same_rank_league");
  await expect(page.locator("#same-rank-uneven-policy-field")).toBeVisible();
  await expect(page.locator("#same-rank-uneven-policy")).toHaveValue("");
  await page.getByRole("button", { name: "日程を生成する" }).click();
  await expect(page.locator("#same-rank-uneven-policy-error")).toContainText("選択してください");
  await expect(page.locator("#schedule-settings-panel")).toBeVisible();
  await page.locator("#same-rank-uneven-policy").selectOption("merge_bottom");

  await page.locator("#tab-tournament").click();
  await page.locator("#teams").fill(
    Array.from({ length: 16 }, (_, index) => `チーム${String(index + 1)}`).join("\n"),
  );
  await page.getByRole("button", { name: "次へ：日程設定・生成" }).click();
  await expect(page.locator("#same-rank-uneven-policy-field")).toBeHidden();
  await expect(page.locator("#same-rank-uneven-policy")).toHaveValue("strict_same_rank");
});

test("同順位リーグの統合生成で仮計画と仮日程を作成し、印刷・オフラインで復元する", async ({
  context,
  page,
}) => {
  const generated = sameRankWebFixture(16, { resolved: false });
  const source = structuredClone(generated);
  const sourceResult = source.tournament.result as Record<string, unknown>;
  delete sourceResult.same_rank_plan;
  delete sourceResult.day2_schedule;
  delete sourceResult.integrated_validation;
  const generatedResult = generated.tournament.result as Record<string, unknown>;
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, source);
  await page.unroute(GENERATE_API);
  let request: Record<string, unknown> | undefined;
  await page.route(GENERATE_API, async (route) => {
    request = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(scheduleCreationResponse({
        ...sourceResult,
        same_rank_plan: generatedResult.same_rank_plan,
        day2_schedule: generatedResult.day2_schedule,
        integrated_validation: generatedResult.integrated_validation,
      }, "day2_only")),
    });
  });
  await page.locator("#tab-schedule-settings").click();
  await page.getByRole("button", { name: "日程を生成する" }).click();
  await expect(page.locator("#same-rank-plan-view")).toContainText("【仮】同順位リーグ");
  expect(request).toMatchObject({
    request_kind: "schedule_creation",
    generation_scope: "day2_only",
    final_stage: { format: "same_rank_league", uneven_policy: "strict_same_rank" },
    existing_result: expect.objectContaining({ league_plan: expect.any(Object) }),
  });
  expect(request).not.toHaveProperty("league_standings");
  await page.locator("#tab-day2").click();
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#same-rank-plan-view")).toBeVisible();
  await page.emulateMedia({ media: "screen" });
  await expect(page.locator("#save-state")).toContainText("この端末に保存済み");
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await page.reload();
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#tab-day2").click();
  await expect(page.locator("#same-rank-plan-view")).toContainText("【仮】同順位リーグ");
});

test("仮の同順位リーグは1日目順位確定後も対戦ID・配置・審判供給元を維持する", async ({
  context,
  page,
}) => {
  const provisional = sameRankWebFixture(16, { resolved: false });
  const resolved = sameRankWebFixture(16);
  const provisionalResult = provisional.tournament.result as Record<string, unknown>;
  const originalIdentity = sameRankScheduleIdentity(
    provisionalResult.day2_schedule as Record<string, unknown>,
  );
  const standings = (resolved.tournament.result as Record<string, unknown>).league_standings;
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, provisional);
  await page.unroute(GENERATE_API);
  await page.route(GENERATE_API, async (route) => {
    const request = route.request().postDataJSON() as { request_kind?: string };
    expect(request.request_kind).toBe("league_standings");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(standings) });
  });
  await page.locator("#tab-day1").click();
  const rows = page.getByRole("table", { name: "1日目の試合結果入力" }).locator("tbody tr");
  const rowCount = await rows.count();
  for (let index = 0; index < rowCount; index += 1) {
    await rows.nth(index).locator("input").evaluateAll((inputs) => {
      (inputs[0] as HTMLInputElement).value = "1";
      (inputs[1] as HTMLInputElement).value = "0";
      inputs[1]!.dispatchEvent(new Event("input", { bubbles: true }));
      inputs[1]!.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  await expect(page.getByRole("button", { name: "順位を確定する" })).toBeEnabled();
  await page.getByRole("button", { name: "順位を確定する" }).click();
  await expect(page.locator("#league-standings-view")).toBeVisible();
  await page.locator("#tab-day2").click();
  await expect(page.locator("#same-rank-plan-view")).not.toContainText("【仮】");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "ファイルへ保存" }).click();
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile((await download.path())!, "utf8")) as {
    tournament: { result: { day2_schedule: Record<string, unknown> } };
  };
  expect(sameRankScheduleIdentity(exported.tournament.result.day2_schedule)).toEqual(originalIdentity);
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#same-rank-plan-view")).toBeVisible();
  await expect(page.locator("#same-rank-plan-view")).toContainText("チーム1");
  await page.emulateMedia({ media: "screen" });
  await expect(page.locator("#save-state")).toContainText("この端末に保存済み");
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await page.reload();
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#tab-day2").click();
  await expect(page.locator("#same-rank-plan-view")).not.toContainText("【仮】");
  await expect(page.locator("#same-rank-plan-view")).toContainText("チーム1");
});
