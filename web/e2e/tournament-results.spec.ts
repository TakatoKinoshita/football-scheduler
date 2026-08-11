import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

import issue75EightTeamDocument from "./fixtures/issue75-eight-team-document.json" with {
  type: "json",
};
import { tournamentResultsFixture } from "./fixtures";
import {
  GENERATE_API,
  importDocument,
  mockExternalServices,
  openApp,
} from "./helpers";

type ResultInput = {
  match_id: string;
  home_team_id: string;
  away_team_id: string;
  regular_score_home: number;
  regular_score_away: number;
  penalty_score_home?: number;
  penalty_score_away?: number;
};

function outcomeResponse(request: {
  tournament_plan: {
    pools: Array<{
      pool_id: string;
      placements: Array<{ rank: number; pool_rank: number; entry: unknown }>;
    }>;
  };
  results: ResultInput[];
}) {
  const matchResults = request.results.map((result) => {
    const penalty = result.regular_score_home === result.regular_score_away;
    const homeWins = penalty
      ? result.penalty_score_home! > result.penalty_score_away!
      : result.regular_score_home > result.regular_score_away;
    return {
      ...result,
      penalty_score_home: result.penalty_score_home ?? null,
      penalty_score_away: result.penalty_score_away ?? null,
      winner: homeWins ? "home" : "away",
      winner_team_id: homeWins ? result.home_team_id : result.away_team_id,
      loser_team_id: homeWins ? result.away_team_id : result.home_team_id,
      decision: penalty ? "penalty_shootout" : "regular_time",
    };
  });
  const finalTeams = [
    "team-01",
    "team-03",
    "team-07",
    "team-05",
    "team-02",
    "team-04",
    "team-08",
    "team-06",
  ];
  const standings = request.tournament_plan.pools.flatMap((pool) =>
    pool.placements.map((placement) => ({
      rank: placement.rank,
      pool_id: pool.pool_id,
      pool_rank: placement.pool_rank,
      team_id: finalTeams[placement.rank - 1],
      entry: placement.entry,
    }))
  );
  return {
    schema_version: "0.2.0",
    status: "COMPLETE",
    match_results: matchResults,
    standings,
  };
}

async function fillRegularResult(
  page: Page,
  matchId: string,
  home: string,
  away: string,
): Promise<void> {
  const row = page.locator(`#tournament-results-input [data-match-id="${matchId}"]`).first();
  const regular = row.locator('[data-field="regular-score"] input');
  await regular.nth(0).fill(home);
  await regular.nth(1).fill(away);
  await regular.nth(1).press("Tab");
  await expect(
    page.locator(`#tournament-results-input [data-match-id="${matchId}"]`).first(),
  ).toContainText("保存済");
}

async function setTournamentResultWidth(page: Page, width: number): Promise<void> {
  await page.locator("#day2-result-content").evaluate((element, nextWidth) => {
    element.style.width = `${String(nextWidth)}px`;
    element.style.padding = "0";
  }, width);
  await expect(page.locator("#tournament-results-input")).toHaveAttribute(
    "data-responsive-presentation",
    width < 900 ? "cards" : "table",
  );
}

function tournamentResultEntry(page: Page, matchId: string) {
  return page.locator(
    `#tournament-results-input .result-input-entry[data-match-id="${matchId}"]`,
  );
}

