import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { scheduleResult, tournamentFixture } from "./fixtures";
import {
  GENERATE_API,
  importDocument,
  mockExternalServices,
  openApp,
  scheduleCreationResponse,
} from "./helpers";

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

function manualGeneratedResult(request: {
  teams?: Array<{ id?: unknown }>;
  courts?: Array<{ id?: unknown }>;
  league?: { manual_blocks?: Array<{ id?: unknown; team_ids?: unknown }> };
}) {
  const teamIds = (request.teams ?? []).map((team) => String(team.id));
  const courtIds = (request.courts ?? []).map((court) => String(court.id));
  const blocks = (request.league?.manual_blocks ?? []).map((block) => ({
    id: String(block.id),
    team_ids: Array.isArray(block.team_ids) ? block.team_ids.map(String) : [],
  }));
  const assignedTeamIds = new Set(blocks.flatMap((block) => block.team_ids));
  const unassignedTeamIds = teamIds.filter((teamId) => !assignedTeamIds.has(teamId));
  const minimumSize = Math.floor(teamIds.length / blocks.length);
  const largerBlockCount = teamIds.length % blocks.length;
  const fixedLargerBlockIds = new Set(
    blocks.filter((block) => block.team_ids.length > minimumSize).map((block) => block.id),
  );
  for (const block of blocks) {
    if (fixedLargerBlockIds.size >= largerBlockCount) break;
    fixedLargerBlockIds.add(block.id);
  }
  const automaticAssignments: Array<{ team_id: string; block_id: string }> = [];
  let offset = 0;
  for (const block of blocks) {
    const targetSize = minimumSize + (fixedLargerBlockIds.has(block.id) ? 1 : 0);
    const additions = unassignedTeamIds.slice(offset, offset + targetSize - block.team_ids.length);
    offset += additions.length;
    block.team_ids.push(...additions);
    automaticAssignments.push(
      ...additions.map((teamId) => ({ team_id: teamId, block_id: block.id })),
    );
  }
  const matches = blocks.map((block) => ({
    id: `LG-${block.id}-M1`,
    phase: "league",
    round: `${block.id}ブロック 第1ラウンド`,
    possible_home_team_ids: [block.team_ids[0]],
    possible_away_team_ids: [block.team_ids[1]],
    prerequisite_match_ids: [],
    organizer_referee_required: false,
  }));
  return {
    ...scheduleResult,
    league_plan: {
      schema_version: "0.2.0",
      assignment_mode: "manual",
      random_seed: 20260803,
      blocks,
      manual_completion: { automatic_assignments: automaticAssignments },
      logical_rounds: blocks.map((block) => ({
        block_id: block.id,
        round_no: 1,
        match_ids: [`LG-${block.id}-M1`],
      })),
      matches,
    },
    slots: matches.map((match, index) => ({
      day_id: "day1",
      section_no: 1,
      court_id: courtIds[index] ?? courtIds[0],
      match_id: match.id,
      referee_assignment: { kind: "organizer" },
    })),
  };
}

async function fillThroughGeneration(page: import("@playwright/test").Page): Promise<void> {
  await page.locator("#tournament-name").fill("本番確認大会");
  await page.locator("#teams").fill("青空FC\nみどりSC\n中央キッカーズ\n海浜ユナイテッド");
  await page.locator("#courts").fill("Aコート\nBコート");
  await page.getByRole("button", { name: "次へ：日程設定・生成" }).click();
  await page.locator("#block-count").selectOption("2");
  await page.locator("#assignment-mode").selectOption("seeded_snake");
  await page.locator("#final-stage-format").selectOption("same_rank_league");
  await expect(page.getByTestId("turnstile-widget-mock")).toBeVisible();
  await expect(page.locator("#generation-status")).toContainText("安全確認が完了しました");
}

