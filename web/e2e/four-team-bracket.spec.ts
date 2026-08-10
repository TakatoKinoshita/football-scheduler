import { expect, test, type Locator, type Page } from "@playwright/test";

import { tournamentResultsFixture } from "./fixtures";
import { importDocument, mockExternalServices, openApp } from "./helpers";

type JsonObject = Record<string, unknown>;

function withMirroredLogicalLayout(pool: JsonObject): void {
  const matches = pool.matches as JsonObject[];
  const openingMatches = matches.filter((match) => Number(match.round_no) === 1);
  pool.logical_layout = {
    layout_version: "1",
    symmetry: "mirrored",
    opening_entry_order: openingMatches.flatMap((match) => [match.home, match.away]),
    match_positions: matches.map((match, index) => ({
      match_id: match.id,
      rank_range: match.rank_range,
      order: Number(match.round_no) === 1 ? index + 1 : 1,
    })),
    branch_alignments: [{
      rank_range: openingMatches[0]!.rank_range,
      status: "mirrored",
      winner_source_order: openingMatches.map((match) => match.id),
      loser_source_order: openingMatches.map((match) => match.id),
      loser_to_winner_permutation: [1, 2],
      diagnostic_code: null,
    }],
  };
}

function fourTeamBracketDocument(): ReturnType<typeof tournamentResultsFixture> {
  const document = tournamentResultsFixture();
  const tournament = document.tournament as unknown as {
    input: { teams: Array<{ id: string; name: string }> };
    result: JsonObject;
  };
  const longNames = [
    "北関東ジュニアフットボールクラブ",
    "海浜ユナイテッドジュニア",
    "みどりヶ丘サッカースポーツ少年団",
    "中央キッカーズアカデミー",
    "西東京フットボールアカデミー",
    "東海岸ジュニアサッカークラブ",
    "南町スポーツ少年団サッカー部",
    "北星ユナイテッドフットボールクラブ",
  ];
  tournament.input.teams.forEach((team, index) => {
    team.name = longNames[index]!;
  });

  const plan = tournament.result.tournament_plan as JsonObject;
  const pools = plan.pools as JsonObject[];
  pools.forEach(withMirroredLogicalLayout);
  const teamByRank = new Map<string, string>();
  for (const pool of pools) {
    for (const seed of pool.seeds as JsonObject[]) {
      teamByRank.set(
        `${String(seed.block_id)}:${String(seed.block_rank)}`,
        String(seed.team_id),
      );
    }
  }
  const outcomes = new Map<string, { winner: string; loser: string }>();
  const entryTeam = (raw: unknown): string | undefined => {
    const entry = raw as JsonObject;
    if (entry.type === "league_rank") {
      return teamByRank.get(`${String(entry.block_id)}:${String(entry.rank)}`);
    }
    const outcome = outcomes.get(String(entry.match_id));
    return entry.type === "winner_of" ? outcome?.winner : outcome?.loser;
  };
  const results: JsonObject[] = [];
  for (const pool of pools) {
    const pending = [...(pool.matches as JsonObject[])];
    while (pending.length > 0) {
      const index = pending.findIndex((match) =>
        entryTeam(match.home) !== undefined && entryTeam(match.away) !== undefined
      );
      if (index < 0) throw new Error("4チームfixtureの勝敗参照を解決できませんでした。");
      const match = pending.splice(index, 1)[0]!;
      const homeTeamId = entryTeam(match.home)!;
      const awayTeamId = entryTeam(match.away)!;
      const penalty = results.length === 1 || results.length === 6;
      const homeWins = results.length % 3 !== 1;
      results.push({
        match_id: match.id,
        home_team_id: homeTeamId,
        away_team_id: awayTeamId,
        regular_score_home: penalty ? 1 : homeWins ? 2 : 0,
        regular_score_away: penalty ? 1 : homeWins ? 0 : 1,
        ...(penalty
          ? { penalty_score_home: homeWins ? 4 : 3, penalty_score_away: homeWins ? 3 : 4 }
          : {}),
      });
      outcomes.set(String(match.id), {
        winner: homeWins ? homeTeamId : awayTeamId,
        loser: homeWins ? awayTeamId : homeTeamId,
      });
    }
  }
  tournament.result.tournament_results = results;
  return document;
}

