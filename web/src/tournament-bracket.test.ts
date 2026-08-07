import { describe, expect, it } from "vitest";

import {
  buildTournamentBracketModel,
  renderTournamentBracket,
  TournamentBracketError,
} from "./tournament-bracket";
import type { JsonObject } from "./types";

type GeneratedPool = {
  pool: string;
  participant_count: number;
  seeds: JsonObject[];
  matches: JsonObject[];
  byes: JsonObject[];
  placements: JsonObject[];
  evaluation: JsonObject;
};

const rankEntry = (rank: number): JsonObject => ({
  type: "league_rank",
  block_id: `B${String(rank)}`,
  rank: 1,
});
const winner = (matchId: string): JsonObject => ({ type: "winner_of", match_id: matchId });
const loser = (matchId: string): JsonObject => ({ type: "loser_of", match_id: matchId });

function key(entry: JsonObject): string {
  if (entry.type === "league_rank") {
    return `R:${String(entry.block_id)}:${String(entry.rank)}`;
  }
  return `${String(entry.type)}:${String(entry.match_id)}`;
}

function generatedPool(participantCount: number): GeneratedPool {
  let serial = 0;
  const matches: JsonObject[] = [];
  const placements: JsonObject[] = [];
  const pendingByes: JsonObject[] = [];
  const nextId = (): string => `UT-M${String(++serial)}`;
  const play = (
    entries: JsonObject[],
    rankStart: number,
    roundNo: number,
    label: string,
  ): [JsonObject[], JsonObject[]] => {
    const half = entries.length / 2;
    const winners: JsonObject[] = [];
    const losers: JsonObject[] = [];
    for (let index = 0; index < half; index += 1) {
      const id = nextId();
      matches.push({
        id,
        phase: "upper_tournament",
        round: label,
        round_no: roundNo,
        home: entries[index],
        away: entries[index + half],
        rank_range: [rankStart, rankStart + entries.length - 1],
      });
      winners.push(winner(id));
      losers.push(loser(id));
    }
    return [winners, losers];
  };
  const build = (entries: JsonObject[], rankStart: number, roundNo: number): void => {
    if (entries.length === 0) return;
    if (entries.length === 1) {
      placements.push({ rank: rankStart, entry: entries[0] });
      return;
    }
    const powerOfTwo = (entries.length & (entries.length - 1)) === 0;
    if (!powerOfTwo) {
      const mainSize = 2 ** Math.floor(Math.log2(entries.length));
      const preliminaryCount = entries.length - mainSize;
      const byeCount = entries.length - preliminaryCount * 2;
      const byeEntries = entries.slice(0, byeCount);
      pendingByes.push(...byeEntries);
      const [preliminaryWinners, preliminaryLosers] = play(
        entries.slice(byeCount),
        rankStart,
        roundNo,
        "予備戦",
      );
      build([...byeEntries, ...preliminaryWinners], rankStart, roundNo + 1);
      build(preliminaryLosers, rankStart + mainSize, roundNo + 1);
      return;
    }
    const [winners, losers] = play(entries, rankStart, roundNo, "順位決定");
    build(winners, rankStart, roundNo + 1);
    build(losers, rankStart + entries.length / 2, roundNo + 1);
  };

  const entries = Array.from({ length: participantCount }, (_value, index) => rankEntry(index + 1));
  build(entries, 1, 1);
  const byes = pendingByes.map((entry) => {
    const entryKey = key(entry);
    const target = matches.find(
      (match) =>
        key(match.home as JsonObject) === entryKey || key(match.away as JsonObject) === entryKey,
    );
    if (target === undefined) throw new Error("test fixture bye target missing");
    return { entry, result: "advance_by_bye", next_match_id: target.id };
  });
  return {
    pool: "upper",
    participant_count: participantCount,
    seeds: entries.map((entry, index) => ({
      seed_no: index + 1,
      team_id: `team-${String(index + 1)}`,
      block_id: entry.block_id,
      block_rank: 1,
      entry,
      team: { type: "concrete_team", team_id: `team-${String(index + 1)}` },
    })),
    matches,
    byes,
    placements,
    evaluation: {
      first_match_same_block_count: 0,
      possible_same_block_match_count: 0,
      earliest_possible_same_block_round: null,
    },
  };
}