test("生成時に全設定を検証し、不備のあるタブと項目へ戻る", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);

  await page.locator("#tab-schedule-settings").click();
  await expect(page.locator("#schedule-settings-panel")).toBeVisible();
  await page.getByRole("button", { name: "日程を生成する" }).click();
  await expect(page.locator("#tournament-name-error")).toContainText("大会名を入力");
  await expect(page.locator("#teams-error")).toContainText("2チーム以上");
  await expect(page.locator("#tournament-panel")).toBeVisible();

  await page.locator("#tournament-name").fill("地区大会");
  await page.locator("#teams").fill("青空FC\nみどりSC");
  await page.locator("#courts").fill("Aコート");
  await page.locator("#tab-schedule-settings").click();
  await page.getByRole("button", { name: "日程を生成する" }).click();
  await expect(page.locator("#block-count-error")).toContainText("選択してください");
  await expect(page.locator("#schedule-settings-panel")).toBeVisible();
});

test("正常入力はseeded_snakeのシード順を付けてAPIを1回だけ呼ぶ", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await fillThroughGeneration(page);
  await page.unroute(GENERATE_API);
  const requests: unknown[] = [];
  await page.route(GENERATE_API, async (route) => {
    const request = route.request().postDataJSON() as {
      teams?: Array<{ id?: unknown }>;
      courts?: Array<{ id?: unknown }>;
    };
    requests.push(request);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(scheduleCreationResponse(generatedRolePathResult(request))),
    });
  });

  await page.getByRole("button", { name: "日程を生成する" }).click();

  await expect(page.locator("#result-summary")).toContainText("配置済み 2試合");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    request_kind: "schedule_creation",
    generation_scope: "all",
    league: { block_count: 2, assignment_mode: "seeded_snake" },
    teams: [{ seed: 1 }, { seed: 2 }, { seed: 3 }, { seed: 4 }],
    courts: [{ name: "Aコート" }, { name: "Bコート" }],
  });
  expect(requests[0]).toHaveProperty("day2");
});

test("複数の遠方チームへ希望セクションを一括指定して生成要求へ保存する", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await fillThroughGeneration(page);
  await page.locator("#arrival-preferences summary").click();
  await page.locator("#arrival-preference-team-team-01").check();
  await page.locator("#arrival-preference-team-team-03").check();
  await page.locator("#arrival-bulk-section").fill("4");
  await page.getByRole("button", { name: "選択したチームに適用" }).click();

  await page.unroute(GENERATE_API);
  let request: Record<string, unknown> | undefined;
  await page.route(GENERATE_API, async (route) => {
    const payload = route.request().postDataJSON() as {
      teams?: Array<{ id?: unknown }>;
      courts?: Array<{ id?: unknown }>;
    };
    request = payload as Record<string, unknown>;
    const generated = generatedRolePathResult(payload);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(scheduleCreationResponse({
        ...generated,
        metrics: {
          ...generated.metrics,
          day1_arrival_preference_metrics: [
            {
              team_id: "team-01",
              earliest_section: 4,
              match_count: 1,
              early_match_count: 1,
              early_referee_count: 1,
              total_section_shortfall: 3,
              early_matches: [
                { match_id: "LG-A-M1", section_no: 1, section_shortfall: 3 },
              ],
              satisfied: false,
            },
            {
              team_id: "team-03",
              earliest_section: 4,
              match_count: 1,
              early_match_count: 1,
              early_referee_count: 0,
              total_section_shortfall: 2,
              early_matches: [
                { match_id: "LG-B-M1", section_no: 2, section_shortfall: 2 },
              ],
              satisfied: false,
            },
          ],
          day1_arrival_early_match_count: 2,
          day1_arrival_total_section_shortfall: 5,
          day1_arrival_early_referee_count: 1,
        },
      })),
    });
  });

  await page.getByRole("button", { name: "日程を生成する" }).click();
  await expect.poll(() => request).toBeDefined();
  expect(request).toMatchObject({
    day1_arrival_preferences: [
      { team_id: "team-01", earliest_section: 4 },
      { team_id: "team-03", earliest_section: 4 },
    ],
  });
  await expect(page.locator("#result-content")).toContainText(
    "開始セクションへの配慮を完全には満たせませんでした",
  );
  await expect(page.locator("#result-content")).toContainText("希望より早い試合 2件");
});

