import { describe, expect, it } from "vitest";

import { scheduleViewTournamentPlanResult } from "../e2e/fixtures";
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
  pool = "upper",
): TournamentBracketInput {
  return { plan, pool, teamNames: new Map() };
}

function fixturePlan(fixture: unknown): JsonObject {
  return structuredClone((fixture as { tournament_plan: JsonObject }).tournament_plan);
}

function mirroredFourTeamPlan(): JsonObject {
  const plan = structuredClone(scheduleViewTournamentPlanResult) as JsonObject;
  plan.participant_resolution = "resolved";
  for (const [poolIndex, pool] of (plan.pools as JsonObject[]).entries()) {
    for (const [seedIndex, seed] of (pool.seeds as JsonObject[]).entries()) {
      const teamId = `four-${String(poolIndex + 1)}-${String(seedIndex + 1)}`;
      seed.team_id = teamId;
      seed.team = { type: "concrete_team", team_id: teamId };
    }
    const matches = pool.matches as JsonObject[];
    const openingMatches = matches.filter((match) => Number(match.round_no) === 1);
    const openingRange = openingMatches[0]!.rank_range as number[];
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
        rank_range: openingRange,
        status: "mirrored",
        winner_source_order: openingMatches.map((match) => match.id),
        loser_source_order: openingMatches.map((match) => match.id),
        loser_to_winner_permutation: [1, 2],
        diagnostic_code: null,
      }],
    };
  }
  return plan;
}

