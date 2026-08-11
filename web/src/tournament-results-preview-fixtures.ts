import type { TournamentResultDrafts } from "./tournament-result-drafts";
import type { TournamentResultScheduleDetails } from "./tournament-results-input";
import type { JsonObject } from "./types";

export const TOURNAMENT_RESULTS_PREVIEW_FIXTURE_MARKER =
  "TOURNAMENT_RESULTS_PREVIEW_FIXTURE_V1";

export type TournamentResultsPreviewScenarioId = "mixed" | "winner-change";

export interface TournamentResultsPreviewTeam {
  id: string;
  name: string;
}

export interface TournamentResultsPreviewScenario {
  id: TournamentResultsPreviewScenarioId;
  label: string;
  description: string;
  plan: JsonObject;
  teams: readonly TournamentResultsPreviewTeam[];
  schedule: readonly TournamentResultScheduleDetails[];
  results: readonly JsonObject[];
  drafts: TournamentResultDrafts;
}

const teams: readonly TournamentResultsPreviewTeam[] = [
  { id: "team-01", name: "北町サッカー" },
  { id: "team-02", name: "GREENWIND" },
  { id: "team-03", name: "チーム3" },
  { id: "team-04", name: "チーム4" },
  { id: "team-05", name: "チーム5" },
  { id: "team-06", name: "チーム6" },
  { id: "team-07", name: "チーム7" },
  { id: "team-08", name: "チーム8" },
];

const openingMatch = (
  id: string,
  poolId: string,
  rankStart: number,
  homeBlock: string,
  awayBlock: string,
  rank: number,
): JsonObject => ({
  id,
  phase: "placement_tournament",
  pool_id: poolId,
  round: `${String(rankStart)}〜${String(rankStart + 3)}位 順位決定`,
  round_no: 1,
  home: { type: "league_rank", block_id: homeBlock, rank },
  away: { type: "league_rank", block_id: awayBlock, rank },
  rank_range: [rankStart, rankStart + 3],
});

const decidingMatch = (
  id: string,
  poolId: string,
  rankStart: number,
  sourceOne: string,
  sourceTwo: string,
  kind: "winner_of" | "loser_of",
): JsonObject => ({
  id,
  phase: "placement_tournament",
  pool_id: poolId,
  round: kind === "winner_of"
    ? `${String(rankStart)}位決定戦`
    : `${String(rankStart + 2)}位決定戦`,
  round_no: 2,
  home: { type: kind, match_id: sourceOne },
  away: { type: kind, match_id: sourceTwo },
  rank_range: kind === "winner_of"
    ? [rankStart, rankStart + 1]
    : [rankStart + 2, rankStart + 3],
});

const seed = (
  seedNo: number,
  teamId: string,
  blockId: string,
  blockRank: number,
): JsonObject => ({ seed_no: seedNo, team_id: teamId, block_id: blockId, block_rank: blockRank });

const plan: JsonObject = {
  schema_version: "0.2.0",
  participant_resolution: "resolved",
  tournament_count: 2,
  fixture_marker: TOURNAMENT_RESULTS_PREVIEW_FIXTURE_MARKER,
  pools: [
    {
      pool_id: "placement-1",
      pool_index: 1,
      display_name: "第1順位決定トーナメント",
      participant_count: 4,
      seeds: [
        seed(1, "team-05", "B", 1),
        seed(2, "team-04", "A", 1),
        seed(3, "team-01", "C", 1),
        seed(4, "team-06", "D", 1),
      ],
      matches: [
        openingMatch("PT-1-RANK-1-4-M1", "placement-1", 1, "B", "D", 1),
        openingMatch("PT-1-RANK-1-4-M2", "placement-1", 1, "A", "C", 1),
        decidingMatch(
          "PT-1-RANK-1-2-M1",
          "placement-1",
          1,
          "PT-1-RANK-1-4-M1",
          "PT-1-RANK-1-4-M2",
          "winner_of",
        ),
        decidingMatch(
          "PT-1-RANK-3-4-M1",
          "placement-1",
          1,
          "PT-1-RANK-1-4-M1",
          "PT-1-RANK-1-4-M2",
          "loser_of",
        ),
      ],
    },
    {
      pool_id: "placement-2",
      pool_index: 2,
      display_name: "第2順位決定トーナメント",
      participant_count: 4,
      seeds: [
        seed(1, "team-03", "C", 2),
        seed(2, "team-07", "A", 2),
        seed(3, "team-02", "B", 2),
        seed(4, "team-08", "D", 2),
      ],
      matches: [
        openingMatch("PT-2-RANK-5-8-M1", "placement-2", 5, "C", "D", 2),
        openingMatch("PT-2-RANK-5-8-M2", "placement-2", 5, "A", "B", 2),
        decidingMatch(
          "PT-2-RANK-5-6-M1",
          "placement-2",
          5,
          "PT-2-RANK-5-8-M1",
          "PT-2-RANK-5-8-M2",
          "winner_of",
        ),
        decidingMatch(
          "PT-2-RANK-7-8-M1",
          "placement-2",
          5,
          "PT-2-RANK-5-8-M1",
          "PT-2-RANK-5-8-M2",
          "loser_of",
        ),
      ],
    },
  ],
};

