import { describe, expect, it, vi } from "vitest";

import {
  buildTournamentBracketModel,
  standardTournamentBracketLayout,
  type TournamentBracketLayoutStrategy,
} from "./tournament-bracket";
import {
  tournamentBracketPreviewFixture,
  tournamentBracketPreviewFixtures,
  TournamentBracketPreviewFixtureError,
  validateTournamentBracketPreviewFixture,
} from "./tournament-bracket-preview-fixtures";
import {
  tournamentBracketPreviewLayout,
  tournamentBracketPreviewLayouts,
} from "./tournament-bracket-preview-layouts";
import type { JsonObject } from "./types";

function rawFixture(id: string): JsonObject {
  const fixture = tournamentBracketPreviewFixture(id);
  if (fixture === undefined) throw new Error(`fixtureがありません: ${id}`);
  return {
    fixture_id: fixture.id,
    description: fixture.description,
    teams: structuredClone(fixture.teams),
    tournament_plan: structuredClone(fixture.tournamentPlan),
    expected: {
      upper_participant_count: fixture.expected.upperParticipantCount,
      upper_match_count: fixture.expected.upperMatchCount,
      upper_bye_count: fixture.expected.upperByeCount,
      lower_participant_count: fixture.expected.lowerParticipantCount,
      opening_preliminary_match_ids: structuredClone(
        fixture.expected.openingPreliminaryMatchIds,
      ),
      opening_byes: fixture.expected.openingByes.map((bye) => ({
        seed_no: bye.seedNo,
        team_id: bye.teamId,
        entry: structuredClone(bye.entry),
        next_match_id: bye.nextMatchId,
      })),
    },
  };
}

function modelFor(id: string) {
  const fixture = tournamentBracketPreviewFixture(id);
  if (fixture === undefined) throw new Error(`fixtureがありません: ${id}`);
  return buildTournamentBracketModel(
    {
      plan: fixture.tournamentPlan,
      pool: "upper",
      teamNames: new Map(fixture.teams.map((team) => [team.id, team.name])),
    },
    standardTournamentBracketLayout,
  );
}

describe("トーナメント表ローカルプレビュー", () => {
  it("8チームの完全順位決定表と文字数境界を固定する", () => {
    const fixture = tournamentBracketPreviewFixture("upper-8");
    expect(fixture).toBeDefined();
    expect(fixture!.teams).toHaveLength(8);
    expect(fixture!.expected).toMatchObject({
      upperParticipantCount: 8,
      upperMatchCount: 12,
      upperByeCount: 0,
      lowerParticipantCount: 0,
      openingPreliminaryMatchIds: [],
      openingByes: [],
    });
    expect(fixture!.teams.some((team) => !/^[A-Za-z]+$/u.test(team.name) && [...team.name].length === 6))
      .toBe(true);
    expect(fixture!.teams.some((team) => /^[A-Za-z]+$/u.test(team.name) && [...team.name].length === 9))
      .toBe(true);
    expect(modelFor(fixture!.id).nodes).toHaveLength(12);
  });

  it("7チームで第1シードと3予備戦を固定する", () => {
    const fixture = tournamentBracketPreviewFixture("upper-7-seeded");
    expect(fixture).toBeDefined();
    expect(fixture!.expected).toMatchObject({
      upperParticipantCount: 7,
      upperMatchCount: 9,
      upperByeCount: 2,
      lowerParticipantCount: 0,
    });
    expect(fixture!.expected.openingPreliminaryMatchIds).toHaveLength(3);
    expect(fixture!.expected.openingByes).toEqual([
      {
        seedNo: 1,
        teamId: "team-04",
        entry: { type: "league_rank", block_id: "D", rank: 1 },
        nextMatchId: "UT-RANK-1-4-M1",
      },
    ]);
    expect(modelFor(fixture!.id).nodes).toHaveLength(9);
  });

  it("同じfixtureとレイアウトから同じモデルを再現する", () => {
    for (const fixture of tournamentBracketPreviewFixtures) {
      expect(modelFor(fixture.id)).toEqual(modelFor(fixture.id));
    }
  });

  it("重複ID、未知参照、文字数超過を拒否する", () => {
    const duplicate = rawFixture("upper-8");
    const duplicatePlan = duplicate.tournament_plan as JsonObject;
    const duplicateUpper = duplicatePlan.upper as JsonObject;
    const duplicateMatches = duplicateUpper.matches as JsonObject[];
    duplicateMatches[1]!.id = duplicateMatches[0]!.id;
    expect(() => validateTournamentBracketPreviewFixture(duplicate)).toThrow(/重複/);

    const unknown = rawFixture("upper-8");
    const unknownPlan = unknown.tournament_plan as JsonObject;
    const unknownUpper = unknownPlan.upper as JsonObject;
    const unknownMatches = unknownUpper.matches as JsonObject[];
    unknownMatches[0]!.home = { type: "winner_of", match_id: "UNKNOWN" };
    expect(() => validateTournamentBracketPreviewFixture(unknown)).toThrow(/未知/);

    const longName = rawFixture("upper-8");
    const teams = longName.teams as JsonObject[];
    teams[0]!.name = "あいうえおかき";
    expect(() => validateTournamentBracketPreviewFixture(longName)).toThrow(/6文字/);
  });

  it("プレビュー用レイアウト名を本番表示とは独立して解決する", () => {
    expect(tournamentBracketPreviewLayout("standard")).toBe(standardTournamentBracketLayout);
    expect(tournamentBracketPreviewLayout("unknown")).toBeUndefined();
    expect(Object.keys(tournamentBracketPreviewLayouts)).toEqual(["standard"]);
  });

  it("注入したレイアウト戦略だけを呼び出す", () => {
    const fixture = tournamentBracketPreviewFixture("upper-8")!;
    const expected = modelFor(fixture.id);
    const build = vi.fn(() => expected);
    const strategy: TournamentBracketLayoutStrategy = { id: "replacement", build };
    const input = {
      plan: fixture.tournamentPlan,
      pool: "upper" as const,
      teamNames: new Map(fixture.teams.map((team) => [team.id, team.name])),
    };
    expect(buildTournamentBracketModel(input, strategy)).toBe(expected);
    expect(build).toHaveBeenCalledOnce();
    expect(build).toHaveBeenCalledWith(input);
  });

  it("fixture以外の形式は専用エラーで拒否する", () => {
    expect(() => validateTournamentBracketPreviewFixture({})).toThrow(
      TournamentBracketPreviewFixtureError,
    );
  });
});
