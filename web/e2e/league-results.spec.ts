import { expect, test } from "@playwright/test";

import {
  day2ScheduleResult,
  minimumSameRankStandingsResult,
  provisionalDay2ScheduleResult,
  provisionalTournamentPlanResult,
  scheduleResult,
  scheduleViewTournamentFixture,
  standingsResult,
  tournamentFixture,
  tournamentPlanResult,
  tournamentResultsFixture,
} from "./fixtures";
import { GENERATE_API, importDocument, mockExternalServices, openApp } from "./helpers";

function day2CreationResponse(
  tournamentPlan: Record<string, unknown>,
  day2Schedule: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schema_version: "0.2.0",
    status: day2Schedule.status,
    tournament_plan: tournamentPlan,
    day2_schedule: day2Schedule,
  };
}

async function openGeneratedLeague(page: import("@playwright/test").Page): Promise<void> {
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, tournamentFixture({ withResult: true }));
  await expect(page.locator("#standings-confirmation")).toBeVisible();
}

async function enterAllSameRankLeagueResults(page: import("@playwright/test").Page): Promise<void> {
  await page.getByLabel("青空FC 対 みどりSC・青空FCの得点").fill("2");
  await page.getByLabel("青空FC 対 みどりSC・みどりSCの得点").fill("1");
  await page.getByLabel("中央キッカーズ 対 海浜ユナイテッド・中央キッカーズの得点").fill("0");
  await page.getByLabel("中央キッカーズ 対 海浜ユナイテッド・海浜ユナイテッドの得点").fill("0");
  await expect(page.getByRole("button", { name: "順位を確定する" })).toBeEnabled();
}

function placementDocument(options: {
  resolved?: boolean;
  includePlan?: boolean;
  includeSchedule?: boolean;
}) {
  const document = options.resolved === true
    ? tournamentResultsFixture()
    : scheduleViewTournamentFixture();
  const result = document.tournament.result as Record<string, unknown>;
  delete result.tournament_results;
  delete result.final_standings;
  if (options.resolved !== true) {
    delete result.league_results;
    delete result.league_standings;
  }
  if (options.includePlan !== true) delete result.tournament_plan;
  if (options.includeSchedule !== true) {
    delete result.day2_schedule;
    delete result.integrated_validation;
  }
  return document;
}

function placementStandingsResult(): Record<string, unknown> {
  const result = tournamentResultsFixture().tournament.result as Record<string, unknown>;
  return structuredClone(result.league_standings) as Record<string, unknown>;
}

async function enterPlacementLeagueResults(
  page: import("@playwright/test").Page,
): Promise<void> {
  const rows = page.getByRole("table", { name: "1日目の試合結果入力" }).locator("tbody tr");
  await expect(rows).toHaveCount(4);
  for (let index = 0; index < 4; index += 1) {
    const inputs = rows.nth(index).locator("input");
    await inputs.nth(0).fill("1");
    await inputs.nth(1).fill("0");
  }
  await expect(page.getByRole("button", { name: "順位を確定する" })).toBeEnabled();
}

test("順位未確定でも1回の操作で仮トーナメントと仮日程を作成・復元する", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, placementDocument({}));
  await page.unroute(GENERATE_API);
  const requests: unknown[] = [];
  await page.route(GENERATE_API, async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        day2CreationResponse(provisionalTournamentPlanResult, provisionalDay2ScheduleResult),
      ),
    });
  });

  await page.locator('.step[data-step="5"]').click();

  await expect(page.locator('[data-panel="5"]')).toBeVisible();
  await expect(page.locator("#day2-generation-confirmation")).toBeVisible();
  await expect(page.locator("#day2-creation-turnstile-widget [data-testid='turnstile-widget-mock']"))
    .toHaveCount(1);
  await expect(page.locator("#day2-creation-turnstile-widget [data-action='create_day2']"))
    .toHaveCount(1);
  await expect(page.getByRole("button", { name: "2日目を作成する" })).toBeEnabled();
  await page.getByRole("button", { name: "2日目を作成する" }).click();

  await expect(page.locator("#day2-schedule-view")).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ request_kind: "day2_creation" });
  expect(requests[0]).not.toHaveProperty("league_standings");
  expect(requests[0]).not.toHaveProperty("tournament_plan");
  await expect(page.locator("#tournament-plan-view")).toContainText("【仮】");
  await expect(page.locator("#tournament-plan-view .tournament-bracket figcaption").first())
    .toHaveText("第1順位帯表（仮）");
  await expect(page.locator("#tournament-plan-view")).toContainText("Aブロック 1位");
  await expect(page.locator("#save-state")).toContainText("この端末に保存済み");
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#tournament-plan-view")).toBeVisible();
  await page.emulateMedia({ media: "screen" });
  await page.context().setOffline(true);
  await page.reload();
  await expect(page.locator("#tournament-plan-view")).toContainText("【仮】");
});