function planFor(participantCount: number, provisional = false): JsonObject {
  return {
    schema_version: "0.1.0",
    status: "COMPLETE",
    participant_resolution: provisional ? "provisional" : "resolved",
    odd_split_policy: "upper",
    random_seed: 20260803,
    upper: generatedPool(participantCount),
    lower: generatedPool(0),
    seed_draws: [],
    warnings: [],
  };
}

function expectedMatchCount(participantCount: number): number {
  if (participantCount <= 1) return 0;
  const mainSize = 2 ** Math.floor(Math.log2(participantCount));
  if (mainSize === participantCount) {
    return participantCount / 2 + 2 * expectedMatchCount(participantCount / 2);
  }
  const preliminaryCount = participantCount - mainSize;
  return preliminaryCount + expectedMatchCount(mainSize) + expectedMatchCount(preliminaryCount);
}

function referenceCount(pool: GeneratedPool): number {
  return pool.matches.reduce((count, match) => {
    return count + [match.home, match.away].filter((entry) => {
      const value = entry as JsonObject;
      return value.type === "winner_of" || value.type === "loser_of";
    }).length;
  }, 0);
}

describe("トーナメントブラケットモデル", () => {
  for (const participantCount of [0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 16, 32]) {
    it(`${String(participantCount)}チームの全試合・進行線・順位を一意に配置する`, () => {
      const plan = planFor(participantCount, true);
      const pool = plan.upper as unknown as GeneratedPool;
      const model = buildTournamentBracketModel({
        plan,
        pool: "upper",
        teamNames: new Map(),
      });
      expect(model.nodes).toHaveLength(expectedMatchCount(participantCount));
      expect(model.edges).toHaveLength(referenceCount(pool));
      expect(
        model.nodes.flatMap((node) => node.terminals).length + model.directPlacements.length,
      ).toBe(participantCount);
      expect(new Set(model.nodes.map((node) => node.id)).size).toBe(model.nodes.length);
      expect(model.width).toBeGreaterThan(0);
      expect(model.height).toBeGreaterThan(0);
      if (participantCount === 0) expect(model.emptyMessage).toBe("該当チームなし");
      if (participantCount === 1) {
        expect(model.directPlacements[0]).toMatchObject({ rank: 1, confirmed: false });
        expect(renderTournamentBracket(model, "進行図").textContent).toContain("1位・未確定");
      }
      for (const layer of model.layers) {
        const nodes = layer.matchIds.map((id) => model.nodes.find((node) => node.id === id)!);
        for (const [index, node] of nodes.entries()) {
          for (const other of nodes.slice(index + 1)) {
            expect(node.y + node.height <= other.y || other.y + other.height <= node.y).toBe(true);
          }
        }
      }
      if ([3, 5, 6, 7, 9, 10].includes(participantCount)) {
        expect(pool.byes.length).toBeGreaterThan(0);
        expect(model.nodes.some((node) => node.home.bye || node.away.bye)).toBe(true);
        expect(renderTournamentBracket(model, "進行図").textContent).toContain("予備戦免除");
      }
      if (participantCount > 16) expect(model.compact).toBe(true);
    });
  }

  it("同じ入力から同じ層順と座標を再現する", () => {
    const input = { plan: planFor(10, true), pool: "upper" as const, teamNames: new Map() };
    expect(buildTournamentBracketModel(input)).toEqual(buildTournamentBracketModel(input));
  });

  it("仮表ではシードにチームIDが残っていても順位枠だけを表示する", () => {
    const plan = planFor(2, true);
    const model = buildTournamentBracketModel({
      plan,
      pool: "upper",
      teamNames: new Map([["team-1", "青空FC"]]),
    });
    expect(model.nodes[0]!.home.primaryLabel).toContain("ブロック");
    expect(model.nodes[0]!.home.primaryLabel).not.toContain("青空FC");
  });

  it("下位1チームの総合順位枠を図の表示範囲内へ配置する", () => {
    const plan = planFor(31, true);
    plan.lower = generatedPool(1);
    const model = buildTournamentBracketModel({
      plan,
      pool: "lower",
      teamNames: new Map(),
    });
    expect(model.directPlacements[0]?.rank).toBe(32);
    const figure = renderTournamentBracket(model, "下位進行図");
    const rect = figure.querySelector(".bracket-direct-placement rect");
    expect(Number(rect?.getAttribute("y"))).toBeLessThan(model.height);
    expect(figure.textContent).toContain("32位・未確定");
  });

  it("通常得点・PK・勝者・時刻・コートを試合枠へ反映する", () => {
    const plan = planFor(2);
    const first = (plan.upper as unknown as GeneratedPool).matches[0]!;
    const matchId = String(first.id);
    const model = buildTournamentBracketModel({
      plan,
      pool: "upper",
      teamNames: new Map([
        ["team-1", "青空FC"],
        ["team-2", "赤松FC"],
      ]),
      scheduleByMatchId: new Map([
        [matchId, { displayNumber: "A①", timeLabel: "09:30〜10:05", courtName: "Aコート" }],
      ]),
      results: [
        {
          match_id: matchId,
          home_team_id: "team-1",
          away_team_id: "team-2",
          regular_score_home: 1,
          regular_score_away: 1,
          penalty_score_home: 4,
          penalty_score_away: 3,
        },
      ],
    });
    expect(model.nodes[0]).toMatchObject({
      displayNumber: "A①",
      metaLabel: "09:30〜10:05 Aコート",
      home: { primaryLabel: "青空FC", scoreLabel: "1 (PK 4)", winner: true },
      away: { primaryLabel: "赤松FC", scoreLabel: "1 (PK 3)", winner: false },
    });
    expect(model.nodes[0]!.terminals.map((terminal) => terminal.label)).toEqual([
      "勝→1位・未確定",
      "敗→2位・未確定",
    ]);
  });

  it("サーバー確定後だけ順位を確定表示する", () => {
    const plan = planFor(2);
    const match = (plan.upper as unknown as GeneratedPool).matches[0]!;
    const matchId = String(match.id);
    const results = [{
      match_id: matchId,
      home_team_id: "team-1",
      away_team_id: "team-2",
      regular_score_home: 2,
      regular_score_away: 0,
    }];
    const model = buildTournamentBracketModel({
      plan,
      pool: "upper",
      teamNames: new Map([["team-1", "青空FC"], ["team-2", "赤松FC"]]),
      results,
      finalStandings: {
        standings: [
          { pool: "upper", pool_rank: 1, team_id: "team-1" },
          { pool: "upper", pool_rank: 2, team_id: "team-2" },
        ],
      },
    });
    expect(model.nodes[0]!.terminals.every((terminal) => terminal.confirmed)).toBe(true);
    expect(model.nodes[0]!.terminals.map((terminal) => terminal.label)).toEqual([
      "勝→1位確定",
      "敗→2位確定",
    ]);
  });

  it("長い名称を図では省略しつつ完全な文字をtitleと表向けモデルへ残す", () => {
    const plan = planFor(2);
    const longName = "とても長い地域サッカークラブ名称ジュニアユースチーム";
    const model = buildTournamentBracketModel({
      plan,
      pool: "upper",
      teamNames: new Map([["team-1", longName], ["team-2", "対戦相手"]]),
    });
    const figure = renderTournamentBracket(model, "上位トーナメントの進行図");
    expect(model.nodes[0]!.home.fullLabel).toContain(longName);
    expect(figure.querySelector(".bracket-team-name")?.textContent).toContain("…");
    expect(figure.querySelector(".bracket-team-name title")?.textContent).toContain(longName);
    expect(figure.querySelector("svg")?.getAttribute("aria-labelledby")).toContain(
      "tournament-bracket-upper-title",
    );
  });

  it("未知参照・重複ID・循環相当の前後関係を拒否する", () => {
    const unknown = planFor(2, true);
    const unknownPool = unknown.upper as unknown as GeneratedPool;
    unknownPool.matches[0]!.home = winner("UNKNOWN");
    expect(() => buildTournamentBracketModel({ plan: unknown, pool: "upper", teamNames: new Map() }))
      .toThrow(TournamentBracketError);

    const duplicate = planFor(4, true);
    const duplicatePool = duplicate.upper as unknown as GeneratedPool;
    duplicatePool.matches[1]!.id = duplicatePool.matches[0]!.id;
    expect(() => buildTournamentBracketModel({ plan: duplicate, pool: "upper", teamNames: new Map() }))
      .toThrow(/重複/);

    const cyclic = planFor(2, true);
    const cyclicPool = cyclic.upper as unknown as GeneratedPool;
    const matchId = String(cyclicPool.matches[0]!.id);
    cyclicPool.matches[0]!.home = winner(matchId);
    expect(() => buildTournamentBracketModel({ plan: cyclic, pool: "upper", teamNames: new Map() }))
      .toThrow(/循環/);
  });
});
