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
        teams: [],
        courts: [],
        matches: [],
      },
    },
  };
}

export function cloneDocument(document: TournamentDocument): TournamentDocument {
  return structuredClone(document);
}
