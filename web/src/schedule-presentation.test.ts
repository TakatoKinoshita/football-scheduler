import { describe, expect, it } from "vitest";

import {
  buildSchedulePresentation,
  defaultScheduleViewMode,
  loadScheduleViewMode,
  saveScheduleViewMode,
  SCHEDULE_VIEW_STORAGE_KEYS,
  type ScheduleViewStorage,
} from "./schedule-presentation";

const courts = [
  { id: "court-b", name: "Bコート" },
  { id: "court-a", name: "Aコート" },
];

const daySettings = {
  start_time: "09:00",
  game_duration_minutes: 35,
  margin_minutes: 10,
  breaks: [{ after_section: 2, duration_minutes: 30 }],
};

describe("日程表示モデル", () => {
  it("1日目は時間順、2日目はコート別を既定にする", () => {
    expect(defaultScheduleViewMode("day1")).toBe("time");
    expect(defaultScheduleViewMode("day2")).toBe("court");
    expect(SCHEDULE_VIEW_STORAGE_KEYS).toEqual({
      day1: "football-scheduler:schedule-view:v1:day1",
      day2: "football-scheduler:schedule-view:v1:day2",
    });
  });

  it("実試合だけを登録コート順・時間順へまとめて表示番号を付ける", () => {
    const result = buildSchedulePresentation({
      dayId: "day2",
      courts,
      slots: [
        { section_no: 2, court_id: "court-a", match_id: "M3", referee: "M1勝者" },
        { section_no: 1, court_id: "court-b", match_id: "M1" },
        { section_no: 1, court_id: "court-a", match_id: null },
        { section_no: 3, court_id: "court-b", match_id: "M4" },
        { section_no: 2, court_id: "court-b", match_id: "M2" },
      ],
      sectionTimings: [
        { section_no: 1, start_time: "09:00:00", match_end: "09:35:00" },
        { section_no: 2, start_time: "09:45:00", match_end: "10:20:00" },
      ],
      daySettings,
    });

    expect(result.timeRows.map((row) => row.matchId)).toEqual(["M1", "M2", "M3", "M4"]);
    expect(result.courtGroups.map((group) => [
      group.court.id,
      group.rows.map((row) => row.matchId),
    ])).toEqual([
      ["court-b", ["M1", "M2", "M4"]],
      ["court-a", ["M3"]],
    ]);
    expect(Object.fromEntries(result.displayNumberByMatchId)).toEqual({
      M1: "A①",
      M2: "A②",
      M4: "A③",
      M3: "B①",
    });
    expect(result.courtGroups[1]?.rows[0]?.slot).toMatchObject({ referee: "M1勝者" });
  });

  it("section_timingsを優先し、欠落分は休憩を含む日設定から再計算する", () => {
    const result = buildSchedulePresentation({
      dayId: "day1",
      courts: [courts[0]!],
      slots: [
        { section_no: 1, court_id: "court-b", match_id: "M1" },
        { section_no: 3, court_id: "court-b", match_id: "M3" },
      ],
      sectionTimings: [{ section_no: 1, start_time: "10:15:00", match_end: "10:50:00" }],
      daySettings,
    });

    expect(result.timeRows.map((row) => [row.matchId, row.timeLabel])).toEqual([
      ["M1", "10:15〜10:50"],
      ["M3", "11:00〜11:35"],
    ]);
  });

  it("時刻を計算できない場合はセクション表記へ戻す", () => {
    const result = buildSchedulePresentation({
      dayId: "day2",
      courts: [courts[0]!],
      slots: [{ section_no: 4, court_id: "court-b", match_id: "M4" }],
      sectionTimings: [],
      daySettings: {},
    });

    expect(result.timeRows[0]).toMatchObject({
      timeLabel: "第4セクション",
      startTime: undefined,
      matchEnd: undefined,
    });
  });

  it("再配置しても試合IDは同じまま表示番号だけを更新する", () => {
    const base = {
      dayId: "day2" as const,
      courts,
      sectionTimings: [],
      daySettings,
    };
    const first = buildSchedulePresentation({
      ...base,
      slots: [
        { section_no: 1, court_id: "court-b", match_id: "M1" },
        { section_no: 2, court_id: "court-b", match_id: "M2" },
      ],
    });
    const moved = buildSchedulePresentation({
      ...base,
      slots: [
        { section_no: 1, court_id: "court-b", match_id: "M2" },
        { section_no: 1, court_id: "court-a", match_id: "M1" },
      ],
    });

    expect([...first.displayNumberByMatchId.keys()].sort()).toEqual(["M1", "M2"]);
    expect([...moved.displayNumberByMatchId.keys()].sort()).toEqual(["M1", "M2"]);
    expect(Object.fromEntries(first.displayNumberByMatchId)).toEqual({ M1: "A①", M2: "A②" });
    expect(Object.fromEntries(moved.displayNumberByMatchId)).toEqual({ M2: "A①", M1: "B①" });
  });

  it("50試合を超えても表示番号を一意にする", () => {
    const result = buildSchedulePresentation({
      dayId: "day2",
      courts: [courts[0]!],
      slots: Array.from({ length: 52 }, (_value, index) => ({
        section_no: index + 1,
        court_id: "court-b",
        match_id: `M${String(index + 1)}`,
      })),
      sectionTimings: [],
      daySettings,
    });

    const values = [...result.displayNumberByMatchId.values()];
    expect(new Set(values).size).toBe(52);
    expect(values[0]).toBe("A①");
    expect(values[49]).toBe("A㊿");
    expect(values[50]).toBe("A(51)");
    expect(values[51]).toBe("A(52)");
  });

  it("登録順の16面をAからPまでのコードへ対応させる", () => {
    const sixteenCourts = Array.from({ length: 16 }, (_value, index) => ({
      id: `court-${String(index + 1)}`,
      name: `第${String(index + 1)}コート`,
    }));
    const result = buildSchedulePresentation({
      dayId: "day2",
      courts: sixteenCourts,
      slots: [{ section_no: 1, court_id: "court-16", match_id: "M-P" }],
      sectionTimings: [],
      daySettings,
    });

    expect(result.courtGroups.map((group) => group.courtCode)).toEqual([
      "A", "B", "C", "D", "E", "F", "G", "H",
      "I", "J", "K", "L", "M", "N", "O", "P",
    ]);
    expect(result.displayNumberByMatchId.get("M-P")).toBe("P①");
  });
});

describe("日程表示モードの端末保存", () => {
  it("保存値を読み書きし、不正値は日別の既定値へ戻す", () => {
    const values = new Map<string, string>();
    const storage: ScheduleViewStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    };

    expect(loadScheduleViewMode("day1", storage)).toBe("time");
    expect(saveScheduleViewMode("day1", "court", storage)).toBe(true);
    expect(loadScheduleViewMode("day1", storage)).toBe("court");
    values.set(SCHEDULE_VIEW_STORAGE_KEYS.day2, "invalid");
    expect(loadScheduleViewMode("day2", storage)).toBe("court");
  });

  it("storageの読書き例外を画面操作へ伝播させない", () => {
    const failingStorage: ScheduleViewStorage = {
      getItem: () => {
        throw new DOMException("blocked");
      },
      setItem: () => {
        throw new DOMException("blocked");
      },
    };

    expect(loadScheduleViewMode("day1", failingStorage)).toBe("time");
    expect(loadScheduleViewMode("day2", failingStorage)).toBe("court");
    expect(saveScheduleViewMode("day1", "court", failingStorage)).toBe(false);
  });
});
