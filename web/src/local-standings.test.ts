import { describe, expect, it } from "vitest";

import parityFixture from "./test-fixtures/local-standings-parity.json";
import {
  calculateLocalLeagueStandings,
  calculateLocalSameRankStandings,
  LocalStandingsError,
} from "./local-standings";
import { parseTournamentJson, serializeTournamentJson } from "./import-export";
import type { JsonObject, TournamentDocument } from "./types";
import { sameRankWebFixture } from "../e2e/fixtures";

function leaguePlan(): JsonObject {
  const pairs = [
    ["A", "D"], ["B", "C"], ["C", "A"],
    ["B", "D"], ["A", "B"], ["C", "D"],
  ];
  return {
    schema_version: "0.2.0",
    assignment_mode: "seeded_snake",
    random_seed: 99,
    blocks: [{ id: "A", team_ids: ["A", "B", "C", "D"] }],
    logical_rounds: [1, 2, 3].map((round) => ({
      block_id: "A",
      round_no: round,
      match_ids: [`LG-A-M${String(round * 2 - 1)}`, `LG-A-M${String(round * 2)}`],
    })),
    matches: pairs.map(([home, away], index) => ({
      id: `LG-A-M${String(index + 1)}`,
      phase: "league",
      round: `Aブロック 第${String(Math.floor(index / 2) + 1)}ラウンド`,
      possible_home_team_ids: [home],
      possible_away_team_ids: [away],
      prerequisite_match_ids: [],
      organizer_referee_required: false,
    })),
  };
}

function leagueResults(scores?: readonly [number, number][]): JsonObject[] {
  return Array.from({ length: 6 }, (_, index) => ({
    match_id: `LG-A-M${String(index + 1)}`,
    home_score: scores?.[index]?.[0] ?? 0,
    away_score: scores?.[index]?.[1] ?? 0,
  }));
}

function rank(blockId: string, value: number): JsonObject {
  return { type: "league_rank", block_id: blockId, rank: value };
}

function participant(blockId: string, value: number, teamId: string): JsonObject {
  return {
    entry: rank(blockId, value),
    team: { type: "concrete_team", team_id: teamId },
  };
}

function sameRankPlan(): JsonObject {
  const group = (
    value: number,
    start: number,
    homeTeamId: string,
    awayTeamId: string,
  ): JsonObject => ({
    id: `same-rank-${String(value)}`,
    display_name: `予選${String(value)}位リーグ`,
    source_block_ranks: [value],
    overall_rank_range: [start, start + 1],
    participants: [participant("A", value, homeTeamId), participant("B", value, awayTeamId)],
    logical_rounds: [{
      group_id: `same-rank-${String(value)}`,
      round_no: 1,
      match_ids: [`SR-${String(value)}-M1`],
    }],
    matches: [{
      id: `SR-${String(value)}-M1`,
      phase: "same_rank_league",
      group_id: `same-rank-${String(value)}`,
      round: `予選${String(value)}位リーグ 第1ラウンド`,
      round_no: 1,
      home: rank("A", value),
      away: rank("B", value),
      home_team: { type: "concrete_team", team_id: homeTeamId },
      away_team: { type: "concrete_team", team_id: awayTeamId },
    }],
  });
  return {
    schema_version: "0.2.0",
    format: "same_rank_league",
    status: "COMPLETE",
    participant_resolution: "resolved",
    uneven_policy: "strict_same_rank",
    team_count: 4,
    block_count: 2,
    random_seed: 41,
    groups: [group(1, 1, "T1", "T2"), group(2, 3, "T4", "T3")],
    automatic_standings: [],
    warnings: [],
  };
}

