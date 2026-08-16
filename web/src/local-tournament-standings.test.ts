import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseTournamentJson, serializeTournamentJson } from "./import-export";
import {
  calculateLocalTournamentStandings,
  LocalTournamentStandingsError,
} from "./local-tournament-standings";
import { resolveTournamentProgress } from "./tournament-results";
import type { JsonObject, TournamentDocument } from "./types";

const regressionFixture = resolve(
  process.cwd(),
  "../scripts/fixtures/tournament-results-8.json",
);
const goldenFixture = resolve(
  process.cwd(),
  "../scripts/fixtures/tournament-results-golden.json",
);
const documentFixture = resolve(
  process.cwd(),
  "e2e/fixtures/issue75-eight-team-document.json",
);

interface GoldenCase {
  pool_size: 4 | 8 | 16;
  team_count: number;
  block_count: number;
  random_seed: number;
  expected_sha256: string;
  pools: Array<{
    seeds: Array<[string, string, number]>;
    opening_block_order: string[];
  }>;
}

interface GoldenDiagnostic {
  case: string;
  code: string;
  reason?: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as JsonObject;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(object[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fixture(): Promise<{ tournament_plan: JsonObject; results: JsonObject[] }> {
  return JSON.parse(await readFile(regressionFixture, "utf8")) as {
    tournament_plan: JsonObject;
    results: JsonObject[];
  };
}

async function golden(): Promise<{
  schema_version: string;
  diagnostics: GoldenDiagnostic[];
  cases: GoldenCase[];
}> {
  return JSON.parse(await readFile(goldenFixture, "utf8")) as {
    schema_version: string;
    diagnostics: GoldenDiagnostic[];
    cases: GoldenCase[];
  };
}

function homeWinResults(plan: JsonObject): JsonObject[] {
  const results: JsonObject[] = [];
  for (;;) {
    const progress = resolveTournamentProgress(plan, results);
    if (progress.complete) return results;
    const ready = progress.orderedMatches.find((match) =>
      match.result === undefined && match.homeTeamId !== undefined && match.awayTeamId !== undefined
    );
    if (ready === undefined) throw new Error("進行可能な試合がありません");
    results.push({
      match_id: ready.matchId,
      home_team_id: ready.homeTeamId,
      away_team_id: ready.awayTeamId,
      regular_score_home: 1,
      regular_score_away: 0,
    });
  }
}

function goldenLogicalLayout(matches: JsonObject[], overallRange: [number, number]): JsonObject {
  const key = (range: unknown) => JSON.stringify(range);
  const counts = new Map<string, number>();
  const matchPositions = matches.map((match) => {
    const rangeKey = key(match.rank_range);
    const order = (counts.get(rangeKey) ?? 0) + 1;
    counts.set(rangeKey, order);
    return { match_id: match.id, rank_range: match.rank_range, order };
  });
  const inRange = (range: [number, number]) =>
    matches.filter((match) => key(match.rank_range) === key(range));
  const branchAlignments: JsonObject[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const range = match.rank_range as [number, number];
    if (seen.has(key(range)) || range[1] - range[0] + 1 < 4) continue;
    seen.add(key(range));
    const half = (range[1] - range[0] + 1) / 2;
    const sources = new Set(inRange(range).map((source) => source.id));
    const sourceOrder = (childRange: [number, number], type: string) =>
      inRange(childRange).flatMap((child) => [child.home, child.away]).map((value) => {
        const entry = value as JsonObject;
        if (entry.type !== type || !sources.has(entry.match_id)) throw new Error("golden graph");
        return String(entry.match_id);
      });
    const winners = sourceOrder([range[0], range[0] + half - 1], "winner_of");
    const losers = sourceOrder([range[0] + half, range[1]], "loser_of");
    const positions = new Map(winners.map((matchId, index) => [matchId, index + 1]));
    const permutation = losers.map((matchId) => positions.get(matchId)!);
    const mirrored = permutation.every((value, index) => value === index + 1);
    branchAlignments.push({
      rank_range: range,
      status: mirrored ? "mirrored" : "permuted",
      winner_source_order: winners,
      loser_source_order: losers,
      loser_to_winner_permutation: permutation,
      diagnostic_code: mirrored ? null : "OUTCOME_BRANCH_ORDER_DIFFERS",
    });
  }
  return {
    layout_version: "1",
    symmetry: branchAlignments.some((item) => item.status === "permuted")
      ? "permuted"
      : "mirrored",
    opening_entry_order: inRange(overallRange).flatMap((match) => [match.home, match.away]),
    match_positions: matchPositions,
    branch_alignments: branchAlignments,
  };
}

function buildGoldenPlan(golden: GoldenCase): JsonObject {
  const pools = golden.pools.map((source, zeroIndex) => {
    const poolIndex = zeroIndex + 1;
    const poolId = `placement-${String(poolIndex)}`;
    const overallStart = zeroIndex * golden.pool_size + 1;
    const overallEnd = poolIndex * golden.pool_size;
    const seeds = source.seeds.map(([teamId, blockId, blockRank], index) => ({
      seed_no: index + 1,
      team_id: teamId,
      block_id: blockId,
      block_rank: blockRank,
      entry: { type: "league_rank", block_id: blockId, rank: blockRank },
      team: { type: "concrete_team", team_id: teamId },
    }));
    const entryByBlock = new Map(seeds.map((seed) => [seed.block_id, seed.entry]));
    const opening = source.opening_block_order.map((blockId) => entryByBlock.get(blockId)!);
    const openingHalf = opening.length / 2;
    const positioned = [
      ...Array.from({ length: openingHalf }, (_, index) => opening[index * 2]!),
      ...Array.from({ length: openingHalf }, (_, index) => opening[index * 2 + 1]!),
    ];
    const matches: JsonObject[] = [];
    const placements: JsonObject[] = [];
    const idCounts = new Map<string, number>();
    const build = (entries: JsonObject[], rankStart: number, roundNo: number): void => {
      if (entries.length === 1) {
        placements.push({
          rank: rankStart,
          pool_rank: rankStart - overallStart + 1,
          entry: entries[0],
        });
        return;
      }
      const rankEnd = rankStart + entries.length - 1;
      const label = rankStart === 1 && entries.length === 2
        ? "優勝決定戦"
        : entries.length === 2
          ? `${String(rankStart)}位決定戦`
          : `${String(rankStart)}〜${String(rankEnd)}位 順位決定`;
      const half = entries.length / 2;
      const winners: JsonObject[] = [];
      const losers: JsonObject[] = [];
      for (let index = 0; index < half; index += 1) {
        const countKey = `${String(rankStart)}:${String(rankEnd)}`;
        const number = (idCounts.get(countKey) ?? 0) + 1;
        idCounts.set(countKey, number);
        const matchId = `PT-${String(poolIndex)}-RANK-${String(rankStart)}-${String(rankEnd)}-M${String(number)}`;
        matches.push({
          id: matchId,
          phase: "placement_tournament",
          pool_id: poolId,
          round: label,
          round_no: roundNo,
          home: entries[index],
          away: entries[index + half],
          rank_range: [rankStart, rankEnd],
        });
        winners.push({ type: "winner_of", match_id: matchId });
        losers.push({ type: "loser_of", match_id: matchId });
      }
      build(winners, rankStart, roundNo + 1);
      build(losers, rankStart + half, roundNo + 1);
    };
    build(positioned, overallStart, 1);
    placements.sort((left, right) => Number(left.rank) - Number(right.rank));
    return {
      pool_id: poolId,
      pool_index: poolIndex,
      display_name: `第${String(poolIndex)}順位決定トーナメント`,
      participant_count: golden.pool_size,
      pool_rank_range: [1, golden.pool_size],
      overall_rank_range: [overallStart, overallEnd],
      seeds,
      matches,
      placements,
      evaluation: {
        first_match_same_block_count: 0,
        possible_same_block_match_count: 0,
        earliest_possible_same_block_round: null,
      },
      logical_layout: goldenLogicalLayout(matches, [overallStart, overallEnd]),
    };
  });
  const seedDraws = pools.flatMap((pool) => {
    const seeds = pool.seeds as Array<{
      team_id: string;
      block_id: string;
      block_rank: number;
      entry: JsonObject;
    }>;
    const rank = seeds[0]!.block_rank;
    return [{
      pool_id: pool.pool_id,
      block_rank: rank,
      candidates: seeds.map((seed) => seed.team_id).sort(),
      decided_order: seeds.map((seed) => seed.team_id),
      candidate_rank_refs: [...seeds]
        .sort((left, right) => left.block_id.localeCompare(right.block_id))
        .map((seed) => seed.entry),
      decided_rank_refs: seeds.map((seed) => seed.entry),
      random_seed: golden.random_seed,
    }];
  });
  return {
    schema_version: "0.2.0",
    format: "placement_tournament",
    status: "COMPLETE",
    participant_resolution: "resolved",
    tournament_count: 2,
    random_seed: golden.random_seed,
    pools,
    seed_draws: seedDraws,
    warnings: [],
  };
}

describe("ローカルトーナメント順位計算", () => {
  it("Python版の通常得点・PK混在golden応答と完全一致する", async () => {
    const input = await fixture();
    const standings = await calculateLocalTournamentStandings({
      tournamentPlan: input.tournament_plan,
      results: [...input.results].reverse(),
    });

    expect(await sha256(canonicalJson(standings))).toBe(
      "3b337c8765372799629dad2759d36ef5edf15da5f6c04d1221890a4328798621",
    );
    expect((standings.standings as JsonObject[]).map((row) => row.rank)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
  });

  it("生成したschema 0.2.0の保存JSONを既存import/export検証で再読込みできる", async () => {
    const document = JSON.parse(await readFile(documentFixture, "utf8")) as TournamentDocument;
    const result = document.tournament.result!;
    const standings = await calculateLocalTournamentStandings({
      tournamentPlan: result.tournament_plan as JsonObject,
      results: result.tournament_results as JsonObject[],
    });
    result.final_standings = standings;

    const restored = parseTournamentJson(serializeTournamentJson(document));
    expect(restored.tournament.result?.final_standings).toEqual(standings);
  });

  it("4・8・16チーム順位帯のPython goldenと一致する", async () => {
    const fixture = await golden();
    expect(fixture.schema_version).toBe("1");
    for (const golden of fixture.cases) {
      const plan = buildGoldenPlan(golden);
      const standings = await calculateLocalTournamentStandings({
        tournamentPlan: plan,
        results: homeWinResults(plan),
      });
      expect(await sha256(canonicalJson(standings)), `順位帯${String(golden.pool_size)}チーム`)
        .toBe(golden.expected_sha256);
    }
  });

  it("結果の重複・未知・不足を区別する", async () => {
    const input = await fixture();
    const diagnostics = new Map((await golden()).diagnostics.map((item) => [item.case, item]));
    const first = input.results[0]!;
    await expect(calculateLocalTournamentStandings({
      tournamentPlan: input.tournament_plan,
      results: [...input.results, first],
    })).rejects.toMatchObject({ code: diagnostics.get("duplicate_result")!.code });
    await expect(calculateLocalTournamentStandings({
      tournamentPlan: input.tournament_plan,
      results: [...input.results, { ...first, match_id: "PT-UNKNOWN" }],
    })).rejects.toMatchObject({ code: diagnostics.get("unknown_result")!.code });
    await expect(calculateLocalTournamentStandings({
      tournamentPlan: input.tournament_plan,
      results: input.results.slice(1),
    })).rejects.toMatchObject({
      code: diagnostics.get("incomplete_results")!.code,
      details: { missing_count: 1 },
    });
  });

  it("参加チーム不一致とPK矛盾をPython版と同じ診断にする", async () => {
    const input = await fixture();
    const diagnostics = new Map((await golden()).diagnostics.map((item) => [item.case, item]));
    const stale = input.results.map((result) => ({ ...result }));
    stale[0]!.home_team_id = "team-99";
    await expect(calculateLocalTournamentStandings({
      tournamentPlan: input.tournament_plan,
      results: stale,
    })).rejects.toMatchObject({ code: diagnostics.get("participant_mismatch")!.code });

    const invalid = input.results.map((result) => ({ ...result }));
    invalid[2]!.penalty_score_home = 3;
    invalid[2]!.penalty_score_away = 2;
    await expect(calculateLocalTournamentStandings({
      tournamentPlan: input.tournament_plan,
      results: invalid,
    })).rejects.toMatchObject({
      code: diagnostics.get("penalty_for_non_draw")!.code,
      details: { reason: diagnostics.get("penalty_for_non_draw")!.reason },
    });
  });

  it("対戦グラフ改変と循環参照を保存前に拒否する", async () => {
    const input = await fixture();
    const diagnostics = new Map((await golden()).diagnostics.map((item) => [item.case, item]));
    const tampered = structuredClone(input.tournament_plan);
    const pools = tampered.pools as JsonObject[];
    const matches = pools[0]!.matches as JsonObject[];
    matches[0]!.away = (matches[1]!.away as JsonObject);
    await expect(calculateLocalTournamentStandings({
      tournamentPlan: tampered,
      results: input.results,
    })).rejects.toMatchObject({
      code: "TOURNAMENT_SOURCE_INVALID",
      details: { reason: "pool_match_graph_invalid" },
    });

    const cyclic = structuredClone(input.tournament_plan);
    const cyclicPools = cyclic.pools as JsonObject[];
    const cyclicMatches = cyclicPools[0]!.matches as JsonObject[];
    cyclicMatches[0]!.home = { type: "winner_of", match_id: cyclicMatches[0]!.id };
    await expect(calculateLocalTournamentStandings({
      tournamentPlan: cyclic,
      results: input.results,
    })).rejects.toBeInstanceOf(LocalTournamentStandingsError);
    await expect(calculateLocalTournamentStandings({
      tournamentPlan: cyclic,
      results: input.results,
    })).rejects.toMatchObject({ code: diagnostics.get("dependency_cycle")!.code });
  });
});
