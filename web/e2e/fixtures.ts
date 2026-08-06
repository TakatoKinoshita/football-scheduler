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

export const day2ScheduleResult = {
  schema_version: "0.1.0",
  schedule_scope: "day2_tournament",
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