test("2日目結果を依存順に入力し、PKを経て総合最終順位を保存・印刷できる", async ({
  page,
}) => {
  await mockExternalServices(page);
  await page.route(GENERATE_API, async (route) => {
    const request = route.request().postDataJSON() as {
      request_kind?: unknown;
      tournament_plan?: unknown;
      results?: unknown;
    };
    if (request.request_kind !== "tournament_results") {
      await route.fallback();
      return;
    }
    const response = outcomeResponse(request as Parameters<typeof outcomeResponse>[0]);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(response),
    });
  });
  await openApp(page);
  await importDocument(page, tournamentResultsFixture());

  const resultHeaders = await page
    .getByRole("table", { name: "2日目の試合結果入力" })
    .locator("thead th")
    .allTextContents();
  expect(resultHeaders).toEqual([
    "試合",
    "時間",
    "コート",
    "対戦",
    "結果",
  ]);
  const scheduledSemifinal = page.locator(
    '#day2-schedule-view tr[data-match-id="PT-1-SF1"]',
  );
  const resultSemifinal = page.locator(
    '#tournament-results-input tr[data-match-id="PT-1-SF1"]',
  );
  await expect(resultSemifinal.locator("td").nth(0).locator(".match-display-number")).toHaveText(
    await scheduledSemifinal.locator("td").nth(0).innerText(),
  );
  await expect(resultSemifinal.locator("td").nth(1)).toHaveText(
    await scheduledSemifinal.locator("td").nth(1).innerText(),
  );
  await expect(resultSemifinal.locator("td").nth(2)).toHaveText("Aコート");
  await expect(page.locator("#day2-team-schedules-view")).not.toHaveAttribute("open", "");
  await expect(page.locator("#tournament-plan-view .result-disclosure")).toHaveCount(2);
  await expect(page.locator("#tournament-plan-view")).not.toContainText("抽選番号");
  await expect(page.locator("#day2-schedule-view")).not.toContainText("最大待ちセクション");
  await expect(page.locator("#day2-schedule-view")).not.toContainText("未証明の目的");

  const finalRow = page.locator('#tournament-results-input tr[data-match-id="PT-1-FINAL"]');
  await expect(finalRow).toContainText("前提試合の結果待ち");
  await expect(finalRow.locator("input")).toHaveCount(0);
  await expect(finalRow.locator('[data-field="waiting-message"]')).toHaveText("—");

  await fillRegularResult(page, "PT-1-SF1", "1", "0");
  const semifinalTwo = page.locator(
    '#tournament-results-input tr[data-match-id="PT-1-SF2"]',
  );
  const regular = semifinalTwo.locator('[data-field="regular-score"] input');
  await regular.nth(0).fill("1");
  await regular.nth(1).fill("1");
  await regular.nth(1).press("Tab");
  const penalty = semifinalTwo.locator('[data-field="penalty-score"] input');
  await expect(penalty.nth(0)).toBeVisible();
  await penalty.nth(0).fill("4");
  await penalty.nth(1).fill("3");
  await penalty.nth(1).press("Tab");
  await expect(
    page.locator('#tournament-results-input tr[data-match-id="PT-1-SF2"]'),
  ).toContainText("保存済");

  await expect(finalRow).toContainText("青空FC 対 赤松FC");
  const upperBracket = page.locator(
    '#tournament-plan-view .tournament-bracket[data-pool="placement-1"]',
  );
  await expect(
    upperBracket.locator('.bracket-match-node[data-match-id="PT-1-SF2"]'),
  ).toContainText("PK 4-3");
  await expect(
    upperBracket.locator('.bracket-match-node[data-match-id="PT-1-SF2"] .bracket-winner-label'),
  ).toContainText("勝者：赤松FC");
  await expect(
    upperBracket.locator('.bracket-match-node[data-match-id="PT-1-FINAL"]'),
  ).toContainText("青空FC 対 赤松FC");
  await fillRegularResult(page, "PT-2-SF1", "1", "0");
  await fillRegularResult(page, "PT-1-PLACE3", "1", "0");
  await fillRegularResult(page, "PT-2-SF2", "1", "0");
  await fillRegularResult(page, "PT-1-FINAL", "2", "0");
  await fillRegularResult(page, "PT-2-PLACE3", "1", "0");
  await fillRegularResult(page, "PT-2-FINAL", "1", "0");

  await expect(page.locator("#tournament-results-progress")).toContainText("8 / 8試合");
  await expect(page.locator("#confirm-tournament-results")).toBeEnabled();
  await page.locator("#confirm-tournament-results").click();

  await expect(page.locator("#tournament-results-status")).toContainText(
    "総合最終順位を確定",
  );
  const standingsRows = page
    .getByRole("table", { name: "総合最終順位" })
    .locator("tbody tr");
  await expect(standingsRows).toHaveCount(8);
  await expect(standingsRows.first()).toContainText(
    "1位第1順位帯青空FC",
  );
  await expect(standingsRows.nth(4)).toContainText(
    "5位第2順位帯みどりSC",
  );
  await expect(
    page.getByRole("table", { name: "検証済みの2日目試合結果" }),
  ).toContainText("赤松FC 1 (PK 4-3) 1 北星FC");
  await expect(upperBracket.locator(".bracket-terminal.confirmed")).toHaveCount(4);
  await expect(upperBracket.locator('.bracket-terminal[data-rank="1"]')).toContainText(
    "1位確定",
  );
  const correctedScore = page
    .locator('#tournament-results-input tr[data-match-id="PT-1-SF1"] td')
    .nth(4)
    .locator("input")
    .first();
  await correctedScore.fill("2");
  await correctedScore.press("Tab");
  await expect(page.locator("#final-standings-view")).toHaveCount(0);
  await expect(page.locator("#tournament-results-progress")).toContainText("8 / 8試合");
  await expect(page.locator("#confirm-tournament-results")).toBeEnabled();
  const recalculationResponse = page.waitForResponse((response) =>
    response.url().includes("/api/v1/schedules:generate") &&
    response.request().method() === "POST",
  );
  await page.locator("#confirm-tournament-results").click();
  const response = await recalculationResponse;
  expect({ status: response.status(), body: await response.text() }).toMatchObject({
    status: 200,
    body: expect.stringContaining('"status":"COMPLETE"'),
  });
  await expect(standingsRows).toHaveCount(8);

  await page.reload();
  await expect(standingsRows).toHaveCount(8);
  await expect(page.locator("#day2-result-summary")).toContainText("総合最終順位を確定済み");

  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#final-standings-view")).toBeVisible();
  await expect(page.locator("#tournament-results-confirmation")).toBeHidden();

  await page.emulateMedia({ media: "screen" });
  await page.locator("#tab-schedule-settings").click();
  await page.locator("#day2-margin-minutes").fill("15");
  await page.locator("#day2-margin-minutes").blur();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "ファイルへ保存" }).click();
  const downloadPath = await (await downloadPromise).path();
  expect(downloadPath).not.toBeNull();
  const exported = JSON.parse(await readFile(downloadPath!, "utf8")) as {
    tournament: {
      result: {
        day2_schedule?: unknown;
        tournament_results?: unknown[];
        final_standings?: unknown;
      };
    };
  };
  expect(exported.tournament.result.day2_schedule).toBeUndefined();
  expect(exported.tournament.result.tournament_results).toHaveLength(8);
  expect(exported.tournament.result.final_standings).toBeDefined();
});

