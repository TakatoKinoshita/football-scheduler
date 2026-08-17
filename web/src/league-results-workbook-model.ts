import type { JsonObject, TournamentDocument } from "./types";
import {
  type WorkbookCell,
  type WorkbookCellStyle,
  type WorkbookFile,
  type WorkbookSheet,
  numberCell,
  sanitizeWorkbookFileName,
  textCell,
  uniqueSheetNames,
} from "./workbook";

const SCHEMA_VERSION = "0.2.0";

const META_LABEL_STYLE: WorkbookCellStyle = {
  fontWeight: "bold",
  textColor: "#FFFFFF",
  backgroundColor: "#174F3F",
  borderColor: "#174F3F",
  borderStyle: "thin",
};
const META_VALUE_STYLE: WorkbookCellStyle = {
  borderColor: "#AAB8B2",
  borderStyle: "thin",
  wrap: true,
};
const HEADER_STYLE: WorkbookCellStyle = {
  fontWeight: "bold",
  textColor: "#FFFFFF",
  backgroundColor: "#28705B",
  borderColor: "#174F3F",
  borderStyle: "thin",
  align: "center",
  alignVertical: "center",
  wrap: true,
};
const TEAM_STYLE: WorkbookCellStyle = {
  fontWeight: "bold",
  backgroundColor: "#DDECE6",
  borderColor: "#AAB8B2",
  borderStyle: "thin",
  alignVertical: "center",
  wrap: true,
};
const DATA_STYLE: WorkbookCellStyle = {
  borderColor: "#AAB8B2",
  borderStyle: "thin",
  align: "center",
  alignVertical: "center",
  wrap: true,
};
const SELF_STYLE: WorkbookCellStyle = {
  ...DATA_STYLE,
  backgroundColor: "#E5E7E6",
  textColor: "#67716D",
};
const DRAW_TITLE_STYLE: WorkbookCellStyle = {
  fontWeight: "bold",
  backgroundColor: "#DDECE6",
  borderColor: "#AAB8B2",
  borderStyle: "thin",
};

interface Team {
  id: string;
  name: string;
}

interface LeagueBlock {
  id: string;
  displayName: string;
  teamIds: string[];
}

interface LeagueMatch {
  id: string;
  blockId: string;
  homeTeamId: string;
  awayTeamId: string;
}

interface MatchResult {
  matchId: string;
  homeScore: number;
  awayScore: number;
}

interface Metrics {
  points: number;
  goalDifference: number;
  goalsFor: number;
}

interface Standing {
  blockId: string;
  rank: number;
  teamId: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  points: number;
  tieBreak: string;
  headToHead: Metrics | null;
}

interface DrawRecord {
  blockId: string;
  candidates: string[];
  decidedOrder: string[];
  randomSeed: number;
}

interface ValidLeagueResults {
  teams: Team[];
  blocks: LeagueBlock[];
  matches: LeagueMatch[];
  results: ReadonlyMap<string, MatchResult>;
  standings: ReadonlyMap<string, Standing>;
  draws: DrawRecord[];
}

interface Aggregate {
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
}

export class LeagueResultsWorkbookError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "LeagueResultsWorkbookError";
  }
}

function fail(
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new LeagueResultsWorkbookError(code, message, details);
}

function object(value: unknown, message: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("LEAGUE_RESULTS_EXPORT_INPUT_INVALID", message);
  }
  return value as JsonObject;
}

function objects(value: unknown, message: string): JsonObject[] {
  if (!Array.isArray(value)) {
    return fail("LEAGUE_RESULTS_EXPORT_INPUT_INVALID", message);
  }
  return value.map((item) => object(item, message));
}

function nonEmptyText(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fail("LEAGUE_RESULTS_EXPORT_INPUT_INVALID", message);
  }
  return value;
}

function integer(value: unknown, message: string, minimum?: number): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || (minimum !== undefined && value < minimum)
  ) {
    return fail("LEAGUE_RESULTS_EXPORT_INPUT_INVALID", message);
  }
  return value;
}

function stringArray(value: unknown, message: string): string[] {
  if (!Array.isArray(value)) return fail("LEAGUE_RESULTS_EXPORT_INPUT_INVALID", message);
  return value.map((item) => nonEmptyText(item, message));
}

