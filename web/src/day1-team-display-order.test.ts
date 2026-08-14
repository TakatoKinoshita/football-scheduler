import { describe, expect, it } from "vitest";

import {
  day1AwayFirstMatchIds,
  displayedTeamPair,
  type Day1DisplayMatch,
  type Day1DisplaySlot,
} from "./day1-team-display-order";

const matches: Day1DisplayMatch[] = [
  { matchId: "LG-1", homeTeamId: "A", awayTeamId: "B" },
  { matchId: "LG-2", homeTeamId: "C", awayTeamId: "D" },
];

function awayRefereesNext(): Day1DisplaySlot[] {
  return [
    { sectionNo: 1, courtId: "court-a", matchId: "LG-1" },
    { sectionNo: 2, courtId: "court-a", matchId: "LG-2", refereeTeamId: "B" },
  ];
}

describe("1日目の対戦表示順", () => {
  it("直後の同一コートを審判するawayチームだけを左側対象にする", () => {
    expect([...day1AwayFirstMatchIds(matches, awayRefereesNext())]).toEqual(["LG-1"]);
    expect(displayedTeamPair("A", "B", true)).toEqual({
      left: "B",
      right: "A",
      leftSide: "away",
      rightSide: "home",
    });
  });

  it("homeが次の審判なら正本の左右順を維持する", () => {
    const slots = awayRefereesNext();
    slots[1] = { ...slots[1]!, refereeTeamId: "A" };

    expect(day1AwayFirstMatchIds(matches, slots).size).toBe(0);
    expect(displayedTeamPair("A", "B")).toEqual({
      left: "A",
      right: "B",
      leftSide: "home",
      rightSide: "away",
    });
  });

  it.each([
    ["主催者審判", undefined, 2, "court-a"],
    ["空きセクション相当", "B", 3, "court-a"],
    ["別コート", "B", 2, "court-b"],
  ])("%sでは左右を入れ替えない", (_label, refereeTeamId, sectionNo, courtId) => {
    const slots: Day1DisplaySlot[] = [
      { sectionNo: 1, courtId: "court-a", matchId: "LG-1" },
      { sectionNo, courtId, matchId: "LG-2", refereeTeamId },
    ];

    expect(day1AwayFirstMatchIds(matches, slots).size).toBe(0);
  });

  it("設定休憩の有無に依存せず連続セクションを判定し、入力を変更しない", () => {
    const sourceMatches = structuredClone(matches);
    const sourceSlots = awayRefereesNext();
    const originalSlots = structuredClone(sourceSlots);

    expect([...day1AwayFirstMatchIds(sourceMatches, sourceSlots)]).toEqual(["LG-1"]);
    expect(sourceMatches).toEqual(matches);
    expect(sourceSlots).toEqual(originalSlots);
  });

  it("参加チームが確定していない試合は正本順へフォールバックする", () => {
    const unresolved: Day1DisplayMatch[] = [{ matchId: "LG-1", homeTeamId: "A" }];

    expect(day1AwayFirstMatchIds(unresolved, awayRefereesNext()).size).toBe(0);
  });
});