test("Issue #75の保存JSONを読み込み、余分な設定を送らず1〜8位を確定できる", async ({
  page,
}) => {
  await mockExternalServices(page);
  let capturedRequest: Record<string, unknown> | undefined;
  await page.route(GENERATE_API, async (route) => {
    const request = route.request().postDataJSON() as Record<string, unknown>;
    if (request.request_kind !== "tournament_results") {
      await route.fallback();
      return;
    }
    capturedRequest = request;
    const response = outcomeResponse(request as Parameters<typeof outcomeResponse>[0]);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(response),
    });
  });
  await openApp(page);
  await importDocument(page, structuredClone(issue75EightTeamDocument));

  await expect(page.locator("#tournament-results-progress")).toContainText("8 / 8試合");
  await expect(page.locator("#confirm-tournament-results")).toBeEnabled();
  await page.locator("#confirm-tournament-results").click();

  await expect(page.locator("#tournament-results-status")).toContainText("総合最終順位を確定");
  await expect(page.getByRole("table", { name: "総合最終順位" }).locator("tbody tr"))
    .toHaveCount(8);
  expect(Object.keys(capturedRequest ?? {})).toEqual([
    "schema_version",
    "request_kind",
    "tournament_plan",
    "results",
  ]);
  expect(capturedRequest).not.toHaveProperty("final_stage");
});