function duplicates(values: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function pairKey(left: string, right: string): string {
  return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function parseTeams(input: JsonObject): Team[] {
  const teams = objects(input.teams, "登録チームを読み取れませんでした。").map((raw): Team => ({
    id: nonEmptyText(raw.id, "チームIDを読み取れませんでした。"),
    name: nonEmptyText(raw.name, "チーム名を読み取れませんでした。"),
  }));
  const duplicateIds = duplicates(teams.map((team) => team.id));
  if (teams.length < 2 || duplicateIds.length > 0) {
    return fail(
      "LEAGUE_RESULTS_EXPORT_INPUT_INVALID",
      duplicateIds.length > 0
        ? "登録チームのIDが重複しています。"
        : "リーグ結果の出力には2チーム以上が必要です。",
      { team_ids: duplicateIds },
    );
  }
  return teams;
}

function parseLeaguePlan(
  rawPlan: JsonObject,
  registeredTeams: readonly Team[],
): { blocks: LeagueBlock[]; matches: LeagueMatch[] } {
  if (rawPlan.schema_version !== SCHEMA_VERSION) {
    return fail(
      "LEAGUE_RESULTS_EXPORT_INPUT_INVALID",
      "リーグ計画のschema versionを確認できませんでした。",
    );
  }
  if (
    rawPlan.assignment_mode !== "random"
    && rawPlan.assignment_mode !== "seeded_snake"
    && rawPlan.assignment_mode !== "manual"
  ) {
    return fail(
      "LEAGUE_RESULTS_EXPORT_INPUT_INVALID",
      "リーグ計画のブロック分け方式を読み取れませんでした。",
    );
  }
  integer(rawPlan.random_seed, "リーグ計画の抽選番号を読み取れませんでした。");
  const blocks = objects(rawPlan.blocks, "リーグのブロック情報を読み取れませんでした。")
    .map((raw): LeagueBlock => {
      const id = nonEmptyText(raw.id, "ブロックIDを読み取れませんでした。");
      const displayName = raw.display_name === undefined
        ? `${id}ブロック`
        : nonEmptyText(raw.display_name, "ブロック名を読み取れませんでした。");
      return {
        id,
        displayName,
        teamIds: stringArray(raw.team_ids, "ブロックの参加チームを読み取れませんでした。"),
      };
    });
  if (blocks.length === 0 || duplicates(blocks.map((block) => block.id)).length > 0) {
    return fail(
      "LEAGUE_RESULTS_EXPORT_INPUT_INVALID",
      blocks.length === 0
        ? "リーグ計画にブロックがありません。"
        : "リーグ計画のブロックIDが重複しています。",
    );
  }
  const plannedTeamIds = blocks.flatMap((block) => block.teamIds);
  const registeredTeamIds = registeredTeams.map((team) => team.id);
  if (
    blocks.some((block) => block.teamIds.length < 2 || duplicates(block.teamIds).length > 0)
    || duplicates(plannedTeamIds).length > 0
    || !sameMembers(plannedTeamIds, registeredTeamIds)
  ) {
    return fail(
      "LEAGUE_RESULTS_EXPORT_INPUT_INVALID",
      "リーグ計画の参加チームと登録チームが一致しません。日程を再生成してください。",
    );
  }

  const blockById = new Map(blocks.map((block) => [block.id, block]));
  const matchBlock = new Map<string, string>();
  const roundAssignments: Array<{ blockId: string; matchIds: string[] }> = [];
  const roundNumbers = new Set<string>();
  for (const round of objects(rawPlan.logical_rounds, "リーグの論理ラウンドを読み取れませんでした。")) {
    const blockId = nonEmptyText(round.block_id, "論理ラウンドのブロックIDを読み取れませんでした。");
    const roundNo = integer(round.round_no, "論理ラウンド番号を読み取れませんでした。", 1);
    if (!blockById.has(blockId)) {
      return fail(
        "LEAGUE_RESULTS_EXPORT_INPUT_INVALID",
        "論理ラウンドが存在しないブロックを参照しています。",
        { block_id: blockId },
      );
    }
    const roundKey = `${blockId}\u0000${String(roundNo)}`;
    if (roundNumbers.has(roundKey)) {
      return fail("LEAGUE_RESULTS_EXPORT_INPUT_INVALID", "同じ論理ラウンドが重複しています。");
    }
    roundNumbers.add(roundKey);
    const matchIds = stringArray(round.match_ids, "論理ラウンドの試合IDを読み取れませんでした。");
    if (matchIds.length === 0 || duplicates(matchIds).length > 0) {
      return fail("LEAGUE_RESULTS_EXPORT_INPUT_INVALID", "論理ラウンドの試合構成が不正です。");
    }
    roundAssignments.push({ blockId, matchIds });
    for (const matchId of matchIds) {
      if (matchBlock.has(matchId)) {
        return fail(
          "LEAGUE_RESULTS_EXPORT_INPUT_INVALID",
          "同じリーグ試合が複数の論理ラウンドに含まれています。",
          { match_id: matchId },
        );
      }
      matchBlock.set(matchId, blockId);
    }
  }

  const teamBlock = new Map(blocks.flatMap((block) =>
    block.teamIds.map((teamId) => [teamId, block.id] as const)
  ));
  const matches = objects(rawPlan.matches, "リーグの試合情報を読み取れませんでした。 ")
    .map((raw): LeagueMatch => {
      const id = nonEmptyText(raw.id, "リーグ試合IDを読み取れませんでした。");
      const home = stringArray(
        raw.possible_home_team_ids,
        `試合「${id}」の左側チームを読み取れませんでした。`,
      );
      const away = stringArray(
        raw.possible_away_team_ids,
        `試合「${id}」の右側チームを読み取れませんでした。`,
      );
      const blockId = matchBlock.get(id);
      if (
        raw.phase !== "league"
        || home.length !== 1
        || away.length !== 1
        || home[0] === away[0]
        || blockId === undefined
        || teamBlock.get(home[0]!) !== blockId
        || teamBlock.get(away[0]!) !== blockId
      ) {
        return fail(
          "LEAGUE_RESULTS_EXPORT_INPUT_INVALID",
          `試合「${id}」のブロックまたは参加チームがリーグ計画と一致しません。`,
          { match_id: id },
        );
      }
      return { id, blockId, homeTeamId: home[0]!, awayTeamId: away[0]! };
    });
  if (
    duplicates(matches.map((match) => match.id)).length > 0
    || matchBlock.size !== matches.length
    || matches.some((match) => !matchBlock.has(match.id))
  ) {
    return fail(
      "LEAGUE_RESULTS_EXPORT_INPUT_INVALID",
      "リーグ試合のIDまたは論理ラウンドとの対応が不正です。",
    );
  }
  const matchById = new Map(matches.map((match) => [match.id, match]));
  for (const round of roundAssignments) {
    const roundTeams = round.matchIds.flatMap((matchId) => {
      const match = matchById.get(matchId);
      return match === undefined ? [] : [match.homeTeamId, match.awayTeamId];
    });
    if (roundTeams.length !== round.matchIds.length * 2 || duplicates(roundTeams).length > 0) {
      return fail(
        "LEAGUE_RESULTS_EXPORT_INPUT_INVALID",
        "同じ論理ラウンドでチームが重複しているか、不明な試合が参照されています。",
        { block_id: round.blockId },
      );
    }
  }
  for (const block of blocks) {
    const expectedPairs = new Set<string>();
    for (let left = 0; left < block.teamIds.length; left += 1) {
      for (let right = left + 1; right < block.teamIds.length; right += 1) {
        expectedPairs.add(pairKey(block.teamIds[left]!, block.teamIds[right]!));
      }
    }
    const actualPairs = matches
      .filter((match) => match.blockId === block.id)
      .map((match) => pairKey(match.homeTeamId, match.awayTeamId));
    if (
      duplicates(actualPairs).length > 0
      || actualPairs.length !== expectedPairs.size
      || actualPairs.some((pair) => !expectedPairs.has(pair))
    ) {
      return fail(
        "LEAGUE_RESULTS_EXPORT_INPUT_INVALID",
        `「${block.displayName}」の総当たり対戦を確認できませんでした。日程を再生成してください。`,
        { block_id: block.id },
      );
    }
  }
  return { blocks, matches };
}

function parseResults(
  rawResults: unknown,
  matches: readonly LeagueMatch[],
): ReadonlyMap<string, MatchResult> {
  const results = objects(rawResults, "リーグ試合結果を読み取れませんでした。").map((raw): MatchResult => ({
    matchId: nonEmptyText(raw.match_id, "リーグ試合結果のIDを読み取れませんでした。"),
    homeScore: integer(raw.home_score, "リーグ試合の得点を読み取れませんでした。", 0),
    awayScore: integer(raw.away_score, "リーグ試合の得点を読み取れませんでした。", 0),
  }));
  const known = new Set(matches.map((match) => match.id));
  const duplicateIds = duplicates(results.map((result) => result.matchId));
  const unknownIds = results.map((result) => result.matchId).filter((id) => !known.has(id));
  const supplied = new Set(results.map((result) => result.matchId));
  const missingIds = matches.map((match) => match.id).filter((id) => !supplied.has(id));
  if (duplicateIds.length > 0 || unknownIds.length > 0 || missingIds.length > 0) {
    return fail(
      "LEAGUE_RESULTS_EXPORT_RESULT_INVALID",
      duplicateIds.length > 0
        ? "同じリーグ試合の結果が重複しています。"
        : unknownIds.length > 0
          ? "日程にないリーグ試合の結果が含まれています。"
          : "全試合の結果を入力し、順位を確定してからExcelへ出力してください。",
      {
        duplicate_match_ids: duplicateIds,
        unknown_match_ids: [...new Set(unknownIds)].sort(),
        missing_match_ids: missingIds.sort(),
      },
    );
  }
  return new Map(results.map((result) => [result.matchId, result]));
}

function emptyAggregate(): Aggregate {
  return {
    played: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    points: 0,
  };
}

function recordResult(
  home: Aggregate,
  away: Aggregate,
  homeScore: number,
  awayScore: number,
): void {
  home.played += 1;
  away.played += 1;
  home.goalsFor += homeScore;
  home.goalsAgainst += awayScore;
  away.goalsFor += awayScore;
  away.goalsAgainst += homeScore;
  if (homeScore > awayScore) {
    home.wins += 1;
    away.losses += 1;
    home.points += 3;
  } else if (homeScore < awayScore) {
    away.wins += 1;
    home.losses += 1;
    away.points += 3;
  } else {
    home.draws += 1;
    away.draws += 1;
    home.points += 1;
    away.points += 1;
  }
}

function aggregateResults(
  teamIds: readonly string[],
  matches: readonly LeagueMatch[],
  results: ReadonlyMap<string, MatchResult>,
): ReadonlyMap<string, Aggregate> {
  const aggregate = new Map(teamIds.map((teamId) => [teamId, emptyAggregate()]));
  for (const match of matches) {
    const result = results.get(match.id)!;
    recordResult(
      aggregate.get(match.homeTeamId)!,
      aggregate.get(match.awayTeamId)!,
      result.homeScore,
      result.awayScore,
    );
  }
  return aggregate;
}

function metrics(value: unknown, teamId: string): Metrics | null {
  if (value === null) return null;
  const raw = object(value, `チーム「${teamId}」の直接対戦値を読み取れませんでした。`);
  return {
    points: integer(raw.points, `チーム「${teamId}」の直接対戦内勝点を読み取れませんでした。`, 0),
    goalDifference: integer(raw.goal_difference, `チーム「${teamId}」の直接対戦内得失点差を読み取れませんでした。`),
    goalsFor: integer(raw.goals_for, `チーム「${teamId}」の直接対戦内得点を読み取れませんでした。`, 0),
  };
}

function parseStandings(
  rawStandings: JsonObject,
  blocks: readonly LeagueBlock[],
  matches: readonly LeagueMatch[],
  results: ReadonlyMap<string, MatchResult>,
): { standings: ReadonlyMap<string, Standing>; orderedRows: Standing[] } {
  if (rawStandings.schema_version !== SCHEMA_VERSION || rawStandings.status !== "COMPLETE") {
    return fail(
      "LEAGUE_RESULTS_EXPORT_UNAVAILABLE",
      "順位を確定してからリーグ結果をExcelへ出力してください。",
    );
  }
  const rows = objects(rawStandings.standings, "確定順位を読み取れませんでした。").map(
    (raw): Standing => {
      const teamId = nonEmptyText(raw.team_id, "順位表のチームIDを読み取れませんでした。");
      return {
        blockId: nonEmptyText(raw.block_id, `チーム「${teamId}」のブロックを読み取れませんでした。`),
        rank: integer(raw.rank, `チーム「${teamId}」の順位を読み取れませんでした。`, 1),
        teamId,
        played: integer(raw.played, `チーム「${teamId}」の試合数を読み取れませんでした。`, 0),
        wins: integer(raw.wins, `チーム「${teamId}」の勝数を読み取れませんでした。`, 0),
        draws: integer(raw.draws, `チーム「${teamId}」の分数を読み取れませんでした。`, 0),
        losses: integer(raw.losses, `チーム「${teamId}」の敗数を読み取れませんでした。`, 0),
        goalsFor: integer(raw.goals_for, `チーム「${teamId}」の得点を読み取れませんでした。`, 0),
        goalsAgainst: integer(raw.goals_against, `チーム「${teamId}」の失点を読み取れませんでした。`, 0),
        goalDifference: integer(raw.goal_difference, `チーム「${teamId}」の得失点差を読み取れませんでした。`),
        points: integer(raw.points, `チーム「${teamId}」の勝点を読み取れませんでした。`, 0),
        tieBreak: nonEmptyText(raw.tie_break, `チーム「${teamId}」の順位決定根拠を読み取れませんでした。`),
        headToHead: metrics(raw.head_to_head, teamId),
      };
    },
  );
  const teamIds = blocks.flatMap((block) => block.teamIds);
  const blockByTeam = new Map(blocks.flatMap((block) =>
    block.teamIds.map((teamId) => [teamId, block.id] as const)
  ));
  const rowTeams = rows.map((row) => row.teamId);
  if (
    rows.length !== teamIds.length
    || duplicates(rowTeams).length > 0
    || !sameMembers(rowTeams, teamIds)
    || rows.some((row) => blockByTeam.get(row.teamId) !== row.blockId)
  ) {
    return fail(
      "LEAGUE_RESULTS_EXPORT_STANDINGS_INVALID",
      "順位表のブロックまたは参加チームがリーグ計画と一致しません。",
    );
  }
  for (const block of blocks) {
    const ranks = rows
      .filter((row) => row.blockId === block.id)
      .map((row) => row.rank)
      .sort((left, right) => left - right);
    const expected = block.teamIds.map((_teamId, index) => index + 1);
    if (ranks.length !== expected.length || ranks.some((rank, index) => rank !== expected[index])) {
      return fail(
        "LEAGUE_RESULTS_EXPORT_STANDINGS_INVALID",
        `「${block.displayName}」の順位に欠落または重複があります。`,
        { block_id: block.id },
      );
    }
  }
  const aggregate = aggregateResults(teamIds, matches, results);
  for (const row of rows) {
    const actual = aggregate.get(row.teamId)!;
    const expected = [
      actual.played,
      actual.wins,
      actual.draws,
      actual.losses,
      actual.goalsFor,
      actual.goalsAgainst,
      actual.goalsFor - actual.goalsAgainst,
      actual.points,
    ];
    const supplied = [
      row.played,
      row.wins,
      row.draws,
      row.losses,
      row.goalsFor,
      row.goalsAgainst,
      row.goalDifference,
      row.points,
    ];
    if (expected.some((value, index) => value !== supplied[index])) {
      return fail(
        "LEAGUE_RESULTS_EXPORT_STANDINGS_INVALID",
        `チーム「${row.teamId}」の集計値が試合結果と一致しません。順位を確定し直してください。`,
        { team_id: row.teamId },
      );
    }
  }
  const baseTieGroups = new Map<string, Standing[]>();
  for (const row of rows) {
    const key = [
      row.blockId,
      String(row.points),
      String(row.goalDifference),
      String(row.goalsFor),
    ].join("\u0000");
    const group = baseTieGroups.get(key);
    if (group === undefined) baseTieGroups.set(key, [row]);
    else group.push(row);
  }
  for (const group of baseTieGroups.values()) {
    if (group.length === 1) {
      if (group[0]!.headToHead !== null) {
        return fail(
          "LEAGUE_RESULTS_EXPORT_STANDINGS_INVALID",
          `チーム「${group[0]!.teamId}」の直接対戦値が試合結果と一致しません。`,
          { team_id: group[0]!.teamId },
        );
      }
      continue;
    }
    const groupTeams = new Set(group.map((row) => row.teamId));
    const mini = new Map(group.map((row) => [row.teamId, emptyAggregate()]));
    for (const match of matches) {
      if (!groupTeams.has(match.homeTeamId) || !groupTeams.has(match.awayTeamId)) continue;
      const result = results.get(match.id)!;
      recordResult(
        mini.get(match.homeTeamId)!,
        mini.get(match.awayTeamId)!,
        result.homeScore,
        result.awayScore,
      );
    }
    for (const row of group) {
      const value = mini.get(row.teamId)!;
      const expected = {
        points: value.points,
        goalDifference: value.goalsFor - value.goalsAgainst,
        goalsFor: value.goalsFor,
      };
      if (!sameMetrics(row.headToHead, expected)) {
        return fail(
          "LEAGUE_RESULTS_EXPORT_STANDINGS_INVALID",
          `チーム「${row.teamId}」の直接対戦値が試合結果と一致しません。順位を確定し直してください。`,
          { team_id: row.teamId },
        );
      }
    }
  }
  return { standings: new Map(rows.map((row) => [row.teamId, row])), orderedRows: rows };
}

function sameMetrics(left: Metrics | null, right: Metrics | null): boolean {
  return left === null && right === null || left !== null && right !== null
    && left.points === right.points
    && left.goalDifference === right.goalDifference
    && left.goalsFor === right.goalsFor;
}

function parseDraws(
  rawDraws: unknown,
  blocks: readonly LeagueBlock[],
  standings: ReadonlyMap<string, Standing>,
  orderedRows: readonly Standing[],
): DrawRecord[] {
  const blockById = new Map(blocks.map((block) => [block.id, block]));
  const seenCandidates = new Set<string>();
  const draws = objects(rawDraws, "抽選記録を読み取れませんでした。").map((raw): DrawRecord => {
    const blockId = nonEmptyText(raw.block_id, "抽選記録のブロックIDを読み取れませんでした。");
    const block = blockById.get(blockId);
    const candidates = stringArray(raw.candidates, "抽選候補を読み取れませんでした。");
    const decidedOrder = stringArray(raw.decided_order, "抽選確定順を読み取れませんでした。");
    if (
      block === undefined
      || candidates.length < 2
      || duplicates(candidates).length > 0
      || duplicates(decidedOrder).length > 0
      || !sameMembers(candidates, decidedOrder)
      || candidates.some((teamId) => !block.teamIds.includes(teamId) || seenCandidates.has(teamId))
    ) {
      return fail(
        "LEAGUE_RESULTS_EXPORT_STANDINGS_INVALID",
        "抽選記録の候補、確定順、またはブロックが順位表と一致しません。",
        { block_id: blockId },
      );
    }
    const rankedOrder = orderedRows
      .filter((row) => row.blockId === blockId && candidates.includes(row.teamId))
      .sort((left, right) => left.rank - right.rank)
      .map((row) => row.teamId);
    if (rankedOrder.some((teamId, index) => decidedOrder[index] !== teamId)) {
      return fail(
        "LEAGUE_RESULTS_EXPORT_STANDINGS_INVALID",
        "抽選記録の確定順が保存済み順位と一致しません。",
        { block_id: blockId },
      );
    }
    const candidateValues = objects(raw.candidate_values, "抽選候補の監査値を読み取れませんでした。");
    const candidateValueTeams = candidateValues.map((candidate) =>
      nonEmptyText(candidate.team_id, "抽選候補のチームIDを読み取れませんでした。")
    );
    if (
      duplicates(candidateValueTeams).length > 0
      || !sameMembers(candidateValueTeams, candidates)
      || candidateValues.some((candidate) => {
        const teamId = String(candidate.team_id);
        const standing = standings.get(teamId);
        return standing === undefined
          || !standing.tieBreak.includes("抽選")
          || !sameMetrics(metrics(candidate.head_to_head, teamId), standing.headToHead);
      })
    ) {
      return fail(
        "LEAGUE_RESULTS_EXPORT_STANDINGS_INVALID",
        "抽選候補の監査値が保存済み順位と一致しません。",
        { block_id: blockId },
      );
    }
    for (const teamId of candidates) seenCandidates.add(teamId);
    return {
      blockId,
      candidates,
      decidedOrder,
      randomSeed: integer(raw.random_seed, "抽選番号を読み取れませんでした。"),
    };
  });
  const missingDrawTeams = orderedRows
    .filter((row) => row.tieBreak.includes("抽選") && !seenCandidates.has(row.teamId))
    .map((row) => row.teamId);
  if (missingDrawTeams.length > 0) {
    return fail(
      "LEAGUE_RESULTS_EXPORT_STANDINGS_INVALID",
      "抽選で決定した順位に対応する抽選記録がありません。",
      { team_ids: missingDrawTeams },
    );
  }
  return draws;
}

function validateLeagueResults(document: TournamentDocument): ValidLeagueResults {
  if (document.schemaVersion !== SCHEMA_VERSION) {
    return fail(
      "LEAGUE_RESULTS_EXPORT_UNAVAILABLE",
      "旧形式の大会データからリーグ結果Excelは生成できません。編集用コピーで順位を確定し直してください。",
    );
  }
  const result = document.tournament.result;
  if (result === undefined) {
    return fail(
      "LEAGUE_RESULTS_EXPORT_UNAVAILABLE",
      "全試合の結果を入力し、順位を確定してからExcelへ出力してください。",
    );
  }
  if (result.league_plan === undefined) {
    return fail(
      "LEAGUE_RESULTS_EXPORT_UNAVAILABLE",
      "1日目の日程を生成してからリーグ結果をExcelへ出力してください。",
    );
  }
  if (result.league_results === undefined || result.league_standings === undefined) {
    return fail(
      "LEAGUE_RESULTS_EXPORT_UNAVAILABLE",
      "全試合の結果を入力し、順位を確定してからExcelへ出力してください。",
    );
  }
  const input = document.tournament.input;
  const teams = parseTeams(input);
  const plan = parseLeaguePlan(
    object(result.league_plan, "リーグ計画を読み取れませんでした。日程を再生成してください。"),
    teams,
  );
  const results = parseResults(result.league_results, plan.matches);
  const rawStandings = object(result.league_standings, "確定順位を読み取れませんでした。");
  const parsedStandings = parseStandings(rawStandings, plan.blocks, plan.matches, results);
  const draws = parseDraws(
    rawStandings.draws,
    plan.blocks,
    parsedStandings.standings,
    parsedStandings.orderedRows,
  );
  return {
    teams,
    blocks: plan.blocks,
    matches: plan.matches,
    results,
    standings: parsedStandings.standings,
    draws,
  };
}

function savedAtLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return fail("LEAGUE_RESULTS_EXPORT_INPUT_INVALID", "大会データの保存日時を読み取れませんでした。");
  }
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(date);
}

