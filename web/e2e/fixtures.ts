import upperEightPreviewJson from "../src/fixtures/tournament-bracket-preview/upper-8.json" with { type: "json" };
import upperSixteenPreviewJson from "../src/fixtures/tournament-bracket-preview/upper-16.json" with { type: "json" };

export interface TournamentFixtureOptions {
  name?: string;
  withResult?: boolean;
}

type PreviewFixture = {
  teams: Array<{ id: string; name: string }>;
  tournament_plan: Record<string, unknown>;
};

function placementTournamentValue(value: unknown, poolIndex: number): unknown {
  if (typeof value === "string") {
    if (value === "upper") return `placement-${String(poolIndex)}`;
    if (value === "upper_tournament") return "placement_tournament";
    if (value.startsWith("UT-")) return `PT-${String(poolIndex)}-${value.slice(3)}`;
    if (value.startsWith("team-") && poolIndex > 1) {
      return `placement-${String(poolIndex)}-${value}`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((child) => placementTournamentValue(child, poolIndex));
  }
  if (value !== null && typeof value === "object") {
    const mapped = Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        placementTournamentValue(child, poolIndex),
      ]),
    );
    if (mapped.block_rank === 1) mapped.block_rank = poolIndex;
    if (mapped.type === "league_rank" && mapped.rank === 1) mapped.rank = poolIndex;
    return mapped;
  }
  return value;
}

function currentPlacementPool(
  value: unknown,
  poolIndex: number,
  participantCount: number,
): Record<string, unknown> {
  const pool = structuredClone(value) as Record<string, unknown>;
  const poolId = `placement-${String(poolIndex)}`;
  const overallStart = (poolIndex - 1) * participantCount + 1;
  const offsetRanges = (child: unknown): unknown => {
    if (Array.isArray(child)) return child.map(offsetRanges);
    if (child === null || typeof child !== "object") return child;
    const mapped = Object.fromEntries(
      Object.entries(child).map(([key, nested]) => [key, offsetRanges(nested)]),
    );
    if (
      Array.isArray(mapped.rank_range)
      && mapped.rank_range.length === 2
      && mapped.rank_range.every((rank) => Number.isInteger(rank))
    ) {
      mapped.rank_range = mapped.rank_range.map((rank) => Number(rank) + overallStart - 1);
    }
    return mapped;
  };
  const converted = offsetRanges(pool) as Record<string, unknown>;
  const matches = (converted.matches as Array<Record<string, unknown>>).map((match) => ({
    ...match,
    phase: "placement_tournament",
    pool_id: poolId,
  }));
  const placements = (pool.placements as Array<Record<string, unknown>>).map((placement) => ({
    ...placement,
    pool_rank: Number(placement.rank),
    rank: overallStart + Number(placement.rank) - 1,
  }));
  delete converted.pool;
  delete converted.byes;
  return {
    ...converted,
    pool_id: poolId,
    pool_index: poolIndex,
    display_name: `第${String(poolIndex)}順位帯`,
    pool_rank_range: [1, participantCount],
    overall_rank_range: [overallStart, overallStart + participantCount - 1],
    matches,
    placements,
  };
}

