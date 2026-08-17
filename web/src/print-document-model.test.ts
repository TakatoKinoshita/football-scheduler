import { describe, expect, it } from "vitest";

import issue75Document from "../e2e/fixtures/issue75-eight-team-document.json";
import {
  horizontalBracketTournamentFixture,
  legacyTournamentFixture,
  sameRankWebFixture,
} from "../e2e/fixtures";
import { buildProductionPrintModel, ProductionPrintError } from "./print-document-model";
import { placementTournamentPools, type JsonObject, type TournamentDocument } from "./types";

function tournamentDocument(): TournamentDocument {
  return structuredClone(issue75Document) as unknown as TournamentDocument;
}

function addTournamentSchedule(document: TournamentDocument): TournamentDocument {
  const result = document.tournament.result as JsonObject;
  const plan = result.tournament_plan as JsonObject;
  const matches = placementTournamentPools(plan).flatMap((pool) =>
    Array.isArray(pool.data.matches) ? pool.data.matches as JsonObject[] : []
  );
  const courts = (document.tournament.input.courts as JsonObject[]).map((court) =>
    String(court.id)
  );
  result.day2_schedule = {
    schema_version: document.schemaVersion,
    schedule_scope: "day2_tournament",
    participant_resolution: plan.participant_resolution,
    status: "FEASIBLE",
    tournament_matches: matches,
    slots: matches.map((match, index) => ({
      day_id: "day2",
      section_no: Math.floor(index / courts.length) + 1,
      court_id: courts[index % courts.length],
      match_id: match.id,
      referee_assignment: { kind: "organizer" },
    })),
  };
  return document;
}

describe("保存済み大会の印刷表示モデル", () => {
  it("1日目を保存値だけから組合せ概要、コート別日程、チーム別予定へ変換する", () => {
    const model = buildProductionPrintModel(tournamentDocument(), "day1");
    expect(model.scope).toBe("day1-league");
    expect(model.fixtureId).toBe("saved-day1-league");
    expect(model.groups).toHaveLength(4);
    expect(model.groups.flatMap((group) => group.members)).toHaveLength(8);
    expect(model.leagueOverview).toMatchObject({
      groupCount: 4,
      courtCount: 3,
      startTimeLabel: "09:30",
    });
    expect(model.courtSchedules).toHaveLength(3);
    expect(model.participantSchedules).toHaveLength(8);
  });

  it("順位確定後トーナメントのチーム名、保存済み結果、正確な時刻を保持する", () => {
    const model = buildProductionPrintModel(tournamentDocument(), "day2");
    expect(model.scope).toBe("day2-tournament");
    expect(model.participantResolution).toBe("resolved");
    expect(model.tournamentPools).toHaveLength(2);
    expect(model.tournamentPools[0]!.participantEntries[0]).toContain("（");
    expect(model.tournamentResults.length).toBeGreaterThan(0);
    expect(model.tournamentOverview).toMatchObject({
      tournamentCount: 2,
      courtCount: 3,
      startTimeLabel: "09:30",
    });
    expect(model.courtSchedules.flatMap((court) => court.rows).length).toBeGreaterThan(0);
  });

  it("仮トーナメントでは確定チーム名を混ぜずリーグ順位枠を表示する", () => {
    const document = tournamentDocument();
    const result = document.tournament.result as JsonObject;
    const plan = result.tournament_plan as JsonObject;
    const schedule = result.day2_schedule as JsonObject;
    plan.participant_resolution = "provisional";
    schedule.participant_resolution = "provisional";
    const model = buildProductionPrintModel(document, "bracket");
    expect(model.participantResolution).toBe("provisional");
    expect(model.tournamentPools[0]!.participantEntries[0]).toMatch(/ブロック \d+位/u);
    expect(model.tournamentPools[0]!.participantEntries[0]).not.toContain("（");
  });

  it("2日目同順位リーグの確定チームと仮順位枠を同じ経路で切り替える", () => {
    const resolved = buildProductionPrintModel(
      sameRankWebFixture(16, { resolved: true }) as unknown as TournamentDocument,
      "day2",
    );
    const provisional = buildProductionPrintModel(
      sameRankWebFixture(16, { resolved: false }) as unknown as TournamentDocument,
      "day2",
    );
    expect(resolved.scope).toBe("day2-same-rank");
    expect(resolved.groups).toHaveLength(4);
    expect(resolved.groups[0]!.members[0]).toMatch(/^チーム/u);
    expect(provisional.groups[0]!.members[0]).toMatch(/ブロック 1位$/u);
    expect(resolved.courtSchedules.flatMap((court) => court.rows)).toHaveLength(24);
    expect(provisional.participantSchedules).toHaveLength(16);
  });

  it("schema 0.1.0の保存済み1日目を変換せず印刷モデルへ読み込む", () => {
    const legacy = legacyTournamentFixture({ withResult: true }) as unknown as TournamentDocument;
    const model = buildProductionPrintModel(legacy, "day1");
    expect(legacy.schemaVersion).toBe("0.1.0");
    expect(model.scope).toBe("day1-league");
    expect(model.groups).toHaveLength(2);
    expect(model.courtSchedules.flatMap((court) => court.rows)).toHaveLength(2);
  });

  it.each([
    [3, 24],
    [4, 32],
  ] as const)("%i順位帯・%iチームのトーナメントをすべて印刷モデルへ含める", (poolCount, teamCount) => {
    const document = addTournamentSchedule(
      horizontalBracketTournamentFixture(8, {
        tournamentCount: poolCount,
      }) as unknown as TournamentDocument,
    );
    const model = buildProductionPrintModel(document, "day2");
    expect(model.tournamentPools).toHaveLength(poolCount);
    expect(model.tournamentOverview?.tournamentCount).toBe(poolCount);
    expect(model.teamNames.size).toBe(teamCount);
    expect(model.courtSchedules.flatMap((court) => court.rows)).toHaveLength(poolCount * 12);
  });

  it("schema 0.1.0の上下トーナメントに全体順位帯を補って印刷する", () => {
    const document = addTournamentSchedule(
      horizontalBracketTournamentFixture(8) as unknown as TournamentDocument,
    );
    const result = document.tournament.result as JsonObject;
    const currentPlan = result.tournament_plan as JsonObject;
    const pools = placementTournamentPools(currentPlan).map((pool) => {
      const legacyPool = structuredClone(pool.data);
      delete legacyPool.overall_rank_range;
      return legacyPool;
    });
    result.tournament_plan = {
      schema_version: "0.1.0",
      status: currentPlan.status,
      participant_resolution: currentPlan.participant_resolution,
      random_seed: currentPlan.random_seed,
      upper: pools[0],
      lower: pools[1],
    };
    document.schemaVersion = "0.1.0";
    const model = buildProductionPrintModel(document, "bracket");
    expect(model.tournamentPools.map((pool) => pool.rankRangeLabel)).toEqual([
      "総合1〜8位",
      "総合9〜16位",
    ]);
  });

  it("2日目日程やトーナメントがないscopeを日本語エラーで拒否する", () => {
    const document = tournamentDocument();
    const result = document.tournament.result as JsonObject;
    delete result.day2_schedule;
    expect(() => buildProductionPrintModel(document, "day2"))
      .toThrowError(ProductionPrintError);
    expect(() => buildProductionPrintModel(document, "day2"))
      .toThrow("2日目日程");
  });
});