function resultSymbol(scoreFor: number, scoreAgainst: number): string {
  return scoreFor > scoreAgainst ? "○" : scoreFor < scoreAgainst ? "●" : "△";
}

function scoreLabel(
  rowTeamId: string,
  match: LeagueMatch,
  result: MatchResult,
): string {
  const home = match.homeTeamId === rowTeamId;
  const scoreFor = home ? result.homeScore : result.awayScore;
  const scoreAgainst = home ? result.awayScore : result.homeScore;
  return `${resultSymbol(scoreFor, scoreAgainst)} ${String(scoreFor)}-${String(scoreAgainst)}`;
}

function metadataRows(
  tournamentName: string,
  blockName: string,
  savedAt: string,
): WorkbookCell[][] {
  return [
    [textCell("大会名", META_LABEL_STYLE), textCell(tournamentName, META_VALUE_STYLE)],
    [textCell("ブロック", META_LABEL_STYLE), textCell(blockName, META_VALUE_STYLE)],
    [textCell("保存日時", META_LABEL_STYLE), textCell(savedAt, META_VALUE_STYLE)],
    [],
  ];
}

const AGGREGATE_HEADERS = [
  "試合",
  "勝",
  "分",
  "敗",
  "勝点",
  "得点",
  "失点",
  "得失点差",
  "順位",
  "順位決定根拠",
  "直接対戦内勝点",
  "直接対戦内得失点差",
  "直接対戦内得点",
] as const;

