import { describe, expect, it } from "vitest";

import {
  ImportValidationError,
  parseTournamentJson,
  safeFileName,
  serializeTournamentJson,
} from "./import-export";
import { sameRankWebFixture, scheduleViewTournamentFixture, tournamentFixture } from "../e2e/fixtures";
import {
  LEGACY_SCHEMA_VERSION,
  SCHEMA_VERSION,
  createTournamentDocument,
  type TournamentDocument,
} from "./types";

function validDocument() {
  const document = createTournamentDocument(new Date("2026-08-05T00:00:00Z"));
  document.schemaVersion = LEGACY_SCHEMA_VERSION;
  document.tournament.name = "地区大会";
  document.tournament.input = {
    schema_version: LEGACY_SCHEMA_VERSION,
    teams: [
      { id: "team-01", name: "青" },
      { id: "team-02", name: "赤" },
    ],
    courts: [{ id: "court-a", name: "Aコート" }],
    matches: [
      {
        id: "LG-A-M1",
        possible_home_team_ids: ["team-01"],
        possible_away_team_ids: ["team-02"],
      },
    ],
    day: { max_sections: 2 },
  };
  return document;
}

function rankedDocument() {
  const document = createTournamentDocument(new Date("2026-08-05T00:00:00Z"));
  document.schemaVersion = LEGACY_SCHEMA_VERSION;
  document.tournament.input.schema_version = LEGACY_SCHEMA_VERSION;
  (document.tournament.input.league as Record<string, unknown>).odd_split_policy = "upper";
  const referees = document.tournament.input.referees as Record<string, unknown>;
  referees.tournament_fallback = referees.day2_fallback;
  delete referees.day2_fallback;
  document.tournament.name = "順位確定大会";
  document.tournament.input.teams = [
    { id: "team-01", name: "青" },
    { id: "team-02", name: "赤" },
  ];
  document.tournament.input.courts = [{ id: "court-a", name: "Aコート" }];
  document.tournament.input.league = { block_count: 1, assignment_mode: "random" };
  document.tournament.result = {
    status: "OPTIMAL",
    metrics: {
      league_team_referee_counts: [
        { team_id: "team-01", count: 0 },
        { team_id: "team-02", count: 0 },
      ],
      league_team_referee_count_min: 0,
      league_team_referee_count_max: 0,
      league_team_referee_count_difference: 0,
    },
    league_plan: {
      schema_version: "0.1.0",
      assignment_mode: "random",
      random_seed: 7,
      blocks: [{ id: "A", team_ids: ["team-01", "team-02"] }],
      logical_rounds: [{ block_id: "A", round_no: 1, match_ids: ["LG-A-M1"] }],
      matches: [
        {
          id: "LG-A-M1",
          phase: "league",
          round: "Aブロック 第1ラウンド",
          possible_home_team_ids: ["team-01"],
          possible_away_team_ids: ["team-02"],
          prerequisite_match_ids: [],
          organizer_referee_required: false,
        },
      ],
    },
    league_results: [{ match_id: "LG-A-M1", home_score: 2, away_score: 1 }],
    league_standings: {
      schema_version: "0.1.0",
      status: "COMPLETE",
      standings: [
        { block_id: "A", rank: 1, team_id: "team-01" },
        { block_id: "A", rank: 2, team_id: "team-02" },
      ],
      draws: [],
    },
    slots: [
      {
        day_id: "day1",
        section_no: 1,
        court_id: "court-a",
        match_id: "LG-A-M1",
        referee_assignment: { kind: "organizer" },
      },
    ],
    section_timings: [
      {
        day_id: "day1",
        section_no: 1,
        start_time: "09:30:00",
        match_end_time: "10:05:00",
        break_after_minutes: 0,
      },
    ],
    expected_end_time: "10:05:00",
  };
  return document;
}

function scheduledDay1Document() {
  return rankedDocument();
}

function completedTournamentPlan() {
  const evaluation = {
    first_match_same_block_count: 0,
    possible_same_block_match_count: 0,
    earliest_possible_same_block_round: null,
  };
  return {
    schema_version: "0.1.0",
    status: "COMPLETE",
    odd_split_policy: "upper",
    random_seed: 20260803,
    upper: {
      pool: "upper",
      participant_count: 1,
      seeds: [
        {
          seed_no: 1,
          team_id: "team-01",
          block_id: "A",
          block_rank: 1,
          entry: { type: "league_rank", block_id: "A", rank: 1 },
          team: { type: "concrete_team", team_id: "team-01" },
        },
      ],
      matches: [],
      byes: [],
      placements: [
        { rank: 1, entry: { type: "league_rank", block_id: "A", rank: 1 } },
      ],
      evaluation,
    },
    lower: {
      pool: "lower",
      participant_count: 1,
      seeds: [
        {
          seed_no: 1,
          team_id: "team-02",
          block_id: "A",
          block_rank: 2,
          entry: { type: "league_rank", block_id: "A", rank: 2 },
          team: { type: "concrete_team", team_id: "team-02" },
        },
      ],
      matches: [],
      byes: [],
      placements: [
        { rank: 1, entry: { type: "league_rank", block_id: "A", rank: 2 } },
      ],
      evaluation,
    },
    seed_draws: [],
    warnings: [],
  };
}

function provisionalTournamentPlan() {
  const plan = completedTournamentPlan();
  const provisional = plan as typeof plan & { participant_resolution: string };
  provisional.participant_resolution = "provisional";
  for (const pool of [provisional.upper, provisional.lower]) {
    for (const seed of pool.seeds) {
      seed.team_id = null as unknown as string;
      seed.team = null as unknown as typeof seed.team;
    }
  }
  return provisional;
}