test("自動方式へ戻した後は非表示の手動割当てを両決勝方式の生成要求へ含めない", async ({
  page,
}) => {
  await mockExternalServices(page);
  await openApp(page);
  await page.locator("#tournament-name").fill("16チーム生成確認大会");
  await page.locator("#teams").fill(
    Array.from({ length: 16 }, (_, index) => `チーム${String(index + 1)}`).join("\n"),
  );
  await page.locator("#courts").fill("Aコート\nBコート\nCコート");
  await page.getByRole("button", { name: "次へ：日程設定・生成" }).click();
  await page.locator("#block-count").selectOption("4");
  await page.locator("#assignment-mode").selectOption("manual");
  await page.getByLabel("チーム1", { exact: true }).selectOption("A");
  await page.locator("#assignment-mode").selectOption("random");
  await page.locator("#final-stage-format").selectOption("same_rank_league");

  await page.unroute(GENERATE_API);
  const requests: Array<Record<string, unknown>> = [];
  await page.route(GENERATE_API, async (route) => {
    requests.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        status: "error",
        diagnostics: [{ code: "TEST_STOP", message: "要求内容を確認しました。" }],
      }),
    });
  });

  await expect(page.getByRole("button", { name: "日程を生成する" })).toBeEnabled();
  await page.getByRole("button", { name: "日程を生成する" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({
    request_kind: "schedule_creation",
    courts: [{ name: "Aコート" }, { name: "Bコート" }, { name: "Cコート" }],
    league: { block_count: 4, assignment_mode: "random" },
    final_stage: { format: "same_rank_league" },
  });
  expect(requests[0]!.teams).toHaveLength(16);
  expect((requests[0]!.teams as Array<Record<string, unknown>>)[15]).toMatchObject({
    name: "チーム16",
  });
  expect((requests[0]!.league as Record<string, unknown>)).not.toHaveProperty("manual_blocks");

  await expect(page.getByRole("button", { name: "日程を生成する" })).toBeEnabled();
  await page.locator("#final-stage-format").selectOption("placement_tournament");
  await page.locator("#tournament-count").selectOption("2");
  await page.getByRole("button", { name: "日程を生成する" }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toMatchObject({
    request_kind: "schedule_creation",
    league: { block_count: 4, assignment_mode: "random" },
    final_stage: { format: "placement_tournament", tournament_count: 2 },
  });
  expect((requests[1]!.league as Record<string, unknown>)).not.toHaveProperty("manual_blocks");
});

test("順位決定トーナメントごとの名前を既定表示し、変更後の名前で生成を要求する", async ({
  page,
}) => {
  await mockExternalServices(page);
  await openApp(page);
  await page.locator("#tournament-name").fill("名称設定大会");
  await page.locator("#teams").fill(
    Array.from({ length: 8 }, (_, index) => `チーム${String(index + 1)}`).join("\n"),
  );
  await page.locator("#courts").fill("Aコート\nBコート");
  await page.getByRole("button", { name: "次へ：日程設定・生成" }).click();
  await page.locator("#block-count").selectOption("2");
  await page.locator("#final-stage-format").selectOption("placement_tournament");
  await page.locator("#tournament-count").selectOption("2");

  await expect(page.locator("#tournament-names-field")).toBeVisible();
  await expect(page.locator("#tournament-name-1")).toHaveValue("第1順位決定トーナメント");
  await expect(page.locator("#tournament-name-2")).toHaveValue("第2順位決定トーナメント");
  await page.locator("#tournament-name-1").fill("チャンピオンリーグ");
  await page.locator("#tournament-name-2").fill("チャレンジリーグ");

  await page.unroute(GENERATE_API);
  let request: Record<string, unknown> | undefined;
  await page.route(GENERATE_API, async (route) => {
    request = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        status: "error",
        diagnostics: [{ code: "TEST_STOP", message: "要求内容を確認しました。" }],
      }),
    });
  });
  await expect(page.getByRole("button", { name: "日程を生成する" })).toBeEnabled();
  await page.getByRole("button", { name: "日程を生成する" }).click();
  await expect.poll(() => request).toBeDefined();

  expect(request).toMatchObject({
    request_kind: "schedule_creation",
    final_stage: {
      format: "placement_tournament",
      tournament_count: 2,
      tournament_names: ["チャンピオンリーグ", "チャレンジリーグ"],
    },
  });
});

