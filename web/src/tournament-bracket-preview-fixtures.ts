import upperSevenSeededJson from "./fixtures/tournament-bracket-preview/upper-7-seeded.json";
import upperEightJson from "./fixtures/tournament-bracket-preview/upper-8.json";
import type { JsonObject } from "./types";

export interface TournamentBracketPreviewTeam {
  id: string;
  name: string;
}

export interface TournamentBracketPreviewExpectedBye {
  seedNo: number;
  teamId: string;
  entry: JsonObject;
  nextMatchId: string;
}

export interface TournamentBracketPreviewFixture {
  id: string;
  description: string;
  teams: readonly TournamentBracketPreviewTeam[];
  tournamentPlan: JsonObject;
  expected: {
    upperParticipantCount: number;
    upperMatchCount: number;
    upperByeCount: number;
    lowerParticipantCount: number;
    openingPreliminaryMatchIds: readonly string[];
    openingByes: readonly TournamentBracketPreviewExpectedBye[];
  };
}

export class TournamentBracketPreviewFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TournamentBracketPreviewFixtureError";
  }
}

function objectValue(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TournamentBracketPreviewFixtureError(`${label}を読み取れませんでした。`);
  }
  return value as JsonObject;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TournamentBracketPreviewFixtureError(`${label}を読み取れませんでした。`);
  }
  return value;
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TournamentBracketPreviewFixtureError(`${label}を読み取れませんでした。`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TournamentBracketPreviewFixtureError(`${label}を読み取れませんでした。`);
  }
  return value;
}

function entryKey(value: unknown): string {
  const entry = objectValue(value, "トーナメント参加枠");
  if (
    entry.type === "league_rank" &&
    typeof entry.block_id === "string" &&
    typeof entry.rank === "number"
  ) {
    return `league_rank:${entry.block_id}:${String(entry.rank)}`;
  }
  if (
    (entry.type === "winner_of" || entry.type === "loser_of") &&
    typeof entry.match_id === "string"
  ) {
    return `${entry.type}:${entry.match_id}`;
  }
  throw new TournamentBracketPreviewFixtureError("トーナメント参加枠が不正です。");
}

function validateName(name: string): void {
  const characterCount = [...name].length;
  const maximum = /^[A-Za-z]+$/u.test(name) ? 9 : 6;
  if (characterCount > maximum) {
    throw new TournamentBracketPreviewFixtureError(
      `チーム名「${name}」が${String(maximum)}文字を超えています。`,
    );
  }
}

function referenceMatchId(value: unknown): string | undefined {
  const entry = objectValue(value, "トーナメント参加枠");
  return entry.type === "winner_of" || entry.type === "loser_of"
    ? textValue(entry.match_id, "参照元試合ID")
    : undefined;
}

