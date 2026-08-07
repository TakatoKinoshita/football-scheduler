import { expect, test } from "@playwright/test";

import { scheduleResult, tournamentFixture } from "./fixtures";
import { GENERATE_API, importDocument, mockExternalServices, openApp } from "./helpers";

function generatedRolePathResult(
  request: {
    teams?: Array<{ id?: unknown }>;
    courts?: Array<{ id?: unknown }>;
  },
  moveOnAdjacentSection = false,
) {
  const teamIds = (request.teams ?? []).map((team) => String(team.id));
  const courtIds = (request.courts ?? []).map((court) => String(court.id));
  if (teamIds.length < 4 || courtIds.length < 2) throw new Error("E2E入力が不足しています。");
  const matches = [
    {
      id: "LG-A-M1",
      phase: "league",
      round: "Aブロック 第1ラウンド",
      possible_home_team_ids: [teamIds[0]],
      possible_away_team_ids: [teamIds[1]],
      prerequisite_match_ids: [],
      organizer_referee_required: false,
    },
    {
      id: "LG-B-M1",
      phase: "league",
      round: "Bブロック 第1ラウンド",
      possible_home_team_ids: [teamIds[2]],
      possible_away_team_ids: [teamIds[3]],
      prerequisite_match_ids: [],
      organizer_referee_required: false,
    },
  ];
  return {
    ...scheduleResult,
    league_plan: {
      ...scheduleResult.league_plan,
      blocks: [
        { id: "A", team_ids: teamIds.slice(0, 2) },
        { id: "B", team_ids: teamIds.slice(2, 4) },
      ],
      logical_rounds: [
        { block_id: "A", round_no: 1, match_ids: ["LG-A-M1"] },
        { block_id: "B", round_no: 1, match_ids: ["LG-B-M1"] },
      ],
      matches,
    },
    slots: [
      {
        day_id: "day1",
        section_no: 1,
        court_id: courtIds[0],
        match_id: "LG-A-M1",
        referee_assignment: { kind: "organizer" },
      },
      {
        day_id: "day1",
        section_no: 2,
        court_id: moveOnAdjacentSection ? courtIds[1] : courtIds[0],
        match_id: "LG-B-M1",
        referee_assignment: { kind: "team", team_id: teamIds[0] },
      },
    ],
  };
}

async function fillThroughGeneration(page: import("@playwright/test").Page): Promise<void> {
  await page.locator("#tournament-name").fill("本番確認大会");
  await page.locator("#teams").fill("青空FC\nみどりSC\n中央キッカーズ\n海浜ユナイテッド");
  await page.getByRole("button", { name: "次へ：ブロック・会場" }).click();
  await page.locator("#block-count").selectOption("2");
  await page.locator("#assignment-mode").selectOption("seeded_snake");
  await page.locator("#courts").fill("Aコート\nBコート");
  await page.getByRole("button", { name: "次へ：時刻・生成" }).click();
  await expect(page.getByTestId("turnstile-widget-mock")).toBeVisible();
  await expect(page.locator("#generation-status")).toContainText("安全確認が完了しました");
}

test("各手順の不備を項目付近に表示して次へ進まない", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);

  await page.getByRole("button", { name: "次へ：ブロック・会場" }).click();
  await expect(page.locator("#tournament-name-error")).toContainText("大会名を入力");
  await expect(page.locator("#teams-error")).toContainText("2チーム以上");
  await expect(page.locator('[data-panel="1"]')).toBeVisible();

  await page.locator("#tournament-name").fill("地区大会");
  await page.locator("#teams").fill("青空FC\nみどりSC");
  await page.getByRole("button", { name: "次へ：ブロック・会場" }).click();
  await page.locator("#courts").fill("Aコート");
  await page.getByRole("button", { name: "次へ：時刻・生成" }).click();
  await expect(page.locator("#block-count-error")).toContainText("選択してください");
  await expect(page.locator('[data-panel="2"]')).toBeVisible();
});

test("正常入力はseeded_snakeのシード順を付けてAPIを1回だけ呼ぶ", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await fillThroughGeneration(page);
  await page.unroute(GENERATE_API);
  const requests: unknown[] = [];
  await page.route(GENERATE_API, async (route) => {
    const request = route.request().postDataJSON() as {
      courts?: Array<{ id?: unknown }>;
    };
    requests.push(request);
    const courtId = typeof request.courts?.[0]?.id === "string"
      ? request.courts[0].id
      : scheduleResult.slots[0]!.court_id;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...scheduleResult,
        slots: scheduleResult.slots.map((slot) => ({ ...slot, court_id: courtId })),
      }),
    });
  });

  await page.getByRole("button", { name: "1日目の日程を生成する" }).click();

  await expect(page.locator("#result-summary")).toContainText("配置済み 1試合");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    request_kind: "day1_league",
    league: { block_count: 2, assignment_mode: "seeded_snake" },
    teams: [{ seed: 1 }, { seed: 2 }, { seed: 3 }, { seed: 4 }],
    courts: [{ name: "Aコート" }, { name: "Bコート" }],
  });
  expect(requests[0]).not.toHaveProperty("day2");
});