test("手動で各チームを均衡ブロックへ割り当て、その所属のまま生成する", async ({
  page,
}) => {
  await mockExternalServices(page);
  await openApp(page);
  await page.locator("#tournament-name").fill("手動割当て大会");
  await page.locator("#teams").fill("青空FC\nみどりSC\n中央キッカーズ\n海浜ユナイテッド");
  await page.locator("#courts").fill("Aコート\nBコート");
  await page.getByRole("button", { name: "次へ：日程設定・生成" }).click();
  await page.locator("#block-count").selectOption("2");
  await page.locator("#assignment-mode").selectOption("manual");
  await page.locator("#final-stage-format").selectOption("same_rank_league");

  await expect(page.locator("#manual-block-summary")).toContainText("未割当て 4チーム");
  const blue = page.getByLabel("青空FC", { exact: true });
  await blue.focus();
  await blue.press("ArrowDown");
  await blue.press("Enter");
  await page.getByLabel("みどりSC", { exact: true }).selectOption("B");
  await page.getByLabel("中央キッカーズ", { exact: true }).selectOption("A");
  await page.getByLabel("海浜ユナイテッド", { exact: true }).selectOption("B");
  await expect(page.locator("#manual-block-summary")).toContainText("割当てが完了");
  await expect(page.locator("#manual-block-count-A")).toContainText("現在2チーム／最終2〜2チーム");
  await expect(page.locator("#manual-block-count-B")).toContainText("現在2チーム／最終2〜2チーム");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  await expect(page.getByTestId("turnstile-widget-mock")).toBeVisible();
  await page.unroute(GENERATE_API);
  let request: Record<string, unknown> | undefined;
  await page.route(GENERATE_API, async (route) => {
    request = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(scheduleCreationResponse(manualGeneratedResult(request))),
    });
  });

  await page.getByRole("button", { name: "日程を生成する" }).click();

  expect(request).toMatchObject({
    league: {
      block_count: 2,
      assignment_mode: "manual",
      manual_blocks: [
        { id: "A", team_ids: ["team-01", "team-03"] },
        { id: "B", team_ids: ["team-02", "team-04"] },
      ],
    },
  });
  await expect(page.locator("#result-summary")).toContainText("配置済み 2試合");
  await expect(page.locator(".block-card").first()).toContainText("青空FC");
  await expect(page.locator(".block-card").first()).toContainText("中央キッカーズ");

  await page.locator("#tab-schedule-settings").click();
  await page.getByLabel("青空FC", { exact: true }).selectOption("B");
  await expect(page.locator("#result-summary")).toContainText("まだ生成結果はありません");
});