function headerRow(teamNames: readonly string[]): WorkbookCell[] {
  return ["チーム", ...teamNames, ...AGGREGATE_HEADERS].map((label) =>
    textCell(label, HEADER_STYLE)
  );
}

function standingCells(standing: Standing): WorkbookCell[] {
  const headToHead = standing.headToHead;
  return [
    standing.played,
    standing.wins,
    standing.draws,
    standing.losses,
    standing.points,
    standing.goalsFor,
    standing.goalsAgainst,
    standing.goalDifference,
    standing.rank,
  ].map((value) => numberCell(value, DATA_STYLE)).concat([
    textCell(standing.tieBreak, DATA_STYLE),
    headToHead === null ? textCell("—", SELF_STYLE) : numberCell(headToHead.points, DATA_STYLE),
    headToHead === null
      ? textCell("—", SELF_STYLE)
      : numberCell(headToHead.goalDifference, DATA_STYLE),
    headToHead === null ? textCell("—", SELF_STYLE) : numberCell(headToHead.goalsFor, DATA_STYLE),
  ]);
}

function drawRows(
  blockId: string,
  draws: readonly DrawRecord[],
  teamNames: ReadonlyMap<string, string>,
): WorkbookCell[][] {
  const blockDraws = draws.filter((draw) => draw.blockId === blockId);
  if (blockDraws.length === 0) return [];
  const rows: WorkbookCell[][] = [[], [textCell("抽選記録", DRAW_TITLE_STYLE)]];
  for (const [index, draw] of blockDraws.entries()) {
    if (index > 0) rows.push([]);
    rows.push(
      [textCell("抽選番号", META_LABEL_STYLE), numberCell(draw.randomSeed, META_VALUE_STYLE)],
      [
        textCell("候補", META_LABEL_STYLE),
        textCell(draw.candidates.map((teamId) => teamNames.get(teamId)!).join("、"), META_VALUE_STYLE),
      ],
      [
        textCell("確定順", META_LABEL_STYLE),
        textCell(
          draw.decidedOrder
            .map((teamId, order) => `${String(order + 1)}. ${teamNames.get(teamId)!}`)
            .join(" → "),
          META_VALUE_STYLE,
        ),
      ],
    );
  }
  return rows;
}

