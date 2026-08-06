import { describe, expect, it } from "vitest";

import {
  bindDay2ScheduleParticipants,
  day2ParticipantResolution,
  unbindDay2ScheduleParticipants,
} from "./day2-resolution";

const rank = (blockId: string, place: number) => ({
  type: "league_rank",
  block_id: blockId,
  rank: place,
});

const standings = {
  standings: [
    { block_id: "A", rank: 1, team_id: "team-a" },
    { block_id: "B", rank: 1, team_id: "team-b" },
  ],
};

function provisionalSchedule() {
  return {
    participant_resolution: "provisional",
    tournament_matches: [
      {
        id: "UT-FINAL",
        possible_rank_refs: [rank("A", 1), rank("B", 1)],
        possible_team_ids: [],
      },
    ],
    slots: [{ section_no: 1, court_id: "court-a", match_id: "UT-FINAL" }],
    team_schedules: [
      {
        rank_ref: rank("A", 1),
        team_id: null,
        match_id: "UT-FINAL",
        section_no: 1,
        court_id: "court-a",
      },
    ],
  };
}

describe("2日目日程の順位枠対応", () => {
  it("順位確定時は配置を変えずにチームIDだけを注記する", () => {
    const provisional = provisionalSchedule();
    const resolved = bindDay2ScheduleParticipants(provisional, standings);

    expect(day2ParticipantResolution(resolved)).toBe("resolved");
    expect(resolved.tournament_matches).toMatchObject([
      { possible_team_ids: ["team-a", "team-b"] },
    ]);
    expect(resolved.team_schedules).toMatchObject([{ team_id: "team-a" }]);
    expect(resolved.slots).toEqual(provisional.slots);
    expect(provisional).toEqual(provisionalSchedule());
  });

  it("得点変更時は順位枠と配置を保ったまま仮日程へ戻す", () => {
    const provisional = provisionalSchedule();
    const resolved = bindDay2ScheduleParticipants(provisional, standings);

    expect(unbindDay2ScheduleParticipants(resolved, standings)).toEqual(provisional);
  });

  it("従来形式の日程から順位枠を補って仮日程へ移行できる", () => {
    const legacy = bindDay2ScheduleParticipants(provisionalSchedule(), standings);
    delete legacy.participant_resolution;
    for (const match of legacy.tournament_matches as Array<Record<string, unknown>>) {
      delete match.possible_rank_refs;
    }
    for (const route of legacy.team_schedules as Array<Record<string, unknown>>) {
      delete route.rank_ref;
    }

    expect(day2ParticipantResolution(legacy)).toBe("resolved");
    expect(unbindDay2ScheduleParticipants(legacy, standings)).toEqual(provisionalSchedule());
  });
});