export function validateTournamentBracketPreviewFixture(
  value: unknown,
): TournamentBracketPreviewFixture {
  const raw = objectValue(value, "プレビューfixture");
  const id = textValue(raw.fixture_id, "fixture ID");
  const description = textValue(raw.description, "fixtureの説明");
  const rawTeams = arrayValue(raw.teams, "fixtureのチーム");
  const teams = rawTeams.map((item, index) => {
    const team = objectValue(item, `チーム${String(index + 1)}`);
    const result = {
      id: textValue(team.id, "チームID"),
      name: textValue(team.name, "チーム名"),
    };
    validateName(result.name);
    return result;
  });
  if (new Set(teams.map((team) => team.id)).size !== teams.length) {
    throw new TournamentBracketPreviewFixtureError("チームIDが重複しています。");
  }
  if (new Set(teams.map((team) => team.name)).size !== teams.length) {
    throw new TournamentBracketPreviewFixtureError("チーム名が重複しています。");
  }

  const tournamentPlan = objectValue(raw.tournament_plan, "トーナメント表");
  const upper = objectValue(tournamentPlan.upper, "上位トーナメント");
  const lower = objectValue(tournamentPlan.lower, "下位トーナメント");
  const matches = arrayValue(upper.matches, "上位トーナメント試合").map((item) =>
    objectValue(item, "上位トーナメント試合")
  );
  const matchIds = matches.map((match) => textValue(match.id, "試合ID"));
  const matchIdSet = new Set(matchIds);
  if (matchIdSet.size !== matchIds.length) {
    throw new TournamentBracketPreviewFixtureError("上位トーナメントの試合IDが重複しています。");
  }
  for (const match of matches) {
    for (const side of [match.home, match.away]) {
      const reference = referenceMatchId(side);
      if (reference !== undefined && !matchIdSet.has(reference)) {
        throw new TournamentBracketPreviewFixtureError(
          `試合「${String(match.id)}」が未知の試合「${reference}」を参照しています。`,
        );
      }
    }
  }
  for (const placement of arrayValue(upper.placements, "上位トーナメント順位").map((item) =>
    objectValue(item, "上位トーナメント順位")
  )) {
    const reference = referenceMatchId(placement.entry);
    if (reference !== undefined && !matchIdSet.has(reference)) {
      throw new TournamentBracketPreviewFixtureError(
        `順位枠が未知の試合「${reference}」を参照しています。`,
      );
    }
  }

  const teamIdSet = new Set(teams.map((team) => team.id));
  const seeds = arrayValue(upper.seeds, "上位トーナメントシード").map((item) =>
    objectValue(item, "上位トーナメントシード")
  );
  const seedTeamIds = seeds.map((seed) => textValue(seed.team_id, "シードのチームID"));
  if (
    new Set(seedTeamIds).size !== seedTeamIds.length ||
    seedTeamIds.some((teamId) => !teamIdSet.has(teamId))
  ) {
    throw new TournamentBracketPreviewFixtureError("シードのチーム参照が重複または不明です。");
  }

  const byes = arrayValue(upper.byes, "上位トーナメントの不戦通過").map((item) =>
    objectValue(item, "上位トーナメントの不戦通過")
  );
  for (const bye of byes) {
    const sourceMatchId = referenceMatchId(bye.entry);
    if (sourceMatchId !== undefined && !matchIdSet.has(sourceMatchId)) {
      throw new TournamentBracketPreviewFixtureError(
        `不戦通過が未知の試合「${sourceMatchId}」を参照しています。`,
      );
    }
    const nextMatchId = textValue(bye.next_match_id, "不戦通過の進行先");
    const nextMatch = matches.find((match) => match.id === nextMatchId);
    if (nextMatch === undefined) {
      throw new TournamentBracketPreviewFixtureError(
        `不戦通過が未知の試合「${nextMatchId}」を参照しています。`,
      );
    }
    const key = entryKey(bye.entry);
    const matchingSides = [nextMatch.home, nextMatch.away].filter((side) => entryKey(side) === key);
    if (matchingSides.length !== 1) {
      throw new TournamentBracketPreviewFixtureError("不戦通過の参加枠と進行先が一致しません。");
    }
  }

  const expectedRaw = objectValue(raw.expected, "fixtureの期待値");
  const openingPreliminaryMatchIds = arrayValue(
    expectedRaw.opening_preliminary_match_ids,
    "予備戦ID",
  ).map((item) => textValue(item, "予備戦ID"));
  if (openingPreliminaryMatchIds.some((matchId) => !matchIdSet.has(matchId))) {
    throw new TournamentBracketPreviewFixtureError("期待値の予備戦IDが試合に存在しません。");
  }
  const openingByes = arrayValue(expectedRaw.opening_byes, "予備戦免除").map((item) => {
    const bye = objectValue(item, "予備戦免除");
    const entry = objectValue(bye.entry, "予備戦免除の参加枠");
    const nextMatchId = textValue(bye.next_match_id, "予備戦免除の進行先");
    const seedNo = nonNegativeInteger(bye.seed_no, "予備戦免除のシード番号");
    const teamId = textValue(bye.team_id, "予備戦免除のチームID");
    if (
      !byes.some((candidate) =>
        entryKey(candidate.entry) === entryKey(entry) && candidate.next_match_id === nextMatchId
      ) ||
      !seeds.some((seed) => seed.seed_no === seedNo && seed.team_id === teamId)
    ) {
      throw new TournamentBracketPreviewFixtureError("予備戦免除の期待値が生成結果と一致しません。");
    }
    return { seedNo, teamId, entry, nextMatchId };
  });
  const expected = {
    upperParticipantCount: nonNegativeInteger(
      expectedRaw.upper_participant_count,
      "上位トーナメント参加数",
    ),
    upperMatchCount: nonNegativeInteger(expectedRaw.upper_match_count, "上位試合数"),
    upperByeCount: nonNegativeInteger(expectedRaw.upper_bye_count, "不戦通過数"),
    lowerParticipantCount: nonNegativeInteger(
      expectedRaw.lower_participant_count,
      "下位トーナメント参加数",
    ),
    openingPreliminaryMatchIds,
    openingByes,
  };
  if (
    upper.participant_count !== expected.upperParticipantCount ||
    matches.length !== expected.upperMatchCount ||
    byes.length !== expected.upperByeCount ||
    lower.participant_count !== expected.lowerParticipantCount ||
    teams.length !== expected.upperParticipantCount ||
    seeds.length !== expected.upperParticipantCount
  ) {
    throw new TournamentBracketPreviewFixtureError("fixtureの期待値がトーナメント表と一致しません。");
  }
  if (expected.lowerParticipantCount !== 0) {
    throw new TournamentBracketPreviewFixtureError("比較用fixtureには下位チームを含められません。");
  }
  return { id, description, teams, tournamentPlan, expected };
}

const fixtures = [upperEightJson, upperSevenSeededJson].map(
  validateTournamentBracketPreviewFixture,
);
if (new Set(fixtures.map((fixture) => fixture.id)).size !== fixtures.length) {
  throw new TournamentBracketPreviewFixtureError("fixture IDが重複しています。");
}

export const tournamentBracketPreviewFixtures: readonly TournamentBracketPreviewFixture[] = fixtures;

export function tournamentBracketPreviewFixture(
  id: string,
): TournamentBracketPreviewFixture | undefined {
  return fixtures.find((fixture) => fixture.id === id);
}