test("最終順位APIの得点診断を専用欄へ示し、保存結果を保持する", async ({
  page,
}) => {
  await mockExternalServices(page);
  await page.route(GENERATE_API, async (route) => {
    const request = route.request().postDataJSON() as { request_kind?: unknown };
    if (request.request_kind !== "tournament_results") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        schema_version: "0.2.0",
        status: "error",
        diagnostics: [{
          code: "INPUT_SCHEMA_INVALID",
          message: "得点欄に0以上の整数を入力してください。入力済みのほかの結果は保持されています。",
          details: {
            scope: "tournament_scores",
            errors: [{
              field: "results.0.regular_score_home",
              message: "得点は0以上の整数で入力してください。",
              type: "greater_than_equal",
              match_id: "PT-1-RANK-1-4-M1",
              score_field: "regular_score_home",
            }],
          },
        }],
      }),
    });
  });
  await openApp(page);
  await importDocument(page, structuredClone(issue75EightTeamDocument));
  await setTournamentResultWidth(page, 899);
  const row = tournamentResultEntry(page, "PT-1-RANK-1-4-M1");
  const score = row.locator("input.score-input").first();
  await page.locator("#confirm-tournament-results").click();

  await expect(page.locator("#tournament-results-status")).toContainText(
    "入力済みのほかの結果は保持されています",
  );
  await expect(score).toHaveValue("0");
  await expect(score).toHaveAttribute("aria-invalid", "true");
  await expect(row.locator(".tournament-result-error")).toContainText(
    "得点は0以上の整数",
  );
  await expect(page.locator("#tournament-results-progress")).toContainText("8 / 8試合");
});

test("順位決定トーナメントは899px以下をカード、900px以上を5列表にし、境界時だけ再描画する", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await mockExternalServices(page);
  await openApp(page);
  const fixtureDocument = tournamentResultsFixture() as unknown as {
    tournament: { input: { teams: Array<{ name: string }> } };
  };
  for (const [index, team] of fixtureDocument.tournament.input.teams.entries()) {
    team.name = index % 2 === 0 ? `地域サッカー${String(index + 1)}組` : `Football${String(index + 1)}`;
  }
  await importDocument(page, fixtureDocument);

  for (const width of [375, 768, 899, 900, 1002, 1280]) {
    await setTournamentResultWidth(page, width);
    const section = page.locator("#tournament-results-input");
    if (width < 900) {
      await expect(section.getByRole("list", { name: "2日目の試合結果入力" })).toBeVisible();
      await expect(section.locator("table")).toHaveCount(0);
    } else {
      await expect(section.getByRole("table", { name: "2日目の試合結果入力" })).toBeVisible();
      await expect(section.getByRole("columnheader")).toHaveCount(5);
    }
    const overflow = await section.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(overflow.scrollWidth, `${String(width)}pxの結果入力領域`).toBeLessThanOrEqual(
      overflow.clientWidth,
    );
  }

  await setTournamentResultWidth(page, 900);
  await page.locator("#tournament-results-input").evaluate((element) => {
    element.dataset.renderIdentity = "same-presentation";
  });
  await setTournamentResultWidth(page, 1002);
  await page.waitForTimeout(50);
  await expect(page.locator("#tournament-results-input")).toHaveAttribute(
    "data-render-identity",
    "same-presentation",
  );
  await setTournamentResultWidth(page, 899);
  await expect(page.locator("#tournament-results-input")).not.toHaveAttribute(
    "data-render-identity",
    "same-presentation",
  );

  const focused = tournamentResultEntry(page, "PT-1-SF1")
    .locator('input[data-score-field="regularHome"]');
  await focused.fill("12");
  await focused.evaluate((input: HTMLInputElement) => input.setSelectionRange(1, 2));
  const scrollY = await page.evaluate(() => {
    window.scrollTo(0, 300);
    return window.scrollY;
  });
  await setTournamentResultWidth(page, 900);
  await expect(focused).toBeFocused();
  await expect.poll(() => focused.evaluate((input: HTMLInputElement) => [
    input.selectionStart,
    input.selectionEnd,
  ])).toEqual([1, 2]);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrollY);
});

