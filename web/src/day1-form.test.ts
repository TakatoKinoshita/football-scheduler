import { describe, expect, it } from "vitest";

import {
  buildDay1ScheduleRequest,
  issuesFromApiDetails,
  normalizeDocument,
  validateDay1LeagueDocument,
} from "./day1-form";
import { createTournamentDocument } from "./types";

describe("1日目リーグ入力", () => {
  it("大会文書の2日目設定を1日目API要求へ含めない", () => {
    const document = createTournamentDocument();

    const request = buildDay1ScheduleRequest(document.tournament.input);

    expect(request).toEqual({
      schema_version: "0.1.0",
      request_kind: "day1_league",
      teams: document.tournament.input.teams,
      courts: document.tournament.input.courts,
      league: document.tournament.input.league,
      day: document.tournament.input.day,
      referees: document.tournament.input.referees,
      random_seed: 20260803,
      solver: { max_time_seconds: 30 },
    });
    expect(request).not.toHaveProperty("day2");
    expect(document.tournament.input).toHaveProperty("day2");
  });

  it("自動方式では保存中の手動下書きをAPI要求から除外する", () => {
    const document = createTournamentDocument();
    document.tournament.input.league = {
      block_count: 2,
      assignment_mode: "random",
      manual_blocks: [{ id: "A", team_ids: ["team-01"] }],
    };

    expect(buildDay1ScheduleRequest(document.tournament.input).league).toEqual({
      block_count: 2,
      assignment_mode: "random",
    });
  });

  it("手動方式では割当てをAPI要求へ含める", () => {
    const document = createTournamentDocument();
    const manualBlocks = [
      { id: "A", team_ids: ["team-01", "team-03"] },
      { id: "B", team_ids: ["team-02", "team-04"] },
    ];
    document.tournament.input.league = {
      block_count: 2,
      assignment_mode: "manual",
      manual_blocks: manualBlocks,
    };

    expect(buildDay1ScheduleRequest(document.tournament.input).league).toMatchObject({
      assignment_mode: "manual",
      manual_blocks: manualBlocks,
    });
  });

  it("旧画面の未完成draftをチームとコートを保って移行する", () => {
    const document = createTournamentDocument(new Date("2026-08-06T00:00:00Z"));
    document.tournament.input = {
      schema_version: "0.1.0",
      teams: [
        { id: "team-01", name: "青空FC" },
        { id: "team-02", name: "みどりSC" },
      ],
      courts: [{ id: "court-01", name: "Aコート" }],
      matches: [],
    };

    const normalized = normalizeDocument(document);

    expect(normalized.migrated).toBe(true);
    expect(normalized.legacyCompatibility).toBe(false);
    expect(normalized.document.tournament.input).toMatchObject({
      request_kind: "day1_league",
      teams: document.tournament.input.teams,
      courts: document.tournament.input.courts,
      league: { block_count: null, assignment_mode: "random" },
      day: { start_time: "09:30", game_duration_minutes: 35, margin_minutes: 5 },
      referees: { organizer_capacity: 1 },
    });
  });

  it("完成済み試合を含む従来入力は互換モードで変更しない", () => {
    const document = createTournamentDocument();
    document.tournament.input = {
      schema_version: "0.1.0",
      teams: [{ id: "A", name: "青" }, { id: "B", name: "赤" }],
      courts: [{ id: "court-a", name: "Aコート" }],
      matches: [{ id: "M1" }],
      day: { id: "day1" },
      referees: { organizer_capacity: 1 },
    };

    const normalized = normalizeDocument(document);

    expect(normalized.migrated).toBe(false);
    expect(normalized.legacyCompatibility).toBe(true);
    expect(normalized.document).toBe(document);
  });

  it("ブロック数未選択を手順2の具体的なエラーにする", () => {
    const document = createTournamentDocument();
    document.tournament.name = "地区大会";
    document.tournament.input.teams = [
      { id: "team-01", name: "青" },
      { id: "team-02", name: "赤" },
    ];
    document.tournament.input.courts = [{ id: "court-01", name: "Aコート" }];

    expect(validateDay1LeagueDocument(document)).toContainEqual({
      field: "block-count",
      step: 2,
      message: "ブロック数を選択してください。",
    });
  });

  it("有効な初期設定では入力エラーがない", () => {
    const document = createTournamentDocument();
    document.tournament.name = "地区大会";
    document.tournament.input.teams = [
      { id: "team-01", name: "青" },
      { id: "team-02", name: "赤" },
    ];
    document.tournament.input.courts = [{ id: "court-01", name: "Aコート" }];
    document.tournament.input.league = { block_count: 1, assignment_mode: "random" };

    expect(validateDay1LeagueDocument(document)).toEqual([]);
  });

  it("有効な手動割当てを受理する", () => {
    const document = createTournamentDocument();
    document.tournament.name = "地区大会";
    document.tournament.input.teams = [
      { id: "team-01", name: "青" },
      { id: "team-02", name: "赤" },
      { id: "team-03", name: "白" },
      { id: "team-04", name: "緑" },
    ];
    document.tournament.input.courts = [{ id: "court-01", name: "Aコート" }];
    document.tournament.input.league = {
      block_count: 2,
      assignment_mode: "manual",
      manual_blocks: [
        { id: "A", team_ids: ["team-01", "team-03"] },
        { id: "B", team_ids: ["team-02", "team-04"] },
      ],
    };

    expect(validateDay1LeagueDocument(document)).toEqual([]);
  });

  it("手動割当ての未選択と人数不均衡をチーム別エラーにする", () => {
    const document = createTournamentDocument();
    document.tournament.name = "地区大会";
    document.tournament.input.teams = [
      { id: "team-01", name: "青" },
      { id: "team-02", name: "赤" },
      { id: "team-03", name: "白" },
      { id: "team-04", name: "緑" },
      { id: "team-05", name: "黄" },
    ];
    document.tournament.input.courts = [{ id: "court-01", name: "Aコート" }];
    document.tournament.input.league = {
      block_count: 2,
      assignment_mode: "manual",
      manual_blocks: [
        { id: "A", team_ids: ["team-01", "team-02", "team-03", "team-04"] },
        { id: "B", team_ids: [] },
      ],
    };

    expect(validateDay1LeagueDocument(document, 2)).toContainEqual({
      field: "manual-block-team-team-05",
      step: 2,
      message: "黄の割当て先を選択してください。",
    });
    (document.tournament.input.league as Record<string, unknown>).manual_blocks = [
      { id: "A", team_ids: ["team-01", "team-02", "team-03", "team-04"] },
      { id: "B", team_ids: ["team-05"] },
    ];
    expect(validateDay1LeagueDocument(document, 2)).toContainEqual({
      field: "manual-block-team-team-01",
      step: 2,
      message: "Aブロックは4チームです。各ブロックを2〜3チームにしてください。",
    });
  });

  it("奇数人数の上下振り分けに未対応値を許可しない", () => {
    const document = createTournamentDocument();
    document.tournament.name = "地区大会";
    document.tournament.input.teams = [
      { id: "team-01", name: "青" },
      { id: "team-02", name: "赤" },
    ];
    document.tournament.input.courts = [{ id: "court-01", name: "Aコート" }];
    document.tournament.input.league = {
      block_count: 1,
      assignment_mode: "random",
      odd_split_policy: "unknown",
    };

    expect(validateDay1LeagueDocument(document, 2)).toContainEqual({
      field: "odd-split-policy",
      step: 2,
      message: "奇数人数ブロックの上下振り分けを選択してください。",
    });
  });

  it("APIのfield詳細を日本語項目へ対応付ける", () => {
    expect(
      issuesFromApiDetails({
        errors: [{ field: "day.game_duration_minutes", type: "greater_than" }],
      }),
    ).toEqual([
      {
        field: "game-duration",
        step: 3,
        message: "試合時間の入力値を確認してください。",
      },
    ]);
  });
});