test("一部だけ手動指定し、残りを自動配置して入力との区別を表示する", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await page.locator("#tournament-name").fill("部分手動割当て大会");
  await page.locator("#teams").fill("青\n赤\n白\n緑");
  await page.locator("#courts").fill("Aコート\nBコート");
  await page.getByRole("button", { name: "次へ：日程設定・生成" }).click();
  await page.locator("#block-count").selectOption("2");
  await page.locator("#assignment-mode").selectOption("manual");
  await page.locator("#final-stage-format").selectOption("same_rank_league");
  await page.getByLabel("青", { exact: true }).selectOption("A");
  await page.getByLabel("緑", { exact: true }).selectOption("B");
  await expect(page.locator("#manual-block-summary")).toContainText(
    "未割当て 2チームは、日程生成時に抽選番号で自動配置します",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  await page.unroute(GENERATE_API);
  let request: Record<string, unknown> | undefined;
  await page.route(GENERATE_API, async (route) => {
    request = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(scheduleCreationResponse(manualGeneratedResult(request))),
    });
  });
  await page.getByRole("button", { name: "日程を生成する" }).click();

  expect(request).toMatchObject({
    league: {
      assignment_mode: "manual",
      manual_blocks: [
        { id: "A", team_ids: ["team-01"] },
        { id: "B", team_ids: ["team-04"] },
      ],
    },
  });
  await expect(page.locator("#result-content")).toContainText("2チームを抽選番号で自動配置");
  await expect(page.locator(".automatic-assignment")).toHaveCount(2);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "ファイルへ保存" }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const exported = JSON.parse(await readFile(downloadPath!, "utf8")) as {
    tournament: {
      input: { league: { manual_blocks: Array<{ id: string; team_ids: string[] }> } };
      result: {
        league_plan: {
          blocks: Array<{ id: string; team_ids: string[] }>;
          manual_completion: { automatic_assignments: unknown[] };
        };
      };
    };
  };
  expect(exported.tournament.input.league.manual_blocks).toEqual([
    { id: "A", team_ids: ["team-01"] },
    { id: "B", team_ids: ["team-04"] },
  ]);
  expect(exported.tournament.result.league_plan.blocks.flatMap((block) => block.team_ids)).toHaveLength(4);
  expect(exported.tournament.result.league_plan.manual_completion.automatic_assignments).toHaveLength(2);
  await importDocument(page, exported);
  await expect(page.locator(".automatic-assignment")).toHaveCount(2);
  await page.locator("#tab-schedule-settings").click();
  await expect(page.getByLabel("青", { exact: true })).toHaveValue("A");
  await expect(page.getByLabel("緑", { exact: true })).toHaveValue("B");
  await expect(page.getByLabel("赤", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("白", { exact: true })).toHaveValue("");
  await page.getByLabel("青", { exact: true }).selectOption("");
  await page.getByLabel("緑", { exact: true }).selectOption("");
  await expect(page.locator("#manual-block-summary")).toContainText("未割当て 4チーム");
  await page.getByRole("button", { name: "日程を生成する" }).click();
  expect(request).toMatchObject({
    league: {
      manual_blocks: [
        { id: "A", team_ids: [] },
        { id: "B", team_ids: [] },
      ],
    },
  });
  await expect(page.locator(".automatic-assignment")).toHaveCount(4);
});

test("手動指定の人数超過では次へ進まない", async ({ page }) => {
  await mockExternalServices(page);
  await openApp(page);
  await page.locator("#tournament-name").fill("入力確認大会");
  await page.locator("#teams").fill("青\n赤\n白\n緑\n黄");
  await page.locator("#courts").fill("Aコート");
  await page.getByRole("button", { name: "次へ：日程設定・生成" }).click();
  await page.locator("#block-count").selectOption("2");
  await page.locator("#assignment-mode").selectOption("manual");
  await page.locator("#final-stage-format").selectOption("same_rank_league");
  for (const name of ["青", "赤", "白", "緑"]) {
    await page.getByLabel(name, { exact: true }).selectOption("A");
  }

  await page.getByRole("button", { name: "日程を生成する" }).click();
  await expect(page.locator("#manual-block-team-team-01-error")).toContainText("2〜3チーム");
  await expect(page.locator("#schedule-settings-panel")).toBeVisible();
});