test("順位決定トーナメントのカードは待機・PK・状態・Tab順・エラー関連付けを保つ", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, tournamentResultsFixture());
  await setTournamentResultWidth(page, 899);

  const section = page.locator("#tournament-results-input");
  await expect(section.getByRole("list", { name: "2日目の試合結果入力" })).toBeVisible();
  await expect(section.getByRole("group", { name: "試合結果" }).first()).toBeVisible();
  await expect(section.locator('[data-state="empty"]').first()).toHaveText("未入力");

  const waiting = section.locator('.result-input-entry:has([data-state="waiting"])');
  await expect(waiting.first()).toBeVisible();
  for (const entry of await waiting.all()) {
    await expect(entry.locator("input")).toHaveCount(0);
    expect((await entry.textContent())?.match(/前提試合の結果待ち/gu)).toHaveLength(1);
    await expect(entry.locator('[data-field="waiting-message"]')).toHaveText("—");
    await expect(entry.locator('[data-state="waiting"]')).toHaveAttribute(
      "aria-label",
      "前提試合待ち",
    );
  }

  await fillRegularResult(page, "PT-1-SF1", "2", "0");
  const saved = tournamentResultEntry(page, "PT-1-SF1");
  await expect(saved.locator('[data-state="saved"]')).toHaveAttribute("aria-label", "保存済み");
  await expect(saved.locator('input[data-score-field="penaltyHome"]')).toBeHidden();

  const edited = tournamentResultEntry(page, "PT-1-SF2");
  await edited.locator('input[data-score-field="regularHome"]').fill("1");
  await expect(edited.locator('[data-state="editing"]')).toContainText("入力中");

  const invalid = tournamentResultEntry(page, "PT-2-SF1");
  const invalidHome = invalid.locator('input[data-score-field="regularHome"]');
  await invalidHome.fill("-1");
  await invalid.locator('input[data-score-field="regularAway"]').fill("0");
  await expect(invalid.locator('[data-state="invalid"]')).toContainText("要確認");
  await expect(invalidHome).toHaveAttribute("aria-invalid", "true");
  const describedBy = await invalidHome.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  await expect(page.locator(`#${describedBy!}`)).toBeVisible();
  await expect(page.locator(`#${describedBy!}`)).not.toBeEmpty();

  const tied = tournamentResultEntry(page, "PT-2-SF2");
  const regularHome = tied.locator('input[data-score-field="regularHome"]');
  const regularAway = tied.locator('input[data-score-field="regularAway"]');
  await regularHome.fill("1");
  await regularAway.fill("1");
  const visibleFields = tied.locator("input:visible");
  await expect(visibleFields).toHaveCount(4);
  expect(await visibleFields.evaluateAll((inputs) =>
    inputs.map((input) => (input as HTMLInputElement).dataset.scoreField)
  )).toEqual(["regularHome", "regularAway", "penaltyHome", "penaltyAway"]);
  await expect(regularHome).toHaveAttribute("aria-label", /対.+通常得点/u);
  await expect(tied.locator('input[data-score-field="penaltyHome"]')).toHaveAttribute(
    "aria-label",
    /対.+PK得点/u,
  );
  await regularHome.focus();
  for (const field of ["regularAway", "penaltyHome", "penaltyAway"]) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() =>
      (document.activeElement as HTMLInputElement | null)?.dataset.scoreField
    )).toBe(field);
  }

  const controls = section.locator("input:visible, button:visible");
  for (const control of await controls.all()) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  }
  const contrastRatios = await section.locator(".tournament-result-state-label").evaluateAll(
    (labels) => {
      const rgb = (value: string): [number, number, number] => {
        const values = value.match(/[\d.]+/gu)?.map(Number) ?? [];
        return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
      };
      const luminance = (color: [number, number, number]): number => {
        const linear = color.map((value) => {
          const channel = value / 255;
          return channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
      };
      return labels.map((label) => {
        const foreground = luminance(rgb(getComputedStyle(label).color));
        let backgroundNode: Element | null = label;
        let background: [number, number, number] = [255, 255, 255];
        while (backgroundNode !== null) {
          const color = getComputedStyle(backgroundNode).backgroundColor;
          if (color !== "rgba(0, 0, 0, 0)") {
            background = rgb(color);
            break;
          }
          backgroundNode = backgroundNode.parentElement;
        }
        const backgroundLuminance = luminance(background);
        return (Math.max(foreground, backgroundLuminance) + 0.05) /
          (Math.min(foreground, backgroundLuminance) + 0.05);
      });
    },
  );
  for (const ratio of contrastRatios) expect(ratio).toBeGreaterThanOrEqual(4.5);
});

