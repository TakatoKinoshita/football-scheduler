import { expect, test } from "@playwright/test";

import {
  day2ScheduleResult,
  provisionalDay2ScheduleResult,
  provisionalTournamentPlanResult,
  scheduleResult,
  standingsResult,
  tournamentFixture,
  tournamentPlanResult,
} from "./fixtures";
import { GENERATE_API, importDocument, mockExternalServices, openApp } from "./helpers";

async function openGeneratedLeague(page: import("@playwright/test").Page): Promise<void> {
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, tournamentFixture({ withResult: true }));
  await expect(page.locator("#standings-confirmation")).toBeVisible();
}

async function enterOnlyResult(page: import("@playwright/test").Page): Promise<void> {
  await page.getByLabel("青空FC 対 みどりSC・青空FCの得点").fill("2");
  await page.getByLabel("青空FC 対 みどりSC・みどりSCの得点").fill("1");
  await expect(page.getByRole("button", { name: "順位を確定する" })).toBeEnabled();
}

test("順位未確定でも順位枠の仮トーナメントを作成・印刷・復元する", async ({ page }) => {
  await openGeneratedLeague(page);
  await page.unroute(GENERATE_API);
  const requests: unknown[] = [];
  await page.route(GENERATE_API, async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(provisionalTournamentPlanResult),
    });
  });

  await page.locator('.step[data-step="5"]').click();

  await expect(page.locator('[data-panel="5"]')).toBeVisible();
  await expect(page.locator("#tournament-confirmation")).toBeVisible();
  await expect(page.getByRole("button", { name: "仮トーナメントを作成する" })).toBeEnabled();
  await page.getByRole("button", { name: "仮トーナメントを作成する" }).click();

  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ request_kind: "tournament_plan" });
  expect(requests[0]).not.toHaveProperty("league_standings");
  await expect(page.locator("#tournament-plan-view")).toContainText("【仮】");
  await expect(page.locator("#tournament-plan-view .tournament-bracket figcaption").first())
    .toHaveText("上位トーナメント表（仮）");
  await expect(page.locator("#tournament-plan-view")).toContainText("Aブロック 1位");
  await expect(page.locator("#day2-confirmation")).toBeVisible();
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
      body: JSON.stringify(standingsResult),
    });
  });

  await enterOnlyResult(page);
  await expect(page.locator("#league-results-progress")).toContainText("入力済み 1 / 1試合");
  await expect(page.getByRole("button", { name: "順位を確定する" })).toBeEnabled();
  await page.getByRole("button", { name: "順位を確定する" }).click();

  await expect(page.locator("#league-standings-view")).toContainText("青空FC");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    request_kind: "league_standings",
    results: [{ match_id: "LG-A-M1", home_score: 2, away_score: 1 }],
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
  const base = tournamentFixture({ withResult: true });
  await importDocument(page, {
    ...base,
    tournament: {
      ...base.tournament,
      input: {
        ...base.tournament.input,
        day2: {
          id: "day2",
          start_time: "09:30",
          game_duration_minutes: 35,
          margin_minutes: 10,
          max_sections: null,
          end_time: null,
          breaks: [],
        },
      },
      result: {
        ...scheduleResult,
        tournament_plan: provisionalTournamentPlanResult,
        day2_schedule: provisionalDay2ScheduleResult,
        integrated_validation: provisionalDay2ScheduleResult.integrated_validation,
      },
    },
  });
  await page.unroute(GENERATE_API);
  await page.route(GENERATE_API, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(standingsResult),
    });
  });

  await page.locator('.step[data-step="5"]').click();
  await expect(page.locator("#tournament-plan-view")).toContainText("Aブロック 1位");
  await expect(page.locator("#tournament-plan-view")).not.toContainText("青空FC");
  await expect(page.locator("#day2-schedule-view")).toContainText("【仮】");
  await page.locator('.step[data-step="4"]').click();
  await enterOnlyResult(page);
  await page.getByRole("button", { name: "順位を確定する" }).click();
  await page.locator('.step[data-step="5"]').click();

  await expect(page.locator("#tournament-plan-view")).not.toContainText("【仮】");
  await expect(page.locator("#tournament-plan-view")).toContainText("青空FC（Aブロック 1位）");
  await expect(page.locator("#day2-schedule-view")).not.toContainText("【仮】");
  await expect(page.locator("#day2-confirmation")).toBeVisible();

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

  await enterOnlyResult(page);
  await page.getByRole("button", { name: "順位を確定する" }).click();

  await expect(page.locator("#standings-status")).toContainText("すべてのリーグ試合");
  await expect(page.getByLabel("青空FC 対 みどりSC・青空FCの得点")).toHaveValue("2");
});

