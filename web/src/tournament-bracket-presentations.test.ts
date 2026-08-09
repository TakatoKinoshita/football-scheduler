import { describe, expect, it } from "vitest";

import upperEightJson from "./fixtures/tournament-bracket-preview/upper-8.json";
import upperSixteenJson from "./fixtures/tournament-bracket-preview/upper-16.json";
import {
  buildTournamentBracketModel,
  type TournamentBracketInput,
} from "./tournament-bracket";
import { isTournamentBracketExplorationModel } from "./tournament-bracket-exploration-layouts";
import { renderTournamentBracketExploration } from "./tournament-bracket-exploration-renderer";
import {
  defaultTournamentBracketPresentation,
  loadTournamentBracketViewMode,
  saveTournamentBracketViewMode,
  selectTournamentBracketPresentation,
  TOURNAMENT_BRACKET_VIEW_STORAGE_KEY,
  tournamentBracketPresentations,
  type TournamentBracketViewStorage,
} from "./tournament-bracket-presentations";
import type { JsonObject } from "./types";

function inputForPlan(
  plan: JsonObject,
  pool: "upper" | "lower" = "upper",
): TournamentBracketInput {
  return { plan, pool, teamNames: new Map() };
}

function fixturePlan(fixture: unknown): JsonObject {
  return structuredClone((fixture as { tournament_plan: JsonObject }).tournament_plan);
}

function lowerEightPlan(): JsonObject {
  const plan = fixturePlan(upperEightJson);
  const upper = structuredClone(plan.upper) as JsonObject;
  const emptyLower = structuredClone(plan.lower) as JsonObject;
  upper.pool = "lower";
  plan.lower = upper;
  plan.upper = emptyLower;
  return plan;
}

function legacyPermutedPlan(): JsonObject {
  const plan = fixturePlan(upperSixteenJson);
  const upper = plan.upper as JsonObject;
  const matches = upper.matches as JsonObject[];
  const loserMatch = matches.find((match) => {
    const range = match.rank_range as number[];
    return range[0] === 9 && range[1] === 16;
  })!;
  [loserMatch.home, loserMatch.away] = [loserMatch.away, loserMatch.home];
  const layout = upper.logical_layout as JsonObject;
  const root = (layout.branch_alignments as JsonObject[]).find((alignment) => {
    const range = alignment.rank_range as number[];
    return range[0] === 1 && range[1] === 16;
  })!;
  const loserOrder = [...(root.winner_source_order as string[])];
  [loserOrder[0], loserOrder[1]] = [loserOrder[1]!, loserOrder[0]!];
  root.status = "permuted";
  root.loser_source_order = loserOrder;
  root.loser_to_winner_permutation = [2, 1, 3, 4, 5, 6, 7, 8];
  root.diagnostic_code = "OUTCOME_BRANCH_ORDER_DIFFERS";
  layout.symmetry = "permuted";
  return plan;
}

