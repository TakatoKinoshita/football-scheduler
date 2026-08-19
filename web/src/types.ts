export const DOCUMENT_TYPE = "football-scheduler-tournament" as const;
export const SCHEMA_VERSION = "0.2.0" as const;
export const LEGACY_SCHEMA_VERSION = "0.1.0" as const;
export const SUPPORTED_SCHEMA_VERSIONS = [LEGACY_SCHEMA_VERSION, SCHEMA_VERSION] as const;

export type SchemaVersion = (typeof SUPPORTED_SCHEMA_VERSIONS)[number];

export type JsonObject = Record<string, unknown>;

export interface PlacementTournamentPool {
  poolId: string;
  poolIndex: number;
  displayName: string;
  data: JsonObject;
  legacyField?: "upper" | "lower";
}

function jsonObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

/** schema 0.2 の順位帯を順序どおり返し、0.1 は閲覧用に上下を正規化する。 */
export function placementTournamentPools(plan: JsonObject): PlacementTournamentPool[] {
  if (Array.isArray(plan.pools)) {
    return plan.pools
      .map((value) => jsonObject(value))
      .filter((value): value is JsonObject => value !== undefined)
      .map((data, index) => ({
        poolId: typeof data.pool_id === "string" ? data.pool_id : `placement-${String(index + 1)}`,
        poolIndex: typeof data.pool_index === "number" ? data.pool_index : index + 1,
        displayName: typeof data.display_name === "string"
          ? data.display_name
          : `第${String(index + 1)}順位決定トーナメント`,
        data,
      }))
      .sort((left, right) => left.poolIndex - right.poolIndex);
  }
  return (["upper", "lower"] as const).flatMap((field, index) => {
    const data = jsonObject(plan[field]);
    return data === undefined ? [] : [{
      poolId: field,
      poolIndex: index + 1,
      displayName: field === "upper" ? "上位トーナメント" : "下位トーナメント",
      data,
      legacyField: field,
    }];
  });
}

export function placementTournamentPool(
  plan: JsonObject,
  poolId: string,
): PlacementTournamentPool | undefined {
  return placementTournamentPools(plan).find((pool) => pool.poolId === poolId);
}

export interface TournamentDocument {
  documentType: typeof DOCUMENT_TYPE;
  schemaVersion: SchemaVersion;
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
        day1_arrival_preferences: [],
        league: {
          block_count: null,
          assignment_mode: "random",
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
          organizer_capacity: 0,
          team_referees_required_after_first: true,
          day2_fallback: "organizer",
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