export function horizontalBracketTournamentFixture(
  participantCount: 8 | 16,
  options: { withTournamentResults?: boolean; tournamentCount?: 2 | 3 | 4 } = {},
) {
  const preview = structuredClone(
    participantCount === 8 ? upperEightPreviewJson : upperSixteenPreviewJson,
  ) as PreviewFixture;
  const legacyPlan = preview.tournament_plan;
  const tournamentCount = options.tournamentCount ?? 2;
  const legacyUpper = legacyPlan.upper;
  const legacyPools = Array.from({ length: tournamentCount }, (_, index) =>
    placementTournamentValue(legacyUpper, index + 1)
  );
  const upperSeedDraws = structuredClone(legacyPlan.seed_draws) as Array<Record<string, unknown>>;
  const plan = {
    schema_version: "0.2.0",
    format: "placement_tournament",
    tournament_count: tournamentCount,
    status: legacyPlan.status,
    participant_resolution: legacyPlan.participant_resolution,
    random_seed: legacyPlan.random_seed,
    pools: legacyPools.map((pool, index) =>
      currentPlacementPool(pool, index + 1, participantCount)
    ),
    seed_draws: legacyPools.flatMap((_pool, index) =>
      upperSeedDraws.map((draw) => ({
        ...(placementTournamentValue(draw, index + 1) as Record<string, unknown>),
        pool_id: `placement-${String(index + 1)}`,
        pool: undefined,
      }))
    ),
    warnings: legacyPlan.warnings,
  };
  const teams = Array.from({ length: tournamentCount }, (_, index) =>
    preview.teams.map((team) => ({
      id: String(placementTournamentValue(team.id, index + 1)),
      name: team.name,
    }))
  ).flat();
  const upper = plan.pools[0] as unknown as {
    seeds: Array<{ block_id: string; team_id: string }>;
  };
  const seedByBlock = new Map(upper.seeds.map((seed) => [seed.block_id, seed.team_id]));
  const blocks = [...seedByBlock].sort(([left], [right]) => left.localeCompare(right)).map(
    ([blockId, teamId]) => ({
      id: blockId,
      team_ids: Array.from({ length: tournamentCount }, (_, index) =>
        String(placementTournamentValue(teamId, index + 1))
      ),
    }),
  );
  const leagueMatches = blocks.map((block) => ({
    id: `LG-${block.id}-M1`,
    phase: "league",
    round: `${block.id}ブロック 第1ラウンド`,
    possible_home_team_ids: [block.team_ids[0]],
    possible_away_team_ids: [block.team_ids[1]],
    prerequisite_match_ids: [],
    organizer_referee_required: false,
  }));
  const courts = ["A", "B", "C", "D"].map((name) => ({
    id: `court-${name.toLowerCase()}`,
    name: `${name}コート`,
  }));
  const slots = leagueMatches.map((match, index) => ({
    day_id: "day1",
    section_no: Math.floor(index / courts.length) + 1,
    court_id: courts[index % courts.length]!.id,
    match_id: match.id,
    referee_assignment: { kind: "organizer" },
  }));
  const sectionCount = Math.ceil(leagueMatches.length / courts.length);
  const sectionTimings = Array.from({ length: sectionCount }, (_, index) => ({
    day_id: "day1",
    section_no: index + 1,
    start_time: `${String(9 + index).padStart(2, "0")}:30`,
    match_end_time: `${String(10 + index).padStart(2, "0")}:05`,
    break_after_minutes: 0,
  }));
  const standings = blocks.flatMap((block) =>
    block.team_ids.map((teamId, index) => ({
      block_id: block.id,
      rank: index + 1,
      team_id: teamId,
      played: tournamentCount - 1,
      wins: tournamentCount - index - 1,
      draws: 0,
      losses: index,
      goals_for: tournamentCount - index - 1,
      goals_against: index,
      goal_difference: tournamentCount - index * 2 - 1,
      points: 3 * (tournamentCount - index - 1),
      tie_break: "勝点",
      head_to_head: null,
    }))
  );
  const document = {
    documentType: "football-scheduler-tournament",
    schemaVersion: "0.2.0",
    updatedAt: "2026-08-09T00:00:00.000Z",
    tournament: {
      name: `水平ブラケット${String(participantCount)}チーム大会`,
      input: {
        schema_version: "0.2.0",
        request_kind: "day1_league",
        teams,
        courts,
        league: {
          block_count: blocks.length,
          assignment_mode: "random",
        },
        final_stage: { format: "placement_tournament", tournament_count: tournamentCount },
        day: {
          id: "day1",
          start_time: "09:30",
          game_duration_minutes: 35,
          margin_minutes: 25,
          max_sections: sectionCount,
          breaks: [],
        },
        referees: {
          organizer_capacity: courts.length,
          team_referees_required_after_first: false,
          day2_fallback: "organizer",
        },
        random_seed: 20260803,
        solver: { max_time_seconds: 30 },
      },
      result: {
        schema_version: "0.2.0",
        status: "OPTIMAL",
        schedule_scope: "day1_league",
        league_plan: {
          schema_version: "0.2.0",
          assignment_mode: "random",
          random_seed: 20260803,
          blocks,
          logical_rounds: blocks.map((block) => ({
            block_id: block.id,
            round_no: 1,
            match_ids: [`LG-${block.id}-M1`],
          })),
          matches: leagueMatches,
        },
        slots,
        section_timings: sectionTimings,
        expected_end_time: sectionTimings.at(-1)?.match_end_time,
        metrics: {
          random_seed: 20260803,
          wall_time_seconds: 0.01,
          used_sections: sectionCount,
          optimality_proven: true,
        },
        diagnostics: [],
        validation: {
          valid: true,
          diagnostics: [],
          summary: {
            checked_match_count: leagueMatches.length,
            checked_slot_count: slots.length,
            error_count: 0,
          },
        },
        league_results: leagueMatches.map((match) => ({
          match_id: match.id,
          home_score: 1,
          away_score: 0,
        })),
        league_standings: {
          schema_version: "0.2.0",
          status: "COMPLETE",
          standings,
          draws: [],
        },
        tournament_plan: plan,
      },
    },
  };
  if (options.withTournamentResults === true) {
    const pools = plan.pools as Array<{
      pool_id: string;
      participant_count: number;
      seeds: Array<Record<string, unknown>>;
      matches: Array<Record<string, unknown>>;
      placements: Array<Record<string, unknown>>;
    }>;
    const teamByRank = new Map<string, string>();
    for (const pool of pools) {
      for (const seed of pool.seeds) {
        teamByRank.set(
          `${String(seed.block_id)}:${String(seed.block_rank)}`,
          String(seed.team_id),
        );
      }
    }
    const outcomes = new Map<string, { winner: string; loser: string }>();
    const tournamentResults: Array<Record<string, unknown>> = [];
    const canonicalResults: Array<Record<string, unknown>> = [];
    const entryTeam = (raw: unknown): string | undefined => {
      const entry = raw as Record<string, unknown>;
      if (entry.type === "concrete_team") return String(entry.team_id);
      if (entry.type === "league_rank") {
        return teamByRank.get(`${String(entry.block_id)}:${String(entry.rank)}`);
      }
      const outcome = outcomes.get(String(entry.match_id));
      if (entry.type === "winner_of") return outcome?.winner;
      if (entry.type === "loser_of") return outcome?.loser;
      return undefined;
    };
    const pending = pools.flatMap((pool) => pool.matches.map((match) => ({ pool, match })));
    while (pending.length > 0) {
      const readyIndex = pending.findIndex(({ match }) =>
        entryTeam(match.home) !== undefined && entryTeam(match.away) !== undefined
      );
      if (readyIndex < 0) {
        throw new Error("E2E用トーナメント結果の依存関係を解決できませんでした。");
      }
      const readyItem = pending.splice(readyIndex, 1)[0];
      if (readyItem === undefined) {
        throw new Error("E2E用トーナメント結果を読み取れませんでした。");
      }
      const { match } = readyItem;
      const homeTeamId = entryTeam(match.home)!;
      const awayTeamId = entryTeam(match.away)!;
      const matchId = String(match.id);
      const penaltyShootout = tournamentResults.length === 0;
      const result = {
        match_id: matchId,
        home_team_id: homeTeamId,
        away_team_id: awayTeamId,
        regular_score_home: penaltyShootout ? 1 : 2,
        regular_score_away: penaltyShootout ? 1 : 0,
        ...(penaltyShootout
          ? { penalty_score_home: 4, penalty_score_away: 3 }
          : {}),
      };
      tournamentResults.push(result);
      outcomes.set(matchId, { winner: homeTeamId, loser: awayTeamId });
      canonicalResults.push({
        ...result,
        penalty_score_home: penaltyShootout ? 4 : null,
        penalty_score_away: penaltyShootout ? 3 : null,
        winner: "home",
        winner_team_id: homeTeamId,
        loser_team_id: awayTeamId,
        decision: penaltyShootout ? "penalty_shootout" : "regular_time",
      });
    }
    const finalStandings = pools.flatMap((pool) => {
      return [...pool.placements]
        .sort((left, right) => Number(left.rank) - Number(right.rank))
        .map((placement) => ({
          rank: Number(placement.rank),
          pool_id: pool.pool_id,
          pool_rank: Number(placement.pool_rank),
          team_id: entryTeam(placement.entry)!,
          entry: placement.entry,
        }));
    });
    const result = document.tournament.result as unknown as Record<string, unknown>;
    result.tournament_results = tournamentResults;
    result.final_standings = {
      schema_version: "0.2.0",
      status: "COMPLETE",
      match_results: canonicalResults,
      standings: finalStandings,
    };
  }
  return document;
}

export const scheduleResult = {
  schema_version: "0.2.0",
  status: "OPTIMAL",
  schedule_scope: "day1_league",
  league_plan: {
    schema_version: "0.2.0",
    assignment_mode: "random",
    random_seed: 20260803,
    blocks: [{ id: "A", team_ids: ["team-01", "team-02"] }],
    logical_rounds: [{ block_id: "A", round_no: 1, match_ids: ["LG-A-M1"] }],
    matches: [
      {
        id: "LG-A-M1",
        phase: "league",
        round: "Aブロック 第1ラウンド",
        possible_home_team_ids: ["team-01"],
        possible_away_team_ids: ["team-02"],
        prerequisite_match_ids: [],
        organizer_referee_required: false,
      },
    ],
  },
  slots: [
    {
      day_id: "day1",
      section_no: 1,
      court_id: "court-a",
      match_id: "LG-A-M1",
      referee_assignment: { kind: "organizer" },
    },
  ],
  metrics: {
    random_seed: 20260803,
    wall_time_seconds: 0.01,
    used_sections: 1,
    optimality_proven: true,
  },
  diagnostics: [],
  validation: {
    valid: true,
    diagnostics: [],
    summary: { checked_match_count: 1, checked_slot_count: 1, error_count: 0 },
  },
};

