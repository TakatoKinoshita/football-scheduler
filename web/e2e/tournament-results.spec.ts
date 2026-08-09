import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

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
    upper: { placements: Array<{ rank: number; entry: unknown }> };
    lower: { placements: Array<{ rank: number; entry: unknown }> };
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
  const standings = [
    ...request.tournament_plan.upper.placements.map((placement, index) => ({
      rank: placement.rank,
      pool: "upper",
      pool_rank: placement.rank,
      team_id: finalTeams[index],
      entry: placement.entry,
    })),
    ...request.tournament_plan.lower.placements.map((placement, index) => ({
      rank: 4 + placement.rank,
      pool: "lower",
      pool_rank: placement.rank,
      team_id: finalTeams[4 + index],
      entry: placement.entry,
    })),
  ];
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
  const row = page.locator(`#tournament-results-input tr[data-match-id="${matchId}"]`);
  const regular = row.locator("td").nth(4).locator("input");
  await regular.nth(0).fill(home);
  await regular.nth(1).fill(away);
  await regular.nth(1).press("Tab");
  await expect(
    page.locator(`#tournament-results-input tr[data-match-id="${matchId}"]`),
  ).toContainText("保存済み");
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
    "通常得点",
    "PK",
    "保存状態",
  ]);
  const scheduledSemifinal = page.locator(
    '#day2-schedule-view tr[data-match-id="UT-SF1"]',
  );
  const resultSemifinal = page.locator(
    '#tournament-results-input tr[data-match-id="UT-SF1"]',
  );
  await expect(resultSemifinal.locator("td").nth(0)).toHaveText(
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
  await expect(page.locator("#day2-schedule-view")).not.toContainText("未証明の下位目的");

  const finalRow = page.locator('#tournament-results-input tr[data-match-id="UT-FINAL"]');
  await expect(finalRow).toContainText("前提試合の結果待ち");
  await expect(finalRow.locator("input").first()).toBeDisabled();

  await fillRegularResult(page, "UT-SF1", "1", "0");
  const semifinalTwo = page.locator(
    '#tournament-results-input tr[data-match-id="UT-SF2"]',
  );
  const regular = semifinalTwo.locator("td").nth(4).locator("input");
  await regular.nth(0).fill("1");
  await regular.nth(1).fill("1");
  await regular.nth(1).press("Tab");
  const penalty = semifinalTwo.locator("td").nth(5).locator("input");
  await expect(penalty.nth(0)).toBeVisible();
  await penalty.nth(0).fill("4");
  await penalty.nth(1).fill("3");
  await penalty.nth(1).press("Tab");
  await expect(
    page.locator('#tournament-results-input tr[data-match-id="UT-SF2"]'),
  ).toContainText("保存済み");

  await expect(finalRow).toContainText("青空FC 対 赤松FC");
  const upperBracket = page.locator(
    '#tournament-plan-view .tournament-bracket[data-pool="upper"]',
  );
  await expect(
    upperBracket.locator('.bracket-match-node[data-match-id="UT-SF2"]'),
  ).toContainText("PK 4-3");
  await expect(
    upperBracket.locator('.bracket-match-node[data-match-id="UT-SF2"] .bracket-winner-label'),
  ).toContainText("勝者：赤松FC");
  await expect(
    upperBracket.locator('.bracket-match-node[data-match-id="UT-FINAL"]'),
  ).toContainText("青空FC 対 赤松FC");
  await fillRegularResult(page, "LT-SF1", "1", "0");
  await fillRegularResult(page, "UT-PLACE3", "1", "0");
  await fillRegularResult(page, "LT-SF2", "1", "0");
  await fillRegularResult(page, "UT-FINAL", "2", "0");
  await fillRegularResult(page, "LT-PLACE3", "1", "0");
  await fillRegularResult(page, "LT-FINAL", "1", "0");

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
    "1位上位青空FC",
  );
  await expect(standingsRows.nth(4)).toContainText(
    "5位下位みどりSC",
  );
  await expect(
    page.getByRole("table", { name: "検証済みの2日目試合結果" }),
  ).toContainText("赤松FC 1 (PK 4-3) 1 北星FC");
  await expect(upperBracket.locator(".bracket-terminal.confirmed")).toHaveCount(4);
  await expect(upperBracket.locator('.bracket-terminal[data-rank="1"]')).toContainText(
    "1位確定",
  );
  const correctedScore = page
    .locator('#tournament-results-input tr[data-match-id="UT-SF1"] td')
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
