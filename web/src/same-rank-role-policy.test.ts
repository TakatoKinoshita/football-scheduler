import { describe, expect, it } from "vitest";

import { sameRankRoleSequenceViolation } from "./same-rank-role-policy";

describe("同順位リーグの連続担当規則", () => {
  it("試合→審判→試合では審判後の試合を別コートに配置できる", () => {
    expect(sameRankRoleSequenceViolation([
      { section: 1, court: "court-a", role: "match", matchId: "M1" },
      { section: 2, court: "court-a", role: "referee", matchId: "M2" },
      { section: 3, court: "court-b", role: "match", matchId: "M3" },
    ])).toBeUndefined();
  });

  it("試合直後の審判が別コートなら拒否する", () => {
    expect(sameRankRoleSequenceViolation([
      { section: 1, court: "court-a", role: "match", matchId: "M1" },
      { section: 2, court: "court-b", role: "referee", matchId: "M2" },
    ])).toBe("match_to_referee_court_change");
  });

  it("直前の試合から供給されない審判を拒否する", () => {
    expect(sameRankRoleSequenceViolation([
      { section: 1, court: "court-a", role: "match", matchId: "M1" },
      { section: 3, court: "court-a", role: "referee", matchId: "M2" },
    ])).toBe("referee_source_invalid");
  });

  it("連続試合を拒否する", () => {
    expect(sameRankRoleSequenceViolation([
      { section: 1, court: "court-a", role: "match", matchId: "M1" },
      { section: 2, court: "court-b", role: "match", matchId: "M2" },
    ])).toBe("consecutive_match");
  });

  it("連続した審判担当を拒否する", () => {
    expect(sameRankRoleSequenceViolation([
      { section: 1, court: "court-a", role: "match", matchId: "M1" },
      { section: 2, court: "court-a", role: "referee", matchId: "M2" },
      { section: 3, court: "court-a", role: "referee", matchId: "M3" },
    ])).toBe("consecutive_referee");
  });
});
