export interface TournamentFixtureOptions {
  name?: string;
  withResult?: boolean;
}

export const scheduleResult = {
  schema_version: "0.1.0",
  status: "OPTIMAL",
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

export function tournamentFixture(options: TournamentFixtureOptions = {}) {
  const document = {
    documentType: "football-scheduler-tournament",
    schemaVersion: "0.1.0",
    updatedAt: "2026-08-05T00:00:00.000Z",
    tournament: {
      name: options.name ?? "E2E地区大会",
      input: {
        schema_version: "0.1.0",
        teams: [
          { id: "team-01", name: "青空FC" },
          { id: "team-02", name: "みどりSC" },
        ],
        courts: [{ id: "court-a", name: "Aコート" }],
        matches: [
          {
            id: "LG-A-M1",
            phase: "league",
            possible_home_team_ids: ["team-01"],
            possible_away_team_ids: ["team-02"],
            prerequisite_match_ids: [],
          },
        ],
        day: {
          start_time: "09:30",
          game_duration_minutes: 35,
          margin_minutes: 5,
          max_sections: 4,
        },
        organizer_capacity: 1,
        random_seed: 20260803,
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
