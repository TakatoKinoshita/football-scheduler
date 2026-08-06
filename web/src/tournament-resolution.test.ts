import { describe, expect, it } from "vitest";

import {
  bindTournamentParticipants,
  tournamentParticipantResolution,
  unbindTournamentParticipants,
} from "./tournament-resolution";

const rank = (blockId: string, place: number) => ({
  type: "league_rank",
  block_id: blockId,
  rank: place,
});

function provisionalPlan() {
  return {
    participant_resolution: "provisional",
    upper: {
      seeds: [
        {
          seed_no: 1,
          team_id: null,
          block_id: "A",
          block_rank: 1,
          entry: rank("A", 1),
          team: null,
        },
        {
          seed_no: 2,
          team_id: null,
          block_id: "B",
          block_rank: 1,
          entry: rank("B", 1),
          team: null,
        },
      ],
    },
    lower: { seeds: [] },
    seed_draws: [
      {
        pool: "upper",
        block_rank: 1,
        candidates: [],
        decided_order: [],
        candidate_rank_refs: [rank("A", 1), rank("B", 1)],
        decided_rank_refs: [rank("B", 1), rank("A", 1)],
      },
    ],
  };
}

const standings = {
  standings: [
    { block_id: "A", rank: 1, team_id: "team-a" },
    { block_id: "B", rank: 1, team_id: "team-b" },
  ],
};

describe("トーナメント順位枠のチーム対応", () => {
  it("順位確定後も順位枠と抽選順を変えずにチームを注記する", () => {
    const provisional = provisionalPlan();
    const resolved = bindTournamentParticipants(provisional, standings);

    expect(tournamentParticipantResolution(resolved)).toBe("resolved");
    expect((resolved.upper as { seeds: unknown[] }).seeds).toMatchObject([
      { entry: rank("A", 1), team_id: "team-a" },
      { entry: rank("B", 1), team_id: "team-b" },
    ]);
    expect((resolved.seed_draws as Array<{ decided_order: string[] }>)[0]!.decided_order).toEqual([
      "team-b",
      "team-a",
    ]);
    expect(provisional).toEqual(provisionalPlan());
  });

  it("得点変更時は具体チームだけを外して仮表へ戻す", () => {
    const provisional = provisionalPlan();
    const resolved = bindTournamentParticipants(provisional, standings);
    const restored = unbindTournamentParticipants(resolved);

    expect(tournamentParticipantResolution(restored)).toBe("provisional");
    expect(restored).toEqual(provisional);
  });

  it("従来形式は具体チーム参照から解決済みと判定する", () => {
    const resolved = bindTournamentParticipants(provisionalPlan(), standings);
    delete resolved.participant_resolution;

    expect(tournamentParticipantResolution(resolved)).toBe("resolved");
  });
});
