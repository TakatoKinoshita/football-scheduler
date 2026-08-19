import { describe, expect, it } from "vitest";

import {
  completedSameRankResultsWorkbookFixture,
  SAME_RANK_RESULTS_WORKBOOK_FIXTURE_VERSION,
} from "./same-rank-results-workbook-fixtures";
import {
  buildSameRankResultsWorkbook,
  SameRankResultsWorkbookError,
} from "./same-rank-results-workbook-model";
import type { JsonObject, TournamentDocument } from "./types";
import type { WorkbookSheet } from "./workbook";

function values(sheet: WorkbookSheet): Array<Array<string | number | null>> {
  return sheet.rows.map((row) => row.map((cell) => cell?.value ?? null));
}

function result(document: TournamentDocument): JsonObject {
  return document.tournament.result as JsonObject;
}

function final(document: TournamentDocument): JsonObject {
  return result(document).same_rank_standings as JsonObject;
}

function standingRows(document: TournamentDocument): JsonObject[] {
  return final(document).standings as JsonObject[];
}

function blockIndex(teamId: unknown): number {
  return Math.floor((Number(String(teamId).match(/\d+$/u)?.[0]) - 1) / 4);
}

function scoreForDirectedPair(
  match: JsonObject,
  directed: ReadonlyMap<string, readonly [number, number]>,
): readonly [number, number] {
  const home = blockIndex((match.home_team as JsonObject).team_id);
  const away = blockIndex((match.away_team as JsonObject).team_id);
  const direct = directed.get(`${String(home)}>${String(away)}`);
  if (direct !== undefined) return direct;
  const reverse = directed.get(`${String(away)}>${String(home)}`);
  if (reverse === undefined) throw new Error("対戦scoreがありません。");
  return [reverse[1], reverse[0]];
}