function generatedSameRankCase(
  teamCount: 16 | 17 | 18,
  policy: "strict_same_rank" | "merge_bottom" = "strict_same_rank",
): { plan: JsonObject; results: JsonObject[] } {
  const document = sameRankWebFixture(teamCount, { policy }) as {
    tournament: { result: JsonObject };
  };
  const plan = document.tournament.result.same_rank_plan as JsonObject;
  const groups = plan.groups as JsonObject[];
  return {
    plan,
    results: groups.flatMap((group) => (group.matches as JsonObject[]).map((match) => ({
      match_id: match.id,
      home_team_id: (match.home_team as JsonObject).team_id,
      away_team_id: (match.away_team as JsonObject).team_id,
      regular_score_home: 0,
      regular_score_away: 0,
    }))),
  };
}

describe("ローカルのリーグ順位計算", () => {
  it("Python公開境界と共有するgolden responseに一致する", async () => {
    expect(parityFixture.fixture_version).toBe(1);
    await expect(calculateLocalLeagueStandings({
      leaguePlan: leaguePlan(),
      results: leagueResults(
        parityFixture.league_all_draws.scores.map((value): [number, number] => [
          Number(value[0]),
          Number(value[1]),
        ]),
      ),
      randomSeed: parityFixture.league_all_draws.random_seed,
    })).resolves.toEqual(parityFixture.league_all_draws.expected);

    await expect(calculateLocalLeagueStandings({
      leaguePlan: leaguePlan(),
      results: [],
    })).rejects.toMatchObject(parityFixture.league_missing_error.expected);
  });

  it("Python版と同じSHA-256抽選順と監査値を返す", async () => {
    const result = await calculateLocalLeagueStandings({
      leaguePlan: leaguePlan(),
      results: leagueResults(),
      randomSeed: 99,
    });
    expect((result.standings as JsonObject[]).map((row) => row.team_id)).toEqual([
      "A", "C", "B", "D",
    ]);
    expect(result.draws).toEqual([{
      block_id: "A",
      candidates: ["A", "B", "C", "D"],
      decided_order: ["A", "C", "B", "D"],
      random_seed: 99,
      candidate_values: ["A", "B", "C", "D"].map((teamId) => ({
        team_id: teamId,
        head_to_head: { points: 3, goal_difference: 0, goals_for: 0 },
      })),
    }]);
  });

  it("最初の同点群によるミニリーグを残存同点だけで作り直さない", async () => {
    const result = await calculateLocalLeagueStandings({
      leaguePlan: leaguePlan(),
      results: leagueResults([[5, 0], [2, 0], [3, 0], [4, 2], [1, 0], [3, 1]]),
    });
    const rows = result.standings as JsonObject[];
    expect(rows.map((row) => row.team_id)).toEqual(["C", "B", "A", "D"]);
    expect(rows.slice(0, 3).map((row) => row.points)).toEqual([6, 6, 6]);
    expect(rows.slice(0, 3).map((row) => (row.head_to_head as JsonObject).goal_difference))
      .toEqual([1, 1, -2]);
  });

  it("2チームが全体値で同点なら直接対戦の勝者を上位にする", async () => {
    const result = await calculateLocalLeagueStandings({
      leaguePlan: leaguePlan(),
      results: leagueResults([[0, 1], [1, 0], [1, 0], [0, 1], [1, 0], [1, 0]]),
    });
    const rows = result.standings as JsonObject[];
    expect(rows.map((row) => row.team_id)).toEqual(["C", "D", "A", "B"]);
    expect(rows.map((row) => row.tie_break)).toEqual([
      "直接対戦", "直接対戦", "直接対戦", "直接対戦",
    ]);
    expect((rows[2]!.head_to_head as JsonObject).points).toBe(3);
    expect((rows[3]!.head_to_head as JsonObject).points).toBe(0);
  });

  it("不足・重複・不明な結果と改変された計画を固有codeで拒否する", async () => {
    await expect(calculateLocalLeagueStandings({ leaguePlan: leaguePlan(), results: [] }))
      .rejects.toMatchObject({ code: "LEAGUE_RESULTS_INCOMPLETE" });
    await expect(calculateLocalLeagueStandings({
      leaguePlan: leaguePlan(),
      results: [leagueResults()[0]!, leagueResults()[0]!],
    })).rejects.toMatchObject({ code: "DUPLICATE_LEAGUE_RESULT" });
    await expect(calculateLocalLeagueStandings({
      leaguePlan: leaguePlan(),
      results: [{ match_id: "missing", home_score: 0, away_score: 0 }],
    })).rejects.toMatchObject({ code: "UNKNOWN_LEAGUE_MATCH" });
    const tampered = leaguePlan();
    (tampered.matches as JsonObject[])[0]!.phase = "placement_tournament";
    await expect(calculateLocalLeagueStandings({ leaguePlan: tampered, results: leagueResults() }))
      .rejects.toMatchObject({ code: "LEAGUE_PLAN_INVALID" });
  });
});

