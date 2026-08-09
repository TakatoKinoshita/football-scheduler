import { describe, expect, it } from "vitest";

import {
  buildDay1ScheduleRequest,
  convertLegacyToEditableDocument,
  issuesFromApiDetails,
  normalizeDocument,
  validateDay1LeagueDocument,
} from "./day1-form";
import {
  LEGACY_SCHEMA_VERSION,
  SCHEMA_VERSION,
  createTournamentDocument,
} from "./types";

describe("1日目リーグ入力", () => {
  it("新規文書をschema 0.2.0の決勝方式未選択状態で作る", () => {
    const document = createTournamentDocument(new Date("2026-08-09T00:00:00Z"));

    expect(document.schemaVersion).toBe(SCHEMA_VERSION);
    expect(document.tournament.input.schema_version).toBe(SCHEMA_VERSION);
    expect(document.tournament.input).not.toHaveProperty("final_stage");
    expect(document.tournament.input.league).not.toHaveProperty("odd_split_policy");
    expect(document.tournament.input.referees).toMatchObject({
      day2_fallback: "organizer",
    });
    expect(document.tournament.input.referees).not.toHaveProperty("tournament_fallback");
  });

  it("大会文書の決勝方式を含め、2日目設定は1日目API要求へ含めない", () => {
    const document = createTournamentDocument();
    document.tournament.input.final_stage = {
      format: "placement_tournament",
      tournament_count: 2,
    };

    const request = buildDay1ScheduleRequest(document.tournament.input);

    expect(request).toEqual({
      schema_version: "0.2.0",
      request_kind: "day1_league",
      teams: document.tournament.input.teams,
      courts: document.tournament.input.courts,
      league: document.tournament.input.league,
      final_stage: document.tournament.input.final_stage,
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

  it("旧文書は閲覧専用の互換モードとして扱う", () => {
    const document = createTournamentDocument(new Date("2026-08-06T00:00:00Z"));
    document.schemaVersion = LEGACY_SCHEMA_VERSION;
    document.tournament.input = {
      schema_version: LEGACY_SCHEMA_VERSION,
      teams: [
        { id: "team-01", name: "青空FC" },
        { id: "team-02", name: "みどりSC" },
      ],
      courts: [{ id: "court-01", name: "Aコート" }],
      matches: [],
    };

    const normalized = normalizeDocument(document);

    expect(normalized).toEqual({
      document,
      migrated: false,
      legacyCompatibility: true,
    });
  });

  it("旧文書の編集用コピーは設定だけを0.2.0へ移し、結果と決勝方式を引き継がない", () => {
    const document = createTournamentDocument(new Date("2026-08-06T00:00:00Z"));
    document.schemaVersion = LEGACY_SCHEMA_VERSION;
    document.tournament.name = "旧大会";
    document.tournament.input = {
      schema_version: LEGACY_SCHEMA_VERSION,
      request_kind: "day1_league",
      teams: [
        { id: "team-01", name: "青空FC" },
        { id: "team-02", name: "みどりSC" },
      ],
      courts: [{ id: "court-01", name: "Aコート" }],
      league: {
        block_count: 1,
        assignment_mode: "random",
        odd_split_policy: "upper",
      },
      day: { id: "day1", start_time: "10:00", game_duration_minutes: 30, margin_minutes: 5 },
      referees: { organizer_capacity: 2, tournament_fallback: "strict" },
      random_seed: 42,
    };
    document.tournament.result = { status: "OPTIMAL", slots: [{ match_id: "LG-A-M1" }] };

    const converted = convertLegacyToEditableDocument(
      document,
      new Date("2026-08-09T01:02:03Z"),
    );

    expect(converted).not.toBe(document);
    expect(converted.schemaVersion).toBe(SCHEMA_VERSION);
    expect(converted.updatedAt).toBe("2026-08-09T01:02:03.000Z");
    expect(converted.tournament.name).toBe("旧大会");
    expect(converted.tournament).not.toHaveProperty("result");
    expect(converted.tournament.input).toMatchObject({
      schema_version: SCHEMA_VERSION,
      request_kind: "day1_league",
      teams: document.tournament.input.teams,
      courts: document.tournament.input.courts,
      league: { block_count: 1, assignment_mode: "random" },
      day: { start_time: "10:00", game_duration_minutes: 30, margin_minutes: 5 },
      referees: { organizer_capacity: 2, day2_fallback: "strict" },
      random_seed: 42,
    });
    expect(converted.tournament.input).not.toHaveProperty("final_stage");
    expect(converted.tournament.input.league).not.toHaveProperty("odd_split_policy");
    expect(converted.tournament.input.referees).not.toHaveProperty("tournament_fallback");

    const convertedTeams = converted.tournament.input.teams as Array<Record<string, unknown>>;
    convertedTeams[0]!.name = "変更後";
    (converted.tournament.input.day as Record<string, unknown>).start_time = "11:00";
    expect((document.tournament.input.teams as Array<Record<string, unknown>>)[0]!.name).toBe(
      "青空FC",
    );
    expect((document.tournament.input.day as Record<string, unknown>).start_time).toBe("10:00");
  });

  it("完成済み試合を含む従来入力は互換モードで変更しない", () => {
    const document = createTournamentDocument();
    document.schemaVersion = LEGACY_SCHEMA_VERSION;
    document.tournament.input = {
      schema_version: LEGACY_SCHEMA_VERSION,
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
      { id: "team-03", name: "白" },
      { id: "team-04", name: "緑" },
    ];
    document.tournament.input.courts = [{ id: "court-01", name: "Aコート" }];
    document.tournament.input.league = { block_count: 2, assignment_mode: "random" };
    document.tournament.input.final_stage = {
      format: "same_rank_league",
      uneven_policy: "strict_same_rank",
    };

    expect(validateDay1LeagueDocument(document)).toEqual([]);
  });

  it("端数がある同順位リーグでは端数処理の明示選択を必須にする", () => {
    const document = createTournamentDocument();
    document.tournament.name = "地区大会";
    document.tournament.input.teams = Array.from({ length: 5 }, (_, index) => ({
      id: `team-${index + 1}`,
      name: `チーム${index + 1}`,
    }));
    document.tournament.input.courts = [{ id: "court-01", name: "Aコート" }];
    document.tournament.input.league = { block_count: 2, assignment_mode: "random" };
    document.tournament.input.final_stage = {
      format: "same_rank_league",
      uneven_policy: "",
    };

    expect(validateDay1LeagueDocument(document, 2)).toContainEqual({
      field: "same-rank-uneven-policy",
      step: 2,
      message: "ブロック人数が揃わない場合のグループ分けを選択してください。",
    });
  });

  it("割り切れる同順位リーグのAPI要求は厳密方式へ正規化する", () => {
    const document = createTournamentDocument();
    document.tournament.input.teams = Array.from({ length: 4 }, (_, index) => ({
      id: `team-${index + 1}`,
      name: `チーム${index + 1}`,
    }));
    document.tournament.input.league = { block_count: 2, assignment_mode: "random" };
    document.tournament.input.final_stage = {
      format: "same_rank_league",
      uneven_policy: "",
    };

    expect(buildDay1ScheduleRequest(document.tournament.input).final_stage).toEqual({
      format: "same_rank_league",
      uneven_policy: "strict_same_rank",
    });
  });

  it("端数がある同順位リーグの明示選択はAPI要求でも保持する", () => {
    const document = createTournamentDocument();
    document.tournament.input.teams = Array.from({ length: 5 }, (_, index) => ({
      id: `team-${index + 1}`,
      name: `チーム${index + 1}`,
    }));
    document.tournament.input.league = { block_count: 2, assignment_mode: "random" };
    document.tournament.input.final_stage = {
      format: "same_rank_league",
      uneven_policy: "merge_bottom",
    };

    expect(buildDay1ScheduleRequest(document.tournament.input).final_stage).toEqual({
      format: "same_rank_league",
      uneven_policy: "merge_bottom",
    });
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
    document.tournament.input.final_stage = {
      format: "same_rank_league",
      uneven_policy: "strict_same_rank",
    };

    expect(validateDay1LeagueDocument(document)).toEqual([]);
  });

  it("自動補完できる未割当てを受理し、人数超過だけをチーム別エラーにする", () => {
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
        { id: "A", team_ids: ["team-01"] },
        { id: "B", team_ids: [] },
      ],
    };
    document.tournament.input.final_stage = {
      format: "same_rank_league",
      uneven_policy: "strict_same_rank",
    };

    expect(validateDay1LeagueDocument(document, 2)).toEqual([]);
    (document.tournament.input.league as Record<string, unknown>).manual_blocks = [
      { id: "A", team_ids: ["team-01", "team-02", "team-03", "team-04"] },
      { id: "B", team_ids: ["team-05"] },
    ];
    expect(validateDay1LeagueDocument(document, 2)).toContainEqual({
      field: "manual-block-team-team-01",
      step: 2,
      message: "Aブロックは4チーム指定済みです。自動配置後は各ブロック2〜3チームになるため、対象チームを未割当てへ戻してください。",
    });
  });

  it("決勝方式未選択を1日目生成前の具体的なエラーにする", () => {
    const document = createTournamentDocument();
    document.tournament.name = "地区大会";
    document.tournament.input.teams = [
      { id: "team-01", name: "青" },
      { id: "team-02", name: "赤" },
    ];
    document.tournament.input.courts = [{ id: "court-01", name: "Aコート" }];
    document.tournament.input.league = { block_count: 1, assignment_mode: "random" };

    expect(validateDay1LeagueDocument(document, 3)).toContainEqual({
      field: "final-stage-format",
      step: 2,
      message: "2日目の決勝方式を選択してください。",
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