describe("2日目同順位リーグ結果Excel workbookモデル", () => {
  it("version管理された通常・端数・統合・自動順位fixtureを1グループ1sheetへ変換する", async () => {
    expect(SAME_RANK_RESULTS_WORKBOOK_FIXTURE_VERSION).toBe("1.0.0");
    const cases = [
      await completedSameRankResultsWorkbookFixture(16),
      await completedSameRankResultsWorkbookFixture(17),
      await completedSameRankResultsWorkbookFixture(18),
      await completedSameRankResultsWorkbookFixture(18, { policy: "merge_bottom" }),
    ];
    for (const document of cases) {
      const workbook = buildSameRankResultsWorkbook(document);
      const groups = ((result(document).same_rank_plan as JsonObject).groups as JsonObject[]);
      expect(workbook.sheets).toHaveLength(groups.length);
      expect(workbook.fileName).toMatch(/_2日目同順位リーグ結果\.xlsx$/u);
      workbook.sheets.forEach((sheet, index) => {
        const rows = values(sheet);
        expect(rows[0]?.slice(0, 2)).toEqual(["大会名", document.tournament.name]);
        expect(rows[1]?.slice(0, 2)).toEqual(["グループ", groups[index]!.display_name]);
        expect(rows[2]?.slice(0, 2)).toEqual(["保存日時", "2026/08/19 15:00"]);
        expect(rows[5]).toContain("グループ内順位");
        expect(rows[5]).toContain("総合順位");
      });
    }
  });

  it("保存済み対戦結果・集計・グループ順位・総合順位を表示する", async () => {
    const document = await completedSameRankResultsWorkbookFixture(16);
    const workbook = buildSameRankResultsWorkbook(document);
    const sheet = workbook.sheets[0]!;
    const rows = values(sheet);
    const firstGroup = ((result(document).same_rank_plan as JsonObject).groups as JsonObject[])[0]!;
    const firstParticipant = (firstGroup.participants as JsonObject[])[0]!;
    const firstTeam = String((firstParticipant.team as JsonObject).team_id);
    const teamName = (document.tournament.input.teams as JsonObject[])
      .find((team) => team.id === firstTeam)!.name;
    const row = rows.find((candidate) => candidate[0] === teamName)!;
    const saved = standingRows(document).find((standing) => standing.team_id === firstTeam)!;
    expect(row.slice(-9)).toEqual([
      saved.wins,
      saved.draws,
      saved.losses,
      saved.points,
      saved.goals_for,
      saved.goals_against,
      saved.goal_difference,
      saved.group_rank,
      saved.rank,
    ]);
    expect(rows.flat()).toContain("○ 1-0");
    expect(sheet.columns).toHaveLength(14);
  });

  it("全引き分けでは直接対戦値と抽選番号・候補・確定順を表示する", async () => {
    const document = await completedSameRankResultsWorkbookFixture(16, {
      score: () => [1, 1],
    });
    const workbook = buildSameRankResultsWorkbook(document);
    const rows = values(workbook.sheets[0]!);
    expect(rows.some((row) => row[0] === "順位決定記録（直接対戦・抽選）")).toBe(true);
    expect(rows.some((row) => row[0] === "抽選記録")).toBe(true);
    expect(rows).toContainEqual(["抽選番号", 20260803]);
    expect(rows.some((row) => row[0] === "候補" && String(row[1]).includes("チーム"))).toBe(true);
    expect(rows.some((row) => row[0] === "確定順" && String(row[1]).includes(" → "))).toBe(true);
  });

  it("2チーム直接対戦と3チーム以上のミニリーグ監査値を保存値どおり表示する", async () => {
    const directScores = new Map<string, readonly [number, number]>([
      ["0>1", [1, 0]], ["2>0", [1, 0]], ["3>0", [1, 0]],
      ["1>2", [1, 0]], ["3>1", [1, 0]], ["2>3", [1, 0]],
    ]);
    const direct = await completedSameRankResultsWorkbookFixture(16, {
      score: ({ match }) => scoreForDirectedPair(match, directScores),
    });
    const directRows = values(buildSameRankResultsWorkbook(direct).sheets[0]!);
    expect(directRows.filter((row) => row[2] === "直接対戦")).toHaveLength(4);

    const miniScores = new Map<string, readonly [number, number]>([
      ["0>1", [3, 0]], ["1>2", [2, 0]], ["2>0", [1, 0]],
      ["0>3", [3, 2]], ["1>3", [4, 0]], ["2>3", [5, 1]],
    ]);
    const mini = await completedSameRankResultsWorkbookFixture(16, {
      score: ({ match }) => scoreForDirectedPair(match, miniScores),
    });
    const miniRows = values(buildSameRankResultsWorkbook(mini).sheets[0]!);
    expect(miniRows).toContainEqual([1, "チーム1", "直接対戦", 3, 2, 3]);
    expect(miniRows).toContainEqual([2, "チーム5", "直接対戦", 3, -1, 2]);
    expect(miniRows).toContainEqual([3, "チーム9", "直接対戦", 3, -1, 1]);
  });

  it("1チームグループを実試合なしの独立sheetとして表示する", async () => {
    const document = await completedSameRankResultsWorkbookFixture(17);
    const workbook = buildSameRankResultsWorkbook(document);
    const singleton = workbook.sheets.at(-1)!;
    const rows = values(singleton);
    expect(rows[3]?.[0]).toContain("実試合を行わず総合順位を自動確定");
    expect(rows[5]).toContain("グループ内順位");
    expect(rows[6]?.slice(-9)).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 17]);
    expect(rows.flat()).not.toContain("○ 0-0");
  });

  it("同じ入力から同じworkbookを得て大会データを変更しない", async () => {
    const document = await completedSameRankResultsWorkbookFixture(18, { policy: "merge_bottom" });
    const original = structuredClone(document);
    expect(buildSameRankResultsWorkbook(document)).toEqual(buildSameRankResultsWorkbook(document));
    expect(document).toEqual(original);
  });
});

