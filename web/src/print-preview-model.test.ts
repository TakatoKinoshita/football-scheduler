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
    ]);
    for (const fixture of printPreviewFixtures) {
      expect(fixture.teams).toHaveLength(16);
      expect(fixture.courts).toHaveLength(3);
      expect(fixture.matches).toHaveLength(24);
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
    ]) {
      const model = buildPrintPreviewModel(printPreviewFixture(id)!);
      expect(model.groups).toHaveLength(4);
      expect(model.courtSchedules).toHaveLength(3);
      expect(model.courtSchedules.flatMap((court) => court.rows)).toHaveLength(24);
      expect(model.participantSchedules).toHaveLength(16);
      expect(model.tournamentPools).toHaveLength(0);
      expect(model.savedAtLabel).toBe("2026/08/17 15:00");
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

  it("トーナメントを2つの表と3コートの日程へ変換する", () => {
    for (const id of [
      "day2-tournament-16-provisional",
      "day2-tournament-16-resolved",
    ]) {
      const model = buildPrintPreviewModel(printPreviewFixture(id)!);
      expect(model.tournamentPools.map((pool) => pool.poolId)).toEqual([
        "placement-1",
        "placement-2",
      ]);
      expect(model.courtSchedules).toHaveLength(3);
      expect(model.participantSchedules).toHaveLength(0);
      expect(model.scheduleByMatchId.size).toBe(24);
    }
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
