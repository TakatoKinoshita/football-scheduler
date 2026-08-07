export interface TournamentFixtureOptions {
  name?: string;
  withResult?: boolean;
}

export const scheduleResult = {
  schema_version: "0.1.0",
  status: "OPTIMAL",
  schedule_scope: "day1_league",
  league_plan: {
    schema_version: "0.1.0",
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

export const standingsResult = {
  schema_version: "0.1.0",
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

const emptyTournamentEvaluation = {
  first_match_same_block_count: 0,
  possible_same_block_match_count: 0,
  earliest_possible_same_block_round: null,
};

export const tournamentPlanResult = {
  schema_version: "0.1.0",
  status: "COMPLETE",
  participant_resolution: "resolved",
  odd_split_policy: "upper",
  random_seed: 20260803,
  upper: {
    pool: "upper",
    participant_count: 1,
    seeds: [
      {
        seed_no: 1,
        team_id: "team-01",
        block_id: "A",
        block_rank: 1,
        entry: { type: "league_rank", block_id: "A", rank: 1 },
        team: { type: "concrete_team", team_id: "team-01" },
      },
    ],
    matches: [],
    byes: [],
    placements: [
      { rank: 1, entry: { type: "league_rank", block_id: "A", rank: 1 } },
    ],
    evaluation: emptyTournamentEvaluation,
  },
  lower: {
    pool: "lower",
    participant_count: 1,
    seeds: [
      {
        seed_no: 1,
        team_id: "team-02",
        block_id: "A",
        block_rank: 2,
        entry: { type: "league_rank", block_id: "A", rank: 2 },
        team: { type: "concrete_team", team_id: "team-02" },
      },
    ],
    matches: [],
    byes: [],
    placements: [
      { rank: 1, entry: { type: "league_rank", block_id: "A", rank: 2 } },
    ],
    evaluation: emptyTournamentEvaluation,
  },
  seed_draws: [],
  warnings: [],
};

export const provisionalTournamentPlanResult = {
  ...tournamentPlanResult,
  participant_resolution: "provisional",
  upper: {
    ...tournamentPlanResult.upper,
    seeds: tournamentPlanResult.upper.seeds.map((seed) => ({
      ...seed,
      team_id: null,
      team: null,
    })),
  },
  lower: {
    ...tournamentPlanResult.lower,
    seeds: tournamentPlanResult.lower.seeds.map((seed) => ({
      ...seed,
      team_id: null,
      team: null,
    })),
  },
};

export const day2ScheduleResult = {
  schema_version: "0.1.0",
  schedule_scope: "day2_tournament",
  participant_resolution: "resolved",
  status: "OPTIMAL",
  tournament_matches: [],
  slots: [],
  section_timings: [],
  expected_end_time: null,
  team_schedules: [],
  metrics: {
    random_seed: 20260803,
    max_time_seconds: 30,
    ortools_version: "test",
    wall_time_seconds: 0,
    used_sections: 0,
    objective_value: 0,
    best_objective_bound: 0,
    organizer_referee_count: 0,
    tournament_team_referee_count: 0,
    tournament_referee_fallback_count: 0,
    optimized_objectives: ["used_sections"],
    optimality_proven: true,
  },
  diagnostics: [],
  validation: { valid: true, issues: [], summary: {} },
  integrated_validation: { valid: true, issues: [], summary: {} },
};

export const provisionalDay2ScheduleResult = {
  ...day2ScheduleResult,
  participant_resolution: "provisional",
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
  schema_version: "0.1.0",
  status: "OPTIMAL",
  schedule_scope: "day1_league",
  league_plan: {
    schema_version: "0.1.0",
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

function scheduleViewPool(pool: "upper" | "lower") {
  const prefix = pool === "upper" ? "UT" : "LT";
  const blockRank = pool === "upper" ? 1 : 2;
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
      phase: `${pool}_tournament`,
      round: "準決勝",
      round_no: 1,
      home: rankRef("A", blockRank),
      away: rankRef("D", blockRank),
      rank_range: [1, 4],
    },
    {
      id: `${prefix}-SF2`,
      phase: `${pool}_tournament`,
      round: "準決勝",
      round_no: 1,
      home: rankRef("B", blockRank),
      away: rankRef("C", blockRank),
      rank_range: [1, 4],
    },
    {
      id: `${prefix}-FINAL`,
      phase: `${pool}_tournament`,
      round: "決勝",
      round_no: 2,
      home: winnerOf(`${prefix}-SF1`),
      away: winnerOf(`${prefix}-SF2`),
      rank_range: [1, 2],
    },
    {
      id: `${prefix}-PLACE3`,
      phase: `${pool}_tournament`,
      round: "3位決定戦",
      round_no: 2,
      home: loserOf(`${prefix}-SF1`),
      away: loserOf(`${prefix}-SF2`),
      rank_range: [3, 4],
    },
  ];
  return {
    pool,
    participant_count: 4,
    seeds,
    matches,
    byes: [],
    placements: [
      { rank: 1, entry: winnerOf(`${prefix}-FINAL`) },
      { rank: 2, entry: loserOf(`${prefix}-FINAL`) },
      { rank: 3, entry: winnerOf(`${prefix}-PLACE3`) },
      { rank: 4, entry: loserOf(`${prefix}-PLACE3`) },
    ],
    evaluation: emptyTournamentEvaluation,
  };
}

export const scheduleViewTournamentPlanResult = {
  schema_version: "0.1.0",
  status: "COMPLETE",
  participant_resolution: "provisional",
  odd_split_policy: "upper",
  random_seed: 20260803,
  upper: scheduleViewPool("upper"),
  lower: scheduleViewPool("lower"),
  seed_draws: [
    { pool: "upper", block_rank: 1, candidates: [], decided_order: [], candidate_rank_refs: ["A", "B", "C", "D"].map((id) => rankRef(id, 1)), decided_rank_refs: ["A", "B", "C", "D"].map((id) => rankRef(id, 1)), random_seed: 20260803 },
    { pool: "lower", block_rank: 2, candidates: [], decided_order: [], candidate_rank_refs: ["A", "B", "C", "D"].map((id) => rankRef(id, 2)), decided_rank_refs: ["A", "B", "C", "D"].map((id) => rankRef(id, 2)), random_seed: 20260803 },
  ],
  warnings: [],
};

const scheduleViewTournamentMatches = [
  ...scheduleViewTournamentPlanResult.upper.matches,
  ...scheduleViewTournamentPlanResult.lower.matches,
].map((match) => ({
  ...match,
  possible_rank_refs: [rankRef("A", match.phase === "upper_tournament" ? 1 : 2)],
  possible_team_ids: [],
  prerequisite_match_ids: [],
  preliminary: false,
  final: match.id.endsWith("FINAL"),
}));

const scheduleViewDay2Slots = [
  { day_id: "day2", section_no: 1, court_id: "court-a", match_id: "UT-SF1", referee_assignment: { kind: "organizer", organizer_reason: "first_section", fallback_reasons: [] } },
  { day_id: "day2", section_no: 1, court_id: "court-b", match_id: "UT-SF2", referee_assignment: { kind: "organizer", organizer_reason: "first_section", fallback_reasons: [] } },
  { day_id: "day2", section_no: 2, court_id: "court-a", match_id: null, referee_assignment: null },
  { day_id: "day2", section_no: 2, court_id: "court-b", match_id: "LT-SF1", referee_assignment: { kind: "team", source_match_id: "UT-SF2" } },
  { day_id: "day2", section_no: 3, court_id: "court-a", match_id: "UT-PLACE3", referee_assignment: { kind: "team", source_match_id: "UT-SF1" } },
  { day_id: "day2", section_no: 3, court_id: "court-b", match_id: "LT-SF2", referee_assignment: { kind: "team", source_match_id: "LT-SF1" } },
  { day_id: "day2", section_no: 4, court_id: "court-a", match_id: "UT-FINAL", referee_assignment: { kind: "organizer", organizer_reason: "tournament_final", fallback_reasons: [] } },
  { day_id: "day2", section_no: 4, court_id: "court-b", match_id: "LT-PLACE3", referee_assignment: { kind: "team", source_match_id: "LT-SF2" } },
  { day_id: "day2", section_no: 5, court_id: "court-a", match_id: "LT-FINAL", referee_assignment: { kind: "organizer", organizer_reason: "tournament_final", fallback_reasons: [] } },
  { day_id: "day2", section_no: 5, court_id: "court-b", match_id: null, referee_assignment: null },
];

export const scheduleViewDay2ScheduleResult = {
  schema_version: "0.1.0",
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
    optimized_objectives: ["used_sections"],
    optimality_proven: true,
  },
  diagnostics: [],
  validation: { valid: true, issues: [], summary: {} },
  integrated_validation: { valid: true, issues: [], summary: {} },
};

export function scheduleViewTournamentFixture() {
  return {
    documentType: "football-scheduler-tournament",
    schemaVersion: "0.1.0",
    updatedAt: "2026-08-07T00:00:00.000Z",
    tournament: {
      name: "表示切替大会",
      input: {
        schema_version: "0.1.0",
        request_kind: "day1_league",
        teams: scheduleViewTeams,
        courts: [
          { id: "court-a", name: "Aコート" },
          { id: "court-b", name: "Bコート" },
        ],
        league: { block_count: 4, assignment_mode: "random", odd_split_policy: "upper" },
        day: { id: "day1", start_time: "09:30", game_duration_minutes: 35, margin_minutes: 5, max_sections: 6, breaks: [] },
        day2: { id: "day2", start_time: "09:30", game_duration_minutes: 35, margin_minutes: 10, max_sections: 8, end_time: null, breaks: [] },
        referees: { organizer_capacity: 2, team_referees_required_after_first: true, tournament_fallback: "organizer" },
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
}

export function tournamentResultsFixture() {
  const document = structuredClone(scheduleViewTournamentFixture()) as unknown as {
    tournament: { result: Record<string, unknown> };
  };
  const standings = {
    schema_version: "0.1.0",
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
  for (const poolName of ["upper", "lower"]) {
    const pool = plan[poolName] as Record<string, unknown>;
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

export function tournamentFixture(options: TournamentFixtureOptions = {}) {
  const document = {
    documentType: "football-scheduler-tournament",
    schemaVersion: "0.1.0",
    updatedAt: "2026-08-05T00:00:00.000Z",
    tournament: {
      name: options.name ?? "E2E地区大会",
      input: {
        schema_version: "0.1.0",
        request_kind: "day1_league",
        teams: [
          { id: "team-01", name: "青空FC" },
          { id: "team-02", name: "みどりSC" },
        ],
        courts: [{ id: "court-a", name: "Aコート" }],
        league: { block_count: 1, assignment_mode: "random", odd_split_policy: "upper" },
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
        },
        random_seed: 20260803,
        solver: { max_time_seconds: 30 },
      },
    },
  };

  if (options.withResult) {
    return {
      ...document,
      tournament: { ...document.tournament, result: scheduleResult },
    };
  }
  return document;
}