test("最終試合の入力直後に順位を確定し、変更時は確定順位を失効する", async ({ page }) => {
  await openGeneratedLeague(page);
  await page.unroute(GENERATE_API);
  const requests: unknown[] = [];
  await page.route(GENERATE_API, async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(minimumSameRankStandingsResult),
    });
  });

  await enterAllSameRankLeagueResults(page);
  await expect(page.locator("#league-results-progress")).toContainText("入力済み 2 / 2試合");
  await expect(page.getByRole("button", { name: "順位を確定する" })).toBeEnabled();
  await page.getByRole("button", { name: "順位を確定する" }).click();

  await expect(page.locator("#league-standings-view")).toContainText("青空FC");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    request_kind: "league_standings",
    results: expect.arrayContaining([
      { match_id: "LG-A-M1", home_score: 2, away_score: 1 },
      { match_id: "LG-B-M1", home_score: 0, away_score: 0 },
    ]),
  });

  await page.getByLabel("青空FC 対 みどりSC・青空FCの得点").fill("3");
  await expect(page.locator("#league-standings-view")).toHaveCount(0);
  await expect(page.locator("#standings-status")).toContainText("確定順位を取り消しました");
  await expect(page.locator("#save-state")).toContainText("この端末に保存済み");

  await page.reload();
  await expect(page.getByLabel("青空FC 対 みどりSC・青空FCの得点")).toHaveValue("3");
  await expect(page.getByLabel("青空FC 対 みどりSC・みどりSCの得点")).toHaveValue("1");
});

test("順位確定時に仮トーナメントと仮日程の構造を保ったままチーム名を反映する", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, placementDocument({ includePlan: true, includeSchedule: true }));
  await page.unroute(GENERATE_API);
  await page.route(GENERATE_API, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(placementStandingsResult()),
    });
  });

  await page.locator('.step[data-step="5"]').click();
  await expect(page.locator("#tournament-plan-view")).toContainText("Aブロック 1位");
  await expect(page.locator("#tournament-plan-view")).not.toContainText("青空FC");
  await expect(page.locator("#day2-schedule-view")).toContainText("【仮】");
  await page.locator('.step[data-step="4"]').click();
  await enterPlacementLeagueResults(page);
  await page.getByRole("button", { name: "順位を確定する" }).click();
  await page.locator('.step[data-step="5"]').click();

  await expect(page.locator("#tournament-plan-view")).not.toContainText("【仮】");
  await expect(page.locator("#tournament-plan-view")).toContainText("青空FC");
  await expect(page.locator("#tournament-plan-view")).toContainText("Aブロック 1位");
  await expect(page.locator("#day2-schedule-view")).not.toContainText("【仮】");
  await expect(page.locator("#day2-generation-confirmation")).toBeVisible();

  await page.locator('.step[data-step="4"]').click();
  await page.getByLabel("青空FC 対 みどりSC・青空FCの得点").fill("3");
  await page.locator('.step[data-step="5"]').click();
  await expect(page.locator("#tournament-plan-view")).toContainText("【仮】");
  await expect(page.locator("#day2-schedule-view")).toContainText("【仮】2日目の日程・審判");
  await expect(page.locator("#day2-result-summary")).toContainText("仮トーナメントと仮日程を保持");
});

test("順位API失敗時も得点を保持して結果画面内に説明する", async ({ page }) => {
  await openGeneratedLeague(page);
  await page.unroute(GENERATE_API);
  await page.route(GENERATE_API, async (route) => {
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        status: "error",
        diagnostics: [
          {
            code: "LEAGUE_RESULTS_INCOMPLETE",
            message: "すべてのリーグ試合の結果を入力してください。",
          },
        ],
      }),
    });
  });

  await enterAllSameRankLeagueResults(page);
  await page.getByRole("button", { name: "順位を確定する" }).click();

  await expect(page.locator("#standings-status")).toContainText("すべてのリーグ試合");
  await expect(page.getByLabel("青空FC 対 みどりSC・青空FCの得点")).toHaveValue("2");
});