function blockSheet(
  document: TournamentDocument,
  data: ValidLeagueResults,
  block: LeagueBlock,
): WorkbookSheet {
  const teamNames = new Map(data.teams.map((team) => [team.id, team.name]));
  const pairMatches = new Map(
    data.matches
      .filter((match) => match.blockId === block.id)
      .map((match) => [pairKey(match.homeTeamId, match.awayTeamId), match]),
  );
  const matrixRows = block.teamIds.map((teamId): WorkbookCell[] => {
    const standing = data.standings.get(teamId)!;
    const opponents = block.teamIds.map((opponentId): WorkbookCell => {
      if (teamId === opponentId) return textCell("—", SELF_STYLE);
      const match = pairMatches.get(pairKey(teamId, opponentId))!;
      return textCell(scoreLabel(teamId, match, data.results.get(match.id)!), DATA_STYLE);
    });
    return [textCell(teamNames.get(teamId)!, TEAM_STYLE), ...opponents, ...standingCells(standing)];
  });
  return {
    name: block.displayName,
    columns: [
      { width: 24 },
      ...block.teamIds.map(() => ({ width: 14 })),
      ...[8, 7, 7, 7, 9, 8, 8, 11, 8, 24, 15, 18, 15].map((width) => ({ width })),
    ],
    rows: [
      ...metadataRows(
        document.tournament.name.trim() || "名称未設定の大会",
        block.displayName,
        savedAtLabel(document.updatedAt),
      ),
      headerRow(block.teamIds.map((teamId) => teamNames.get(teamId)!)),
      ...matrixRows,
      ...drawRows(block.id, data.draws, teamNames),
    ],
  };
}

export function buildLeagueResultsWorkbook(document: TournamentDocument): WorkbookFile {
  const data = validateLeagueResults(document);
  const names = uniqueSheetNames(data.blocks.map((block) => block.displayName));
  return {
    fileName: sanitizeWorkbookFileName(
      `${document.tournament.name.trim() || "名称未設定"}_1日目リーグ結果.xlsx`,
    ),
    sheets: data.blocks.map((block, index) => ({
      ...blockSheet(document, data, block),
      name: names[index]!,
    })),
  };
}
