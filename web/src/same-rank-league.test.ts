import { describe, expect, it } from "vitest";

import {
  bindSameRankPlan,
  bindSameRankSchedule,
  sameRankProgress,
  unbindSameRankPlan,
} from "./same-rank-league";
import type { JsonObject } from "./types";

const entry = (block: string): JsonObject => ({ type: "league_rank", block_id: block, rank: 1 });

function plan(): JsonObject {
  return {
    participant_resolution: "provisional",
    groups: [{
      id: "same-rank-1",
      participants: [{ entry: entry("A"), team: null }, { entry: entry("B"), team: null }],
      matches: [{
        id: "SR-1-M1",
        home: entry("A"),
        away: entry("B"),
        home_team: null,
        away_team: null,
      }],
    }],
    automatic_standings: [],
  };
}

const standings: JsonObject = {
  standings: [
    { block_id: "A", rank: 1, team_id: "team-a" },
    { block_id: "B", rank: 1, team_id: "team-b" },
  ],
};

describe("同順位リーグのWeb状態", () => {
  it("順位確定時に計画と日程の順位枠へ同じチームを注記する", () => {
    const resolved = bindSameRankPlan(plan(), standings);
    const schedule = bindSameRankSchedule({
      participant_resolution: "provisional",
      same_rank_matches: structuredClone((resolved.groups as JsonObject[])[0]!.matches),
      slots: [{
        match_id: "SR-1-M1",
        referee_assignment: { kind: "team", rank_ref: entry("A"), team_id: null },
      }],
      team_schedules: [{ rank_ref: entry("B"), team_id: null }],
      metrics: { referee_counts: [] },
    }, standings);

    expect(resolved.participant_resolution).toBe("resolved");
    expect(schedule.participant_resolution).toBe("resolved");
    expect(((schedule.slots as JsonObject[])[0]!.referee_assignment as JsonObject).team_id)
      .toBe("team-a");
    expect(unbindSameRankPlan(resolved)).toEqual(plan());
  });

  it("引き分けを許可し、PKフィールドを拒否する", () => {
    const resolved = bindSameRankPlan(plan(), standings);
    const draw = {
      match_id: "SR-1-M1",
      home_team_id: "team-a",
      away_team_id: "team-b",
      regular_score_home: 1,
      regular_score_away: 1,
    };
    expect(sameRankProgress(resolved, [draw])).toEqual({ total: 1, entered: 1, complete: true });
    expect(() => sameRankProgress(resolved, [{ ...draw, penalty_score_home: 4 }]))
      .toThrow(/PK/);
  });
});