export const minimumSameRankScheduleResult = {
  ...scheduleResult,
  league_plan: {
    ...scheduleResult.league_plan,
    blocks: [
      { id: "A", team_ids: ["team-01", "team-02"] },
      { id: "B", team_ids: ["team-03", "team-04"] },
    ],
    logical_rounds: [
      { block_id: "A", round_no: 1, match_ids: ["LG-A-M1"] },
      { block_id: "B", round_no: 1, match_ids: ["LG-B-M1"] },
    ],
    matches: [
      scheduleResult.league_plan.matches[0],
      {
        id: "LG-B-M1",
        phase: "league",
        round: "Bブロック 第1ラウンド",
        possible_home_team_ids: ["team-03"],
        possible_away_team_ids: ["team-04"],
        prerequisite_match_ids: [],
        organizer_referee_required: false,
      },
    ],
  },
  slots: [
    scheduleResult.slots[0],
    {
      day_id: "day1",
      section_no: 2,
      court_id: "court-a",
      match_id: "LG-B-M1",
      referee_assignment: { kind: "team", team_id: "team-01" },
    },
  ],
  metrics: {
    ...scheduleResult.metrics,
    used_sections: 2,
  },
  validation: {
    valid: true,
    diagnostics: [],
    summary: { checked_match_count: 2, checked_slot_count: 2, error_count: 0 },
  },
};

export const standingsResult = {
  schema_version: "0.2.0",
  status: "COMPLETE",
  standings: [
    {
      block_id: "A",
      rank: 1,
      team_id: "team-01",
      played: 1,
      wins: 1,
      draws: 0,
      losses: 0,
      goals_for: 2,
      goals_against: 1,
      goal_difference: 1,
      points: 3,
      tie_break: "勝点・得失点差・総得点",
      head_to_head: null,
    },
    {
      block_id: "A",
      rank: 2,
      team_id: "team-02",
      played: 1,
      wins: 0,
      draws: 0,
      losses: 1,
      goals_for: 1,
      goals_against: 2,
      goal_difference: -1,
      points: 0,
      tie_break: "勝点・得失点差・総得点",
      head_to_head: null,
    },
  ],
  draws: [],
};

export const minimumSameRankStandingsResult = {
  ...standingsResult,
  standings: [
    ...standingsResult.standings,
    {
      block_id: "B", rank: 1, team_id: "team-03", played: 1,
      wins: 0, draws: 1, losses: 0, goals_for: 0, goals_against: 0,
      goal_difference: 0, points: 1, tie_break: "勝点・得失点差・総得点", head_to_head: null,
    },
    {
      block_id: "B", rank: 2, team_id: "team-04", played: 1,
      wins: 0, draws: 1, losses: 0, goals_for: 0, goals_against: 0,
      goal_difference: 0, points: 1, tie_break: "勝点・得失点差・総得点", head_to_head: null,
    },
  ],
};

const emptyTournamentEvaluation = {
  first_match_same_block_count: 0,
  possible_same_block_match_count: 0,
  earliest_possible_same_block_round: null,
};

const scheduleViewTeams = [
  { id: "team-01", name: "青空FC" },
  { id: "team-02", name: "みどりSC" },
  { id: "team-03", name: "赤松FC" },
  { id: "team-04", name: "白波SC" },
  { id: "team-05", name: "北星FC" },
  { id: "team-06", name: "南風SC" },
  { id: "team-07", name: "東山FC" },
  { id: "team-08", name: "西海SC" },
];

const scheduleViewBlocks = ["A", "B", "C", "D"].map((id, index) => ({
  id,
  team_ids: [`team-${String(index * 2 + 1).padStart(2, "0")}`, `team-${String(index * 2 + 2).padStart(2, "0")}`],
}));

const scheduleViewLeagueMatches = scheduleViewBlocks.map((block, index) => ({
  id: `LG-${block.id}-M1`,
  phase: "league",
  round: `${block.id}ブロック 第1ラウンド`,
  possible_home_team_ids: [scheduleViewTeams[index * 2]!.id],
  possible_away_team_ids: [scheduleViewTeams[index * 2 + 1]!.id],
  prerequisite_match_ids: [],
  organizer_referee_required: false,
}));

export const scheduleViewDay1Result = {
  schema_version: "0.2.0",
  status: "OPTIMAL",
  schedule_scope: "day1_league",
  league_plan: {
    schema_version: "0.2.0",
    assignment_mode: "random",
    random_seed: 20260803,
    blocks: scheduleViewBlocks,
    logical_rounds: scheduleViewBlocks.map((block) => ({
      block_id: block.id,
      round_no: 1,
      match_ids: [`LG-${block.id}-M1`],
    })),
    matches: scheduleViewLeagueMatches,
  },
  slots: [
    { day_id: "day1", section_no: 1, court_id: "court-a", match_id: "LG-A-M1", referee_assignment: { kind: "organizer" } },
    { day_id: "day1", section_no: 1, court_id: "court-b", match_id: "LG-B-M1", referee_assignment: { kind: "organizer" } },
    { day_id: "day1", section_no: 2, court_id: "court-a", match_id: null, referee_assignment: null },
    { day_id: "day1", section_no: 2, court_id: "court-b", match_id: "LG-C-M1", referee_assignment: { kind: "team", team_id: "team-04" } },
    { day_id: "day1", section_no: 3, court_id: "court-a", match_id: "LG-D-M1", referee_assignment: { kind: "team", team_id: "team-03" } },
    { day_id: "day1", section_no: 3, court_id: "court-b", match_id: null, referee_assignment: null },
  ],
  section_timings: [
    { day_id: "day1", section_no: 1, start_time: "09:30", match_end_time: "10:05", break_after_minutes: 0 },
    { day_id: "day1", section_no: 2, start_time: "10:10", match_end_time: "10:45", break_after_minutes: 0 },
    { day_id: "day1", section_no: 3, start_time: "10:50", match_end_time: "11:25", break_after_minutes: 0 },
  ],
  expected_end_time: "11:25",
  metrics: {
    random_seed: 20260803,
    wall_time_seconds: 0.01,
    used_sections: 3,
    optimality_proven: true,
  },
  diagnostics: [],
  validation: {
    valid: true,
    diagnostics: [],
    summary: { checked_match_count: 4, checked_slot_count: 6, error_count: 0 },
  },
};

const rankRef = (blockId: string, rank: number) => ({
  type: "league_rank",
  block_id: blockId,
  rank,
});
const winnerOf = (matchId: string) => ({ type: "winner_of", match_id: matchId });
const loserOf = (matchId: string) => ({ type: "loser_of", match_id: matchId });