test("名称変更・追加・ブロック変更では有効な手動割当てだけを保持する", async ({
  page,
}) => {
  await mockExternalServices(page);
  await openApp(page);
  await page.locator("#tournament-name").fill("割当て編集大会");
  await page.locator("#teams").fill("青\n赤\n白\n緑");
  await page.locator("#courts").fill("Aコート");
  await page.getByRole("button", { name: "次へ：日程設定・生成" }).click();
  await page.locator("#block-count").selectOption("2");
  await page.locator("#assignment-mode").selectOption("manual");
  await page.getByLabel("青", { exact: true }).selectOption("A");
  await page.getByLabel("赤", { exact: true }).selectOption("B");
  await page.getByLabel("白", { exact: true }).selectOption("A");
  await page.getByLabel("緑", { exact: true }).selectOption("B");

  await page.getByRole("button", { name: "大会・チームへ戻る" }).click();
  await page.locator("#teams").fill("青空\n赤\n白\n緑\n黄");
  await page.getByRole("button", { name: "次へ：日程設定・生成" }).click();
  await expect(page.getByLabel("青空", { exact: true })).toHaveValue("A");
  await expect(page.getByLabel("赤", { exact: true })).toHaveValue("B");
  await expect(page.getByLabel("黄", { exact: true })).toHaveValue("");

  await page.locator("#block-count").selectOption("3");
  await expect(page.getByLabel("青空", { exact: true })).toHaveValue("A");
  await expect(page.getByLabel("赤", { exact: true })).toHaveValue("B");
  await expect(page.locator("#manual-block-count-C")).toContainText("0チーム");
  await page.locator("#block-count").selectOption("1");
  await expect(page.getByLabel("青空", { exact: true })).toHaveValue("A");
  await expect(page.getByLabel("赤", { exact: true })).toHaveValue("");
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
      body: JSON.stringify(scheduleCreationResponse(generatedRolePathResult(request))),
    });
  });

  await page.getByRole("button", { name: "日程を生成する" }).click();

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
      body: JSON.stringify(scheduleCreationResponse(generatedRolePathResult(request, true))),
    });
  });

  await page.getByRole("button", { name: "日程を生成する" }).click();

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
  const source = tournamentFixture({ withResult: true }) as ReturnType<
    typeof tournamentFixture
  > & { tournament: { result: unknown } };
  source.tournament.input.courts.push({ id: "court-b", name: "Bコート" });
  source.tournament.input.league.block_count = 2;
  source.tournament.result = generatedRolePathResult({
    teams: source.tournament.input.teams,
    courts: source.tournament.input.courts,
  });
  const customized = JSON.parse(
    JSON.stringify(source)
      .replaceAll("team-01", "blue-team")
      .replaceAll("team-02", "green-team")
      .replaceAll("court-a", "main-pitch"),
  ) as { tournament: { result: unknown } };
  await importDocument(page, customized);
  await page.locator("#tab-schedule-settings").click();
  await page.locator("#game-duration").fill("40");
  await page.unroute(GENERATE_API);
  let request: Record<string, unknown> | undefined;
  await page.route(GENERATE_API, async (route) => {
    request = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(scheduleCreationResponse(generatedRolePathResult(request))),
    });
  });

  await expect(page.getByRole("button", { name: "日程を生成する" })).toBeEnabled();
  await page.getByRole("button", { name: "日程を生成する" }).click();
  await expect(page.locator("#result-summary")).toContainText("配置済み 2試合");

  expect(request).toMatchObject({ day: { game_duration_minutes: 40 } });
  expect(request?.teams).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "blue-team" }),
    expect.objectContaining({ id: "green-team" }),
  ]));
  expect(request?.courts).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "main-pitch" }),
  ]));
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

  await page.getByRole("button", { name: "日程を生成する" }).click();

  await expect(page.locator("#game-duration-error")).toContainText("1分以上");
  await expect(page.getByRole("button", { name: "日程を生成する" })).toBeEnabled();
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

  await page.getByRole("button", { name: "日程を生成する" }).click();

  await expect(page.locator("#schedule-settings-panel")).toBeVisible();
  await expect(page.locator("#block-count-error")).toContainText("ブロック数の入力値");
});
