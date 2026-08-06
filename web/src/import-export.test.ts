import { describe, expect, it } from "vitest";

import {
  ImportValidationError,
  parseTournamentJson,
  safeFileName,
  serializeTournamentJson,
} from "./import-export";
import { createTournamentDocument } from "./types";

function validDocument() {
  const document = createTournamentDocument(new Date("2026-08-05T00:00:00Z"));
  document.tournament.name = "地区大会";
  document.tournament.input = {
    schema_version: "0.1.0",
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
  document.tournament.name = "順位確定大会";
  document.tournament.input.teams = [
    { id: "team-01", name: "青" },
    { id: "team-02", name: "赤" },
  ];
  document.tournament.input.courts = [{ id: "court-a", name: "Aコート" }];
  document.tournament.input.league = { block_count: 1, assignment_mode: "random" };
  document.tournament.result = {
    status: "OPTIMAL",
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
  };
  return document;
}

describe("大会JSONの入出力", () => {
  it("書き出した文書を同じ内容で読み込む", () => {
    const document = validDocument();
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

  it("未知のschema versionを利用者向けメッセージで拒否する", () => {
    const document = validDocument() as unknown as Record<string, unknown>;
    document.schemaVersion = "9.9.9";
    expect(() => parseTournamentJson(JSON.stringify(document))).toThrowError(
      new ImportValidationError(
        "UNSUPPORTED_SCHEMA_VERSION",
        "このファイルの版「9.9.9」には対応していません。アプリを更新してから再度お試しください。",
      ),
    );
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

  it("ファイル名に使えない文字を置き換える", () => {
    expect(safeFileName("地区/夏季:大会")).toBe("地区-夏季-大会.json");
  });
});
