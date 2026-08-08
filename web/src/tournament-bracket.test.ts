import { describe, expect, it } from "vitest";

import {
  buildTournamentBracketModel,
  renderTournamentBracket,
  TournamentBracketError,
  type TournamentBracketBox,
  type TournamentBracketSegment,
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
    rankEnd = rankStart + entries.length - 1,
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
        rank_range: [rankStart, rankEnd],
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
        rankStart + entries.length - 1,
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

function overlap(left: TournamentBracketBox, right: TournamentBracketBox): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x &&
    left.y < right.y + right.height && left.y + left.height > right.y;
}

function properIntersection(left: TournamentBracketSegment, right: TournamentBracketSegment): boolean {
  if (left.ownerId === right.ownerId) return false;
  const leftHorizontal = left.y1 === left.y2;
  const rightHorizontal = right.y1 === right.y2;
  if (leftHorizontal === rightHorizontal) return false;
  const horizontal = leftHorizontal ? left : right;
  const vertical = leftHorizontal ? right : left;
  const horizontalMin = Math.min(horizontal.x1, horizontal.x2);
  const horizontalMax = Math.max(horizontal.x1, horizontal.x2);
  const verticalMin = Math.min(vertical.y1, vertical.y2);
  const verticalMax = Math.max(vertical.y1, vertical.y2);
  return horizontalMin < vertical.x1 && vertical.x1 < horizontalMax &&
    verticalMin < horizontal.y1 && horizontal.y1 < verticalMax;
}