test("通常得点の部分入力を端末内だけで復元し、取消しまで行っても行レイアウトを保つ", async ({
  page,
}) => {
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, structuredClone(issue75EightTeamDocument));

  const row = page.locator(
    '#tournament-results-input tr[data-match-id="PT-1-RANK-1-4-M1"]',
  );
  const home = row.locator('input[data-score-field="regularHome"]');
  const before = await row.boundingBox();
  expect(before).not.toBeNull();
  await expect(row.locator(".result-input-state-trigger")).toHaveCount(0);

  await home.fill("");
  await expect(row.locator(".tournament-result-state-label")).toContainText("入力中");
  await expect(row.locator(".result-input-state-trigger")).toHaveAccessibleName(
    /保存済の得点に戻すの入力操作を開く/,
  );
  await expect(row.locator(".tournament-result-error")).toBeEmpty();
  await expect(page.locator("#confirm-tournament-results")).toBeDisabled();
  await expect(page.locator("#tournament-results-progress")).toContainText("8 / 8試合");
  const whileInputting = await row.boundingBox();
  expect(whileInputting).not.toBeNull();
  expect(Math.abs(whileInputting!.width - before!.width)).toBeLessThan(1);
  await expect(row).toBeVisible();

  await page.waitForTimeout(50);
  await page.reload();
  const restoredRow = page.locator(
    '#tournament-results-input tr[data-match-id="PT-1-RANK-1-4-M1"]',
  );
  await expect(restoredRow.locator('input[data-score-field="regularHome"]')).toHaveValue("");
  await expect(restoredRow.locator(".tournament-result-state-label")).toContainText("入力中");
  await expect(page.locator("#confirm-tournament-results")).toBeDisabled();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "ファイルへ保存" }).click();
  const downloadPath = await (await downloadPromise).path();
  expect(downloadPath).not.toBeNull();
  const exported = JSON.parse(await readFile(downloadPath!, "utf8")) as {
    tournament: { result: { tournament_results: ResultInput[] } };
  };
  expect(exported.tournament.result.tournament_results).toHaveLength(8);
  expect(
    exported.tournament.result.tournament_results.at(0)?.regular_score_home,
  ).toBe(0);
  expect(JSON.stringify(exported)).not.toContain("planFingerprint");
  expect(JSON.stringify(exported)).not.toContain('"drafts"');

  await restoredRow.locator(".result-input-state-trigger").click();
  await expect(restoredRow.locator(".result-input-draft-action")).toHaveAccessibleName(
    /保存済の得点に戻す$/,
  );
  await restoredRow.locator(".result-input-draft-action").click();
  await expect(
    restoredRow.locator('input[data-score-field="regularHome"]'),
  ).toHaveValue("0");
  await expect(restoredRow.locator(".tournament-result-state-label")).toHaveText("保存済");
  await expect(restoredRow.locator(".result-input-state-trigger")).toHaveCount(0);
  await expect(page.locator("#confirm-tournament-results")).toBeEnabled();
});