function day2Document() {
  const document = rankedDocument();
  const result = document.tournament.result as Record<string, unknown>;
  result.tournament_plan = completedTournamentPlan();
  const integratedValidation = { valid: true, issues: [], summary: {} };
  result.day2_schedule = {
    schema_version: "0.1.0",
    schedule_scope: "day2_tournament",
    participant_resolution: "resolved",
    status: "OPTIMAL",
    tournament_matches: [],
    slots: [],
    section_timings: [],
    expected_end_time: null,
    team_schedules: [],
    metrics: { used_sections: 0 },
    diagnostics: [],
    integrated_validation: integratedValidation,
  };
  result.integrated_validation = integratedValidation;
  return document;
}

function completedTournamentResultsDocument() {
  const document = day2Document();
  const result = document.tournament.result as Record<string, unknown>;
  result.tournament_results = [];
  result.final_standings = {
    schema_version: "0.1.0",
    status: "COMPLETE",
    match_results: [],
    standings: [
      {
        rank: 1,
        pool: "upper",
        pool_rank: 1,
        team_id: "team-01",
        entry: { type: "league_rank", block_id: "A", rank: 1 },
      },
      {
        rank: 2,
        pool: "lower",
        pool_rank: 1,
        team_id: "team-02",
        entry: { type: "league_rank", block_id: "A", rank: 2 },
      },
    ],
  };
  return document;
}

function provisionalDay2Document() {
  const document = rankedDocument();
  const result = document.tournament.result as Record<string, unknown>;
  delete result.league_standings;
  result.tournament_plan = provisionalTournamentPlan();
  const integratedValidation = { valid: true, issues: [], summary: {} };
  result.day2_schedule = {
    schema_version: "0.1.0",
    schedule_scope: "day2_tournament",
    participant_resolution: "provisional",
    status: "OPTIMAL",
    tournament_matches: [],
    slots: [],
    section_timings: [],
    expected_end_time: null,
    team_schedules: [],
    metrics: { used_sections: 0 },
    diagnostics: [],
    integrated_validation: integratedValidation,
  };
  result.integrated_validation = integratedValidation;
  return document;
}

function completedSameRankStandingsDocument() {
  const document = sameRankWebFixture(16) as unknown as TournamentDocument;
  const result = document.tournament.result as Record<string, unknown>;
  const plan = result.same_rank_plan as {
    groups: Array<{
      id: string;
      overall_rank_range: number[];
      participants: Array<{ entry: Record<string, unknown>; team: { team_id: string } }>;
      matches: Array<{
        id: string;
        home_team: { team_id: string };
        away_team: { team_id: string };
      }>;
    }>;
  };
  const results = plan.groups.flatMap((group) => group.matches.map((match) => ({
    match_id: match.id,
    home_team_id: match.home_team.team_id,
    away_team_id: match.away_team.team_id,
    regular_score_home: 1,
    regular_score_away: 0,
  })));
  result.same_rank_league_results = results;
  const standings = plan.groups.flatMap((group) => {
    const stats = new Map(group.participants.map((participant) => [participant.team.team_id, {
      played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, points: 0,
      entry: participant.entry,
    }]));
    for (const match of group.matches) {
      const home = stats.get(match.home_team.team_id)!;
      const away = stats.get(match.away_team.team_id)!;
      home.played += 1; home.wins += 1; home.goalsFor += 1; home.points += 3;
      away.played += 1; away.losses += 1; away.goalsAgainst += 1;
    }
    return [...stats].sort(([, left], [, right]) =>
      right.points - left.points ||
      (right.goalsFor - right.goalsAgainst) - (left.goalsFor - left.goalsAgainst) ||
      right.goalsFor - left.goalsFor
    ).map(([teamId, values], index) => ({
      rank: group.overall_rank_range[0]! + index,
      group_id: group.id,
      group_rank: index + 1,
      team_id: teamId,
      entry: values.entry,
      played: values.played,
      wins: values.wins,
      draws: values.draws,
      losses: values.losses,
      goals_for: values.goalsFor,
      goals_against: values.goalsAgainst,
      goal_difference: values.goalsFor - values.goalsAgainst,
      points: values.points,
      tie_break: "勝点・得失点差・総得点",
      head_to_head: null,
      automatic: false,
    }));
  });
  result.same_rank_standings = {
    schema_version: "0.2.0",
    status: "COMPLETE",
    match_results: results.map((match) => ({ ...match, outcome: "home_win" })),
    standings,
    draws: [],
  };
  return document;
}

