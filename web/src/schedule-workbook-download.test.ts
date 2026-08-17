import { describe, expect, it, vi } from "vitest";

import tournamentDocumentJson from "../e2e/fixtures/issue75-eight-team-document.json";
import {
  downloadScheduleWorkbook,
  ScheduleWorkbookDownloadError,
  scheduleWorkbookAvailable,
  scheduleWorkbookDownloadFileName,
} from "./schedule-workbook-download";
import type { TournamentDocument } from "./types";
import type { WorkbookFile } from "./workbook";

const document = tournamentDocumentJson as unknown as TournamentDocument;

describe("日程Excel download", () => {
  it("対象日の日程がある場合だけ利用可能にする", () => {
    const empty = structuredClone(document);
    delete empty.tournament.result;
    expect(scheduleWorkbookAvailable(empty, "day1")).toBe(false);
    expect(scheduleWorkbookAvailable(empty, "day2")).toBe(false);
    expect(scheduleWorkbookAvailable(document, "day1")).toBe(true);
    expect(scheduleWorkbookAvailable(document, "day2")).toBe(true);

    const withoutDay2 = structuredClone(document);
    delete withoutDay2.tournament.result!.day2_schedule;
    expect(scheduleWorkbookAvailable(withoutDay2, "day1")).toBe(true);
    expect(scheduleWorkbookAvailable(withoutDay2, "day2")).toBe(false);
  });

  it("対象日を含む安全なfile名を生成する", () => {
    expect(scheduleWorkbookDownloadFileName("地区/夏季:大会", "day1"))
      .toBe("地区_夏季_大会_1日目日程.xlsx");
    expect(scheduleWorkbookDownloadFileName(" ", "day2"))
      .toBe("名称未設定_2日目日程.xlsx");
  });

  it("指定日をbuildしてdownloadし、成功・失敗時とも大会データを変更しない", async () => {
    const input = structuredClone(document);
    const original = structuredClone(input);
    const workbook: WorkbookFile = {
      fileName: "builder-name.xlsx",
      sheets: [{ name: "時間順日程表", columns: [], rows: [] }],
    };
    const build = vi.fn(() => workbook);
    const createBlob = vi.fn(async () => new Blob(["xlsx"]));
    const download = vi.fn();
    const result = await downloadScheduleWorkbook(input, "day2", {
      build,
      createBlob,
      download,
    });

    expect(build).toHaveBeenCalledWith(input, "day2");
    expect(createBlob).toHaveBeenCalledWith({
      ...workbook,
      fileName: "8チーム2ブロック杯_2日目日程.xlsx",
    });
    expect(download).toHaveBeenCalledWith(expect.any(Blob), result.fileName);
    expect(input).toEqual(original);

    const failure = new Error("生成失敗");
    await expect(downloadScheduleWorkbook(input, "day1", {
      build: () => { throw failure; },
      createBlob,
      download,
    })).rejects.toEqual(expect.objectContaining({
      name: "ScheduleWorkbookDownloadError",
      cause: failure,
    } satisfies Partial<ScheduleWorkbookDownloadError>));
    expect(input).toEqual(original);
  });
});
