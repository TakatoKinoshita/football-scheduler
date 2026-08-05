import { describe, expect, it } from "vitest";

import {
  issuesFromApiDetails,
  normalizeDocument,
  validateDay1LeagueDocument,
} from "./day1-form";
import { createTournamentDocument } from "./types";

describe("1日目リーグ入力", () => {
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
