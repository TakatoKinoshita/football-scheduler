import { expect, test } from "@playwright/test";

import { sameRankWebFixture } from "./fixtures";
import { GENERATE_API, importDocument, mockExternalServices, openApp } from "./helpers";

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
  expect(headers).toEqual(["試合", "時間", "コート", "対戦", "得点", "保存状態"]);

  const result = (fixture as { tournament: { result: Record<string, unknown> } }).tournament.result;
  const plan = result.same_rank_plan as { groups: Array<{ matches: Array<{ id: string }> }> };
  const matchIds = plan.groups.flatMap((group) => group.matches.map((match) => match.id));
  for (const matchId of matchIds) {
    const row = page.locator(`#same-rank-results-input tr[data-match-id="${matchId}"]`);
    const inputs = row.locator("input");
    await inputs.nth(0).fill("1");
    await inputs.nth(1).fill("1");
    await inputs.nth(1).press("Tab");
    await expect(page.locator(`#same-rank-results-input tr[data-match-id="${matchId}"]`))
      .toContainText("保存済み");
  }

  await expect(page.locator("#confirm-tournament-results")).toBeEnabled();
  await page.locator("#confirm-tournament-results").click();
  await expect(page.locator("#same-rank-standings-view")).toBeVisible();
  await expect(page.getByRole("table", { name: "同順位リーグの総合最終順位" }).locator("tbody tr"))
    .toHaveCount(16);
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
