import { SCHEMA_VERSION, type JsonObject } from "./types";

export type TournamentResultsApiRequest = JsonObject & {
  schema_version: typeof SCHEMA_VERSION;
  request_kind: "tournament_results";
  tournament_plan: JsonObject;
  results: JsonObject[];
};

/** Python の TournamentResultsRequest と一致する最小の公開要求を組み立てる。 */
export function buildTournamentResultsRequest(
  tournamentPlan: JsonObject,
  results: readonly JsonObject[],
): TournamentResultsApiRequest {
  return {
    schema_version: SCHEMA_VERSION,
    request_kind: "tournament_results",
    tournament_plan: tournamentPlan,
    results: [...results],
  };
}