function fourTeamInput(): TournamentBracketInput {
  const plan = mirroredFourTeamPlan();
  const pool = (plan.pools as JsonObject[])[0]!;
  const seeds = pool.seeds as JsonObject[];
  const teamNames = new Map(seeds.map((seed, index) => [
    String(seed.team_id),
    [
      "北関東ジュニアフットボールクラブ",
      "海浜ユナイテッドジュニア",
      "みどりヶ丘サッカースポーツ少年団",
      "中央キッカーズアカデミー",
    ][index]!,
  ]));
  const matches = pool.matches as JsonObject[];
  const teamByBlock = new Map(seeds.map((seed) => [String(seed.block_id), String(seed.team_id)]));
  const team = (blockId: string): string => teamByBlock.get(blockId)!;
  return {
    plan,
    pool: "placement-1",
    teamNames,
    scheduleByMatchId: new Map(matches.map((match, index) => [
      String(match.id),
      {
        displayNumber: `${["A", "B", "C", "A"][index]}①`,
        startTime: ["09:30", "09:30", "11:45", "11:00"][index]!,
        timeLabel: ["09:30〜10:05", "09:30〜10:05", "11:45〜12:20", "11:00〜11:35"][index]!,
        courtName: `${["A", "B", "C", "A"][index]}コート`,
      },
    ])),
    results: [
      {
        match_id: "PT-1-SF1",
        home_team_id: team("A"),
        away_team_id: team("D"),
        regular_score_home: 2,
        regular_score_away: 1,
      },
      {
        match_id: "PT-1-SF2",
        home_team_id: team("B"),
        away_team_id: team("C"),
        regular_score_home: 1,
        regular_score_away: 1,
        penalty_score_home: 3,
        penalty_score_away: 4,
      },
      {
        match_id: "PT-1-FINAL",
        home_team_id: team("A"),
        away_team_id: team("C"),
        regular_score_home: 1,
        regular_score_away: 0,
      },
      {
        match_id: "PT-1-PLACE3",
        home_team_id: team("D"),
        away_team_id: team("B"),
        regular_score_home: 1,
        regular_score_away: 1,
        penalty_score_home: 4,
        penalty_score_away: 3,
      },
    ],
  };
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
  it("mirroredな4・8・16チームだけ水平版を既定にする", () => {
    expect(defaultTournamentBracketPresentation(inputForPlan(mirroredFourTeamPlan(), "placement-1")).id)
      .toBe("horizontal");
    expect(defaultTournamentBracketPresentation(inputForPlan(fixturePlan(upperEightJson))).id)
      .toBe("horizontal");
    expect(defaultTournamentBracketPresentation(inputForPlan(fixturePlan(upperSixteenJson))).id)
      .toBe("horizontal");

    for (const participantCount of [0, 1, 2, 3, 5, 6, 7, 9, 10, 17, 24, 31, 32]) {
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

  it("mirroredな4・8・16チームで端末の水平・垂直選択を使う", () => {
    for (const [plan, pool] of [
      [mirroredFourTeamPlan(), "placement-1"],
      [fixturePlan(upperEightJson), "upper"],
      [fixturePlan(upperSixteenJson), "upper"],
    ] as const) {
      expect(selectTournamentBracketPresentation(inputForPlan(plan, pool), "horizontal"))
        .toEqual({ presentation: tournamentBracketPresentations.horizontal });
      expect(selectTournamentBracketPresentation(inputForPlan(plan, pool), "vertical"))
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

  it("添付事例相当の4チーム表を水平・垂直とも余白内へ配置する", () => {
    type Bounds = { left: number; right: number; top: number; bottom: number };
    const intersects = (left: Bounds, right: Bounds): boolean =>
      left.left < right.right && left.right > right.left &&
      left.top < right.bottom && left.bottom > right.top;
    const approximateWidth = (lines: readonly string[]): number =>
      Math.max(...lines.map((line) => [...line].reduce(
        (width, character) => width + (/^[\x20-\x7e]$/u.test(character) ? 7 : 13),
        0,
      )));

    for (const mode of ["horizontal", "vertical"] as const) {
      const input = fourTeamInput();
      const model = buildTournamentBracketModel(
        input,
        tournamentBracketPresentations[mode].layout,
      );
      expect(isTournamentBracketExplorationModel(model)).toBe(true);
      if (!isTournamentBracketExplorationModel(model)) continue;
      const geometry = model.explorationGeometry;
      const point = (value: { x: number; y: number }) => mode === "horizontal"
        ? { x: geometry.height - value.y, y: value.x }
        : value;
      const fixedBounds: Bounds[] = [
        ...geometry.segments.map((segment) => {
          const start = point(segment.start);
          const end = point(segment.end);
          return {
            left: Math.min(start.x, end.x) - 3,
            right: Math.max(start.x, end.x) + 3,
            top: Math.min(start.y, end.y) - 3,
            bottom: Math.max(start.y, end.y) + 3,
          };
        }),
        ...geometry.slots.map((slot) => {
          const center = point(slot.center);
          return {
            left: center.x - slot.width / 2 - 3,
            right: center.x + slot.width / 2 + 3,
            top: center.y - slot.height / 2 - 3,
            bottom: center.y + slot.height / 2 + 3,
          };
        }),
      ];
      const labelBounds = geometry.matchLabels.map((label) => {
        const center = point(label.center);
        const halfWidth = approximateWidth(label.lines) / 2 + 3;
        const halfHeight = (label.lines.length > 1 ? 38 : 22) / 2;
        return {
          left: center.x - halfWidth,
          right: center.x + halfWidth,
          top: center.y - halfHeight,
          bottom: center.y + halfHeight,
        };
      });

      expect(geometry.slots).toHaveLength(4);
      expect(geometry.slots.every((slot) => slot.width === 124 && slot.height === 64)).toBe(true);
      expect(geometry.slots.every((slot) => slot.label.endsWith("…"))).toBe(true);
      expect(geometry.slots.every((slot) => slot.fullLabel.length > slot.label.length)).toBe(true);
      expect(geometry.matchLabels).toHaveLength(4);
      const conflicts = labelBounds.flatMap((bounds, index) => [
        ...(fixedBounds.findIndex((fixed) => intersects(bounds, fixed)) >= 0
          ? (() => {
            const fixedIndex = fixedBounds.findIndex((fixed) => intersects(bounds, fixed));
            return [`${mode}:label-${String(index + 1)}:fixed-${String(fixedIndex)}:${JSON.stringify(bounds)}:${JSON.stringify(fixedBounds[fixedIndex])}`];
          })()
          : []),
        ...(labelBounds.slice(index + 1).some((other) => intersects(bounds, other))
          ? [`${mode}:label-${String(index + 1)}:label`]
          : []),
      ]);
      expect(conflicts).toEqual([]);

      const rendered = renderTournamentBracketExploration(model, "第1順位決定トーナメント表");
      expect(rendered.dataset.participantCount).toBe("4");
      expect(rendered.querySelector('[data-match-id="PT-1-SF2"]')?.getAttribute("aria-label"))
        .toContain("PK 3-4");
      expect(rendered.querySelector('[data-match-id="PT-1-FINAL"]')?.getAttribute("aria-label"))
        .toContain("11:45〜12:20 Cコート");
      expect(rendered.querySelector(".bracket-exploration-slot")?.getAttribute("aria-label"))
        .toContain("北関東ジュニアフットボールクラブ");
    }
  });

  it("4チームの標準版fallbackでも試合情報と参加枠の間隔を確保する", () => {
    const input = fourTeamInput();
    const plan = structuredClone(input.plan);
    delete ((plan.pools as JsonObject[])[0] as JsonObject).logical_layout;
    const fallbackInput = { ...input, plan };
    const selection = selectTournamentBracketPresentation(fallbackInput, "horizontal");
    expect(selection.presentation.id).toBe("standard");
    const model = buildTournamentBracketModel(fallbackInput, selection.presentation.layout);
    const sheet = model.sheets[0]!;
    const openingLineY = Math.max(
      ...sheet.nodes.filter((node) => node.roundNo === 1).map((node) => node.lineY),
    );
    expect(Math.min(...sheet.slots.map((slot) => slot.y)) - openingLineY).toBeGreaterThanOrEqual(48);
    const rendered = selection.presentation.render(model, "第1順位決定トーナメント表");
    expect(rendered.querySelectorAll(".bracket-match-node")).toHaveLength(4);
    expect(rendered.querySelectorAll(".bracket-entry-slot")).toHaveLength(4);
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
