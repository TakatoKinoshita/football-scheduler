import { describe, expect, it } from "vitest";

import {
  sameRankAwayFirstMatchIds,
  type SameRankDisplayMatch,
  type SameRankDisplaySlot,
} from "./same-rank-team-display-order";

const a1 = { type: "league_rank", block_id: "A", rank: 1 };
const b1 = { type: "league_rank", block_id: "B", rank: 1 };
const c1 = { type: "league_rank", block_id: "C", rank: 1 };
const d1 = { type: "league_rank", block_id: "D", rank: 1 };
const matches: SameRankDisplayMatch[] = [
  { matchId: "SR-1", home: a1, away: b1 },
  { matchId: "SR-2", home: c1, away: d1 },
];

function awayRefereesNext(): SameRankDisplaySlot[] {
  return [
    { sectionNo: 1, courtId: "court-a", matchId: "SR-1" },
    { sectionNo: 2, courtId: "court-a", matchId: "SR-2", refereeRankRef: b1 },
  ];
}

describe("2日目同順位リーグの対戦表示順", () => {
  it("直後の同一コートを審判するaway順位枠だけを左側対象にする", () => {
    expect([...sameRankAwayFirstMatchIds(matches, awayRefereesNext())]).toEqual(["SR-1"]);
  });

  it("home順位枠が次の審判なら正本の左右順を維持する", () => {
    const slots = awayRefereesNext();
    slots[1] = { ...slots[1]!, refereeRankRef: a1 };

    expect(sameRankAwayFirstMatchIds(matches, slots).size).toBe(0);
  });

  it.each([
    ["主催者審判", undefined, 2, "court-a"],
    ["空きセクション相当", b1, 3, "court-a"],
    ["別コート", b1, 2, "court-b"],
    ["現在の対戦外の順位枠", c1, 2, "court-a"],
  ])("%sでは左右を入れ替えない", (_label, refereeRankRef, sectionNo, courtId) => {
    const slots: SameRankDisplaySlot[] = [
      { sectionNo: 1, courtId: "court-a", matchId: "SR-1" },
      { sectionNo, courtId, matchId: "SR-2", refereeRankRef },
    ];

    expect(sameRankAwayFirstMatchIds(matches, slots).size).toBe(0);
  });

  it("順位確定後のチーム注記に依存せず順位枠だけで判定し、入力を変更しない", () => {
    const resolvedMatches = matches.map((match, index) => ({
      ...match,
      homeTeam: { type: "concrete_team", team_id: `home-${String(index)}` },
      awayTeam: { type: "concrete_team", team_id: `away-${String(index)}` },
    }));
    const sourceMatches = structuredClone(resolvedMatches);
    const sourceSlots = awayRefereesNext();
    const originalSlots = structuredClone(sourceSlots);

    expect([...sameRankAwayFirstMatchIds(sourceMatches, sourceSlots)]).toEqual(["SR-1"]);
    expect(sourceMatches).toEqual(resolvedMatches);
    expect(sourceSlots).toEqual(originalSlots);
  });

  it("不正または未確定の順位枠では正本順へフォールバックする", () => {
    const unresolved: SameRankDisplayMatch[] = [
      { matchId: "SR-1", home: a1, away: { type: "league_rank", block_id: "B" } },
    ];

    expect(sameRankAwayFirstMatchIds(unresolved, awayRefereesNext()).size).toBe(0);
  });
});