describe("本番トーナメント表presentation", () => {
  it("mirroredな8・16チームだけ水平版を既定にする", () => {
    expect(defaultTournamentBracketPresentation(inputForPlan(fixturePlan(upperEightJson))).id)
      .toBe("horizontal");
    expect(defaultTournamentBracketPresentation(inputForPlan(fixturePlan(upperSixteenJson))).id)
      .toBe("horizontal");

    for (const participantCount of [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 17, 24, 31, 32]) {
      const plan = {
        participant_resolution: "resolved",
        upper: { participant_count: participantCount, logical_layout: null },
      } satisfies JsonObject;
      expect(defaultTournamentBracketPresentation(inputForPlan(plan)).id).toBe("standard");
    }
  });

  it("旧形式・permuted・上下で異なる参加数をプールごとに判定する", () => {
    const missing = fixturePlan(upperEightJson);
    delete (missing.upper as JsonObject).logical_layout;
    expect(defaultTournamentBracketPresentation(inputForPlan(missing)).id).toBe("standard");

    expect(defaultTournamentBracketPresentation(inputForPlan(legacyPermutedPlan())).id)
      .toBe("standard");

    const mixed = fixturePlan(upperEightJson);
    mixed.lower = {
      pool: "lower",
      participant_count: 7,
      matches: [],
      seeds: [],
      byes: [],
      placements: [],
      logical_layout: null,
    };
    expect(defaultTournamentBracketPresentation(inputForPlan(mixed, "upper")).id)
      .toBe("horizontal");
    expect(defaultTournamentBracketPresentation(inputForPlan(mixed, "lower")).id)
      .toBe("standard");
  });

  it("mirroredな8・16チームで端末の水平・垂直選択を使う", () => {
    for (const plan of [fixturePlan(upperEightJson), fixturePlan(upperSixteenJson)]) {
      expect(selectTournamentBracketPresentation(inputForPlan(plan), "horizontal"))
        .toEqual({ presentation: tournamentBracketPresentations.horizontal });
      expect(selectTournamentBracketPresentation(inputForPlan(plan), "vertical"))
        .toEqual({ presentation: tournamentBracketPresentations.vertical });
    }

    const provisional = fixturePlan(upperEightJson);
    provisional.participant_resolution = "provisional";
    expect(selectTournamentBracketPresentation(inputForPlan(provisional), "vertical"))
      .toEqual({ presentation: tournamentBracketPresentations.vertical });
  });

  it("非対応形状を理由付きで標準版へフォールバックする", () => {
    const unsupportedCount = fixturePlan(upperEightJson);
    (unsupportedCount.upper as JsonObject).participant_count = 7;
    (unsupportedCount.upper as JsonObject).logical_layout = null;
    expect(selectTournamentBracketPresentation(inputForPlan(unsupportedCount), "vertical"))
      .toMatchObject({
        presentation: tournamentBracketPresentations.standard,
        fallbackReason: expect.stringContaining("参加数"),
      });

    const missingLayout = fixturePlan(upperEightJson);
    delete (missingLayout.upper as JsonObject).logical_layout;
    expect(selectTournamentBracketPresentation(inputForPlan(missingLayout), "horizontal"))
      .toMatchObject({
        presentation: tournamentBracketPresentations.standard,
        fallbackReason: expect.stringContaining("配置情報"),
      });

    expect(selectTournamentBracketPresentation(inputForPlan(legacyPermutedPlan()), "vertical"))
      .toMatchObject({
        presentation: tournamentBracketPresentations.standard,
        fallbackReason: expect.stringContaining("対応形状"),
      });
  });

  it("不正なlogical_layoutを標準版へ黙ってフォールバックしない", () => {
    const invalid = fixturePlan(upperEightJson);
    ((invalid.upper as JsonObject).logical_layout as JsonObject).symmetry = "invalid";
    expect(() => defaultTournamentBracketPresentation(inputForPlan(invalid))).toThrow();

    const invalidSeven = fixturePlan(upperEightJson);
    (invalidSeven.upper as JsonObject).participant_count = 7;
    expect(() => defaultTournamentBracketPresentation(inputForPlan(invalidSeven))).toThrow();
  });

  it("水平版でも標準モデルの意味情報を保持する", () => {
    const plan = fixturePlan(upperEightJson);
    const model = buildTournamentBracketModel(
      inputForPlan(plan),
      tournamentBracketPresentations.horizontal.layout,
    );
    expect(isTournamentBracketExplorationModel(model)).toBe(true);
    expect(model.nodes).toHaveLength(12);
    expect(model.edges.length).toBeGreaterThan(0);
    expect(model.references.length).toBeGreaterThan(0);
  });

  it("下位トーナメントでもプール内の特別試合名を使う", () => {
    const model = buildTournamentBracketModel(
      inputForPlan(lowerEightPlan(), "lower"),
      tournamentBracketPresentations.horizontal.layout,
    );
    expect(model.nodes.filter((node) => node.roundLabel === "決勝")).toHaveLength(1);
    expect(model.nodes.filter((node) => node.roundLabel === "3位決定戦")).toHaveLength(1);
    expect(model.nodes.filter((node) => node.roundLabel === "準決勝")).toHaveLength(2);
    expect(model.nodes.some((node) => /9位決定戦/u.test(node.roundLabel))).toBe(false);
  });

  it("水平版の図中では時間帯でなく開始時刻を使う", () => {
    const plan = fixturePlan(upperEightJson);
    const matchId = String(((plan.upper as JsonObject).matches as JsonObject[])[0]!.id);
    const input = {
      ...inputForPlan(plan),
      scheduleByMatchId: new Map([[matchId, {
        displayNumber: "A①",
        startTime: "09:30",
        timeLabel: "09:30〜10:05",
        courtName: "Aコート",
      }]]),
    } satisfies TournamentBracketInput;
    const model = buildTournamentBracketModel(
      input,
      tournamentBracketPresentations.horizontal.layout,
    );
    expect(isTournamentBracketExplorationModel(model)).toBe(true);
    if (!isTournamentBracketExplorationModel(model)) return;
    const label = model.explorationGeometry.matchLabels.find(
      (candidate) => candidate.matchId === matchId,
    );
    expect(label?.text).toContain("A①　09:30");
    expect(label?.text).not.toContain("10:05");
  });

  it("水平版は結果・PK・勝者・決定順位を図中で増やさずアクセシブル説明へ残す", () => {
    const fixture = upperEightJson as {
      teams: Array<{ id: string; name: string }>;
      tournament_plan: JsonObject;
    };
    const plan = fixturePlan(fixture);
    const pool = plan.upper as JsonObject;
    const seeds = pool.seeds as JsonObject[];
    const seedTeam = new Map(seeds.map((seed) => [
      `${String(seed.block_id)}:${String(seed.block_rank)}`,
      String(seed.team_id),
    ]));
    const openingMatch = (pool.matches as JsonObject[]).find((match) =>
      JSON.stringify(match.rank_range) === "[1,8]"
    )!;
    const teamFor = (entry: unknown): string => {
      const rank = entry as JsonObject;
      return seedTeam.get(`${String(rank.block_id)}:${String(rank.rank)}`)!;
    };
    const homeTeamId = teamFor(openingMatch.home);
    const awayTeamId = teamFor(openingMatch.away);
    const model = buildTournamentBracketModel({
      plan,
      pool: "upper",
      teamNames: new Map(fixture.teams.map((team) => [team.id, team.name])),
      results: [{
        match_id: openingMatch.id,
        home_team_id: homeTeamId,
        away_team_id: awayTeamId,
        regular_score_home: 1,
        regular_score_away: 1,
        penalty_score_home: 4,
        penalty_score_away: 3,
      }],
    }, tournamentBracketPresentations.horizontal.layout);
    const rendered = renderTournamentBracketExploration(model, "上位トーナメント表");
    const resultGroup = rendered.querySelector(
      `.bracket-exploration-match[data-match-id="${String(openingMatch.id)}"]`,
    );
    expect(resultGroup?.getAttribute("aria-label")).toContain("1 - 1（PK 4-3）");
    expect(resultGroup?.getAttribute("aria-label")).toContain(`勝者 ${fixture.teams.find(
      (team) => team.id === homeTeamId,
    )!.name}`);
    const finalMatch = (pool.matches as JsonObject[]).find((match) =>
      JSON.stringify(match.rank_range) === "[1,2]"
    )!;
    expect(rendered.querySelector(
      `.bracket-exploration-match[data-match-id="${String(finalMatch.id)}"]`,
    )?.getAttribute("aria-label")).toContain("1位");
    const visibleLabels = [...rendered.querySelectorAll(".bracket-exploration-match-label")]
      .map((label) => label.textContent).join(" ");
    expect(visibleLabels).not.toContain("PK");
    expect(visibleLabels).not.toContain("勝者");
    expect(visibleLabels).not.toContain("1位確定");
  });
});

describe("トーナメント表表示設定の端末保存", () => {
  it("水平版を既定にし、選択を大会データと別のキーへ保存する", () => {
    const values = new Map<string, string>();
    const storage: TournamentBracketViewStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    };

    expect(loadTournamentBracketViewMode(storage)).toBe("horizontal");
    expect(saveTournamentBracketViewMode("vertical", storage)).toBe(true);
    expect(values).toEqual(new Map([[TOURNAMENT_BRACKET_VIEW_STORAGE_KEY, "vertical"]]));
    expect(loadTournamentBracketViewMode(storage)).toBe("vertical");
    values.set(TOURNAMENT_BRACKET_VIEW_STORAGE_KEY, "invalid");
    expect(loadTournamentBracketViewMode(storage)).toBe("horizontal");
  });

  it("storageの読書き例外を画面操作へ伝播させない", () => {
    const failingStorage: TournamentBracketViewStorage = {
      getItem: () => {
        throw new DOMException("blocked");
      },
      setItem: () => {
        throw new DOMException("blocked");
      },
    };

    expect(loadTournamentBracketViewMode(failingStorage)).toBe("horizontal");
    expect(saveTournamentBracketViewMode("vertical", failingStorage)).toBe(false);
  });
});