describe("標準トーナメントブラケットモデル", () => {
  for (const participantCount of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 16, 17, 24, 31, 32]) {
    it(`${String(participantCount)}チームを一意な試合・順位帯ページへ配置する`, () => {
      const plan = planFor(participantCount, true);
      const pool = plan.upper as unknown as GeneratedPool;
      const model = buildTournamentBracketModel({ plan, pool: "upper", teamNames: new Map() });
      expect(model.nodes).toHaveLength(expectedMatchCount(participantCount));
      expect(model.references).toHaveLength(referenceCount(pool));
      expect(new Set(model.nodes.map((node) => node.id)).size).toBe(model.nodes.length);
      expect(model.edges).toHaveLength(referenceCount(pool));
      if (participantCount === 0) {
        expect(model.emptyMessage).toBe("該当チームなし");
        expect(model.sheets).toHaveLength(0);
        return;
      }
      if (participantCount <= 16) expect(model.sheets).toHaveLength(1);
      if (participantCount > 16) {
        expect(model.sheets.filter((sheet) => sheet.kind === "opening_overview").length)
          .toBeGreaterThanOrEqual(2);
        expect(model.sheets.some((sheet) => sheet.kind === "rank_band")).toBe(true);
      }
      expect(model.sheets.every((sheet) => sheet.slots.length <= 16)).toBe(true);
      expect(model.references.every((reference) =>
        reference.continuation === (reference.sourceSheetId !== reference.targetSheetId)
      )).toBe(true);
      expect(model.nodes.every((node) => node.labelBox.x >= 0 && node.labelBox.y >= 0)).toBe(true);
      for (const sheet of model.sheets) {
        for (const [index, slot] of sheet.slots.entries()) {
          expect(sheet.slots.slice(index + 1).some((other) => overlap(slot, other))).toBe(false);
        }
        for (const [index, node] of sheet.nodes.entries()) {
          expect(sheet.nodes.slice(index + 1).some((other) => overlap(node.labelBox, other.labelBox)))
            .toBe(false);
        }
        expect(sheet.segments.every((segment) => segment.x1 === segment.x2 || segment.y1 === segment.y2))
          .toBe(true);
        for (const [index, segment] of sheet.segments.entries()) {
          const crossing = sheet.segments.slice(index + 1).find((other) =>
            properIntersection(segment, other)
          );
          if (crossing !== undefined) {
            throw new Error(
              `進行線交差 ${sheet.id}: ${JSON.stringify(segment)} / ${JSON.stringify(crossing)} / ${JSON.stringify(sheet.nodes.filter((node) => segment.ownerId.includes(node.id) || crossing.ownerId.includes(node.id)).map((node) => ({ id: node.id, range: node.rankRangeLabel, x: node.centerX, y: node.lineY })))}`,
            );
          }
        }
      }
      const rendered = renderTournamentBracket(model, "進行図");
      expect(rendered.querySelectorAll(".bracket-match-node")).toHaveLength(model.nodes.length);
      expect([...rendered.querySelectorAll("path")].every((path) =>
        !/[CQ]/.test(path.getAttribute("d") ?? "")
      )).toBe(true);
      if (participantCount === 1) expect(rendered.textContent).toContain("1位・未確定");
      if (pool.byes.length > 0) expect(rendered.textContent).toContain("予備戦免除");
    });
  }

  it("同じ入力から同じページ・座標・直交線を再現する", () => {
    const input = { plan: planFor(10, true), pool: "upper" as const, teamNames: new Map() };
    expect(buildTournamentBracketModel(input)).toEqual(buildTournamentBracketModel(input));
  });

  it("プール内順位から決勝・3位決定戦・準決勝を共通判定する", () => {
    const model = buildTournamentBracketModel({
      plan: planFor(4),
      pool: "upper",
      teamNames: new Map(),
    });
    expect(model.nodes.filter((node) => node.roundLabel === "決勝")).toHaveLength(1);
    expect(model.nodes.filter((node) => node.roundLabel === "3位決定戦")).toHaveLength(1);
    expect(model.nodes.filter((node) => node.roundLabel === "準決勝")).toHaveLength(2);
  });

  it("仮表では順位枠だけ、確定後はチーム名と由来を表示する", () => {
    const provisionalPlan = planFor(2, true);
    const provisional = buildTournamentBracketModel({
      plan: provisionalPlan,
      pool: "upper",
      teamNames: new Map([["team-1", "青空FC"]]),
    });
    expect(provisional.nodes[0]!.home.primaryLabel).toBe("B11位");
    expect(provisional.nodes[0]!.home.fullLabel).toContain("ブロック");
    expect(provisional.nodes[0]!.home.primaryLabel).not.toContain("青空FC");

    const resolved = buildTournamentBracketModel({
      plan: planFor(2),
      pool: "upper",
      teamNames: new Map([["team-1", "青空FC"]]),
    });
    expect(resolved.nodes[0]!.home).toMatchObject({
      primaryLabel: "青空FC",
      secondaryLabel: "B1ブロック 1位",
    });
  });

  it("表示番号・時刻・コート・通常得点・PK・勝者を同じ試合線へ反映する", () => {
    const plan = planFor(2);
    const matchId = String((plan.upper as unknown as GeneratedPool).matches[0]!.id);
    const model = buildTournamentBracketModel({
      plan,
      pool: "upper",
      teamNames: new Map([["team-1", "青空FC"], ["team-2", "赤松FC"]]),
      scheduleByMatchId: new Map([
        [matchId, { displayNumber: "A①", timeLabel: "09:30〜10:05", courtName: "Aコート" }],
      ]),
      results: [{
        match_id: matchId,
        home_team_id: "team-1",
        away_team_id: "team-2",
        regular_score_home: 1,
        regular_score_away: 1,
        penalty_score_home: 4,
        penalty_score_away: 3,
      }],
    });
    expect(model.nodes[0]).toMatchObject({
      displayNumber: "A①",
      metaLabel: "09:30〜10:05 Aコート",
      resultLabel: "1 - 1（PK 4-3）",
      home: { primaryLabel: "青空FC", winner: true },
      away: { primaryLabel: "赤松FC", winner: false },
    });
    const rendered = renderTournamentBracket(model, "上位トーナメント表");
    expect(rendered.textContent).toContain("勝者：青空FC");
    expect(rendered.textContent).toContain("PK 4-3");
  });

  it("サーバー確定後だけ順位を確定表示する", () => {
    const plan = planFor(2);
    const matchId = String((plan.upper as unknown as GeneratedPool).matches[0]!.id);
    const results = [{
      match_id: matchId,
      home_team_id: "team-1",
      away_team_id: "team-2",
      regular_score_home: 2,
      regular_score_away: 0,
    }];
    const pending = buildTournamentBracketModel({ plan, pool: "upper", teamNames: new Map(), results });
    expect(pending.nodes[0]!.terminals.every((terminal) => terminal.pendingConfirmation)).toBe(true);
    const confirmed = buildTournamentBracketModel({
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
    expect(confirmed.nodes[0]!.terminals.every((terminal) => terminal.confirmed)).toBe(true);
    expect(renderTournamentBracket(confirmed, "進行図").textContent).toContain("1位確定");
  });

  it("長い名称を省略し完全な文字をtitleとariaへ残す", () => {
    const longName = "とても長い地域サッカークラブ名称ジュニアユースチーム";
    const model = buildTournamentBracketModel({
      plan: planFor(2),
      pool: "upper",
      teamNames: new Map([["team-1", longName], ["team-2", "対戦相手"]]),
    });
    const figure = renderTournamentBracket(model, "上位トーナメントの進行図");
    expect(model.nodes[0]!.home.fullLabel).toContain(longName);
    expect(figure.querySelector(".bracket-entry-name")?.textContent).toContain("…");
    expect(figure.querySelector(".bracket-entry-name title")?.textContent).toContain(longName);
    expect(figure.querySelector("svg")?.getAttribute("aria-labelledby")).toContain(
      "tournament-bracket-upper-1-title",
    );
  });

  it("未知参照・重複ID・循環・交差順位帯を図だけのエラーにする", () => {
    const unknown = planFor(2, true);
    (unknown.upper as unknown as GeneratedPool).matches[0]!.home = winner("UNKNOWN");
    expect(() => buildTournamentBracketModel({ plan: unknown, pool: "upper", teamNames: new Map() }))
      .toThrow(TournamentBracketError);

    const duplicate = planFor(4, true);
    const duplicatePool = duplicate.upper as unknown as GeneratedPool;
    duplicatePool.matches[1]!.id = duplicatePool.matches[0]!.id;
    expect(() => buildTournamentBracketModel({ plan: duplicate, pool: "upper", teamNames: new Map() }))
      .toThrow(/重複/);

    const cyclic = planFor(2, true);
    const cyclicPool = cyclic.upper as unknown as GeneratedPool;
    cyclicPool.matches[0]!.home = winner(String(cyclicPool.matches[0]!.id));
    expect(() => buildTournamentBracketModel({ plan: cyclic, pool: "upper", teamNames: new Map() }))
      .toThrow(/循環/);

    const crossing = planFor(4, true);
    const crossingPool = crossing.upper as unknown as GeneratedPool;
    crossingPool.matches[1]!.rank_range = [2, 4];
    expect(() => buildTournamentBracketModel({ plan: crossing, pool: "upper", teamNames: new Map() }))
      .toThrow(/順位帯/);
  });
});