describe("2日目同順位リーグ結果Excelの独立検証", () => {
  it("未確定・参加枠未解決・順位決定トーナメントを拒否する", async () => {
    const noFinal = await completedSameRankResultsWorkbookFixture(16);
    delete result(noFinal).same_rank_standings;
    expect(() => buildSameRankResultsWorkbook(noFinal)).toThrow(expect.objectContaining({
      code: "SAME_RANK_RESULTS_EXPORT_UNAVAILABLE",
    } satisfies Partial<SameRankResultsWorkbookError>));

    const provisional = await completedSameRankResultsWorkbookFixture(16);
    (result(provisional).same_rank_plan as JsonObject).participant_resolution = "provisional";
    expect(() => buildSameRankResultsWorkbook(provisional)).toThrow(expect.objectContaining({
      code: "SAME_RANK_RESULTS_EXPORT_UNAVAILABLE",
    } satisfies Partial<SameRankResultsWorkbookError>));

    const tournament = await completedSameRankResultsWorkbookFixture(16);
    (tournament.tournament.input.final_stage as JsonObject).format = "placement_tournament";
    expect(() => buildSameRankResultsWorkbook(tournament)).toThrow(expect.objectContaining({
      message: "同順位リーグを選択した大会だけが対象です。",
    } satisfies Partial<SameRankResultsWorkbookError>));
  });

  it("結果不足・重複・PK・参加チーム不一致を拒否する", async () => {
    const missing = await completedSameRankResultsWorkbookFixture(16);
    (result(missing).same_rank_league_results as JsonObject[]).pop();
    expect(() => buildSameRankResultsWorkbook(missing)).toThrow(expect.objectContaining({
      code: "SAME_RANK_RESULTS_EXPORT_RESULT_INVALID",
    } satisfies Partial<SameRankResultsWorkbookError>));

    const duplicate = await completedSameRankResultsWorkbookFixture(16);
    const duplicateResults = result(duplicate).same_rank_league_results as JsonObject[];
    duplicateResults.push(structuredClone(duplicateResults[0]!));
    expect(() => buildSameRankResultsWorkbook(duplicate)).toThrow(/重複/u);

    const penalty = await completedSameRankResultsWorkbookFixture(16);
    (result(penalty).same_rank_league_results as JsonObject[])[0]!.penalty_score_home = 3;
    expect(() => buildSameRankResultsWorkbook(penalty)).toThrow(/PK/u);

    const mismatch = await completedSameRankResultsWorkbookFixture(16);
    (result(mismatch).same_rank_league_results as JsonObject[])[0]!.home_team_id = "unknown";
    expect(() => buildSameRankResultsWorkbook(mismatch)).toThrow(/参加チーム/u);
  });

  it("match_results・aggregate・group rank・overall rank・automaticの不一致を拒否する", async () => {
    const matchResults = await completedSameRankResultsWorkbookFixture(16);
    (final(matchResults).match_results as JsonObject[])[0]!.regular_score_home = 99;
    expect(() => buildSameRankResultsWorkbook(matchResults)).toThrow(/検証済み結果/u);

    const aggregate = await completedSameRankResultsWorkbookFixture(16);
    standingRows(aggregate)[0]!.points = 99;
    expect(() => buildSameRankResultsWorkbook(aggregate)).toThrow(/集計値/u);

    const groupRank = await completedSameRankResultsWorkbookFixture(16);
    standingRows(groupRank)[0]!.group_rank = 2;
    expect(() => buildSameRankResultsWorkbook(groupRank)).toThrow(/グループ内順位/u);

    const overall = await completedSameRankResultsWorkbookFixture(16);
    standingRows(overall)[0]!.rank = 2;
    expect(() => buildSameRankResultsWorkbook(overall)).toThrow(/総合順位/u);

    const automatic = await completedSameRankResultsWorkbookFixture(17);
    standingRows(automatic).at(-1)!.automatic = false;
    expect(() => buildSameRankResultsWorkbook(automatic)).toThrow(/グループ内順位または総合順位/u);
  });

  it("直接対戦値・抽選監査値の不一致を拒否する", async () => {
    const headToHead = await completedSameRankResultsWorkbookFixture(16, { score: () => [1, 1] });
    (standingRows(headToHead)[0]!.head_to_head as JsonObject).points = 99;
    expect(() => buildSameRankResultsWorkbook(headToHead)).toThrow(/直接対戦値/u);

    const draw = await completedSameRankResultsWorkbookFixture(16, { score: () => [1, 1] });
    (final(draw).draws as JsonObject[])[0]!.random_seed = 1;
    expect(() => buildSameRankResultsWorkbook(draw)).toThrow(/抽選記録/u);
  });
});