describe("ローカルの同順位リーグ順位計算", () => {
  it("Python公開境界と共有する同順位リーグgolden responseに一致する", async () => {
    const results = [
      { match_id: "SR-1-M1", home_team_id: "T1", away_team_id: "T2", regular_score_home: 1, regular_score_away: 1 },
      { match_id: "SR-2-M1", home_team_id: "T4", away_team_id: "T3", regular_score_home: 1, regular_score_away: 1 },
    ];
    await expect(calculateLocalSameRankStandings({
      sameRankPlan: sameRankPlan(),
      results,
    })).resolves.toEqual(parityFixture.same_rank_all_draws.expected);
    await expect(calculateLocalSameRankStandings({
      sameRankPlan: sameRankPlan(),
      results: [
        { ...results[0]!, penalty_score_home: 4, penalty_score_away: 3 },
        results[1]!,
      ],
    })).rejects.toMatchObject(parityFixture.same_rank_penalty_error.expected);
  });

  it("検証済み試合、総合順位、抽選記録をPython版と同じ形で返す", async () => {
    const results = [
      { match_id: "SR-1-M1", home_team_id: "T1", away_team_id: "T2", regular_score_home: 1, regular_score_away: 1 },
      { match_id: "SR-2-M1", home_team_id: "T4", away_team_id: "T3", regular_score_home: 1, regular_score_away: 1 },
    ];
    const result = await calculateLocalSameRankStandings({ sameRankPlan: sameRankPlan(), results });
    expect(result.match_results).toEqual([
      { ...results[0], outcome: "draw" },
      { ...results[1], outcome: "draw" },
    ]);
    expect((result.standings as JsonObject[]).map((row) => row.team_id)).toEqual([
      "T2", "T1", "T4", "T3",
    ]);
    expect((result.draws as JsonObject[]).map((draw) => draw.decided_order)).toEqual([
      ["T2", "T1"], ["T4", "T3"],
    ]);
  });

  it("未確定計画、PK、参加チーム不一致、生成規則から外れた計画を拒否する", async () => {
    const unresolved = sameRankPlan();
    unresolved.participant_resolution = "provisional";
    await expect(calculateLocalSameRankStandings({ sameRankPlan: unresolved, results: [] }))
      .rejects.toMatchObject({ code: "SAME_RANK_RESULTS_REQUIRE_RESOLVED_PLAN" });

    const baseResult = {
      match_id: "SR-1-M1", home_team_id: "T1", away_team_id: "T2",
      regular_score_home: 1, regular_score_away: 1,
    };
    await expect(calculateLocalSameRankStandings({
      sameRankPlan: sameRankPlan(),
      results: [
        { ...baseResult, penalty_score_home: 4, penalty_score_away: 3 },
        { match_id: "SR-2-M1", home_team_id: "T4", away_team_id: "T3", regular_score_home: 0, regular_score_away: 0 },
      ],
    })).rejects.toMatchObject({ code: "SAME_RANK_PENALTY_NOT_ALLOWED" });
    await expect(calculateLocalSameRankStandings({
      sameRankPlan: sameRankPlan(),
      results: [
        { ...baseResult, home_team_id: "wrong" },
        { match_id: "SR-2-M1", home_team_id: "T4", away_team_id: "T3", regular_score_home: 0, regular_score_away: 0 },
      ],
    })).rejects.toMatchObject({ code: "SAME_RANK_RESULT_PARTICIPANT_MISMATCH" });
    const tampered = sameRankPlan();
    (tampered.groups as JsonObject[])[0]!.display_name = "改変";
    await expect(calculateLocalSameRankStandings({ sameRankPlan: tampered, results: [] }))
      .rejects.toMatchObject({ code: "SAME_RANK_SOURCE_INVALID" });
  });

  it("不足・重複・不明な試合結果を固有codeで拒否する", async () => {
    const first = {
      match_id: "SR-1-M1", home_team_id: "T1", away_team_id: "T2",
      regular_score_home: 0, regular_score_away: 0,
    };
    const second = {
      match_id: "SR-2-M1", home_team_id: "T4", away_team_id: "T3",
      regular_score_home: 0, regular_score_away: 0,
    };
    await expect(calculateLocalSameRankStandings({
      sameRankPlan: sameRankPlan(),
      results: [first],
    })).rejects.toMatchObject({ code: "SAME_RANK_RESULTS_INCOMPLETE" });
    await expect(calculateLocalSameRankStandings({
      sameRankPlan: sameRankPlan(),
      results: [first, first, second],
    })).rejects.toMatchObject({ code: "DUPLICATE_SAME_RANK_RESULT" });
    await expect(calculateLocalSameRankStandings({
      sameRankPlan: sameRankPlan(),
      results: [{ ...first, match_id: "SR-UNKNOWN" }, second],
    })).rejects.toMatchObject({ code: "UNKNOWN_SAME_RANK_MATCH" });
  });

  it.each([
    [17, "strict_same_rank", 5, 1],
    [18, "strict_same_rank", 5, 0],
    [18, "merge_bottom", 4, 0],
  ] as const)(
    "%iチーム・%sの端数グループと自動順位をPython生成規則どおり処理する",
    async (teamCount, policy, groupCount, automaticCount) => {
      const fixture = generatedSameRankCase(teamCount, policy);
      const result = await calculateLocalSameRankStandings({
        sameRankPlan: fixture.plan,
        results: fixture.results,
      });
      const rows = result.standings as JsonObject[];
      expect((fixture.plan.groups as JsonObject[])).toHaveLength(groupCount);
      expect(rows.map((row) => row.rank)).toEqual(
        Array.from({ length: teamCount }, (_, index) => index + 1),
      );
      expect(rows.filter((row) => row.automatic === true)).toHaveLength(automaticCount);
      expect(result.match_results).toHaveLength(fixture.results.length);
    },
  );

  it("端末内で生成した保存JSONを既存のimport検証で再読込みできる", async () => {
    const document = sameRankWebFixture(16) as unknown as TournamentDocument;
    const result = document.tournament.result as JsonObject;
    const plan = result.same_rank_plan as JsonObject;
    const results = (plan.groups as JsonObject[]).flatMap((group) =>
      (group.matches as JsonObject[]).map((match) => ({
        match_id: match.id,
        home_team_id: (match.home_team as JsonObject).team_id,
        away_team_id: (match.away_team as JsonObject).team_id,
        regular_score_home: 1,
        regular_score_away: 1,
      }))
    );
    result.same_rank_league_results = results;
    result.same_rank_standings = await calculateLocalSameRankStandings({
      sameRankPlan: plan,
      results,
    });

    expect(parseTournamentJson(serializeTournamentJson(document))).toEqual(document);
  });

  it("診断Errorはcodeとdetailsを保持する", () => {
    const error = new LocalStandingsError("TEST", "message", { value: 1 });
    expect(error).toMatchObject({ code: "TEST", message: "message", details: { value: 1 } });
  });
});
