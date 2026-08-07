import { describe, expect, it } from "vitest";

import {
  applyTournamentResultChange,
  overallTournamentRank,
  overallTournamentRankRange,
  parseTournamentResult,
  previewTournamentStandings,
  resolveTournamentProgress,
  TournamentProgressError,
} from "./tournament-results";
import type { JsonObject } from "./types";

const rank = (blockId: string, value: number) => ({
  type: "league_rank",
  block_id: blockId,
  rank: value,
});
const winner = (matchId: string) => ({ type: "winner_of", match_id: matchId });
const loser = (matchId: string) => ({ type: "loser_of", match_id: matchId });
const evaluation = {
  first_match_same_block_count: 0,
  possible_same_block_match_count: 0,
  earliest_possible_same_block_round: null,
};

function plan(): JsonObject {
  return {
    schema_version: "0.1.0",
    status: "COMPLETE",
    participant_resolution: "resolved",
    odd_split_policy: "upper",
    random_seed: 17,
    upper: {
      pool: "upper",
      participant_count: 4,
      seeds: ["A", "B", "C", "D"].map((blockId, index) => ({
        seed_no: index + 1,
        team_id: `T${String(index + 1)}`,
        block_id: blockId,
        block_rank: 1,
        entry: rank(blockId, 1),
        team: { type: "concrete_team", team_id: `T${String(index + 1)}` },
      })),
      matches: [
        { id: "UT-SF1", home: rank("A", 1), away: rank("D", 1), rank_range: [1, 4] },
        { id: "UT-SF2", home: rank("B", 1), away: rank("C", 1), rank_range: [1, 4] },
        { id: "UT-FINAL", home: winner("UT-SF1"), away: winner("UT-SF2"), rank_range: [1, 2] },
        { id: "UT-PLACE3", home: loser("UT-SF1"), away: loser("UT-SF2"), rank_range: [3, 4] },
      ],
      byes: [],
      placements: [
        { rank: 1, entry: winner("UT-FINAL") },
        { rank: 2, entry: loser("UT-FINAL") },
        { rank: 3, entry: winner("UT-PLACE3") },
        { rank: 4, entry: loser("UT-PLACE3") },
      ],
      evaluation,
    },
    lower: {
      pool: "lower",
      participant_count: 2,
      seeds: ["E", "F"].map((blockId, index) => ({
        seed_no: index + 1,
        team_id: `T${String(index + 5)}`,
        block_id: blockId,
        block_rank: 2,
        entry: rank(blockId, 2),
        team: { type: "concrete_team", team_id: `T${String(index + 5)}` },
      })),
      matches: [
        { id: "LT-FINAL", home: rank("E", 2), away: rank("F", 2), rank_range: [1, 2] },
      ],
      byes: [],
      placements: [
        { rank: 1, entry: winner("LT-FINAL") },
        { rank: 2, entry: loser("LT-FINAL") },
      ],
      evaluation,
    },
    seed_draws: [],
    warnings: [],
  };
}

function result(
  matchId: string,
  homeTeamId: string,
  awayTeamId: string,
  homeScore = 1,
  awayScore = 0,
): JsonObject {
  return {
    match_id: matchId,
    home_team_id: homeTeamId,
    away_team_id: awayTeamId,
    regular_score_home: homeScore,
    regular_score_away: awayScore,
  };
}

function completeResults(): JsonObject[] {
  return [
    result("UT-SF1", "T1", "T4"),
    result("UT-SF2", "T2", "T3"),
    result("UT-FINAL", "T1", "T2"),
    result("UT-PLACE3", "T4", "T3"),
    result("LT-FINAL", "T5", "T6"),
  ];
}

describe("2日目トーナメント結果", () => {
  it("前提試合の結果が揃うまで後続の対戦チームを確定しない", () => {
    const initial = resolveTournamentProgress(plan(), []);
    expect(initial.matchesById.get("UT-SF1")).toMatchObject({
      homeTeamId: "T1",
      awayTeamId: "T4",
    });
    expect(initial.matchesById.get("UT-FINAL")?.homeTeamId).toBeUndefined();

    const afterFirst = resolveTournamentProgress(plan(), [result("UT-SF1", "T1", "T4")]);
    expect(afterFirst.matchesById.get("UT-FINAL")?.homeTeamId).toBe("T1");
    expect(afterFirst.matchesById.get("UT-FINAL")?.awayTeamId).toBeUndefined();

    const afterSemifinals = resolveTournamentProgress(plan(), [
      result("UT-SF1", "T1", "T4"),
      result("UT-SF2", "T2", "T3"),
    ]);
    expect(afterSemifinals.matchesById.get("UT-FINAL")).toMatchObject({
      homeTeamId: "T1",
      awayTeamId: "T2",
    });
  });

  it("勝者が同じ得点修正は後続を保持し、勝者変更は子孫だけを削除する", () => {
    const sameWinner = applyTournamentResultChange(
      plan(),
      completeResults(),
      "UT-SF1",
      result("UT-SF1", "T1", "T4", 2, 0),
    );
    expect(sameWinner.winnerChanged).toBe(false);
    expect(sameWinner.removedDescendantCount).toBe(0);
    expect(sameWinner.results).toHaveLength(5);

    const changedWinner = applyTournamentResultChange(
      plan(),
      completeResults(),
      "UT-SF1",
      result("UT-SF1", "T1", "T4", 0, 1),
    );
    expect(changedWinner.winnerChanged).toBe(true);
    expect(changedWinner.removedDescendantCount).toBe(2);
    expect(changedWinner.results.map((item) => item.match_id)).toEqual([
      "UT-SF1",
      "UT-SF2",
      "LT-FINAL",
    ]);
  });

  it("下位トーナメントの相対順位を総合順位へ変換する", () => {
    expect(overallTournamentRank(plan(), "upper", 2)).toBe(2);
    expect(overallTournamentRank(plan(), "lower", 1)).toBe(5);
    expect(overallTournamentRankRange(plan(), "lower", [1, 2])).toEqual([5, 6]);

    const progress = resolveTournamentProgress(plan(), completeResults());
    expect(previewTournamentStandings(plan(), progress).map((row) => row.rank)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it("通常得点とPK得点を分けて検証する", () => {
    expect(
      parseTournamentResult({
        ...result("UT-SF1", "T1", "T4", 1, 1),
        penalty_score_home: 4,
        penalty_score_away: 3,
      }),
    ).toMatchObject({ penalty_score_home: 4, penalty_score_away: 3 });

    expect(() =>
      parseTournamentResult({
        ...result("UT-SF1", "T1", "T4", 1, 1),
        penalty_score_home: 3,
        penalty_score_away: 3,
      }),
    ).toThrowError(TournamentProgressError);
  });

  it("保存済みの参加チームが現在の勝敗経路と違う場合は拒否する", () => {
    const stale = completeResults();
    stale[2] = result("UT-FINAL", "T4", "T2");

    expect(() => resolveTournamentProgress(plan(), stale)).toThrowError(
      expect.objectContaining({ code: "TOURNAMENT_RESULT_PARTICIPANT_MISMATCH" }),
    );
  });
});
