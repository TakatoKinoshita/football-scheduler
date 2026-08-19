import { sameRankWebFixture } from "../e2e/fixtures";
import { calculateLocalSameRankStandings } from "./local-standings";
import type { JsonObject, TournamentDocument } from "./types";

export const SAME_RANK_RESULTS_WORKBOOK_FIXTURE_VERSION = "1.0.0";

export type SameRankFixtureScore = (input: {
  groupIndex: number;
  matchIndex: number;
  match: JsonObject;
}) => readonly [number, number];

export async function completedSameRankResultsWorkbookFixture(
  teamCount: 16 | 17 | 18 = 16,
  options: {
    policy?: "strict_same_rank" | "merge_bottom";
    name?: string;
    score?: SameRankFixtureScore;
  } = {},
): Promise<TournamentDocument> {
  const document = sameRankWebFixture(teamCount, {
    policy: options.policy ?? "strict_same_rank",
  }) as unknown as TournamentDocument;
  document.tournament.name = options.name ?? `${String(teamCount)}チーム同順位リーグ大会`;
  document.updatedAt = "2026-08-19T06:00:00.000Z";
  const result = document.tournament.result as JsonObject;
  const plan = result.same_rank_plan as JsonObject;
  const groups = plan.groups as JsonObject[];
  const results = groups.flatMap((group, groupIndex) =>
    (group.matches as JsonObject[]).map((match, matchIndex): JsonObject => {
      const [regularHome, regularAway] = options.score?.({ groupIndex, matchIndex, match }) ?? [1, 0];
      return {
        match_id: match.id,
        home_team_id: (match.home_team as JsonObject).team_id,
        away_team_id: (match.away_team as JsonObject).team_id,
        regular_score_home: regularHome,
        regular_score_away: regularAway,
      };
    })
  );
  result.same_rank_league_results = results;
  result.same_rank_standings = await calculateLocalSameRankStandings({
    sameRankPlan: plan,
    results,
  });
  return document;
}