test("確定順位から2日目トーナメントを作成し、得点変更時は仮表を保持する", async ({
  page,
}) => {
  await mockExternalServices(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  const base = tournamentFixture({ withResult: true });
  await importDocument(page, {
    ...base,
    tournament: {
      ...base.tournament,
      result: {
        ...scheduleResult,
        league_results: [{ match_id: "LG-A-M1", home_score: 2, away_score: 1 }],
        league_standings: standingsResult,
      },
    },
  });
  await page.unroute(GENERATE_API);
  const requests: unknown[] = [];
  await page.route(GENERATE_API, async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(tournamentPlanResult),
    });
  });

  await expect(page.locator("#go-day2-area")).toBeVisible();
  await page.getByRole("button", { name: "2日目へ進む" }).click();
  await expect(page.locator("#tournament-confirmation")).toBeVisible();
  await expect(page.getByRole("button", { name: "2日目トーナメントを作成する" })).toBeEnabled();
  await page.getByRole("button", { name: "2日目トーナメントを作成する" }).click();

  await expect(page.locator("#tournament-plan-view")).toContainText("上位トーナメント");
  await expect(page.locator("#tournament-plan-view")).toContainText("青空FC");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    request_kind: "tournament_plan",
    odd_split_policy: "upper",
    league_standings: { status: "COMPLETE" },
  });

  await page.locator('.step[data-step="4"]').click();
  await page.getByLabel("青空FC 対 みどりSC・青空FCの得点").fill("3");
  await expect(page.locator("#league-standings-view")).toHaveCount(0);
  await expect(page.locator("#standings-status")).toContainText("仮トーナメントへ戻しました");
  await page.locator('.step[data-step="5"]').click();
  await expect(page.locator("#tournament-plan-view")).toContainText("【仮】");
  await expect(page.locator("#tournament-plan-view")).toContainText("Aブロック 1位");
  await expect(page.locator("#tournament-confirmation")).toBeVisible();
  await expect(page.locator("#day2-confirmation")).toBeVisible();
});

test("仮トーナメントから仮の2日目日程を作成・印刷・オフライン復元する", async ({
  page,
}) => {
  await mockExternalServices(page);
  await openApp(page);
  const base = tournamentFixture({ withResult: true });
  await importDocument(page, {
    ...base,
    tournament: {
      ...base.tournament,
      result: {
        ...scheduleResult,
        tournament_plan: provisionalTournamentPlanResult,
      },
    },
  });
  await page.unroute(GENERATE_API);
  const requests: unknown[] = [];
  await page.route(GENERATE_API, async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(provisionalDay2ScheduleResult),
    });
  });

  await expect(page.getByRole("button", { name: "2日目の日程を作成する" })).toBeEnabled();
  await page.getByRole("button", { name: "2日目の日程を作成する" }).click();

  expect(requests[0]).toMatchObject({
    request_kind: "day2_schedule",
    tournament_plan: { participant_resolution: "provisional" },
  });
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

test("1日目と2日目をモバイルで分け、日別に印刷表示できる", async ({ page }) => {
  await mockExternalServices(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  const base = tournamentFixture({ withResult: true });
  const document = {
    ...base,
    tournament: {
      ...base.tournament,
      result: {
        ...scheduleResult,
        league_results: [{ match_id: "LG-A-M1", home_score: 2, away_score: 1 }],
        league_standings: standingsResult,
        tournament_plan: tournamentPlanResult,
      },
    },
  };
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
  const base = tournamentFixture({ withResult: true });
  await importDocument(page, {
    ...base,
    tournament: {
      ...base.tournament,
      result: {
        ...scheduleResult,
        league_results: [{ match_id: "LG-A-M1", home_score: 2, away_score: 1 }],
        league_standings: standingsResult,
        tournament_plan: tournamentPlanResult,
      },
    },
  });
  await page.unroute(GENERATE_API);
  const requests: unknown[] = [];
  await page.route(GENERATE_API, async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(day2ScheduleResult),
    });
  });

  await expect(page.locator("#day2-confirmation")).toBeVisible();
  await expect(page.getByRole("button", { name: "2日目の日程を作成する" })).toBeEnabled();
  await page.getByRole("button", { name: "2日目の日程を作成する" }).click();

  await expect(page.locator("#day2-schedule-view")).toContainText("2日目の日程・審判");
  expect(requests[0]).toMatchObject({
    request_kind: "day2_schedule",
    day: { id: "day2", start_time: "09:30", margin_minutes: 10 },
    referees: { tournament_fallback: "organizer" },
    tournament_plan: { status: "COMPLETE" },
  });

  await page.locator("#day2-margin-minutes").fill("15");
  await page.locator("#day2-margin-minutes").blur();
  await expect(page.locator("#day2-schedule-view")).toHaveCount(0);
  await expect(page.locator("#tournament-plan-view")).toBeVisible();
  await expect(page.locator("#day2-status")).toContainText("以前の日程を取り消しました");
  await page.getByRole("button", { name: "2日目の日程を作成する" }).click();
  await expect(page.locator("#day2-schedule-view")).toBeVisible();
  await expect(page.locator("#save-state")).toContainText("この端末に保存済み");
  await page.context().setOffline(true);
  await page.reload();
  await expect(page.locator("#day2-schedule-view")).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#day2-confirmation")).toBeHidden();
  await expect(page.locator("#day2-schedule-view")).toBeVisible();
});
