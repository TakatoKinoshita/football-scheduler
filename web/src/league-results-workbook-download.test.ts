import { describe, expect, it, vi } from "vitest";

import { leagueResultsWorkbookFixture } from "./league-results-workbook-fixtures";
import {
  downloadLeagueResultsWorkbook,
  LeagueResultsWorkbookDownloadError,
  LeagueResultsWorkbookDownloadGuard,
  leagueResultsWorkbookAvailable,
  leagueResultsWorkbookDownloadFileName,
} from "./league-results-workbook-download";
import type { WorkbookFile } from "./workbook";

const fixtureDocument = leagueResultsWorkbookFixture("league-results-direct-4")!.document;

describe("リーグ結果Excel download", () => {
  it("全試合結果と保存済み確定順位が揃ったschema 0.2.0だけを利用可能にする", () => {
    expect(leagueResultsWorkbookAvailable(fixtureDocument)).toBe(true);

    const cases = [
      (document: typeof fixtureDocument) => { delete document.tournament.result; },
      (document: typeof fixtureDocument) => { delete document.tournament.result!.league_standings; },
      (document: typeof fixtureDocument) => {
        document.tournament.result!.league_standings = {
          ...document.tournament.result!.league_standings as object,
          status: "PENDING",
        };
      },
      (document: typeof fixtureDocument) => { document.tournament.result!.league_results = []; },
      (document: typeof fixtureDocument) => {
        const results = document.tournament.result!.league_results as unknown[];
        results.push(structuredClone(results[0]));
      },
      (document: typeof fixtureDocument) => {
        const first = (document.tournament.result!.league_results as Record<string, unknown>[])[0]!;
        first.home_score = -1;
      },
      (document: typeof fixtureDocument) => { document.schemaVersion = "0.1.0"; },
    ];
    for (const change of cases) {
      const document = structuredClone(fixtureDocument);
      change(document);
      expect(leagueResultsWorkbookAvailable(document)).toBe(false);
    }
  });

  it("大会名を安全なfile名へ正規化する", () => {
    expect(leagueResultsWorkbookDownloadFileName("地区/夏季:大会"))
      .toBe("地区_夏季_大会_リーグ戦結果.xlsx");
    expect(leagueResultsWorkbookDownloadFileName(" "))
      .toBe("名称未設定_リーグ戦結果.xlsx");
  });

  it("snapshotを1回だけbuildしてdownloadし、成功時も大会データを変更しない", async () => {
    const input = structuredClone(fixtureDocument);
    input.tournament.name = "地区/夏季:大会";
    const original = structuredClone(input);
    const workbook: WorkbookFile = {
      fileName: "builder-name.xlsx",
      sheets: [{ name: "Aブロック", columns: [], rows: [] }],
    };
    const build = vi.fn(() => workbook);
    const createBlob = vi.fn(async () => new Blob(["xlsx"]));
    const download = vi.fn();

    const result = await downloadLeagueResultsWorkbook(input, { build, createBlob, download });

    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith(input);
    expect(createBlob).toHaveBeenCalledWith({
      ...workbook,
      fileName: "地区_夏季_大会_リーグ戦結果.xlsx",
    });
    expect(download).toHaveBeenCalledWith(expect.any(Blob), result.fileName);
    expect(result).toEqual({ fileName: "地区_夏季_大会_リーグ戦結果.xlsx", size: 4 });
    expect(input).toEqual(original);
  });

  it("生成失敗時は日本語errorへ変換し、大会データを変更しない", async () => {
    const input = structuredClone(fixtureDocument);
    const original = structuredClone(input);
    const modelError = Object.assign(new Error("保存済み順位が試合結果と一致しません。"), {
      name: "LeagueResultsWorkbookError",
    });

    await expect(downloadLeagueResultsWorkbook(input, {
      build: () => { throw modelError; },
      createBlob: async () => new Blob(),
      download: () => undefined,
    })).rejects.toEqual(expect.objectContaining({
      name: "LeagueResultsWorkbookDownloadError",
      message: modelError.message,
      cause: modelError,
    } satisfies Partial<LeagueResultsWorkbookDownloadError>));
    expect(input).toEqual(original);
  });

  it("連打時は最初の処理だけを実行し、成功・失敗後に再実行できる", async () => {
    const guard = new LeagueResultsWorkbookDownloadGuard();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const task = vi.fn(async () => { await waiting; return "done"; });

    const first = guard.run(task);
    expect(guard.active).toBe(true);
    await expect(guard.run(task)).resolves.toBeUndefined();
    expect(task).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toBe("done");
    expect(guard.active).toBe(false);

    await expect(guard.run(async () => { throw new Error("failure"); })).rejects.toThrow("failure");
    expect(guard.active).toBe(false);
    await expect(guard.run(async () => "retry")).resolves.toBe("retry");
  });
});