const schedule: readonly TournamentResultScheduleDetails[] = [
  { matchId: "PT-1-RANK-1-4-M1", displayNumber: "A①", timeLabel: "09:30〜10:05", courtName: "Aコート" },
  { matchId: "PT-2-RANK-5-8-M1", displayNumber: "B①", timeLabel: "09:30〜10:05", courtName: "Bコート" },
  { matchId: "PT-1-RANK-1-4-M2", displayNumber: "C①", timeLabel: "09:30〜10:05", courtName: "Cコート" },
  { matchId: "PT-2-RANK-5-8-M2", displayNumber: "B②", timeLabel: "10:15〜10:50", courtName: "Bコート" },
  { matchId: "PT-1-RANK-3-4-M1", displayNumber: "C②", timeLabel: "11:00〜11:35", courtName: "Cコート" },
  { matchId: "PT-1-RANK-1-2-M1", displayNumber: "A②", timeLabel: "11:45〜12:20", courtName: "Aコート" },
  { matchId: "PT-2-RANK-5-6-M1", displayNumber: "B③", timeLabel: "11:45〜12:20", courtName: "Bコート" },
  { matchId: "PT-2-RANK-7-8-M1", displayNumber: "C③", timeLabel: "11:45〜12:20", courtName: "Cコート" },
];

const result = (
  matchId: string,
  homeTeamId: string,
  awayTeamId: string,
  regularHome: number,
  regularAway: number,
  penaltyHome?: number,
  penaltyAway?: number,
): JsonObject => ({
  match_id: matchId,
  home_team_id: homeTeamId,
  away_team_id: awayTeamId,
  regular_score_home: regularHome,
  regular_score_away: regularAway,
  ...(penaltyHome === undefined ? {} : { penalty_score_home: penaltyHome }),
  ...(penaltyAway === undefined ? {} : { penalty_score_away: penaltyAway }),
});

const mixed: TournamentResultsPreviewScenario = {
  id: "mixed",
  label: "混在状態",
  description: "未入力・入力中・保存済・要確認・待機中を同時に比較します。",
  plan,
  teams,
  schedule,
  results: [
    result("PT-1-RANK-1-4-M1", "team-05", "team-06", 2, 0),
    result("PT-1-RANK-1-4-M2", "team-04", "team-01", 1, 1, 4, 3),
  ],
  drafts: {
    "PT-1-RANK-3-4-M1": {
      regularHome: "-1",
      regularAway: "0",
      penaltyHome: "",
      penaltyAway: "",
    },
    "PT-2-RANK-5-8-M1": {
      regularHome: "2",
      regularAway: "",
      penaltyHome: "",
      penaltyAway: "",
    },
    "PT-2-RANK-5-8-M2": {
      regularHome: "1",
      regularAway: "1",
      penaltyHome: "4",
      penaltyAway: "",
    },
  },
};

const winnerChange: TournamentResultsPreviewScenario = {
  id: "winner-change",
  label: "勝者変更",
  description: "先行試合の勝者を変えたとき、影響する後続結果だけが取り消されることを確認します。",
  plan,
  teams,
  schedule,
  results: [
    result("PT-1-RANK-1-4-M1", "team-05", "team-06", 2, 0),
    result("PT-1-RANK-1-4-M2", "team-04", "team-01", 1, 1, 4, 3),
    result("PT-1-RANK-1-2-M1", "team-05", "team-04", 1, 0),
    result("PT-1-RANK-3-4-M1", "team-06", "team-01", 0, 1),
    result("PT-2-RANK-5-8-M1", "team-03", "team-08", 0, 1),
    result("PT-2-RANK-5-8-M2", "team-07", "team-02", 2, 0),
    result("PT-2-RANK-5-6-M1", "team-08", "team-07", 1, 1, 3, 4),
    result("PT-2-RANK-7-8-M1", "team-03", "team-02", 0, 2),
  ],
  drafts: {},
};

export const tournamentResultsPreviewScenarios: readonly TournamentResultsPreviewScenario[] = [
  mixed,
  winnerChange,
];

export function tournamentResultsPreviewScenario(
  id: string,
): TournamentResultsPreviewScenario | undefined {
  return tournamentResultsPreviewScenarios.find((scenario) => scenario.id === id);
}