function scheduleViewPool(poolIndex: 1 | 2) {
  const poolId = `placement-${String(poolIndex)}`;
  const prefix = poolIndex === 1 ? "PT-1" : "PT-2";
  const blockRank = poolIndex;
  const overallStart = (poolIndex - 1) * 4 + 1;
  const seeds = ["A", "B", "C", "D"].map((blockId, index) => ({
    seed_no: index + 1,
    team_id: null,
    block_id: blockId,
    block_rank: blockRank,
    entry: rankRef(blockId, blockRank),
    team: null,
  }));
  const matches = [
    {
      id: `${prefix}-SF1`,
      phase: "placement_tournament",
      pool_id: poolId,
      round: "準決勝",
      round_no: 1,
      home: rankRef("A", blockRank),
      away: rankRef("D", blockRank),
      rank_range: [overallStart, overallStart + 3],
    },
    {
      id: `${prefix}-SF2`,
      phase: "placement_tournament",
      pool_id: poolId,
      round: "準決勝",
      round_no: 1,
      home: rankRef("B", blockRank),
      away: rankRef("C", blockRank),
      rank_range: [overallStart, overallStart + 3],
    },
    {
      id: `${prefix}-FINAL`,
      phase: "placement_tournament",
      pool_id: poolId,
      round: "決勝",
      round_no: 2,
      home: winnerOf(`${prefix}-SF1`),
      away: winnerOf(`${prefix}-SF2`),
      rank_range: [overallStart, overallStart + 1],
    },
    {
      id: `${prefix}-PLACE3`,
      phase: "placement_tournament",
      pool_id: poolId,
      round: "3位決定戦",
      round_no: 2,
      home: loserOf(`${prefix}-SF1`),
      away: loserOf(`${prefix}-SF2`),
      rank_range: [overallStart + 2, overallStart + 3],
    },
  ];
  return {
    pool_id: poolId,
    pool_index: poolIndex,
    display_name: `第${String(poolIndex)}順位帯`,
    participant_count: 4,
    pool_rank_range: [1, 4],
    overall_rank_range: [overallStart, overallStart + 3],
    seeds,
    matches,
    placements: [
      { rank: overallStart, pool_rank: 1, entry: winnerOf(`${prefix}-FINAL`) },
      { rank: overallStart + 1, pool_rank: 2, entry: loserOf(`${prefix}-FINAL`) },
      { rank: overallStart + 2, pool_rank: 3, entry: winnerOf(`${prefix}-PLACE3`) },
      { rank: overallStart + 3, pool_rank: 4, entry: loserOf(`${prefix}-PLACE3`) },
    ],
    evaluation: emptyTournamentEvaluation,
  };
}

export const scheduleViewTournamentPlanResult = {
  schema_version: "0.2.0",
  format: "placement_tournament",
  tournament_count: 2,
  status: "COMPLETE",
  participant_resolution: "provisional",
  random_seed: 20260803,
  pools: [scheduleViewPool(1), scheduleViewPool(2)],
  seed_draws: [
    { pool_id: "placement-1", block_rank: 1, candidates: [], decided_order: [], candidate_rank_refs: ["A", "B", "C", "D"].map((id) => rankRef(id, 1)), decided_rank_refs: ["A", "B", "C", "D"].map((id) => rankRef(id, 1)), random_seed: 20260803 },
    { pool_id: "placement-2", block_rank: 2, candidates: [], decided_order: [], candidate_rank_refs: ["A", "B", "C", "D"].map((id) => rankRef(id, 2)), decided_rank_refs: ["A", "B", "C", "D"].map((id) => rankRef(id, 2)), random_seed: 20260803 },
  ],
  warnings: [],
};

const scheduleViewTournamentMatches = [
  ...scheduleViewTournamentPlanResult.pools.flatMap((pool) => pool.matches),
].map((match) => ({
  ...match,
  possible_rank_refs: [rankRef("A", match.pool_id === "placement-1" ? 1 : 2)],
  possible_team_ids: [],
  prerequisite_match_ids: [],
  final: match.id.endsWith("-FINAL"),
}));

const scheduleViewDay2Slots = [
  { day_id: "day2", section_no: 1, court_id: "court-a", match_id: "PT-1-SF1", referee_assignment: { kind: "organizer", organizer_reason: "first_section", fallback_reasons: [] } },
  { day_id: "day2", section_no: 1, court_id: "court-b", match_id: "PT-1-SF2", referee_assignment: { kind: "organizer", organizer_reason: "first_section", fallback_reasons: [] } },
  { day_id: "day2", section_no: 2, court_id: "court-a", match_id: null, referee_assignment: null },
  { day_id: "day2", section_no: 2, court_id: "court-b", match_id: "PT-2-SF1", referee_assignment: { kind: "team", source_match_id: "PT-1-SF2" } },
  { day_id: "day2", section_no: 3, court_id: "court-a", match_id: "PT-1-PLACE3", referee_assignment: { kind: "team", source_match_id: "PT-1-SF1" } },
  { day_id: "day2", section_no: 3, court_id: "court-b", match_id: "PT-2-SF2", referee_assignment: { kind: "team", source_match_id: "PT-2-SF1" } },
  { day_id: "day2", section_no: 4, court_id: "court-a", match_id: "PT-2-FINAL", referee_assignment: { kind: "organizer", organizer_reason: "tournament_final", fallback_reasons: [] } },
  { day_id: "day2", section_no: 4, court_id: "court-b", match_id: "PT-2-PLACE3", referee_assignment: { kind: "team", source_match_id: "PT-2-SF2" } },
  { day_id: "day2", section_no: 5, court_id: "court-a", match_id: "PT-1-FINAL", referee_assignment: { kind: "organizer", organizer_reason: "tournament_final", fallback_reasons: [] } },
  { day_id: "day2", section_no: 5, court_id: "court-b", match_id: null, referee_assignment: null },
];

export const scheduleViewDay2ScheduleResult = {
  schema_version: "0.2.0",
  schedule_scope: "day2_tournament",
  participant_resolution: "provisional",
  status: "OPTIMAL",
  tournament_matches: scheduleViewTournamentMatches,
  slots: scheduleViewDay2Slots,
  section_timings: [
    { day_id: "day2", section_no: 1, start_time: "09:30", match_end_time: "10:05", break_after_minutes: 0 },
    { day_id: "day2", section_no: 2, start_time: "10:15", match_end_time: "10:50", break_after_minutes: 0 },
    { day_id: "day2", section_no: 3, start_time: "11:00", match_end_time: "11:35", break_after_minutes: 0 },
    { day_id: "day2", section_no: 4, start_time: "11:45", match_end_time: "12:20", break_after_minutes: 0 },
    { day_id: "day2", section_no: 5, start_time: "12:30", match_end_time: "13:05", break_after_minutes: 0 },
  ],
  expected_end_time: "13:05",
  team_schedules: scheduleViewDay2Slots.flatMap((slot) => {
    if (slot.match_id === null) return [];
    const match = scheduleViewTournamentMatches.find((candidate) => candidate.id === slot.match_id)!;
    return match.possible_rank_refs.map((rankRef) => ({
      rank_ref: rankRef,
      team_id: null,
      match_id: slot.match_id,
      section_no: slot.section_no,
      court_id: slot.court_id,
      role: "match",
      conditions: [],
    }));
  }),
  metrics: {
    random_seed: 20260803,
    max_time_seconds: 30,
    ortools_version: "test",
    wall_time_seconds: 0.01,
    used_sections: 5,
    objective_value: 5,
    best_objective_bound: 5,
    organizer_referee_count: 4,
    tournament_team_referee_count: 4,
    tournament_referee_fallback_count: 0,
    unused_slot_count: 2,
    placement_tournament_finals: [
      { pool_id: "placement-1", section_no: 5, final_section_gap: 0 },
      { pool_id: "placement-2", section_no: 4, final_section_gap: 1 },
    ],
    non_primary_final_max_gap: 1,
    non_primary_final_sum_gap: 1,
    optimized_objectives: ["used_sections"],
    optimality_proven: true,
  },
  diagnostics: [],
  validation: { valid: true, issues: [], summary: {} },
  integrated_validation: { valid: true, issues: [], summary: {} },
};

