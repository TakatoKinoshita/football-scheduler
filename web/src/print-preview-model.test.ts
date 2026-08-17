import { describe, expect, it } from "vitest";

import { printPreviewFixture, printPreviewFixtures } from "./print-preview-fixtures";
import { buildPrintPreviewModel, PrintPreviewFixtureError } from "./print-preview-model";

describe("印刷プレビューfixture", () => {
  it("対象3形式と仮・確定状態を固定データで網羅する", () => {
    expect(printPreviewFixtures.map((fixture) => fixture.id)).toEqual([
      "day1-league-16",
      "day2-same-rank-16-provisional",
      "day2-same-rank-16-resolved",
      "day2-tournament-16-provisional",
      "day2-tournament-16-resolved",
      "day1-league-32",
      "day2-same-rank-32-provisional",
      "day2-same-rank-32-resolved",
      "day2-tournament-32-provisional",
      "day2-tournament-32-resolved",
    ]);
    for (const fixture of printPreviewFixtures) {
      const teamCount = fixture.id.includes("-32") ? 32 : 16;
      const expectedMatches = fixture.scope === "day1-league"
        ? teamCount / 4 * 6
        : fixture.scope === "day2-same-rank"
          ? 4 * (teamCount / 4) * (teamCount / 4 - 1) / 2
          : teamCount === 16 ? 24 : 64;
      expect(fixture.teams).toHaveLength(teamCount);
      expect(fixture.courts).toHaveLength(teamCount === 16 ? 3 : 4);
      expect(fixture.matches).toHaveLength(expectedMatches);
      expect(fixture.savedAt).toBe("2026-08-17T06:00:00.000Z");
    }
    expect(printPreviewFixtures.some((fixture) =>
      fixture.teams.some((team) => [...team.name].length >= 14)
    )).toBe(true);
  });

  it("リーグ系をメタ情報、組分け、コート別日程、チーム別予定へ変換する", () => {
    for (const id of [
      "day1-league-16",
      "day2-same-rank-16-provisional",
      "day2-same-rank-16-resolved",
      "day1-league-32",
      "day2-same-rank-32-provisional",
      "day2-same-rank-32-resolved",
    ]) {
      const model = buildPrintPreviewModel(printPreviewFixture(id)!);
      const teamCount = id.includes("-32") ? 32 : 16;
      const sameRank = id.includes("same-rank");
      const expectedMatches = sameRank
        ? 4 * (teamCount / 4) * (teamCount / 4 - 1) / 2
        : teamCount / 4 * 6;
      expect(model.groups).toHaveLength(sameRank ? 4 : teamCount / 4);
      expect(model.courtSchedules).toHaveLength(teamCount === 16 ? 3 : 4);
      expect(model.courtSchedules.flatMap((court) => court.rows)).toHaveLength(expectedMatches);
      expect(model.participantSchedules).toHaveLength(teamCount);
      expect(model.tournamentPools).toHaveLength(0);
      expect(model.leagueOverview).toMatchObject({
        groupCount: sameRank ? 4 : teamCount / 4,
        courtCount: teamCount === 16 ? 3 : 4,
        matchCount: expectedMatches,
        startTimeLabel: "09:30",
      });
      expect(model.savedAtLabel).toBe("2026/08/17 15:00");
    }
  });

  it("1日目リーグを組合せ概要へ変換する", () => {
    for (const id of ["day1-league-16", "day1-league-32"] as const) {
      const model = buildPrintPreviewModel(printPreviewFixture(id)!);
      const teamCount = id.includes("-32") ? 32 : 16;
      expect(model.leagueOverview).toEqual({
        groupCount: teamCount / 4,
        courtCount: teamCount === 16 ? 3 : 4,
        matchCount: teamCount / 4 * 6,
        startTimeLabel: "09:30",
        endTimeLabel: teamCount === 16 ? "15:30" : "18:10",
      });
    }
  });

  it("同順位リーグの仮参照と順位確定後の長いチーム名を区別する", () => {
    const provisional = buildPrintPreviewModel(
      printPreviewFixture("day2-same-rank-16-provisional")!,
    );
    const resolved = buildPrintPreviewModel(
      printPreviewFixture("day2-same-rank-16-resolved")!,
    );
    expect(provisional.groups[0]!.members).toEqual([
      "Aブロック 1位",
      "Bブロック 1位",
      "Cブロック 1位",
      "Dブロック 1位",
    ]);
    expect(resolved.groups[0]!.members[0]).toBe("北町ジュニアフットボールクラブ");
    expect(provisional.courtSchedules[0]!.rows[0]!.homeLabel).toContain("ブロック");
    expect(resolved.courtSchedules[0]!.rows[0]!.homeLabel).not.toContain("ブロック");
  });

  it("トーナメントを2つの表と構成別コート日程へ変換する", () => {
    for (const id of [
      "day2-tournament-16-provisional",
      "day2-tournament-16-resolved",
      "day2-tournament-32-provisional",
      "day2-tournament-32-resolved",
    ]) {
      const model = buildPrintPreviewModel(printPreviewFixture(id)!);
      const teamCount = id.includes("-32") ? 32 : 16;
      expect(model.tournamentPools.map((pool) => pool.poolId)).toEqual([
        "placement-1",
        "placement-2",
      ]);
      expect(model.groups).toHaveLength(0);
      expect(model.courtSchedules).toHaveLength(teamCount === 16 ? 3 : 4);
      expect(model.participantSchedules).toHaveLength(0);
      expect(model.scheduleByMatchId.size).toBe(teamCount === 16 ? 24 : 64);
      expect(model.tournamentOverview).toEqual({
        tournamentCount: 2,
        courtCount: teamCount === 16 ? 3 : 4,
        matchCount: teamCount === 16 ? 24 : 64,
        startTimeLabel: "09:30",
        endTimeLabel: teamCount === 16 ? "18:20" : "00:20",
      });
      expect(model.tournamentPools.every((pool) =>
        pool.participantEntries.length === teamCount / 2
      )).toBe(true);
    }
  });

  it("トーナメント概要は仮参加枠と確定チーム名を区別する", () => {
    const provisional = buildPrintPreviewModel(
      printPreviewFixture("day2-tournament-16-provisional")!,
    );
    const resolved = buildPrintPreviewModel(
      printPreviewFixture("day2-tournament-16-resolved")!,
    );
    expect(provisional.tournamentPools[0]!.participantEntries[0]).toMatch(/ブロック 1位/u);
    expect(provisional.tournamentPools[0]!.participantEntries[0]).not.toContain("（");
    expect(resolved.tournamentPools[0]!.participantEntries[0]).toContain("（");
    expect(resolved.tournamentPools[0]!.participantEntries[0]).toMatch(/ブロック 1位）$/u);
  });

  it("同じfixtureから同じ表示内容と順序を得る", () => {
    const summarize = (id: string) => {
      const model = buildPrintPreviewModel(printPreviewFixture(id)!);
      return {
        metadata: [model.tournamentName, model.savedAtLabel],
        groups: model.groups,
        courts: model.courtSchedules,
        teams: model.participantSchedules,
        pools: model.tournamentPools.map((pool) => [pool.poolId, pool.heading]),
      };
    };
    expect(summarize("day1-league-16")).toEqual(summarize("day1-league-16"));
    expect(summarize("day2-tournament-16-resolved"))
      .toEqual(summarize("day2-tournament-16-resolved"));
    expect(summarize("day1-league-32")).toEqual(summarize("day1-league-32"));
    expect(summarize("day2-tournament-32-resolved"))
      .toEqual(summarize("day2-tournament-32-resolved"));
  });

  it("未知のコートを含むfixtureを日本語エラーで拒否し、モデルを返さない", () => {
    const fixture = structuredClone(printPreviewFixture("day1-league-16")!);
    fixture.slots[0]!.court_id = "court-unknown";
    expect(() => buildPrintPreviewModel(fixture)).toThrowError(PrintPreviewFixtureError);
    expect(() => buildPrintPreviewModel(fixture)).toThrow("未知のコート");
  });

  it("重複配置または欠落があるfixtureを拒否する", () => {
    const fixture = structuredClone(printPreviewFixture("day1-league-16")!);
    fixture.slots[0]!.match_id = fixture.slots[1]!.match_id;
    expect(() => buildPrintPreviewModel(fixture)).toThrow("日程に1回だけ配置されていません");
  });
});