test("生成した1日目の全担当経路が隣接同一コートなら保存する", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await fillThroughGeneration(page);
  await page.unroute(GENERATE_API);
  await page.route(GENERATE_API, async (route) => {
    const request = route.request().postDataJSON() as {
      teams?: Array<{ id?: unknown }>;
      courts?: Array<{ id?: unknown }>;
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(generatedRolePathResult(request)),
    });
  });

  await page.getByRole("button", { name: "1日目の日程を生成する" }).click();

  await expect(page.locator("#result-summary")).toContainText("配置済み 2試合");
  await expect(page.locator(".legacy-schedule-warning")).toHaveCount(0);
});

test("旧バックエンドから届いた隣接コート違反の日程は保存しない", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await fillThroughGeneration(page);
  await page.unroute(GENERATE_API);
  await page.route(GENERATE_API, async (route) => {
    const request = route.request().postDataJSON() as {
      teams?: Array<{ id?: unknown }>;
      courts?: Array<{ id?: unknown }>;
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(generatedRolePathResult(request, true)),
    });
  });

  await page.getByRole("button", { name: "1日目の日程を生成する" }).click();

  await expect(page.locator("#generation-status")).toContainText(
    "隣接セクションの担当を同じコート",
  );
  await expect(page.locator("#result-summary")).toContainText("まだ生成結果はありません");
});

test("読込み済み文書のチームIDとコートIDを設定変更後の再生成でも保持する", async ({
  page,
}) => {
  await mockExternalServices(page);
  await openApp(page);
  const customized = JSON.parse(
    JSON.stringify(tournamentFixture({ withResult: true }))
      .replaceAll("team-01", "blue-team")
      .replaceAll("team-02", "green-team")
      .replaceAll("court-a", "main-pitch"),
  ) as { tournament: { result: unknown } };
  await importDocument(page, customized);
  await page.locator('.step[data-step="3"]').click();
  await page.locator("#game-duration").fill("40");
  await page.unroute(GENERATE_API);
  let request: Record<string, unknown> | undefined;
  await page.route(GENERATE_API, async (route) => {
    request = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(customized.tournament.result),
    });
  });

  await expect(page.getByRole("button", { name: "1日目の日程を生成する" })).toBeEnabled();
  await page.getByRole("button", { name: "1日目の日程を生成する" }).click();
  await expect(page.locator("#result-summary")).toContainText("配置済み 1試合");

  expect(request).toMatchObject({
    teams: [{ id: "blue-team" }, { id: "green-team" }],
    courts: [{ id: "main-pitch" }],
    day: { game_duration_minutes: 40 },
  });
});

test("生成直前の無効入力ではAPIを呼ばず安全確認を維持する", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await fillThroughGeneration(page);
  await page.unroute(GENERATE_API);
  let requestCount = 0;
  await page.route(GENERATE_API, async (route) => {
    requestCount += 1;
    await route.abort();
  });
  await page.locator("#game-duration").fill("");

  await page.getByRole("button", { name: "1日目の日程を生成する" }).click();

  await expect(page.locator("#game-duration-error")).toContainText("1分以上");
  await expect(page.getByRole("button", { name: "1日目の日程を生成する" })).toBeEnabled();
  expect(requestCount).toBe(0);
});

test("APIのfield詳細を日本語項目へ表示して該当手順へ戻る", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await fillThroughGeneration(page);
  await page.unroute(GENERATE_API);
  await page.route(GENERATE_API, async (route) => {
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        status: "error",
        diagnostics: [
          {
            code: "INPUT_SCHEMA_INVALID",
            message: "大会設定に入力不備があります。",
            details: { errors: [{ field: "league.block_count", type: "missing" }] },
          },
        ],
      }),
    });
  });

  await page.getByRole("button", { name: "1日目の日程を生成する" }).click();

  await expect(page.locator('[data-panel="2"]')).toBeVisible();
  await expect(page.locator("#block-count-error")).toContainText("ブロック数の入力値");
});
