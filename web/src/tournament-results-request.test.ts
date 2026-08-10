import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildTournamentResultsRequest } from "./tournament-results-request";
import type { JsonObject } from "./types";

const regressionFixture = resolve(
  process.cwd(),
  "../scripts/fixtures/tournament-results-8.json",
);

describe("最終順位確定要求", () => {
  it("Python契約と一致する4フィールドだけを送る", async () => {
    const fixture = JSON.parse(await readFile(regressionFixture, "utf8")) as JsonObject;
    const request = buildTournamentResultsRequest(
      fixture.tournament_plan as JsonObject,
      fixture.results as JsonObject[],
    );

    expect(Object.keys(request)).toEqual([
      "schema_version",
      "request_kind",
      "tournament_plan",
      "results",
    ]);
    expect(request).toEqual(fixture);
    expect(request).not.toHaveProperty("final_stage");
  });

  it("呼び出し元の結果配列を変更しない", () => {
    const plan = { pools: [] };
    const results = [{ match_id: "PT-1" }];
    const request = buildTournamentResultsRequest(plan, results);

    request.results.push({ match_id: "PT-2" });

    expect(results).toEqual([{ match_id: "PT-1" }]);
    expect(plan).toEqual({ pools: [] });
  });
});
