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

  it("ファイル名に使えない文字を置き換える", () => {
    expect(safeFileName("地区/夏季:大会")).toBe("地区-夏季-大会.json");
  });
});