test("draft取消の永続化に失敗した場合は入力内容と状態メニューを保持する", async ({
  page,
}) => {
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, structuredClone(issue75EightTeamDocument));

  const row = page.locator(
    '#tournament-results-input tr[data-match-id="PT-1-RANK-1-4-M1"]',
  );
  const regularHome = row.locator('input[data-score-field="regularHome"]');
  await regularHome.fill("");
  await page.waitForTimeout(50);
  await page.reload();
  const restoredRow = page.locator(
    '#tournament-results-input tr[data-match-id="PT-1-RANK-1-4-M1"]',
  );
  await expect(restoredRow.locator('input[data-score-field="regularHome"]')).toHaveValue("");
  await page.evaluate(() => {
    const originalDelete = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (key: IDBValidKey): IDBRequest<undefined> {
      if (this.name === "ui-state" && key === "tournament-result-drafts") {
        throw new DOMException("test quota", "QuotaExceededError");
      }
      return originalDelete.call(this, key);
    };
  });

  await restoredRow.locator(".result-input-state-trigger").click();
  await restoredRow.locator(".result-input-draft-action").click();
  await expect(page.locator("#tournament-results-status")).toContainText(
    "入力途中の変更を破棄できませんでした。入力内容は保持されています",
  );
  await expect(restoredRow.locator('input[data-score-field="regularHome"]')).toHaveValue("");
  await expect(restoredRow.locator(".result-input-state-trigger")).toHaveCount(1);
  await expect(restoredRow).not.toHaveAttribute("aria-busy", "true");
  await expect(restoredRow.locator('input[data-score-field="regularHome"]')).toBeEnabled();
  await expect(page.locator("#confirm-tournament-results")).toBeDisabled();
});

test("PKの部分入力と保存済み結果の変更をtransactionalに扱い、確定時だけ後続を更新する", async ({
  page,
}) => {
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, structuredClone(issue75EightTeamDocument));

  const parent = page.locator(
    '#tournament-results-input tr[data-match-id="PT-1-RANK-1-4-M1"]',
  );
  const descendant = page.locator(
    '#tournament-results-input tr[data-match-id="PT-1-RANK-1-2-M1"]',
  );
  const penaltyHome = parent.locator('input[data-score-field="penaltyHome"]');
  await penaltyHome.fill("");
  await expect(parent.locator(".tournament-result-state-label")).toContainText("入力中");
  await expect(parent.locator(".tournament-result-error")).toBeEmpty();
  await page.waitForTimeout(50);
  await page.reload();

  const reloadedParent = page.locator(
    '#tournament-results-input tr[data-match-id="PT-1-RANK-1-4-M1"]',
  );
  const reloadedPenaltyHome = reloadedParent.locator(
    'input[data-score-field="penaltyHome"]',
  );
  await expect(reloadedPenaltyHome).toHaveValue("");
  await reloadedPenaltyHome.fill("1");
  await expect(reloadedParent.locator(".tournament-result-error")).toContainText(
    "PK戦は勝敗が決まるまで",
  );
  await expect(page.locator("#tournament-results-progress")).toContainText("8 / 8試合");
  await expect(descendant.locator(".tournament-result-state-label")).toHaveText("保存済");
  await reloadedParent.locator(".result-input-draft-action").evaluate(
    (button: HTMLButtonElement) => button.click(),
  );
  await expect(reloadedPenaltyHome).toHaveValue("0");
  await expect(reloadedParent.locator(".penalty-score-fields")).toBeVisible();

  const reloadedDescendant = page.locator(
    '#tournament-results-input tr[data-match-id="PT-1-RANK-1-2-M1"]',
  );
  await reloadedDescendant.locator('input[data-score-field="regularHome"]').fill("");
  const regularHome = reloadedParent.locator('input[data-score-field="regularHome"]');
  await regularHome.fill("2");
  await expect(page.locator("#tournament-results-progress")).toContainText("8 / 8試合");
  await regularHome.evaluate((input: HTMLInputElement) => {
    input.focus();
    input.setSelectionRange(1, 1);
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await expect(page.locator("#tournament-results-progress")).toContainText("6 / 8試合");
  await expect.poll(() => page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return {
      field: active?.dataset.scoreField,
      matchId: active?.closest<HTMLElement>("[data-match-id]")?.dataset.matchId,
    };
  })).toEqual({ field: "regularHome", matchId: "PT-1-RANK-1-4-M1" });
  await expect.poll(() =>
    regularHome.evaluate((input: HTMLInputElement) => input.selectionStart)
  ).toBe(1);
  await expect(reloadedDescendant).toContainText("チーム5 対 チーム1");
  await expect(reloadedDescendant.locator(".tournament-result-state-label")).toHaveText(
    "未入力",
  );
  await expect(
    reloadedDescendant.locator('input[data-score-field="regularHome"]'),
  ).toHaveValue("");
  await expect(page.locator("#confirm-tournament-results")).toBeDisabled();
});