export function scheduleViewTournamentFixture() {
  const document = {
    documentType: "football-scheduler-tournament",
    schemaVersion: "0.2.0",
    updatedAt: "2026-08-07T00:00:00.000Z",
    tournament: {
      name: "表示切替大会",
      input: {
        schema_version: "0.2.0",
        request_kind: "day1_league",
        teams: scheduleViewTeams,
        courts: [
          { id: "court-a", name: "Aコート" },
          { id: "court-b", name: "Bコート" },
        ],
        league: { block_count: 4, assignment_mode: "random" },
        final_stage: { format: "placement_tournament", tournament_count: 2 },
        day: { id: "day1", start_time: "09:30", game_duration_minutes: 35, margin_minutes: 5, max_sections: 6, breaks: [] },
        day2: { id: "day2", start_time: "09:30", game_duration_minutes: 35, margin_minutes: 10, max_sections: 8, end_time: null, breaks: [] },
        referees: { organizer_capacity: 2, team_referees_required_after_first: true, day2_fallback: "organizer" },
        random_seed: 20260803,
        solver: { max_time_seconds: 30 },
      },
      result: {
        ...scheduleViewDay1Result,
        tournament_plan: scheduleViewTournamentPlanResult,
        day2_schedule: scheduleViewDay2ScheduleResult,
        integrated_validation: scheduleViewDay2ScheduleResult.integrated_validation,
      },
    },
  };
  return structuredClone(document);
}