describe("大会JSONの入出力", () => {
  it("E2E用4チーム同順位リーグ文書を復元する", () => {
    const document = tournamentFixture({ withResult: true }) as unknown as TournamentDocument;
    expect(parseTournamentJson(serializeTournamentJson(document))).toEqual(document);
  });
  it("schema 0.2.0文書を書き出して同じ内容で読み込む", () => {
    const document = createTournamentDocument(new Date("2026-08-05T00:00:00Z"));
    document.tournament.name = "地区大会";
    document.tournament.input.teams = [
      { id: "team-01", name: "青" },
      { id: "team-02", name: "赤" },
      { id: "team-03", name: "白" },
      { id: "team-04", name: "緑" },
    ];
    document.tournament.input.courts = [{ id: "court-a", name: "Aコート" }];
    document.tournament.input.league = { block_count: 2, assignment_mode: "random" };
    document.tournament.input.final_stage = {
      format: "same_rank_league",
      uneven_policy: "strict_same_rank",
    };

    expect(parseTournamentJson(serializeTournamentJson(document as unknown as TournamentDocument)))
      .toEqual(document);
  });

  it("設定したトーナメント名を生成計画と対応付けてJSON往復する", () => {
    const document = scheduleViewTournamentFixture() as unknown as TournamentDocument;
    const names = ["チャンピオンリーグ", "チャレンジリーグ"];
    const finalStage = document.tournament.input.final_stage as Record<string, unknown>;
    finalStage.tournament_names = names;
    const plan = (document.tournament.result!.tournament_plan as Record<string, unknown>);
    plan.tournament_names = names;
    for (const [index, pool] of (plan.pools as Array<Record<string, unknown>>).entries()) {
      pool.display_name = names[index];
    }

    expect(parseTournamentJson(serializeTournamentJson(document))).toEqual(document);

    (plan.pools as Array<Record<string, unknown>>)[0]!.display_name = "異なる名前";
    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/トーナメント|順位帯/);
  });

  it("同順位リーグの仮計画と仮日程を同じ内容で復元する", () => {
    const document = sameRankWebFixture(16, { resolved: false });
    expect(parseTournamentJson(serializeTournamentJson(document as unknown as TournamentDocument)))
      .toEqual(document);
  });

  it("同順位グループの順位範囲改ざんを拒否する", () => {
    const document = sameRankWebFixture(16, { resolved: false });
    const result = document.tournament.result as Record<string, unknown>;
    const plan = result.same_rank_plan as Record<string, unknown>;
    const groups = plan.groups as Array<Record<string, unknown>>;
    groups[0]!.overall_rank_range = [1, 5];

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/順位範囲/);
  });

  it("割り切れる同順位リーグへ端数警告を混在させた文書を拒否する", () => {
    const document = sameRankWebFixture(16, { resolved: false });
    const result = document.tournament.result as Record<string, unknown>;
    const plan = result.same_rank_plan as Record<string, unknown>;
    plan.warnings = [{
      code: "SAME_RANK_UNEVEN_BLOCKS",
      message: "不正な警告",
      group_id: null,
      details: {},
    }];

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/警告/);
  });

  it("16チーム4ブロックの警告なし同順位リーグをJSON往復する", () => {
    const document = sameRankWebFixture(16) as unknown as TournamentDocument;
    expect(parseTournamentJson(serializeTournamentJson(document))).toEqual(document);
  });

  it("17チーム4ブロックのsingletonと2警告をJSON往復する", () => {
    const document = sameRankWebFixture(17) as unknown as TournamentDocument;
    expect(parseTournamentJson(serializeTournamentJson(document))).toEqual(document);
  });

  it.each(["strict_same_rank", "merge_bottom"] as const)(
    "18チーム4ブロックの%s同順位リーグをJSON往復する",
    (policy) => {
      const document = sameRankWebFixture(18, { policy }) as unknown as TournamentDocument;
      expect(parseTournamentJson(serializeTournamentJson(document))).toEqual(document);
    },
  );

  it("同順位リーグ日程の重複slotと未知courtを拒否する", () => {
    const duplicate = sameRankWebFixture(16, { resolved: false }) as unknown as TournamentDocument;
    const duplicateSchedule = (duplicate.tournament.result as Record<string, unknown>).day2_schedule as Record<string, unknown>;
    const duplicateSlots = duplicateSchedule.slots as Array<Record<string, unknown>>;
    duplicateSlots[1]!.section_no = duplicateSlots[0]!.section_no;
    duplicateSlots[1]!.court_id = duplicateSlots[0]!.court_id;
    expect(() => parseTournamentJson(JSON.stringify(duplicate))).toThrow(/スロット位置/);

    const unknown = sameRankWebFixture(16, { resolved: false }) as unknown as TournamentDocument;
    const unknownSchedule = (unknown.tournament.result as Record<string, unknown>).day2_schedule as Record<string, unknown>;
    (unknownSchedule.slots as Array<Record<string, unknown>>)[0]!.court_id = "unknown-court";
    expect(() => parseTournamentJson(JSON.stringify(unknown))).toThrow(/スロット位置/);
  });

  it("同順位リーグ日程の未知審判順位枠を拒否する", () => {
    const document = sameRankWebFixture(16, { resolved: false }) as unknown as TournamentDocument;
    const schedule = (document.tournament.result as Record<string, unknown>).day2_schedule as Record<string, unknown>;
    const slot = (schedule.slots as Array<Record<string, unknown>>).find(
      (item) => item.match_id !== null && item.section_no !== 1,
    )!;
    slot.referee_assignment = {
      kind: "team",
      rank_ref: { type: "league_rank", block_id: "UNKNOWN", rank: 1 },
      team_id: null,
      organizer_reason: null,
      fallback_reasons: [],
    };
    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/チーム審判参照/);
  });

  it("同順位リーグの第1セクションでチーム審判を拒否する", () => {
    const document = sameRankWebFixture(16, { resolved: false }) as unknown as TournamentDocument;
    const schedule = (document.tournament.result as Record<string, unknown>).day2_schedule as Record<string, unknown>;
    const slot = (schedule.slots as Array<Record<string, unknown>>).find(
      (item) => item.match_id !== null && item.section_no === 1,
    )!;
    slot.referee_assignment = {
      kind: "team",
      rank_ref: { type: "league_rank", block_id: "C", rank: 1 },
      team_id: null,
      organizer_reason: null,
      fallback_reasons: [],
    };
    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/チーム審判参照/);
  });

  it("同順位リーグ日程の審判回数と目的別監査値の改ざんを拒否する", () => {
    const missingRank = sameRankWebFixture(16, { resolved: false }) as unknown as TournamentDocument;
    const missingSchedule = (missingRank.tournament.result as Record<string, unknown>).day2_schedule as Record<string, unknown>;
    const missingMetrics = missingSchedule.metrics as Record<string, unknown>;
    (missingMetrics.referee_counts as Array<Record<string, unknown>>).pop();
    expect(() => parseTournamentJson(JSON.stringify(missingRank))).toThrow(/審判回数監査値/);

    const changedStage = sameRankWebFixture(16, { resolved: false }) as unknown as TournamentDocument;
    const changedSchedule = (changedStage.tournament.result as Record<string, unknown>).day2_schedule as Record<string, unknown>;
    const changedMetrics = changedSchedule.metrics as Record<string, unknown>;
    (changedMetrics.objective_stages as Array<Record<string, unknown>>)[0]!.value = 999;
    expect(() => parseTournamentJson(JSON.stringify(changedStage))).toThrow(/目的別監査値/);
  });

  it("同順位リーグ日程の独立検証欠落と統合検証不一致を拒否する", () => {
    const missing = sameRankWebFixture(16, { resolved: false }) as unknown as TournamentDocument;
    const missingSchedule = (missing.tournament.result as Record<string, unknown>).day2_schedule as Record<string, unknown>;
    delete missingSchedule.validation;
    expect(() => parseTournamentJson(JSON.stringify(missing))).toThrow(/独立検証/);

    const mismatch = sameRankWebFixture(16, { resolved: false }) as unknown as TournamentDocument;
    const mismatchResult = mismatch.tournament.result as Record<string, unknown>;
    mismatchResult.integrated_validation = { valid: true, diagnostics: [], summary: {} };
    expect(() => parseTournamentJson(JSON.stringify(mismatch))).toThrow(/統合検証結果/);
  });

  it("同順位リーグ順位を保存済み結果から再検証する", () => {
    const document = completedSameRankStandingsDocument();
    expect(parseTournamentJson(serializeTournamentJson(document))).toEqual(document);

    for (const field of ["points", "group_id", "entry"] as const) {
      const tampered = structuredClone(document);
      const result = tampered.tournament.result as Record<string, unknown>;
      const final = result.same_rank_standings as Record<string, unknown>;
      const rows = final.standings as Array<Record<string, unknown>>;
      rows[0]![field] = field === "points"
        ? 999
        : field === "entry"
          ? { type: "league_rank", block_id: "UNKNOWN", rank: 1 }
          : "same-rank-unknown";
      expect(() => parseTournamentJson(JSON.stringify(tampered))).toThrow(/保存済み結果/);
    }
    const duplicateCanonical = structuredClone(document);
    const duplicateResult = duplicateCanonical.tournament.result as Record<string, unknown>;
    const duplicateFinal = duplicateResult.same_rank_standings as Record<string, unknown>;
    const canonical = duplicateFinal.match_results as Array<Record<string, unknown>>;
    canonical[1] = structuredClone(canonical[0]!);
    expect(() => parseTournamentJson(JSON.stringify(duplicateCanonical))).toThrow(/検証済み同順位リーグ結果/);
    const swapped = structuredClone(document);
    const swappedResult = swapped.tournament.result as Record<string, unknown>;
    const swappedFinal = swappedResult.same_rank_standings as Record<string, unknown>;
    const rows = swappedFinal.standings as Array<Record<string, unknown>>;
    [rows[0], rows[1]] = [rows[1]!, rows[0]!];
    expect(() => parseTournamentJson(JSON.stringify(swapped))).toThrow(/総合順位/);
  });

  it("plan未生成でも形式別の決勝設定不正を拒否する", () => {
    const sameRank = createTournamentDocument(new Date("2026-08-05T00:00:00Z"));
    sameRank.tournament.name = "不正設定";
    sameRank.tournament.input.teams = [
      { id: "team-01", name: "1" }, { id: "team-02", name: "2" },
      { id: "team-03", name: "3" }, { id: "team-04", name: "4" },
    ];
    sameRank.tournament.input.courts = [{ id: "court-a", name: "A" }];
    sameRank.tournament.input.league = { block_count: 1, assignment_mode: "random" };
    sameRank.tournament.input.final_stage = { format: "same_rank_league", uneven_policy: "strict_same_rank" };
    expect(() => parseTournamentJson(JSON.stringify(sameRank))).toThrow(/同順位リーグ/);

    const placement = structuredClone(sameRank);
    placement.tournament.input.teams = Array.from({ length: 8 }, (_, index) => ({
      id: `team-${String(index + 1)}`, name: String(index + 1),
    }));
    placement.tournament.input.league = { block_count: 3, assignment_mode: "random" };
    placement.tournament.input.final_stage = { format: "placement_tournament", tournament_count: 2 };
    expect(() => parseTournamentJson(JSON.stringify(placement))).toThrow(/順位決定トーナメント/);
  });

  it("schema 0.1.0文書を閲覧・印刷用として内容を変えずに読み込む", () => {
    const document = validDocument();

    const parsed = parseTournamentJson(serializeTournamentJson(document));

    expect(parsed).toEqual(document);
    expect(parsed.schemaVersion).toBe(LEGACY_SCHEMA_VERSION);
  });

  it("従来のinput.matches形式でも1日目スロットを復元する", () => {
    const document = validDocument();
    document.tournament.result = {
      status: "OPTIMAL",
      slots: [
        {
          day_id: "day1",
          section_no: 1,
          court_id: "court-a",
          match_id: "LG-A-M1",
          referee_assignment: { type: "organizer" },
        },
      ],
    };

    expect(parseTournamentJson(serializeTournamentJson(document))).toEqual(document);
  });

  it("旧ルールの隣接コート移動がある1日目日程も失わずに復元する", () => {
    const document = validDocument();
    const teams = document.tournament.input.teams as Array<Record<string, unknown>>;
    teams.push(
      { id: "team-03", name: "白" },
      { id: "team-04", name: "緑" },
    );
    const courts = document.tournament.input.courts as Array<Record<string, unknown>>;
    courts.push({ id: "court-b", name: "Bコート" });
    const matches = document.tournament.input.matches as Array<Record<string, unknown>>;
    matches.push({
      id: "LG-B-M1",
      possible_home_team_ids: ["team-03"],
      possible_away_team_ids: ["team-04"],
    });
    document.tournament.result = {
      status: "OPTIMAL",
      slots: [
        {
          day_id: "day1",
          section_no: 1,
          court_id: "court-a",
          match_id: "LG-A-M1",
          referee_assignment: { kind: "organizer" },
        },
        {
          day_id: "day1",
          section_no: 2,
          court_id: "court-b",
          match_id: "LG-B-M1",
          referee_assignment: { kind: "team", team_id: "team-01" },
        },
      ],
    };

    expect(parseTournamentJson(serializeTournamentJson(document))).toEqual(document);
  });

  it("新しい1日目リーグ形式はmatchesなしで読み込む", () => {
    const document = createTournamentDocument(new Date("2026-08-05T00:00:00Z"));
    document.tournament.name = "地区大会";
    document.tournament.input.teams = [
      { id: "team-01", name: "青" },
      { id: "team-02", name: "赤" },
    ];
    document.tournament.input.courts = [{ id: "court-a", name: "Aコート" }];
    document.tournament.input.league = { block_count: 1, assignment_mode: "random" };

    expect(parseTournamentJson(serializeTournamentJson(document))).toEqual(document);
  });

  it("入力途中の手動割当てを人数不均衡のまま復元する", () => {
    const document = createTournamentDocument(new Date("2026-08-05T00:00:00Z"));
    document.tournament.name = "手動割当て大会";
    document.tournament.input.teams = [
      { id: "team-01", name: "青" },
      { id: "team-02", name: "赤" },
      { id: "team-03", name: "白" },
      { id: "team-04", name: "緑" },
    ];
    document.tournament.input.courts = [{ id: "court-a", name: "Aコート" }];
    document.tournament.input.league = {
      block_count: 2,
      assignment_mode: "manual",
      manual_blocks: [
        { id: "A", team_ids: ["team-01"] },
        { id: "B", team_ids: [] },
      ],
    };

    expect(parseTournamentJson(serializeTournamentJson(document))).toEqual(document);
  });

  it("手動割当ての未知参照と重複所属を拒否する", () => {
    const document = createTournamentDocument(new Date("2026-08-05T00:00:00Z"));
    document.tournament.name = "手動割当て大会";
    document.tournament.input.teams = [
      { id: "team-01", name: "青" },
      { id: "team-02", name: "赤" },
    ];
    document.tournament.input.courts = [{ id: "court-a", name: "Aコート" }];
    document.tournament.input.league = {
      block_count: 2,
      assignment_mode: "manual",
      manual_blocks: [
        { id: "A", team_ids: ["team-01", "team-99"] },
        { id: "B", team_ids: ["team-01"] },
      ],
    };

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/登録されていないチーム/);
    (document.tournament.input.league as Record<string, unknown>).manual_blocks = [
      { id: "A", team_ids: ["team-01"] },
      { id: "B", team_ids: ["team-01"] },
    ];
    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/複数の手動ブロック/);
  });

  it("生成済みリーグと手動割当ての順序不一致を拒否する", () => {
    const document = rankedDocument();
    document.tournament.input.league = {
      block_count: 1,
      assignment_mode: "manual",
      manual_blocks: [{ id: "A", team_ids: ["team-02", "team-01"] }],
    };

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/手動割当てと一致/);
  });

  it("部分的な手動割当てと自動配置監査を復元する", () => {
    const document = rankedDocument();
    document.tournament.input.league = {
      block_count: 1,
      assignment_mode: "manual",
      manual_blocks: [{ id: "A", team_ids: ["team-01"] }],
    };
    const plan = document.tournament.result!.league_plan as Record<string, unknown>;
    plan.assignment_mode = "manual";
    plan.manual_completion = {
      automatic_assignments: [{ team_id: "team-02", block_id: "A" }],
    };

    expect(parseTournamentJson(serializeTournamentJson(document))).toEqual(document);
  });

  it("部分的な手動割当ての監査不足と改ざんを拒否する", () => {
    const document = rankedDocument();
    document.tournament.input.league = {
      block_count: 1,
      assignment_mode: "manual",
      manual_blocks: [{ id: "A", team_ids: ["team-01"] }],
    };
    const plan = document.tournament.result!.league_plan as Record<string, unknown>;
    plan.assignment_mode = "manual";

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/手動割当てと一致/);
    plan.manual_completion = {
      automatic_assignments: [{ team_id: "team-01", block_id: "A" }],
    };
    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/自動配置情報/);
  });

  it("監査情報のない従来の完全な手動割当てを復元する", () => {
    const document = rankedDocument();
    document.tournament.input.league = {
      block_count: 1,
      assignment_mode: "manual",
      manual_blocks: [{ id: "A", team_ids: ["team-01", "team-02"] }],
    };
    const plan = document.tournament.result!.league_plan as Record<string, unknown>;
    plan.assignment_mode = "manual";

    expect(parseTournamentJson(serializeTournamentJson(document))).toEqual(document);
  });

  it("未知のschema versionを利用者向けメッセージで拒否する", () => {
    const document = validDocument() as unknown as Record<string, unknown>;
    document.schemaVersion = "9.9.9";
    expect(() => parseTournamentJson(JSON.stringify(document))).toThrowError(
      new ImportValidationError(
        "SCHEMA_VERSION_UNSUPPORTED",
        "このファイルの版「9.9.9」には対応していません。アプリを更新してから再度お試しください。",
      ),
    );
  });

  it("文書と生成入力のschema versionが一致しないファイルを拒否する", () => {
    const document = createTournamentDocument();
    document.tournament.name = "版不一致大会";
    document.tournament.input.schema_version = LEGACY_SCHEMA_VERSION;

    let thrown: unknown;
    try {
      parseTournamentJson(JSON.stringify(document));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ImportValidationError);
    expect(thrown).toMatchObject({ code: "SCHEMA_VERSION_UNSUPPORTED" });
    expect((thrown as Error).message).toContain("一致しません");
  });

  it("生成結果の途中に異なるschema versionが混在するファイルを拒否する", () => {
    const document = scheduleViewTournamentFixture();
    const result = document.tournament.result as Record<string, unknown>;
    const leaguePlan = result.league_plan as Record<string, unknown>;
    leaguePlan.schema_version = LEGACY_SCHEMA_VERSION;

    let thrown: unknown;
    try {
      parseTournamentJson(JSON.stringify(document));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ImportValidationError);
    expect(thrown).toMatchObject({ code: "SCHEMA_VERSION_UNSUPPORTED" });
    expect((thrown as Error).message).toContain("異なる版");
  });

  it("壊れたJSONを利用者向けメッセージで拒否する", () => {
    expect(() => parseTournamentJson('{"途中":')).toThrow(/ファイルを読み取れませんでした/);
  });

  it("存在しないチーム参照を拒否する", () => {
    const document = validDocument();
    const matches = document.tournament.input.matches as Array<Record<string, unknown>>;
    matches[0]!.possible_away_team_ids = ["team-99"];
    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/登録されていないチーム/);
  });

  it("32チームを超える文書を拒否する", () => {
    const document = validDocument();
    document.tournament.input.teams = Array.from({ length: 33 }, (_, index) => ({
      id: `team-${index}`,
      name: `チーム${index}`,
    }));
    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/32件まで/);
  });

  it("重複したコートIDを拒否する", () => {
    const document = validDocument();
    document.tournament.input.courts = [
      { id: "court-a", name: "Aコート" },
      { id: "court-a", name: "予備コート" },
    ];
    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/コートID.*重複/);
  });

  it("入力途中の結果と確定順位を同じ内容で復元する", () => {
    const document = rankedDocument();
    expect(parseTournamentJson(serializeTournamentJson(document))).toEqual(document);
  });

  it("1日目の時刻一覧がない従来文書を復元する", () => {
    const document = scheduledDay1Document();
    const result = document.tournament.result as Record<string, unknown>;
    delete result.section_timings;

    expect(parseTournamentJson(serializeTournamentJson(document))).toEqual(document);
  });

  it("生成済み1日目日程のスロット欠落を拒否する", () => {
    const document = scheduledDay1Document();
    const result = document.tournament.result as Record<string, unknown>;
    delete result.slots;
    delete result.section_timings;

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/試合配置/);
  });

  it("リーグ計画が欠けていても成功状態のスロット欠落を拒否する", () => {
    const document = validDocument();
    document.tournament.result = { status: "OPTIMAL" };

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/試合配置/);
  });

  it("1日目時刻だけが残ったスロット欠落を拒否する", () => {
    const document = scheduledDay1Document();
    const result = document.tournament.result as Record<string, unknown>;
    delete result.slots;

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/試合配置/);
  });

  it("1日目スロットの未知のコートを拒否する", () => {
    const document = scheduledDay1Document();
    const result = document.tournament.result as Record<string, unknown>;
    const slots = result.slots as Array<Record<string, unknown>>;
    slots[0]!.court_id = "court-unknown";

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/コート位置/);
  });

  it("1日目スロットの未知の試合を拒否する", () => {
    const document = scheduledDay1Document();
    const result = document.tournament.result as Record<string, unknown>;
    const slots = result.slots as Array<Record<string, unknown>>;
    slots[0]!.match_id = "LG-A-UNKNOWN";

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/未知または重複/);
  });

  it("1日目スロットの重複位置を拒否する", () => {
    const document = scheduledDay1Document();
    const result = document.tournament.result as Record<string, unknown>;
    const slots = result.slots as Array<Record<string, unknown>>;
    slots.push({ ...slots[0]!, match_id: null, referee_assignment: null });

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/コート位置/);
  });

  it("1日目の同じ試合の重複配置を拒否する", () => {
    const document = scheduledDay1Document();
    document.tournament.input.courts = [
      { id: "court-a", name: "Aコート" },
      { id: "court-b", name: "Bコート" },
    ];
    const result = document.tournament.result as Record<string, unknown>;
    const slots = result.slots as Array<Record<string, unknown>>;
    slots.push({ ...slots[0]!, court_id: "court-b" });

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/未知または重複/);
  });

  it("1日目の実試合に審判がない文書を拒否する", () => {
    const document = scheduledDay1Document();
    const result = document.tournament.result as Record<string, unknown>;
    const slots = result.slots as Array<Record<string, unknown>>;
    slots[0]!.referee_assignment = null;

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/審判割当て/);
  });

  it("1日目の未知のチーム審判を拒否する", () => {
    const document = scheduledDay1Document();
    const result = document.tournament.result as Record<string, unknown>;
    const slots = result.slots as Array<Record<string, unknown>>;
    slots[0]!.referee_assignment = { kind: "team", team_id: "team-unknown" };

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/審判割当て/);
  });

  it("1日目の空きスロットに審判がある文書を拒否する", () => {
    const document = scheduledDay1Document();
    const result = document.tournament.result as Record<string, unknown>;
    const slots = result.slots as Array<Record<string, unknown>>;
    slots.push({
      day_id: "day1",
      section_no: 2,
      court_id: "court-a",
      match_id: null,
      referee_assignment: { kind: "organizer" },
    });
    const timings = result.section_timings as Array<Record<string, unknown>>;
    timings.push({
      day_id: "day1",
      section_no: 2,
      start_time: "10:10:00",
      match_end_time: "10:45:00",
      break_after_minutes: 0,
    });

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/空きスロット/);
  });

  it("1日目に配置されていない試合を拒否する", () => {
    const document = scheduledDay1Document();
    const result = document.tournament.result as Record<string, unknown>;
    result.slots = [];
    result.section_timings = [];

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/配置されていない/);
  });

  it("改ざんされた1日目の時刻一覧を拒否する", () => {
    const document = scheduledDay1Document();
    const result = document.tournament.result as Record<string, unknown>;
    const timings = result.section_timings as Array<Record<string, unknown>>;
    timings[0]!.start_time = "09:31:00";

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/大会設定と一致/);
  });

  it("重複した1日目時刻セクションを拒否する", () => {
    const document = scheduledDay1Document();
    const result = document.tournament.result as Record<string, unknown>;
    const timings = result.section_timings as Array<Record<string, unknown>>;
    timings.push({ ...timings[0]! });

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/セクション時刻/);
  });

  it("日程のセクションが欠けた1日目時刻一覧を拒否する", () => {
    const document = scheduledDay1Document();
    const result = document.tournament.result as Record<string, unknown>;
    result.section_timings = [];

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/すべて含んで/);
  });

  it.each([
    ["試合時間0分", { game_duration_minutes: 0 }],
    ["文字列の試合時間", { game_duration_minutes: "35" }],
    ["負の休憩", { breaks: [{ after_section: 1, duration_minutes: -1 }] }],
    [
      "重複した休憩",
      {
        breaks: [
          { after_section: 1, duration_minutes: 10 },
          { after_section: 1, duration_minutes: 20 },
        ],
      },
    ],
  ])("不正な1日目設定（%s）を拒否する", (_label, changes) => {
    const document = scheduledDay1Document();
    document.tournament.input.day = {
      ...(document.tournament.input.day as Record<string, unknown>),
      ...changes,
    };

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/1日目.*(?:時刻|休憩)/);
  });

  it("現行形式は時刻一覧がなくても不正な1日目設定を拒否する", () => {
    const document = scheduledDay1Document();
    const result = document.tournament.result as Record<string, unknown>;
    delete result.section_timings;
    const day = document.tournament.input.day as Record<string, unknown>;
    day.game_duration_minutes = 0;

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/1日目の時刻設定/);
  });

  it("1日目の最大セクションを超えた配置を拒否する", () => {
    const document = scheduledDay1Document();
    const day = document.tournament.input.day as Record<string, unknown>;
    day.max_sections = 1;
    const result = document.tournament.result as Record<string, unknown>;
    const slots = result.slots as Array<Record<string, unknown>>;
    slots[0]!.section_no = 2;
    const timings = result.section_timings as Array<Record<string, unknown>>;
    timings[0]!.section_no = 2;

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/コート位置/);
  });

  it("日程にない試合結果を拒否して現在データ候補にしない", () => {
    const document = rankedDocument();
    const result = document.tournament.result as Record<string, unknown>;
    result.league_results = [{ match_id: "LG-A-M99", home_score: 2, away_score: 1 }];

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/日程にない試合/);
  });

  it("負の得点を拒否する", () => {
    const document = rankedDocument();
    const result = document.tournament.result as Record<string, unknown>;
    result.league_results = [{ match_id: "LG-A-M1", home_score: -1, away_score: 1 }];

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/0以上の整数/);
  });

  it("重複した確定順位を拒否する", () => {
    const document = rankedDocument();
    const result = document.tournament.result as Record<string, unknown>;
    const standings = result.league_standings as Record<string, unknown>;
    standings.standings = [
      { block_id: "A", rank: 1, team_id: "team-01" },
      { block_id: "A", rank: 1, team_id: "team-02" },
    ];

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/重複した順位/);
  });

  it("候補と確定順が一致しない抽選記録を拒否する", () => {
    const document = rankedDocument();
    const result = document.tournament.result as Record<string, unknown>;
    const standings = result.league_standings as Record<string, unknown>;
    standings.draws = [
      {
        block_id: "A",
        candidates: ["team-01", "team-02"],
        decided_order: ["team-01"],
        random_seed: 7,
      },
    ];

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/抽選記録/);
  });

  it("確定した2日目トーナメントを同じ内容で復元する", () => {
    const document = rankedDocument();
    const result = document.tournament.result as Record<string, unknown>;
    result.tournament_plan = completedTournamentPlan();

    expect(parseTournamentJson(serializeTournamentJson(document))).toEqual(document);
  });

  it("不正なトーナメント論理配置をインポート時に拒否する", () => {
    const document = rankedDocument();
    const result = document.tournament.result as Record<string, unknown>;
    const plan = completedTournamentPlan();
    (plan.upper as typeof plan.upper & { logical_layout: unknown }).logical_layout = {
      layout_version: "1",
    };
    result.tournament_plan = plan;

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/2のべき乗/);
  });

  it("存在しないリーグ順位を参照するトーナメントを拒否する", () => {
    const document = rankedDocument();
    const result = document.tournament.result as Record<string, unknown>;
    const plan = completedTournamentPlan();
    plan.upper.placements[0]!.entry.rank = 99;
    result.tournament_plan = plan;

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/存在しないリーグ順位/);
  });

  it("確定順位がないトーナメントを拒否する", () => {
    const document = rankedDocument();
    const result = document.tournament.result as Record<string, unknown>;
    delete result.league_standings;
    result.tournament_plan = completedTournamentPlan();

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/仮・確定状態/);
  });

  it("確定順位がなくても順位枠だけの仮トーナメントを復元する", () => {
    const document = rankedDocument();
    const result = document.tournament.result as Record<string, unknown>;
    delete result.league_standings;
    result.tournament_plan = provisionalTournamentPlan();

    expect(parseTournamentJson(serializeTournamentJson(document))).toEqual(document);
  });

  it("仮トーナメントに混在した具体チーム参照を拒否する", () => {
    const document = rankedDocument();
    const result = document.tournament.result as Record<string, unknown>;
    delete result.league_standings;
    const plan = provisionalTournamentPlan();
    plan.upper.seeds[0]!.team_id = "team-01";
    result.tournament_plan = plan;

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/確定チームが混在/);
  });

  it("2日目設定・日程・統合検証を同じ内容で復元する", () => {
    const document = day2Document();
    expect(parseTournamentJson(serializeTournamentJson(document))).toEqual(document);
  });

  it("現行2日目日程は決勝配置の監査値がなければ拒否する", () => {
    const document = scheduleViewTournamentFixture();
    const result = document.tournament.result as Record<string, unknown>;
    const schedule = result.day2_schedule as Record<string, unknown>;
    const metrics = schedule.metrics as Record<string, unknown>;
    delete metrics.placement_tournament_finals;
    delete metrics.non_primary_final_max_gap;
    delete metrics.non_primary_final_sum_gap;

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/決勝配置/);
  });

  it("現行監査値のある2日目日程で決勝が最終でなければ拒否する", () => {
    const document = scheduleViewTournamentFixture();
    const result = document.tournament.result as Record<string, unknown>;
    const schedule = result.day2_schedule as Record<string, unknown>;
    const metrics = schedule.metrics as Record<string, unknown>;
    const slots = schedule.slots as Array<Record<string, unknown>>;
    const primary = slots.find((slot) => slot.match_id === "PT-1-FINAL")!;
    const secondary = slots.find((slot) => slot.match_id === "PT-2-FINAL")!;
    primary.match_id = "PT-2-FINAL";
    secondary.match_id = "PT-1-FINAL";
    metrics.placement_tournament_finals = [
      { pool_id: "placement-1", section_no: 4, final_section_gap: 1 },
      { pool_id: "placement-2", section_no: 5, final_section_gap: 0 },
    ];
    metrics.non_primary_final_max_gap = 0;
    metrics.non_primary_final_sum_gap = 0;

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/最高順位帯の決勝/);
  });

  it("2日目日程の決勝配置と現行監査値の不一致を拒否する", () => {
    const document = scheduleViewTournamentFixture();
    const result = document.tournament.result as Record<string, unknown>;
    const schedule = result.day2_schedule as Record<string, unknown>;
    const metrics = schedule.metrics as Record<string, unknown>;
    metrics.placement_tournament_finals = [
      { pool_id: "placement-1", section_no: 4, final_section_gap: 1 },
      { pool_id: "placement-2", section_no: 4, final_section_gap: 1 },
    ];

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/決勝配置/);
  });

  it("2日目試合結果と総合最終順位を同じ内容で復元する", () => {
    const document = completedTournamentResultsDocument();
    expect(parseTournamentJson(serializeTournamentJson(document))).toEqual(document);
  });

  it("2日目試合結果と一致しない総合最終順位を拒否する", () => {
    const document = completedTournamentResultsDocument();
    const result = document.tournament.result as Record<string, unknown>;
    const finalStandings = result.final_standings as Record<string, unknown>;
    const rows = finalStandings.standings as Array<Record<string, unknown>>;
    rows[0]!.team_id = "team-02";

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/総合最終順位/);
  });

  it("仮トーナメントへ2日目試合結果を付けた文書を拒否する", () => {
    const document = provisionalDay2Document();
    const result = document.tournament.result as Record<string, unknown>;
    result.tournament_results = [];

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/リーグ順位を確定/);
  });

  it("確定順位がなくても順位枠だけの仮2日目日程を復元する", () => {
    const document = provisionalDay2Document();
    expect(parseTournamentJson(serializeTournamentJson(document))).toEqual(document);
  });

  it("仮日程に混在した具体チーム注記を拒否する", () => {
    const document = provisionalDay2Document();
    const result = document.tournament.result as Record<string, unknown>;
    const schedule = result.day2_schedule as Record<string, unknown>;
    schedule.team_schedules = [
      {
        rank_ref: { type: "league_rank", block_id: "A", rank: 1 },
        team_id: "team-01",
        role: "match",
        match_id: "UT-UNKNOWN",
        section_no: 1,
        court_id: "court-a",
        conditions: [],
      },
    ];

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/チーム経路/);
  });

  it("2日目日程とトーナメントの解決状態の矛盾を拒否する", () => {
    const document = provisionalDay2Document();
    const result = document.tournament.result as Record<string, unknown>;
    const schedule = result.day2_schedule as Record<string, unknown>;
    schedule.participant_resolution = "resolved";

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/仮・確定状態/);
  });

  it("解決状態がない従来の2日目日程を復元する", () => {
    const document = day2Document();
    const result = document.tournament.result as Record<string, unknown>;
    const schedule = result.day2_schedule as Record<string, unknown>;
    delete schedule.participant_resolution;

    expect(parseTournamentJson(serializeTournamentJson(document))).toEqual(document);
  });

  it("トーナメント表にない2日目試合参照を拒否する", () => {
    const document = day2Document();
    const result = document.tournament.result as Record<string, unknown>;
    const schedule = result.day2_schedule as Record<string, unknown>;
    schedule.tournament_matches = [{ id: "UT-UNKNOWN" }];

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/トーナメント表が一致/);
  });

  it("改ざんされた2日目の休憩設定を拒否する", () => {
    const document = day2Document();
    const day2 = document.tournament.input.day2 as Record<string, unknown>;
    day2.breaks = [
      { after_section: 4, duration_minutes: 60 },
      { after_section: 4, duration_minutes: 30 },
    ];

    expect(() => parseTournamentJson(JSON.stringify(document))).toThrow(/休憩設定/);
  });

  it("ファイル名に使えない文字を置き換える", () => {
    expect(safeFileName("地区/夏季:大会")).toBe("地区-夏季-大会.json");
  });
});