test("有効な変更を確定した直後に再読込みしても正式結果を失わない", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, structuredClone(issue75EightTeamDocument));

  const parent = page.locator(
    '#tournament-results-input tr[data-match-id="PT-1-RANK-1-4-M1"]',
  );
  const regularHome = parent.locator('input[data-score-field="regularHome"]');
  await regularHome.fill("2");
  await regularHome.press("Tab");
  await page.reload();

  const restoredParent = page.locator(
    '#tournament-results-input tr[data-match-id="PT-1-RANK-1-4-M1"]',
  );
  await expect(
    restoredParent.locator('input[data-score-field="regularHome"]'),
  ).toHaveValue("2");
  await expect(restoredParent.locator(".tournament-result-state-label")).toHaveText("保存済");
  await expect(page.locator("#tournament-results-progress")).toContainText("6 / 8試合");
  await expect(
    page.locator('#tournament-results-input tr[data-match-id="PT-1-RANK-1-2-M1"]')
      .locator(".tournament-result-state-label"),
  ).toHaveText("未入力");
});

test("正式結果のatomic保存に失敗した場合は以前の結果と入力途中draftを保持する", async ({
  page,
}) => {
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, structuredClone(issue75EightTeamDocument));
  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey): IDBRequest {
      const stored = value as { key?: unknown; document?: {
        tournament?: { result?: { tournament_results?: Array<{ regular_score_home?: unknown }> } };
      } };
      if (
        this.name === "documents" &&
        stored.key === "draft" &&
        stored.document?.tournament?.result?.tournament_results?.[0]
          ?.regular_score_home === 2
      ) {
        throw new DOMException("test quota", "QuotaExceededError");
      }
      return key === undefined
        ? originalPut.call(this, value)
        : originalPut.call(this, value, key);
    };
  });

  const row = page.locator(
    '#tournament-results-input tr[data-match-id="PT-1-RANK-1-4-M1"]',
  );
  const regularHome = row.locator('input[data-score-field="regularHome"]');
  await regularHome.fill("2");
  await regularHome.press("Tab");

  await expect(page.locator("#tournament-results-status")).toContainText(
    "入力途中の変更と以前の結果は保持されています",
  );
  await expect(regularHome).toHaveValue("2");
  await expect(row.locator(".tournament-result-state-label")).toContainText("入力中");
  await expect(page.locator("#tournament-results-progress")).toContainText("8 / 8試合");
  await page.reload();
  const restoredRow = page.locator(
    '#tournament-results-input tr[data-match-id="PT-1-RANK-1-4-M1"]',
  );
  await expect(
    restoredRow.locator('input[data-score-field="regularHome"]'),
  ).toHaveValue("2");
  await expect(restoredRow.locator(".tournament-result-state-label")).toContainText("入力中");
  await expect(page.locator("#tournament-results-progress")).toContainText("8 / 8試合");
});
