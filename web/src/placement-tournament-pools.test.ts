import { describe, expect, it } from "vitest";

import { horizontalBracketTournamentFixture } from "../e2e/fixtures";
import { parseTournamentJson, serializeTournamentJson } from "./import-export";
import {
  buildTournamentBracketModel,
  renderTournamentBracket,
} from "./tournament-bracket";
import {
  previewTournamentStandings,
  resolveTournamentProgress,
} from "./tournament-results";
import {
  placementTournamentPools,
  type JsonObject,
  type TournamentDocument,
} from "./types";

describe("複数順位帯のWeb統合", () => {
  it.each([
    { tournamentCount: 3 as const, teamCount: 24 },
    { tournamentCount: 4 as const, teamCount: 32 },
  ])(
    "$teamCountチーム・$tournamentCount順位帯を順番どおり表示・集計・保存する",
    ({ tournamentCount, teamCount }) => {
      const tournamentDocument = horizontalBracketTournamentFixture(8, {
        tournamentCount,
        withTournamentResults: true,
      });
      const result = tournamentDocument.tournament.result as unknown as JsonObject;
      const plan = result.tournament_plan as JsonObject;
      const pools = placementTournamentPools(plan);

      expect(pools.map((pool) => pool.poolId)).toEqual(
        Array.from({ length: tournamentCount }, (_, index) =>
          `placement-${String(index + 1)}`
        ),
      );
      expect(pools.map((pool) => pool.data.overall_rank_range)).toEqual(
        Array.from({ length: tournamentCount }, (_, index) => [index * 8 + 1, index * 8 + 8]),
      );

      const container = document.createElement("section");
      for (const pool of pools) {
        const model = buildTournamentBracketModel({
          plan,
          pool: pool.poolId,
          teamNames: new Map(),
          results: result.tournament_results as JsonObject[],
          finalStandings: result.final_standings as JsonObject,
        });
        const rendered = renderTournamentBracket(model, `${pool.displayName}トーナメント表`);
        rendered.dataset.pool = pool.poolId;
        container.append(rendered);
      }
      expect([...container.querySelectorAll("figure")].map((figure) => figure.dataset.pool))
        .toEqual(pools.map((pool) => pool.poolId));
      expect(container.textContent).toContain(`第${String(tournamentCount)}順位帯トーナメント表`);

      const progress = resolveTournamentProgress(
        plan,
        result.tournament_results as JsonObject[],
      );
      expect(progress.complete).toBe(true);
      expect(previewTournamentStandings(plan, progress).map((row) => row.rank)).toEqual(
        Array.from({ length: teamCount }, (_, index) => index + 1),
      );

      expect(parseTournamentJson(serializeTournamentJson(
        tournamentDocument as unknown as TournamentDocument,
      )))
        .toEqual(tournamentDocument);
    },
  );
});
