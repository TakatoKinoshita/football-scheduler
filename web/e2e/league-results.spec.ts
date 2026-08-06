import { expect, test } from "@playwright/test";

import {
  day2ScheduleResult,
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

test("確定順位から2日目トーナメントを作成し、得点変更時は一緒に失効する", async ({
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

  await page.getByLabel("青空FC 対 みどりSC・青空FCの得点").fill("3");
  await expect(page.locator("#league-standings-view")).toHaveCount(0);
  await expect(page.locator("#tournament-plan-view")).toHaveCount(0);
  await expect(page.locator("#tournament-confirmation")).toBeHidden();
});

test("確定順位はモバイルと印刷表示で確認できる", async ({ page }) => {
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

  await expect(page.locator("#league-standings-view")).toBeVisible();
  await expect(page.locator("#tournament-plan-view")).toBeVisible();
  await expect(page.getByLabel("青空FC 対 みどりSC・青空FCの得点")).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#standings-confirmation")).toBeHidden();
  await expect(page.locator("#league-standings-view")).toBeVisible();
  await expect(page.locator("#tournament-plan-view")).toBeVisible();
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