async function expectDiagramContentInsideSvg(bracket: Locator): Promise<void> {
  const result = await bracket.locator("svg").evaluate((svg) => {
    const viewBox = (svg as SVGSVGElement).viewBox.baseVal;
    const textBoxes = [...svg.querySelectorAll<SVGGraphicsElement>("text")].map((element) => ({
      className: element.getAttribute("class") ?? "",
      box: element.getBBox(),
    }));
    const outside = textBoxes.filter(({ box }) =>
      box.x < viewBox.x - 1 || box.y < viewBox.y - 1 ||
      box.x + box.width > viewBox.x + viewBox.width + 1 ||
      box.y + box.height > viewBox.y + viewBox.height + 1
    ).map(({ className }) => className);
    const matchLabels = textBoxes.filter(({ className }) =>
      className.includes("bracket-exploration-match-label")
    ).map(({ box }) => box);
    const overlaps = matchLabels.flatMap((box, index) =>
      matchLabels.slice(index + 1).some((other) =>
          box.x < other.x + other.width && box.x + box.width > other.x &&
          box.y < other.y + other.height && box.y + box.height > other.y
        )
        ? [index]
        : []
    );
    return { outside, overlaps };
  });
  expect(result).toEqual({ outside: [], overlaps: [] });
}

async function openFourTeamBracket(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await mockExternalServices(page);
  await openApp(page);
  await importDocument(page, fourTeamBracketDocument());
}

for (const viewport of [
  { name: "375px", width: 375, height: 812 },
  { name: "768px", width: 768, height: 1024 },
  { name: "1280px", width: 1280, height: 900 },
]) {
  test(`添付相当の4チーム表を${viewport.name}で水平・垂直表示できる`, async ({ page }) => {
    await openFourTeamBracket(page, viewport.width, viewport.height);
    const toggle = page.locator("#tournament-bracket-view-toggle");
    await expect(toggle).toBeEnabled();
    await expect(toggle.getByLabel("水平版")).toBeChecked();
    await expect(page.locator(".tournament-bracket-fallback")).toHaveCount(0);

    const horizontal = page.locator(
      "#tournament-plan-view .tournament-bracket.exploration.horizontal",
    );
    await expect(horizontal).toHaveCount(2);
    await expect(horizontal.first()).toHaveAttribute("data-participant-count", "4");
    await expect(horizontal.first().locator(".bracket-exploration-slot").first())
      .toHaveAttribute("aria-label", "北関東ジュニアフットボールクラブ");
    await expect(page.locator(
      '#tournament-plan-view .bracket-exploration-match[aria-label*="PK 3-4"]',
    )).toHaveCount(1);
    await expect(page.locator(
      '#tournament-plan-view .bracket-exploration-match[data-match-id="PT-1-FINAL"][aria-label*="Aコート"]',
    )).toHaveCount(1);
    await expectDiagramContentInsideSvg(horizontal.first());
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth));
    if (viewport.width <= 768) {
      const scroll = await horizontal.first().locator(".tournament-bracket-scroll").evaluate(
        (element) => ({ client: element.clientWidth, scroll: element.scrollWidth }),
      );
      expect(scroll.scroll).toBeGreaterThan(scroll.client);
    }

    await toggle.getByLabel("垂直版").check();
    const vertical = page.locator(
      "#tournament-plan-view .tournament-bracket.exploration.vertical",
    );
    await expect(vertical).toHaveCount(2);
    await expectDiagramContentInsideSvg(vertical.first());
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth));
  });
}

test("4チーム表をA4横・縦の印刷ページへ割り当てる", async ({ page }) => {
  await openFourTeamBracket(page, 1280, 900);
  await page.evaluate(() => {
    document.body.dataset.printScope = "bracket";
  });
  await page.emulateMedia({ media: "print" });
  expect(await page.locator(".tournament-bracket.exploration.horizontal").evaluateAll(
    (figures) => figures.map((figure) => getComputedStyle(figure).page),
  )).toEqual(["bracket-horizontal", "bracket-horizontal"]);

  await page.emulateMedia({ media: "screen" });
  await page.locator("#tournament-bracket-view-toggle").getByLabel("垂直版").check();
  await page.emulateMedia({ media: "print" });
  expect(await page.locator(".tournament-bracket.exploration.vertical").evaluateAll(
    (figures) => figures.map((figure) => getComputedStyle(figure).page),
  )).toEqual(["bracket", "bracket"]);
});