export function sameRankWebFixture(
  teamCount: 16 | 17 | 18,
  options: {
    resolved?: boolean;
    policy?: "strict_same_rank" | "merge_bottom";
    teamReferees?: boolean;
  } = {},
) {
  const resolved = options.resolved ?? true;
  const policy = options.policy ?? "strict_same_rank";
  const teamReferees = options.teamReferees ?? false;
  const document = scheduleViewTournamentFixture() as unknown as {
    tournament: { input: Record<string, unknown>; result: Record<string, unknown> };
  };
  const teams = Array.from({ length: teamCount }, (_, index) => ({
    id: `team-${String(index + 1).padStart(2, "0")}`,
    name: `チーム${String(index + 1)}`,
  }));
  const blockCount = 4;
  const q = Math.floor(teamCount / blockCount);
  const r = teamCount % blockCount;
  let cursor = 0;
  const blocks = Array.from({ length: blockCount }, (_, index) => {
    const size = q + (index < r ? 1 : 0);
    const teamIds = teams.slice(cursor, cursor + size).map((team) => team.id);
    cursor += size;
    return { id: String.fromCharCode(65 + index), team_ids: teamIds };
  });
  const leagueMatches: Array<Record<string, unknown>> = [];
  const logicalRounds: Array<Record<string, unknown>> = [];
  for (const block of blocks) {
    for (let home = 0; home < block.team_ids.length; home += 1) {
      for (let away = home + 1; away < block.team_ids.length; away += 1) {
        const id = `LG-${block.id}-M${String(leagueMatches.length + 1)}`;
        leagueMatches.push({
          id,
          phase: "league",
          round: `${block.id}ブロック`,
          possible_home_team_ids: [block.team_ids[home]],
          possible_away_team_ids: [block.team_ids[away]],
          prerequisite_match_ids: [],
          organizer_referee_required: false,
        });
        logicalRounds.push({
          block_id: block.id,
          round_no: logicalRounds.filter((round) => round.block_id === block.id).length + 1,
          match_ids: [id],
        });
      }
    }
  }
  const clock = (section: number, end = false): string => {
    const minutes = 9 * 60 + 30 + (section - 1) * 15 + (end ? 15 : 0);
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00`;
  };
  const standingsRows = blocks.flatMap((block) =>
    block.team_ids.map((teamId, index) => ({
      block_id: block.id,
      rank: index + 1,
      team_id: teamId,
      played: block.team_ids.length - 1,
      wins: block.team_ids.length - index - 1,
      draws: 0,
      losses: index,
      goals_for: block.team_ids.length - index - 1,
      goals_against: index,
      goal_difference: block.team_ids.length - 2 * index - 1,
      points: 3 * (block.team_ids.length - index - 1),
      tie_break: "勝点",
      head_to_head: null,
    })),
  );
  const teamByRank = new Map(
    standingsRows.map((row) => [`${row.block_id}:${String(row.rank)}`, row.team_id]),
  );
  const regularGroupCount = policy === "merge_bottom" && r > 0 ? q - 1 : q;
  const groups = Array.from({ length: regularGroupCount }, (_, index) => {
    const rank = index + 1;
    const participants = blocks.map((block) => {
      const entry = { type: "league_rank", block_id: block.id, rank };
      const teamId = teamByRank.get(`${block.id}:${String(rank)}`)!;
      return { entry, team: resolved ? { type: "concrete_team", team_id: teamId } : null };
    });
    const matches: Array<Record<string, unknown>> = [];
    for (let home = 0; home < participants.length; home += 1) {
      for (let away = home + 1; away < participants.length; away += 1) {
        const id = `SR-${String(rank)}-M${String(matches.length + 1)}`;
        matches.push({
          id,
          phase: "same_rank_league",
          group_id: `same-rank-${String(rank)}`,
          round: `第${String(matches.length + 1)}ラウンド`,
          round_no: matches.length + 1,
          home: participants[home]!.entry,
          away: participants[away]!.entry,
          home_team: participants[home]!.team,
          away_team: participants[away]!.team,
        });
      }
    }
    return {
      id: `same-rank-${String(rank)}`,
      display_name: `${String(rank)}位グループ`,
      source_block_ranks: [rank],
      overall_rank_range: [(rank - 1) * blockCount + 1, rank * blockCount],
      participants,
      logical_rounds: matches.map((match, roundIndex) => ({
        group_id: `same-rank-${String(rank)}`,
        round_no: roundIndex + 1,
        match_ids: [match.id],
      })),
      matches,
    };
  });
  if (r > 0 && policy === "strict_same_rank") {
    const rank = q + 1;
    const participants = blocks.slice(0, r).map((block) => {
      const entry = { type: "league_rank", block_id: block.id, rank };
      const teamId = teamByRank.get(`${block.id}:${String(rank)}`)!;
      return { entry, team: resolved ? { type: "concrete_team", team_id: teamId } : null };
    });
    const matches: Array<Record<string, unknown>> = [];
    for (let home = 0; home < participants.length; home += 1) {
      for (let away = home + 1; away < participants.length; away += 1) {
        matches.push({
          id: `SR-${String(rank)}-M${String(matches.length + 1)}`,
          phase: "same_rank_league",
          group_id: `same-rank-${String(rank)}`,
          round: `第${String(matches.length + 1)}ラウンド`,
          round_no: matches.length + 1,
          home: participants[home]!.entry,
          away: participants[away]!.entry,
          home_team: participants[home]!.team,
          away_team: participants[away]!.team,
        });
      }
    }
    groups.push({
      id: `same-rank-${String(rank)}`,
      display_name: `${String(rank)}位グループ`,
      source_block_ranks: [rank],
      overall_rank_range: [q * blockCount + 1, teamCount],
      participants,
      logical_rounds: matches.map((match, index) => ({
        group_id: `same-rank-${String(rank)}`,
        round_no: index + 1,
        match_ids: [match.id],
      })),
      matches,
    });
  } else if (r > 0) {
    const rank = q;
    const participants = [
      ...blocks.map((block) => ({ block, rank })),
      ...blocks.slice(0, r).map((block) => ({ block, rank: q + 1 })),
    ].map(({ block, rank: participantRank }) => {
      const entry = { type: "league_rank", block_id: block.id, rank: participantRank };
      const teamId = teamByRank.get(`${block.id}:${String(participantRank)}`)!;
      return { entry, team: resolved ? { type: "concrete_team", team_id: teamId } : null };
    });
    const matches: Array<Record<string, unknown>> = [];
    for (let home = 0; home < participants.length; home += 1) {
      for (let away = home + 1; away < participants.length; away += 1) {
        matches.push({
          id: `SR-BOTTOM-M${String(matches.length + 1)}`,
          phase: "same_rank_league",
          group_id: "same-rank-bottom",
          round: `第${String(matches.length + 1)}ラウンド`,
          round_no: matches.length + 1,
          home: participants[home]!.entry,
          away: participants[away]!.entry,
          home_team: participants[home]!.team,
          away_team: participants[away]!.team,
        });
      }
    }
    groups.push({
      id: "same-rank-bottom",
      display_name: "最下位統合グループ",
      source_block_ranks: [q, q + 1],
      overall_rank_range: [(q - 1) * blockCount + 1, teamCount],
      participants,
      logical_rounds: matches.map((match, index) => ({
        group_id: "same-rank-bottom", round_no: index + 1, match_ids: [match.id],
      })),
      matches,
    });
  }
  const activeGroups = groups.filter((group) => group.matches.length > 0);
  const batchCount = Math.ceil(activeGroups.length / 2);
  const scheduledMatches = Array.from(
    { length: Math.max(...activeGroups.map((group) => group.matches.length), 0) },
    (_, matchIndex) => activeGroups.flatMap((group, groupIndex) => {
      const match = group.matches[matchIndex];
      return match === undefined ? [] : [{
        match,
        section: matchIndex * batchCount + Math.floor(groupIndex / 2) + 1,
        court: groupIndex % 2 === 0 ? "court-a" : "court-b",
      }];
    }),
  ).flat();
  const sameRankMatches = groups.flatMap((group) => group.matches);
  const automaticStandings = policy === "strict_same_rank" && r === 1 ? [{
    group_id: `same-rank-${String(q + 1)}`,
    overall_rank: teamCount,
    entry: groups.at(-1)!.participants[0]!.entry,
    team: groups.at(-1)!.participants[0]!.team,
  }] : [];
  document.tournament.input.teams = teams;
  document.tournament.input.league = { block_count: blockCount, assignment_mode: "random" };
  document.tournament.input.final_stage = {
    format: "same_rank_league",
    uneven_policy: policy,
  };
  document.tournament.input.day = {
    id: "day1", start_time: "09:30", game_duration_minutes: 15,
    margin_minutes: 0, max_sections: 40, breaks: [],
  };
  document.tournament.input.day2 = {
    id: "day2", start_time: "09:30", game_duration_minutes: 15,
    margin_minutes: 0, max_sections: 80, end_time: null, breaks: [],
  };
  document.tournament.result = {
    schema_version: "0.2.0",
    status: "OPTIMAL",
    league_plan: {
      schema_version: "0.2.0", assignment_mode: "random", random_seed: 20260803,
      blocks, logical_rounds: logicalRounds, matches: leagueMatches,
    },
    ...(resolved ? {
      league_results: leagueMatches.map((match) => ({
        match_id: match.id, home_score: 1, away_score: 0,
      })),
      league_standings: {
        schema_version: "0.2.0", status: "COMPLETE", standings: standingsRows, draws: [],
      },
    } : {}),
    slots: leagueMatches.map((match, index) => ({
      day_id: "day1", section_no: index + 1, court_id: "court-a", match_id: match.id,
      referee_assignment: { kind: "organizer" },
    })),
    section_timings: leagueMatches.map((_, index) => ({
      day_id: "day1", section_no: index + 1, start_time: clock(index + 1),
      match_end_time: clock(index + 1, true), break_after_minutes: 0,
    })),
    expected_end_time: clock(leagueMatches.length, true),
    metrics: {
      used_sections: leagueMatches.length,
      league_team_referee_counts: teams.map((team) => ({ team_id: team.id, count: 0 })),
      league_team_referee_count_min: 0,
      league_team_referee_count_max: 0,
      league_team_referee_count_difference: 0,
    },
    validation: { valid: true, diagnostics: [], summary: {} },
    same_rank_plan: {
      schema_version: "0.2.0", format: "same_rank_league", status: "COMPLETE",
      participant_resolution: resolved ? "resolved" : "provisional",
      uneven_policy: policy, team_count: teamCount, block_count: blockCount,
      random_seed: 20260803, groups, automatic_standings: automaticStandings,
      warnings: r > 0 ? [
        { code: "SAME_RANK_UNEVEN_BLOCKS", message: "ブロック人数に端数があります。", group_id: null, details: {} },
        ...(policy === "strict_same_rank" && r === 1 ? [{
          code: "SAME_RANK_SINGLETON_GROUP", message: "1チームの順位を自動確定します。",
          group_id: `same-rank-${String(q + 1)}`, details: {},
        }] : []),
      ] : [],
    },
    day2_schedule: {
      schema_version: "0.2.0", schedule_scope: "day2_same_rank_league",
      participant_resolution: resolved ? "resolved" : "provisional", status: "OPTIMAL",
      same_rank_matches: sameRankMatches,
      slots: [],
      section_timings: [], expected_end_time: null, team_schedules: [],
      metrics: {},
      diagnostics: [],
    },
  };
  const schedule = document.tournament.result.day2_schedule as Record<string, unknown>;
  const usedSections = Math.max(...scheduledMatches.map((item) => item.section), 0);
  const byPosition = new Map(
    scheduledMatches.map((item) => [`${String(item.section)}:${item.court}`, item]),
  );
  const rankRefKey = (rankRef: unknown): string => {
    const entry = rankRef as Record<string, unknown>;
    return `${String(entry.block_id)}:${String(entry.rank)}`;
  };
  const teamIdForRankRef = (rankRef: unknown): string | null =>
    resolved ? (teamByRank.get(rankRefKey(rankRef)) ?? null) : null;
  const day2Slots = Array.from({ length: usedSections }, (_, index) => index + 1).flatMap((section) =>
    ["court-a", "court-b"].map((court) => {
      const item = byPosition.get(`${String(section)}:${court}`);
      if (item === undefined) {
        return { day_id: "day2", section_no: section, court_id: court, match_id: null, referee_assignment: null };
      }
      const previous = byPosition.get(`${String(section - 1)}:${court}`);
      const refereeRankRef = teamReferees && section > 1 ? previous?.match.away : undefined;
      return {
        day_id: "day2",
        section_no: section,
        court_id: court,
        match_id: item.match.id,
        referee_assignment: refereeRankRef === undefined
          ? section === 1
            ? { kind: "organizer", rank_ref: null, team_id: null, organizer_reason: "first_section", fallback_reasons: [] }
            : { kind: "organizer", rank_ref: null, team_id: null, organizer_reason: "fallback", fallback_reasons: ["team_referee_unavailable"] }
          : {
              kind: "team",
              rank_ref: refereeRankRef,
              team_id: teamIdForRankRef(refereeRankRef),
              organizer_reason: null,
              fallback_reasons: [],
            },
      };
    })
  );
  schedule.slots = day2Slots;
  schedule.team_schedules = [
    ...scheduledMatches.flatMap((item) =>
      [item.match.home, item.match.away].map((rankRef) => ({
        rank_ref: rankRef,
        team_id: teamIdForRankRef(rankRef),
        role: "match",
        match_id: item.match.id,
        section_no: item.section,
        court_id: item.court,
      }))
    ),
    ...day2Slots.flatMap((slot) => {
      const assignment = slot.referee_assignment as Record<string, unknown> | null;
      return assignment?.kind === "team" ? [{
        rank_ref: assignment.rank_ref,
        team_id: assignment.team_id,
        role: "referee",
        match_id: slot.match_id,
        section_no: slot.section_no,
        court_id: slot.court_id,
      }] : [];
    }),
  ];
  const day2Start = 9 * 60 + 30;
  schedule.section_timings = Array.from({ length: usedSections }, (_, index) => {
    const start = day2Start + index * 15;
    const clockValue = (minutes: number): string =>
      `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00`;
    return {
      day_id: "day2", section_no: index + 1, start_time: clockValue(start),
      match_end_time: clockValue(start + 15), break_after_minutes: 0,
    };
  });
  schedule.expected_end_time = usedSections === 0
    ? null
    : (schedule.section_timings as Array<Record<string, unknown>>).at(-1)!.match_end_time;
  const rankRefs = groups.flatMap((group) =>
    group.participants.map((participant) => participant.entry)
  );
  const refereeCounts = new Map(rankRefs.map((rankRef) => [rankRefKey(rankRef), 0]));
  let organizerCount = 0;
  let fallbackCount = 0;
  let previousSameCourtRefereeCount = 0;
  for (const slot of day2Slots) {
    if (slot.match_id === null) continue;
    const assignment = slot.referee_assignment as Record<string, unknown>;
    if (assignment.kind === "organizer") {
      organizerCount += 1;
      if (slot.section_no > 1) fallbackCount += 1;
    } else {
      const key = rankRefKey(assignment.rank_ref);
      refereeCounts.set(key, (refereeCounts.get(key) ?? 0) + 1);
      previousSameCourtRefereeCount += 1;
    }
  }
  const sectionsByRank = new Map<string, number[]>();
  const rolesByRank = new Map<
    string,
    Array<{ section: number; court: string; role: "match" | "referee" }>
  >();
  const pushRole = (
    rankRef: unknown,
    section: number,
    court: string,
    role: "match" | "referee",
  ): void => {
    const key = rankRefKey(rankRef);
    rolesByRank.set(key, [...(rolesByRank.get(key) ?? []), { section, court, role }]);
  };
  for (const item of scheduledMatches) {
    for (const rankRef of [item.match.home, item.match.away]) {
      const key = rankRefKey(rankRef);
      sectionsByRank.set(key, [...(sectionsByRank.get(key) ?? []), item.section]);
      pushRole(rankRef, item.section, item.court, "match");
    }
  }
  for (const slot of day2Slots) {
    const assignment = slot.referee_assignment as Record<string, unknown> | null;
    if (slot.match_id !== null && assignment?.kind === "team") {
      pushRole(assignment.rank_ref, slot.section_no, slot.court_id, "referee");
    }
  }
  let maximumWait = 0;
  for (const sections of sectionsByRank.values()) {
    const ordered = [...sections].sort((left, right) => left - right);
    for (let index = 1; index < ordered.length; index += 1) {
      maximumWait = Math.max(maximumWait, ordered[index]! - ordered[index - 1]! - 1);
    }
  }
  const courtCounts = ["court-a", "court-b"].map(
    (court) => scheduledMatches.filter((item) => item.court === court).length,
  );
  const refereeCountValues = [...refereeCounts.values()];
  const refereeCountMin = Math.min(...refereeCountValues);
  const refereeCountMax = Math.max(...refereeCountValues);
  let refereeThenMatchCount = 0;
  let gapCourtChangeCount = 0;
  for (const roles of rolesByRank.values()) {
    const ordered = [...roles].sort((left, right) => left.section - right.section);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1]!;
      const current = ordered[index]!;
      if (
        previous.role === "referee" &&
        current.role === "match" &&
        current.section === previous.section + 1
      ) {
        refereeThenMatchCount += 1;
      }
      if (current.section - previous.section > 1 && current.court !== previous.court) {
        gapCourtChangeCount += 1;
      }
    }
  }
  const metricValues: Record<string, number> = {
    used_sections: usedSections,
    referee_count_difference: refereeCountMax - refereeCountMin,
    maximum_team_wait_sections: maximumWait,
    referee_then_match_count: refereeThenMatchCount,
    previous_same_court_referee_count: previousSameCourtRefereeCount,
    gap_court_change_count: gapCourtChangeCount,
    court_usage_difference: Math.max(...courtCounts) - Math.min(...courtCounts),
  };
  const objectives = [
    "used_sections",
    "referee_count_difference",
    "maximum_team_wait_sections",
    "gap_court_change_count",
    "court_usage_difference",
  ];
  const summary = {
    expected_match_count: sameRankMatches.length,
    scheduled_match_count: sameRankMatches.length,
    used_sections: usedSections,
    organizer_referee_count: organizerCount,
    fallback_count: fallbackCount,
    error_count: 0,
  };
  schedule.metrics = {
    random_seed: 20260803,
    num_search_workers: 1,
    max_time_seconds: 10,
    ortools_version: "fixture",
    wall_time_seconds: 0,
    used_sections: usedSections,
    organizer_referee_count: organizerCount,
    fallback_count: fallbackCount,
    unused_slot_count: usedSections * 2 - sameRankMatches.length,
    referee_counts: rankRefs.map((rankRef) => ({
      rank_ref: rankRef,
      team_id: teamIdForRankRef(rankRef),
      count: refereeCounts.get(rankRefKey(rankRef)) ?? 0,
    })),
    referee_count_min: refereeCountMin,
    referee_count_max: refereeCountMax,
    referee_count_difference: metricValues.referee_count_difference,
    maximum_team_wait_sections: maximumWait,
    referee_then_match_count: refereeThenMatchCount,
    previous_same_court_referee_count: previousSameCourtRefereeCount,
    gap_court_change_count: gapCourtChangeCount,
    court_usage_difference: metricValues.court_usage_difference,
    layout_attempt_count: 1,
    optimized_objectives: objectives,
    objective_stages: objectives.map((objective) => ({
      objective,
      value: metricValues[objective],
      optimality_proven: true,
    })),
    optimality_proven: true,
  };
  schedule.validation = { valid: true, diagnostics: [], summary };
  schedule.integrated_validation = {
    valid: true,
    diagnostics: [],
    summary: { day1: {}, day2: summary, error_count: 0 },
  };
  document.tournament.result.integrated_validation = schedule.integrated_validation;
  return structuredClone(document);
}

export function tournamentResultsFixture() {
  const document = structuredClone(scheduleViewTournamentFixture()) as unknown as {
    tournament: { result: Record<string, unknown> };
  };
  const standings = {
    schema_version: "0.2.0",
    status: "COMPLETE",
    standings: scheduleViewBlocks.flatMap((block) =>
      block.team_ids.map((teamId, index) => ({
        block_id: block.id,
        rank: index + 1,
        team_id: teamId,
        played: 1,
        wins: index === 0 ? 1 : 0,
        draws: 0,
        losses: index === 0 ? 0 : 1,
        goals_for: index === 0 ? 1 : 0,
        goals_against: index === 0 ? 0 : 1,
        goal_difference: index === 0 ? 1 : -1,
        points: index === 0 ? 3 : 0,
        tie_break: "勝点",
        head_to_head: null,
      })),
    ),
    draws: [],
  };
  const result = document.tournament.result;
  result.league_results = scheduleViewLeagueMatches.map((match) => ({
    match_id: match.id,
    home_score: 1,
    away_score: 0,
  }));
  result.league_standings = standings;
  const teamsByRank = new Map(
    standings.standings.map((row) => [
      `${row.block_id}:${String(row.rank)}`,
      row.team_id,
    ]),
  );
  const plan = structuredClone(result.tournament_plan) as Record<string, unknown>;
  for (const pool of plan.pools as Array<Record<string, unknown>>) {
    for (const seed of pool.seeds as Array<Record<string, unknown>>) {
      const teamId = teamsByRank.get(`${String(seed.block_id)}:${String(seed.block_rank)}`)!;
      seed.team_id = teamId;
      seed.team = { type: "concrete_team", team_id: teamId };
    }
  }
  for (const draw of plan.seed_draws as Array<Record<string, unknown>>) {
    const candidateRefs = draw.candidate_rank_refs as Array<Record<string, unknown>>;
    const decidedRefs = draw.decided_rank_refs as Array<Record<string, unknown>>;
    draw.candidates = candidateRefs
      .map((entry) => teamsByRank.get(`${String(entry.block_id)}:${String(entry.rank)}`)!)
      .sort();
    draw.decided_order = decidedRefs.map(
      (entry) => teamsByRank.get(`${String(entry.block_id)}:${String(entry.rank)}`)!,
    );
  }
  plan.participant_resolution = "resolved";
  result.tournament_plan = plan;

  const schedule = structuredClone(result.day2_schedule) as Record<string, unknown>;
  for (const match of schedule.tournament_matches as Array<Record<string, unknown>>) {
    const rankRefs = match.possible_rank_refs as Array<Record<string, unknown>>;
    match.possible_team_ids = rankRefs.map(
      (entry) => teamsByRank.get(`${String(entry.block_id)}:${String(entry.rank)}`)!,
    );
  }
  for (const route of schedule.team_schedules as Array<Record<string, unknown>>) {
    const rankRef = route.rank_ref as Record<string, unknown>;
    route.team_id = teamsByRank.get(
      `${String(rankRef.block_id)}:${String(rankRef.rank)}`,
    )!;
  }
  schedule.participant_resolution = "resolved";
  result.day2_schedule = schedule;
  result.integrated_validation = schedule.integrated_validation;
  return document;
}

const resolvedScheduleViewFixture = tournamentResultsFixture();
export const tournamentPlanResult = structuredClone(
  resolvedScheduleViewFixture.tournament.result.tournament_plan,
) as Record<string, unknown>;
export const provisionalTournamentPlanResult = structuredClone(
  scheduleViewTournamentPlanResult,
) as Record<string, unknown>;
export const day2ScheduleResult = structuredClone(
  resolvedScheduleViewFixture.tournament.result.day2_schedule,
) as Record<string, unknown>;
export const provisionalDay2ScheduleResult = structuredClone(
  scheduleViewDay2ScheduleResult,
) as Record<string, unknown>;

export function tournamentFixture(options: TournamentFixtureOptions = {}) {
  const document = {
    documentType: "football-scheduler-tournament",
    schemaVersion: "0.2.0",
    updatedAt: "2026-08-05T00:00:00.000Z",
    tournament: {
      name: options.name ?? "E2E地区大会",
      input: {
        schema_version: "0.2.0",
        request_kind: "day1_league",
        teams: [
          { id: "team-01", name: "青空FC" },
          { id: "team-02", name: "みどりSC" },
          { id: "team-03", name: "中央キッカーズ" },
          { id: "team-04", name: "海浜ユナイテッド" },
        ],
        courts: [{ id: "court-a", name: "Aコート" }],
        league: { block_count: 2, assignment_mode: "random" },
        final_stage: { format: "same_rank_league", uneven_policy: "strict_same_rank" },
        day: {
          id: "day1",
          start_time: "09:30",
          game_duration_minutes: 35,
          margin_minutes: 5,
          max_sections: 4,
        },
        referees: {
          organizer_capacity: 1,
          team_referees_required_after_first: true,
          day2_fallback: "organizer",
        },
        random_seed: 20260803,
        solver: { max_time_seconds: 30 },
      },
    },
  };

  if (options.withResult) {
    return {
      ...document,
      tournament: { ...document.tournament, result: minimumSameRankScheduleResult },
    };
  }
  return document;
}

/** schema 0.1.0の閲覧・印刷専用フローを検証するための明示的な旧文書。 */
export function legacyTournamentFixture(options: TournamentFixtureOptions = {}) {
  const document = structuredClone(tournamentFixture(options)) as ReturnType<
    typeof tournamentFixture
  >;
  document.schemaVersion = "0.1.0" as "0.2.0";
  document.tournament.input.schema_version = "0.1.0";
  document.tournament.input.league = {
    ...document.tournament.input.league,
    odd_split_policy: "upper",
  } as typeof document.tournament.input.league;
  delete (document.tournament.input as Record<string, unknown>).final_stage;
  const referees = document.tournament.input.referees as Record<string, unknown>;
  referees.tournament_fallback = referees.day2_fallback;
  delete referees.day2_fallback;
  if ("result" in document.tournament && document.tournament.result !== undefined) {
    document.tournament.result.schema_version = "0.1.0";
    document.tournament.result.league_plan.schema_version = "0.1.0";
  }
  return document;
}