test("確定順位から2日目を作成し、得点変更時は仮表と仮日程を保持する", async ({
  page,
}) => {
  await mockExternalServices(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await importDocument(page, placementDocument({ resolved: true }));
  await page.unroute(GENERATE_API);
  const requests: unknown[] = [];
  await page.route(GENERATE_API, async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(day2CreationResponse(tournamentPlanResult, day2ScheduleResult)),
    });
  });

  await expect(page.locator("#go-day2-area")).toBeVisible();
  await page.getByRole("button", { name: "2日目へ進む" }).click();
  await expect(page.locator("#day2-generation-confirmation")).toBeVisible();
  await expect(page.getByRole("button", { name: "2日目を作成する" })).toBeEnabled();
  await page.getByRole("button", { name: "2日目を作成する" }).click();

  await expect(page.locator("#day2-schedule-view")).toBeVisible();
  await expect(page.locator("#tournament-plan-view")).toContainText("第1順位帯");
  await expect(page.locator("#tournament-plan-view")).toContainText("青空FC");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    request_kind: "day2_creation",
    final_stage: { format: "placement_tournament", tournament_count: 2 },
    league_standings: { status: "COMPLETE" },
    day: { id: "day2" },
  });

  await page.locator('.step[data-step="4"]').click();
  await page.getByLabel("青空FC 対 みどりSC・青空FCの得点").fill("3");
  await expect(page.locator("#league-standings-view")).toHaveCount(0);
  await expect(page.locator("#standings-status")).toContainText("仮トーナメントへ戻しました");
  await page.locator('.step[data-step="5"]').click();
  await expect(page.locator("#tournament-plan-view")).toContainText("【仮】");
  await expect(page.locator("#tournament-plan-view")).toContainText("Aブロック 1位");
  await expect(page.locator("#day2-generation-confirmation")).toBeVisible();
});

test("既存の仮トーナメントだけを持つデータから2日目全体を再作成する", async ({
  page,
}) => {
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, placementDocument({ includePlan: true }));
  await page.unroute(GENERATE_API);
  const requests: unknown[] = [];
  await page.route(GENERATE_API, async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        day2CreationResponse(provisionalTournamentPlanResult, provisionalDay2ScheduleResult),
      ),
    });
  });

  await expect(page.getByRole("button", { name: "2日目を作成する" })).toBeEnabled();
  await page.getByRole("button", { name: "2日目を作成する" }).click();

  await expect(page.locator("#day2-schedule-view")).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ request_kind: "day2_creation" });
  expect(requests[0]).not.toHaveProperty("tournament_plan");
  await expect(page.locator("#day2-schedule-view")).toContainText("【仮】2日目の日程・審判");
  await expect(page.locator("#day2-schedule-view")).toContainText("時刻・コート・試合番号");
  await expect(page.locator("#save-state")).toContainText("この端末に保存済み");
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#day2-schedule-view")).toBeVisible();
  await page.emulateMedia({ media: "screen" });
  await page.context().setOffline(true);
  await page.reload();
  await expect(page.locator("#day2-schedule-view")).toContainText("【仮】");
});

