export const DOCUMENT_TYPE = "football-scheduler-tournament" as const;
export const SCHEMA_VERSION = "0.1.0" as const;

export type JsonObject = Record<string, unknown>;

export interface TournamentDocument {
  documentType: typeof DOCUMENT_TYPE;
  schemaVersion: typeof SCHEMA_VERSION;
  updatedAt: string;
  tournament: {
    name: string;
    input: JsonObject;
    result?: JsonObject;
  };
}

export function createTournamentDocument(now = new Date()): TournamentDocument {
  return {
    documentType: DOCUMENT_TYPE,
    schemaVersion: SCHEMA_VERSION,
    updatedAt: now.toISOString(),
    tournament: {
      name: "",
      input: {
        schema_version: SCHEMA_VERSION,
        request_kind: "day1_league",
        teams: [],
        courts: [],
        league: {
          block_count: null,
          assignment_mode: "random",
          odd_split_policy: "upper",
        },
        day: {
          id: "day1",
          start_time: "09:30",
          game_duration_minutes: 35,
          margin_minutes: 5,
          max_sections: null,
        },
        day2: {
          id: "day2",
          start_time: "09:30",
          game_duration_minutes: 35,
          margin_minutes: 10,
          max_sections: null,
          end_time: null,
          breaks: [],
        },
        referees: {
          organizer_capacity: 1,
          team_referees_required_after_first: true,
          tournament_fallback: "organizer",
        },
        random_seed: 20260803,
        solver: { max_time_seconds: 30 },
      },
    },
  };
}

export function cloneDocument(document: TournamentDocument): TournamentDocument {
  return structuredClone(document);
}
