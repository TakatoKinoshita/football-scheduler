import { describe, expect, it, vi } from "vitest";

import { completedSameRankResultsWorkbookFixture } from "./same-rank-results-workbook-fixtures";
import {
  downloadSameRankResultsWorkbook,
  SameRankResultsWorkbookDownloadError,
  SameRankResultsWorkbookDownloadGuard,
  sameRankResultsWorkbookAvailable,
  sameRankResultsWorkbookDownloadFileName,
} from "./same-rank-results-workbook-download";
import type { JsonObject } from "./types";
import type { WorkbookFile } from "./workbook";

describe("2日目同順位リーグ結果Excel download", () => {
  it("参加確定・全結果・保存済み総合順位が揃った同順位リーグだけを利用可能にする", async () => {
    const complete = await completedSameRankResultsWorkbookFixture(16);
    expect(sameRankResultsWorkbookAvailable(complete)).toBe(true);
    const changes = [
      (document: typeof complete) => { delete document.tournament.result; },
      (document: typeof complete) => { delete document.tournament.result!.same_rank_standings; },
      (document: typeof complete) => { document.schemaVersion = "0.1.0"; },
      (document: typeof complete) => {
        (document.tournament.input.final_stage as JsonObject).format = "placement_tournament";
      },
      (document: typeof complete) => {
        (document.tournament.result!.same_rank_plan as JsonObject).participant_resolution = "provisional";
      },
      (document: typeof complete) => {
        (document.tournament.result!.same_rank_league_results as JsonObject[]).pop();
      },
    ];
    for (const change of changes) {
      const document = structuredClone(complete);
      change(document);
      expect(sameRankResultsWorkbookAvailable(document)).toBe(false);
    }
  });

  it("大会名を安全なfile名へ正規化する", () => {
    expect(sameRankResultsWorkbookDownloadFileName("地区/夏季:大会"))
      .toBe("地区_夏季_大会_2日目同順位リーグ結果.xlsx");
    expect(sameRankResultsWorkbookDownloadFileName(" "))
      .toBe("名称未設定_2日目同順位リーグ結果.xlsx");
  });

  it("snapshotを1回だけbuildしてdownloadし、大会データを変更しない", async () => {
    const input = await completedSameRankResultsWorkbookFixture(16, { name: "地区/夏季:大会" });
    const original = structuredClone(input);
    const workbook: WorkbookFile = {
      fileName: "builder.xlsx",
      sheets: [{ name: "予選1位リーグ", columns: [], rows: [] }],
    };
    const build = vi.fn(() => workbook);
    const createBlob = vi.fn(async () => new Blob(["xlsx"]));
    const download = vi.fn();
    const result = await downloadSameRankResultsWorkbook(input, { build, createBlob, download });
    expect(build).toHaveBeenCalledOnce();
    expect(build).toHaveBeenCalledWith(input);
    expect(createBlob).toHaveBeenCalledWith({
      ...workbook,
      fileName: "地区_夏季_大会_2日目同順位リーグ結果.xlsx",
    });
    expect(download).toHaveBeenCalledWith(expect.any(Blob), result.fileName);
    expect(input).toEqual(original);
  });

  it("生成失敗を日本語errorへ変換し、連打を抑止して再実行できる", async () => {
    const input = await completedSameRankResultsWorkbookFixture(16);
    const modelError = Object.assign(new Error("保存済み総合順位が一致しません。"), {
      name: "SameRankResultsWorkbookError",
    });
    await expect(downloadSameRankResultsWorkbook(input, {
      build: () => { throw modelError; },
      createBlob: async () => new Blob(),
      download: () => undefined,
    })).rejects.toEqual(expect.objectContaining({
      name: "SameRankResultsWorkbookDownloadError",
      message: modelError.message,
      cause: modelError,
    } satisfies Partial<SameRankResultsWorkbookDownloadError>));

    const guard = new SameRankResultsWorkbookDownloadGuard();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const task = vi.fn(async () => { await waiting; return "done"; });
    const first = guard.run(task);
    await expect(guard.run(task)).resolves.toBeUndefined();
    expect(task).toHaveBeenCalledOnce();
    release();
    await expect(first).resolves.toBe("done");
    await expect(guard.run(async () => "retry")).resolves.toBe("retry");
  });
});