for (const failedStage of ["tournament_plan", "day2_schedule", "integrated_validation"] as const) {
  test(`2日目作成の${failedStage}段階が失敗しても既存結果を変更せず新tokenで再試行する`, async ({
    page,
  }) => {
    await mockExternalServices(page);
    await openApp(page);
    await importDocument(page, placementDocument({ includePlan: true, includeSchedule: true }));
    await page.unroute(GENERATE_API);
    const requests: Array<{ kind: unknown; token: string | undefined }> = [];
    await page.route(GENERATE_API, async (route) => {
      const request = route.request().postDataJSON() as { request_kind?: unknown };
      requests.push({
        kind: request.request_kind,
        token: route.request().headers()["x-turnstile-token"],
      });
      if (requests.length === 1) {
        await route.fulfill({
          status: failedStage === "integrated_validation" ? 500 : 422,
          contentType: "application/json",
          body: JSON.stringify({
            status: "error",
            diagnostics: [{
              code: failedStage === "integrated_validation"
                ? "DAY2_VALIDATION_FAILED"
                : "TEST_FAILURE",
              message: "テスト用の生成失敗です。",
              details: { operation_stage: failedStage },
            }],
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          day2CreationResponse(provisionalTournamentPlanResult, provisionalDay2ScheduleResult),
        ),
      });
    });

    await expect(page.getByRole("button", { name: "2日目を再作成する" })).toBeEnabled();
    await page.getByRole("button", { name: "2日目を再作成する" }).click();

    await expect(page.locator("#day2-status")).toContainText("既存の結果と入力は変更していません");
    await expect(page.locator("#day2-schedule-view")).toContainText("【仮】2日目の日程・審判");
    expect(requests.map(({ kind }) => kind)).toEqual(["day2_creation"]);

    await expect(page.getByRole("button", { name: "2日目を再作成する" })).toBeEnabled();
    await page.getByRole("button", { name: "2日目を再作成する" }).click();
    await expect(page.locator("#day2-status")).toContainText("この端末へ保存しました");
    expect(requests.map(({ kind }) => kind)).toEqual(["day2_creation", "day2_creation"]);
    expect(requests[0]?.token).toBeTruthy();
    expect(requests[1]?.token).toBeTruthy();
    expect(requests[1]?.token).not.toBe(requests[0]?.token);
  });
}

test("複合応答に表または日程が欠ける場合は保存しない", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, placementDocument({ includePlan: true, includeSchedule: true }));
  await page.unroute(GENERATE_API);
  await page.route(GENERATE_API, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "OPTIMAL",
        tournament_plan: provisionalTournamentPlanResult,
      }),
    });
  });

  await page.getByRole("button", { name: "2日目を再作成する" }).click();

  await expect(page.locator("#day2-status")).toContainText("2日目を作成できませんでした");
  await expect(page.locator("#day2-status")).toContainText("既存の結果と入力は変更していません");
  await expect(page.locator("#day2-schedule-view")).toContainText("【仮】2日目の日程・審判");
});

test("1日目と2日目をモバイルで分け、日別に印刷表示できる", async ({ page }) => {
  await mockExternalServices(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  const document = placementDocument({ resolved: true, includePlan: true });
  await importDocument(page, document);

  await expect(page.locator('[data-panel="5"]')).toBeVisible();
  await expect(page.locator("#day2-standings-summary")).toContainText("青空FC");
  await expect(page.locator("#tournament-plan-view")).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#tournament-plan-view")).toBeVisible();
  await expect(page.locator("#league-standings-view")).toBeHidden();

  await page.emulateMedia({ media: "screen" });
  await page.locator('.step[data-step="4"]').click();
  await expect(page.locator('[data-panel="4"]')).toBeVisible();
  await expect(page.locator("#league-standings-view")).toBeVisible();
  await expect(page.getByLabel("青空FC 対 みどりSC・青空FCの得点")).toBeVisible();
  await expect(page.locator("#tournament-plan-view")).toBeHidden();
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#standings-confirmation")).toBeHidden();
  await expect(page.locator("#league-standings-view")).toBeVisible();
  await expect(page.locator("#tournament-plan-view")).toBeHidden();
});

test("トーナメント表から2日目日程を作成し、設定変更時は2日目だけ失効する", async ({
  page,
}) => {
  await mockExternalServices(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await importDocument(page, placementDocument({ resolved: true, includePlan: true }));
  await page.unroute(GENERATE_API);
  const requests: unknown[] = [];
  await page.route(GENERATE_API, async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(day2CreationResponse(tournamentPlanResult, day2ScheduleResult)),
    });
  });

  await expect(page.locator("#day2-generation-confirmation")).toBeVisible();
  await expect(page.getByRole("button", { name: "2日目を作成する" })).toBeEnabled();
  await page.getByRole("button", { name: "2日目を作成する" }).click();

  await expect(page.locator("#day2-schedule-view")).toContainText("2日目の日程・審判");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    request_kind: "day2_creation",
    day: { id: "day2", start_time: "09:30", margin_minutes: 10 },
    referees: { day2_fallback: "organizer" },
  });

  await page.locator("#day2-margin-minutes").fill("15");
  await page.locator("#day2-margin-minutes").blur();
  await expect(page.locator("#day2-schedule-view")).toHaveCount(0);
  await expect(page.locator("#tournament-plan-view")).toBeVisible();
  await expect(page.locator("#day2-status")).toContainText("以前の日程を取り消しました");
  await page.getByRole("button", { name: "2日目を作成する" }).click();
  await expect(page.locator("#day2-schedule-view")).toBeVisible();
  expect(requests).toHaveLength(2);
  await expect(page.locator("#save-state")).toContainText("この端末に保存済み");
  await page.context().setOffline(true);
  await page.reload();
  await expect(page.locator("#day2-schedule-view")).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#day2-generation-confirmation")).toBeHidden();
  await expect(page.locator("#day2-schedule-view")).toBeVisible();
});
