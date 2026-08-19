import {
  buildRoundRobinResultsWorkbook,
  type RoundRobinResultsWorkbookData,
  type RoundRobinWorkbookDrawRecord,
  type RoundRobinWorkbookGroup,
  type RoundRobinWorkbookMatch,
  type RoundRobinWorkbookMatchResult,
  type RoundRobinWorkbookMetrics,
  type RoundRobinWorkbookStanding,
  type RoundRobinWorkbookTeam,
} from "./league-results-workbook-model";
import type { JsonObject, TournamentDocument } from "./types";
import type { WorkbookFile } from "./workbook";

const SCHEMA_VERSION = "0.2.0";

interface RankEntry {
  type: "league_rank";
  blockId: string;
  rank: number;
}

interface Participant {
  entry: RankEntry;
  teamId: string;
}

interface SameRankGroup extends RoundRobinWorkbookGroup {
  sourceRanks: number[];
  rankRange: [number, number];
  participants: Participant[];
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

export class SameRankResultsWorkbookError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "SameRankResultsWorkbookError";
  }
}

function fail(
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new SameRankResultsWorkbookError(code, message, details);
}

function object(value: unknown, message: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("SAME_RANK_RESULTS_EXPORT_INPUT_INVALID", message);
  }
  return value as JsonObject;
}

function objects(value: unknown, message: string): JsonObject[] {
  if (!Array.isArray(value)) {
    return fail("SAME_RANK_RESULTS_EXPORT_INPUT_INVALID", message);
  }
  return value.map((item) => object(item, message));
}

function text(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fail("SAME_RANK_RESULTS_EXPORT_INPUT_INVALID", message);
  }
  return value;
}

function integer(value: unknown, message: string, minimum?: number): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || (minimum !== undefined && value < minimum)
  ) {
    return fail("SAME_RANK_RESULTS_EXPORT_INPUT_INVALID", message);
  }
  return value;
}

function stringArray(value: unknown, message: string): string[] {
  if (!Array.isArray(value)) return fail("SAME_RANK_RESULTS_EXPORT_INPUT_INVALID", message);
  return value.map((item) => text(item, message));
}

function numberArray(value: unknown, message: string): number[] {
  if (!Array.isArray(value)) return fail("SAME_RANK_RESULTS_EXPORT_INPUT_INVALID", message);
  return value.map((item) => integer(item, message, 1));
}

function duplicates(values: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value).sort();
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function sameOrder<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function entry(value: unknown, message: string): RankEntry {
  const raw = object(value, message);
  if (raw.type !== "league_rank") return fail("SAME_RANK_RESULTS_EXPORT_INPUT_INVALID", message);
  return {
    type: "league_rank",
    blockId: text(raw.block_id, message),
    rank: integer(raw.rank, message, 1),
  };
}

function entryKey(value: RankEntry): string {
  return `${value.blockId}\u0000${String(value.rank)}`;
}

function concreteTeamId(value: unknown, message: string): string {
  const raw = object(value, message);
  if (raw.type !== "concrete_team") return fail("SAME_RANK_RESULTS_EXPORT_INPUT_INVALID", message);
  return text(raw.team_id, message);
}

function pairKey(left: string, right: string): string {
  return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function parseTeams(input: JsonObject): RoundRobinWorkbookTeam[] {
  const teams = objects(input.teams, "登録チームを読み取れませんでした。").map((raw) => ({
    id: text(raw.id, "チームIDを読み取れませんでした。"),
    name: text(raw.name, "チーム名を読み取れませんでした。"),
  }));
  if (teams.length < 4 || teams.length > 32 || duplicates(teams.map((team) => team.id)).length > 0) {
    return fail(
      "SAME_RANK_RESULTS_EXPORT_INPUT_INVALID",
      "同順位リーグの登録チームを確認できませんでした。",
    );
  }
  return teams;
}

function parseParticipant(value: unknown): Participant {
  const raw = object(value, "同順位リーグの参加チームを読み取れませんでした。");
  return {
    entry: entry(raw.entry, "同順位リーグの参加順位枠を読み取れませんでした。"),
    teamId: concreteTeamId(raw.team, "同順位リーグの確定チームを読み取れませんでした。"),
  };
}

function parsePlan(
  rawPlan: JsonObject,
  teams: readonly RoundRobinWorkbookTeam[],
): { groups: SameRankGroup[]; matches: RoundRobinWorkbookMatch[]; randomSeed: number } {
  if (
    rawPlan.schema_version !== SCHEMA_VERSION
    || rawPlan.format !== "same_rank_league"
    || rawPlan.status !== "COMPLETE"
    || rawPlan.participant_resolution !== "resolved"
  ) {
    return fail(
      "SAME_RANK_RESULTS_EXPORT_UNAVAILABLE",
      "1日目順位を確定し、2日目の参加チームを確定してからExcelへ出力してください。",
    );
  }
  const policy = rawPlan.uneven_policy;
  if (policy !== "strict_same_rank" && policy !== "merge_bottom") {
    return fail("SAME_RANK_RESULTS_EXPORT_INPUT_INVALID", "同順位リーグの端数処理方針を読み取れませんでした。");
  }
  const teamCount = integer(rawPlan.team_count, "同順位リーグのチーム数を読み取れませんでした。", 4);
  const blockCount = integer(rawPlan.block_count, "同順位リーグのブロック数を読み取れませんでした。", 2);
  const randomSeed = integer(rawPlan.random_seed, "同順位リーグの抽選番号を読み取れませんでした。");
  if (teamCount !== teams.length || teamCount > 32 || blockCount > Math.floor(teamCount / 2)) {
    return fail("SAME_RANK_RESULTS_EXPORT_INPUT_INVALID", "同順位リーグ計画の参加数が登録内容と一致しません。");
  }
  const remainder = teamCount % blockCount;
  const quotient = Math.floor(teamCount / blockCount);
  if (remainder === 0 && policy !== "strict_same_rank") {
    return fail("SAME_RANK_RESULTS_EXPORT_INPUT_INVALID", "同順位リーグの端数処理方針が参加数と一致しません。");
  }

  const rawGroups = objects(rawPlan.groups, "同順位リーグのグループを読み取れませんでした。");
  const groups: SameRankGroup[] = [];
  const matches: RoundRobinWorkbookMatch[] = [];
  const allMatchIds = new Set<string>();
  let expectedRankStart = 1;
  for (const [groupIndex, raw] of rawGroups.entries()) {
    const id = text(raw.id, "同順位グループIDを読み取れませんでした。");
    const displayName = text(raw.display_name, "同順位グループ名を読み取れませんでした。");
    const sourceRanks = numberArray(raw.source_block_ranks, "同順位グループの対象順位を読み取れませんでした。");
    const rawRange = numberArray(raw.overall_rank_range, "同順位グループの総合順位範囲を読み取れませんでした。");
    if (rawRange.length !== 2) {
      return fail("SAME_RANK_RESULTS_EXPORT_INPUT_INVALID", "同順位グループの総合順位範囲が不正です。");
    }
    const rankRange: [number, number] = [rawRange[0]!, rawRange[1]!];
    const participants = objects(raw.participants, "同順位グループの参加チームを読み取れませんでした。 ")
      .map(parseParticipant);
    if (
      participants.length === 0
      || rankRange[0] !== expectedRankStart
      || rankRange[1] - rankRange[0] + 1 !== participants.length
      || duplicates(participants.map((item) => entryKey(item.entry))).length > 0
      || duplicates(participants.map((item) => item.teamId)).length > 0
    ) {
      return fail("SAME_RANK_RESULTS_EXPORT_INPUT_INVALID", `「${displayName}」の参加チームまたは総合順位範囲が不正です。`);
    }
    expectedRankStart = rankRange[1] + 1;
    const expectedSourceRanks = policy === "merge_bottom" && remainder > 0 && groupIndex === rawGroups.length - 1
      ? [quotient, quotient + 1]
      : [groupIndex + 1];
    const expectedSize = policy === "merge_bottom" && remainder > 0 && groupIndex === rawGroups.length - 1
      ? blockCount + remainder
      : groupIndex < quotient ? blockCount : remainder;
    const expectedRankCounts = new Map<number, number>(
      policy === "merge_bottom" && remainder > 0 && groupIndex === rawGroups.length - 1
        ? [[quotient, blockCount], [quotient + 1, remainder]]
        : [[expectedSourceRanks[0]!, expectedSize]],
    );
    const actualRankCounts = new Map<number, number>();
    for (const participant of participants) {
      actualRankCounts.set(
        participant.entry.rank,
        (actualRankCounts.get(participant.entry.rank) ?? 0) + 1,
      );
    }
    if (
      !sameOrder(sourceRanks, expectedSourceRanks)
      || participants.length !== expectedSize
      || [...expectedRankCounts].some(([rank, count]) => actualRankCounts.get(rank) !== count)
      || actualRankCounts.size !== expectedRankCounts.size
    ) {
      return fail("SAME_RANK_RESULTS_EXPORT_INPUT_INVALID", `「${displayName}」が端数処理方針から導かれる構成と一致しません。`);
    }
    const participantByEntry = new Map(participants.map((item) => [entryKey(item.entry), item]));
    const participantByTeam = new Map(participants.map((item) => [item.teamId, item]));
    const groupMatches = objects(raw.matches, "同順位グループの試合を読み取れませんでした。").map((matchRaw) => {
      const matchId = text(matchRaw.id, "同順位リーグ試合IDを読み取れませんでした。");
      const homeEntry = entry(matchRaw.home, `試合「${matchId}」の左側順位枠を読み取れませんでした。`);
      const awayEntry = entry(matchRaw.away, `試合「${matchId}」の右側順位枠を読み取れませんでした。`);
      const homeTeamId = concreteTeamId(matchRaw.home_team, `試合「${matchId}」の左側チームを読み取れませんでした。`);
      const awayTeamId = concreteTeamId(matchRaw.away_team, `試合「${matchId}」の右側チームを読み取れませんでした。`);
      if (
        matchRaw.phase !== "same_rank_league"
        || matchRaw.group_id !== id
        || entryKey(homeEntry) === entryKey(awayEntry)
        || participantByEntry.get(entryKey(homeEntry))?.teamId !== homeTeamId
        || participantByEntry.get(entryKey(awayEntry))?.teamId !== awayTeamId
        || !participantByTeam.has(homeTeamId)
        || !participantByTeam.has(awayTeamId)
        || allMatchIds.has(matchId)
      ) {
        return fail("SAME_RANK_RESULTS_EXPORT_INPUT_INVALID", `試合「${matchId}」が同順位グループと一致しません。`);
      }
      allMatchIds.add(matchId);
      return { id: matchId, blockId: id, homeTeamId, awayTeamId };
    });
    const expectedPairs = new Set<string>();
    for (let left = 0; left < participants.length; left += 1) {
      for (let right = left + 1; right < participants.length; right += 1) {
        expectedPairs.add(pairKey(participants[left]!.teamId, participants[right]!.teamId));
      }
    }
    const actualPairs = groupMatches.map((match) => pairKey(match.homeTeamId, match.awayTeamId));
    if (duplicates(actualPairs).length > 0 || !sameMembers(actualPairs, [...expectedPairs])) {
      return fail("SAME_RANK_RESULTS_EXPORT_INPUT_INVALID", `「${displayName}」の総当たり対戦を確認できませんでした。`);
    }
    const logicalMatchIds: string[] = [];
    const roundKeys = new Set<string>();
    for (const round of objects(raw.logical_rounds, "同順位グループの論理ラウンドを読み取れませんでした。")) {
      const roundGroupId = text(round.group_id, "論理ラウンドのグループを読み取れませんでした。");
      const roundNo = integer(round.round_no, "論理ラウンド番号を読み取れませんでした。", 1);
      const ids = stringArray(round.match_ids, "論理ラウンドの試合を読み取れませんでした。");
      const roundTeams = ids.flatMap((matchId) => {
        const match = groupMatches.find((candidate) => candidate.id === matchId);
        return match === undefined ? [] : [match.homeTeamId, match.awayTeamId];
      });
      if (
        roundGroupId !== id
        || ids.length === 0
        || roundKeys.has(String(roundNo))
        || roundTeams.length !== ids.length * 2
        || duplicates(roundTeams).length > 0
      ) {
        return fail("SAME_RANK_RESULTS_EXPORT_INPUT_INVALID", `「${displayName}」の論理ラウンドが不正です。`);
      }
      roundKeys.add(String(roundNo));
      logicalMatchIds.push(...ids);
    }
    if (duplicates(logicalMatchIds).length > 0 || !sameMembers(logicalMatchIds, groupMatches.map((match) => match.id))) {
      return fail("SAME_RANK_RESULTS_EXPORT_INPUT_INVALID", `「${displayName}」の試合と論理ラウンドが一致しません。`);
    }
    groups.push({
      id,
      displayName,
      teamIds: participants.map((item) => item.teamId),
      automatic: participants.length === 1,
      sourceRanks,
      rankRange,
      participants,
    });
    matches.push(...groupMatches);
  }
  const expectedGroupCount = policy === "merge_bottom" && remainder > 0
    ? quotient
    : quotient + (remainder > 0 ? 1 : 0);
  const allParticipants = groups.flatMap((group) => group.participants);
  if (
    groups.length !== expectedGroupCount
    || expectedRankStart !== teamCount + 1
    || duplicates(groups.map((group) => group.id)).length > 0
    || duplicates(allParticipants.map((item) => entryKey(item.entry))).length > 0
    || !sameMembers(allParticipants.map((item) => item.teamId), teams.map((team) => team.id))
  ) {
    return fail("SAME_RANK_RESULTS_EXPORT_INPUT_INVALID", "同順位リーグのグループが全参加チームを一意に覆っていません。");
  }
  const blockIds = [...new Set(allParticipants.map((item) => item.entry.blockId))];
  const blockSizes = blockIds.map((blockId) => allParticipants.filter((item) => item.entry.blockId === blockId).length)
    .sort((left, right) => left - right);
  const expectedBlockSizes = [
    ...Array.from({ length: blockCount - remainder }, () => quotient),
    ...Array.from({ length: remainder }, () => quotient + 1),
  ].sort((left, right) => left - right);
  if (blockIds.length !== blockCount || !sameOrder(blockSizes, expectedBlockSizes)) {
    return fail("SAME_RANK_RESULTS_EXPORT_INPUT_INVALID", "同順位リーグの参加順位枠が予選ブロック構成と一致しません。");
  }
  validateAutomaticStandings(rawPlan.automatic_standings, groups);
  return { groups, matches, randomSeed };
}

function validateAutomaticStandings(value: unknown, groups: readonly SameRankGroup[]): void {
  const automatic = objects(value, "同順位リーグの自動順位を読み取れませんでした。");
  const singletonGroups = groups.filter((group) => group.automatic === true);
  if (automatic.length !== singletonGroups.length) {
    return fail("SAME_RANK_RESULTS_EXPORT_INPUT_INVALID", "1チームグループと自動順位確定が一致しません。");
  }
  for (const [index, group] of singletonGroups.entries()) {
    const raw = automatic[index]!;
    const participant = group.participants[0]!;
    if (
      raw.group_id !== group.id
      || raw.overall_rank !== group.rankRange[0]
      || entryKey(entry(raw.entry, "自動順位の参加枠を読み取れませんでした。")) !== entryKey(participant.entry)
      || concreteTeamId(raw.team, "自動順位のチームを読み取れませんでした。") !== participant.teamId
    ) {
      return fail("SAME_RANK_RESULTS_EXPORT_INPUT_INVALID", "1チームグループの自動順位が参加チームと一致しません。");
    }
  }
}

function parseResults(
  rawResults: unknown,
  matches: readonly RoundRobinWorkbookMatch[],
): ReadonlyMap<string, RoundRobinWorkbookMatchResult> {
  const known = new Map(matches.map((match) => [match.id, match]));
  const parsed = objects(rawResults, "同順位リーグの試合結果を読み取れませんでした。").map((raw) => {
    const matchId = text(raw.match_id, "同順位リーグの試合結果IDを読み取れませんでした。");
    const match = known.get(matchId);
    if (raw.penalty_score_home != null || raw.penalty_score_away != null) {
      return fail("SAME_RANK_RESULTS_EXPORT_RESULT_INVALID", "同順位リーグ結果にPK得点が含まれています。", { match_id: matchId });
    }
    if (
      match === undefined
      || raw.home_team_id !== match.homeTeamId
      || raw.away_team_id !== match.awayTeamId
    ) {
      return fail("SAME_RANK_RESULTS_EXPORT_RESULT_INVALID", `試合「${matchId}」の参加チームが計画と一致しません。`);
    }
    return {
      matchId,
      homeScore: integer(raw.regular_score_home, `試合「${matchId}」の得点を読み取れませんでした。`, 0),
      awayScore: integer(raw.regular_score_away, `試合「${matchId}」の得点を読み取れませんでした。`, 0),
    };
  });
  const ids = parsed.map((result) => result.matchId);
  const missing = matches.map((match) => match.id).filter((matchId) => !ids.includes(matchId));
  const unknown = ids.filter((matchId) => !known.has(matchId));
  if (duplicates(ids).length > 0 || missing.length > 0 || unknown.length > 0) {
    return fail(
      "SAME_RANK_RESULTS_EXPORT_RESULT_INVALID",
      duplicates(ids).length > 0
        ? "同じ同順位リーグ試合の結果が重複しています。"
        : unknown.length > 0
          ? "日程にない同順位リーグ試合の結果が含まれています。"
          : "全試合の結果を入力し、総合最終順位を確定してからExcelへ出力してください。",
    );
  }
  return new Map(parsed.map((result) => [result.matchId, result]));
}

function emptyAggregate(): Aggregate {
  return { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, points: 0 };
}

function recordResult(home: Aggregate, away: Aggregate, homeScore: number, awayScore: number): void {
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

function groupAggregate(
  group: SameRankGroup,
  matches: readonly RoundRobinWorkbookMatch[],
  results: ReadonlyMap<string, RoundRobinWorkbookMatchResult>,
): ReadonlyMap<string, Aggregate> {
  const aggregate = new Map(group.teamIds.map((teamId) => [teamId, emptyAggregate()]));
  for (const match of matches.filter((item) => item.blockId === group.id)) {
    const result = results.get(match.id)!;
    recordResult(aggregate.get(match.homeTeamId)!, aggregate.get(match.awayTeamId)!, result.homeScore, result.awayScore);
  }
  return aggregate;
}

function metrics(value: unknown, teamId: string): RoundRobinWorkbookMetrics | null {
  if (value === null) return null;
  const raw = object(value, `チーム「${teamId}」の直接対戦値を読み取れませんでした。`);
  return {
    points: integer(raw.points, `チーム「${teamId}」の直接対戦内勝点を読み取れませんでした。`, 0),
    goalDifference: integer(raw.goal_difference, `チーム「${teamId}」の直接対戦内得失点差を読み取れませんでした。`),
    goalsFor: integer(raw.goals_for, `チーム「${teamId}」の直接対戦内得点を読み取れませんでした。`, 0),
  };
}

function sameMetrics(left: RoundRobinWorkbookMetrics | null, right: RoundRobinWorkbookMetrics | null): boolean {
  return left === null && right === null || left !== null && right !== null
    && left.points === right.points
    && left.goalDifference === right.goalDifference
    && left.goalsFor === right.goalsFor;
}

function parseStandings(
  rawFinal: JsonObject,
  groups: readonly SameRankGroup[],
  matches: readonly RoundRobinWorkbookMatch[],
  results: ReadonlyMap<string, RoundRobinWorkbookMatchResult>,
): { standings: ReadonlyMap<string, RoundRobinWorkbookStanding>; ordered: RoundRobinWorkbookStanding[] } {
  if (rawFinal.schema_version !== SCHEMA_VERSION || rawFinal.status !== "COMPLETE") {
    return fail("SAME_RANK_RESULTS_EXPORT_UNAVAILABLE", "総合最終順位を確定してから同順位リーグ結果をExcelへ出力してください。");
  }
  validateSavedMatchResults(rawFinal.match_results, matches, results);
  const participantByTeam = new Map(groups.flatMap((group) =>
    group.participants.map((participant) => [participant.teamId, { group, participant }] as const)
  ));
  const rows = objects(rawFinal.standings, "同順位リーグの確定順位を読み取れませんでした。").map((raw) => {
    const teamId = text(raw.team_id, "確定順位のチームIDを読み取れませんでした。");
    const resolved = participantByTeam.get(teamId);
    if (resolved === undefined) {
      return fail("SAME_RANK_RESULTS_EXPORT_STANDINGS_INVALID", `順位表に不明なチーム「${teamId}」があります。`);
    }
    const suppliedEntry = entry(raw.entry, `チーム「${teamId}」の参加順位枠を読み取れませんでした。`);
    if (entryKey(suppliedEntry) !== entryKey(resolved.participant.entry)) {
      return fail("SAME_RANK_RESULTS_EXPORT_STANDINGS_INVALID", `チーム「${teamId}」の参加順位枠がグループ計画と一致しません。`);
    }
    return {
      blockId: text(raw.group_id, `チーム「${teamId}」のグループを読み取れませんでした。`),
      rank: integer(raw.group_rank, `チーム「${teamId}」のグループ内順位を読み取れませんでした。`, 1),
      overallRank: integer(raw.rank, `チーム「${teamId}」の総合順位を読み取れませんでした。`, 1),
      teamId,
      played: integer(raw.played, `チーム「${teamId}」の試合数を読み取れませんでした。`, 0),
      wins: integer(raw.wins, `チーム「${teamId}」の勝数を読み取れませんでした。`, 0),
      draws: integer(raw.draws, `チーム「${teamId}」の分数を読み取れませんでした。`, 0),
      losses: integer(raw.losses, `チーム「${teamId}」の敗数を読み取れませんでした。`, 0),
      goalsFor: integer(raw.goals_for, `チーム「${teamId}」の得点を読み取れませんでした。`, 0),
      goalsAgainst: integer(raw.goals_against, `チーム「${teamId}」の失点を読み取れませんでした。`, 0),
      goalDifference: integer(raw.goal_difference, `チーム「${teamId}」の得失点差を読み取れませんでした。`),
      points: integer(raw.points, `チーム「${teamId}」の勝点を読み取れませんでした。`, 0),
      tieBreak: text(raw.tie_break, `チーム「${teamId}」の順位決定根拠を読み取れませんでした。`),
      headToHead: metrics(raw.head_to_head, teamId),
      automatic: raw.automatic === true,
    } satisfies RoundRobinWorkbookStanding;
  });
  if (
    rows.length !== participantByTeam.size
    || duplicates(rows.map((row) => row.teamId)).length > 0
    || !sameOrder(
      rows.map((row) => row.overallRank).sort((left, right) => left! - right!),
      Array.from({ length: rows.length }, (_, index) => index + 1),
    )
  ) {
    return fail("SAME_RANK_RESULTS_EXPORT_STANDINGS_INVALID", "総合順位に欠落、重複、または参加チームの不一致があります。");
  }
  for (const group of groups) {
    const groupRows = rows.filter((row) => row.blockId === group.id);
    const ranks = groupRows.map((row) => row.rank).sort((left, right) => left - right);
    if (
      !sameMembers(groupRows.map((row) => row.teamId), group.teamIds)
      || !sameOrder(ranks, group.teamIds.map((_teamId, index) => index + 1))
      || groupRows.some((row) =>
        row.overallRank !== group.rankRange[0] + row.rank - 1
        || row.automatic !== (group.automatic === true)
      )
    ) {
      return fail("SAME_RANK_RESULTS_EXPORT_STANDINGS_INVALID", `「${group.displayName}」のグループ内順位または総合順位が不正です。`);
    }
    const aggregate = groupAggregate(group, matches, results);
    for (const row of groupRows) {
      const actual = aggregate.get(row.teamId)!;
      const expected = [actual.played, actual.wins, actual.draws, actual.losses, actual.goalsFor,
        actual.goalsAgainst, actual.goalsFor - actual.goalsAgainst, actual.points];
      const supplied = [row.played, row.wins, row.draws, row.losses, row.goalsFor,
        row.goalsAgainst, row.goalDifference, row.points];
      if (!sameOrder(expected, supplied)) {
        return fail("SAME_RANK_RESULTS_EXPORT_STANDINGS_INVALID", `チーム「${row.teamId}」の集計値が試合結果と一致しません。`);
      }
    }
    const tieGroups = new Map<string, RoundRobinWorkbookStanding[]>();
    for (const row of groupRows) {
      const key = [row.points, row.goalDifference, row.goalsFor].join("\u0000");
      const tieGroup = tieGroups.get(key) ?? [];
      tieGroup.push(row);
      tieGroups.set(key, tieGroup);
    }
    for (const tied of tieGroups.values()) {
      if (tied.length === 1) {
        if (tied[0]!.headToHead !== null) {
          return fail("SAME_RANK_RESULTS_EXPORT_STANDINGS_INVALID", `チーム「${tied[0]!.teamId}」の直接対戦値が試合結果と一致しません。`);
        }
        continue;
      }
      const tiedIds = new Set(tied.map((row) => row.teamId));
      const mini = new Map(tied.map((row) => [row.teamId, emptyAggregate()]));
      for (const match of matches.filter((item) => item.blockId === group.id)) {
        if (!tiedIds.has(match.homeTeamId) || !tiedIds.has(match.awayTeamId)) continue;
        const result = results.get(match.id)!;
        recordResult(mini.get(match.homeTeamId)!, mini.get(match.awayTeamId)!, result.homeScore, result.awayScore);
      }
      for (const row of tied) {
        const value = mini.get(row.teamId)!;
        if (!sameMetrics(row.headToHead, {
          points: value.points,
          goalDifference: value.goalsFor - value.goalsAgainst,
          goalsFor: value.goalsFor,
        })) {
          return fail("SAME_RANK_RESULTS_EXPORT_STANDINGS_INVALID", `チーム「${row.teamId}」の直接対戦値が試合結果と一致しません。`);
        }
      }
    }
  }
  return { standings: new Map(rows.map((row) => [row.teamId, row])), ordered: rows };
}

function validateSavedMatchResults(
  value: unknown,
  matches: readonly RoundRobinWorkbookMatch[],
  results: ReadonlyMap<string, RoundRobinWorkbookMatchResult>,
): void {
  const canonical = objects(value, "保存済み順位の検証済み試合結果を読み取れませんでした。");
  const ids = canonical.map((raw) => text(raw.match_id, "検証済み試合結果IDを読み取れませんでした。"));
  if (duplicates(ids).length > 0 || !sameMembers(ids, matches.map((match) => match.id))) {
    return fail("SAME_RANK_RESULTS_EXPORT_STANDINGS_INVALID", "検証済み試合結果が同順位リーグ計画と一致しません。");
  }
  const matchById = new Map(matches.map((match) => [match.id, match]));
  for (const raw of canonical) {
    const matchId = String(raw.match_id);
    const match = matchById.get(matchId)!;
    const result = results.get(matchId)!;
    const expectedOutcome = result.homeScore > result.awayScore
      ? "home_win"
      : result.homeScore < result.awayScore ? "away_win" : "draw";
    if (
      raw.home_team_id !== match.homeTeamId
      || raw.away_team_id !== match.awayTeamId
      || raw.regular_score_home !== result.homeScore
      || raw.regular_score_away !== result.awayScore
      || raw.outcome !== expectedOutcome
    ) {
      return fail("SAME_RANK_RESULTS_EXPORT_STANDINGS_INVALID", `試合「${matchId}」の検証済み結果が入力結果と一致しません。`);
    }
  }
}

function parseDraws(
  value: unknown,
  groups: readonly SameRankGroup[],
  standings: ReadonlyMap<string, RoundRobinWorkbookStanding>,
  ordered: readonly RoundRobinWorkbookStanding[],
  randomSeed: number,
): RoundRobinWorkbookDrawRecord[] {
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const seen = new Set<string>();
  const draws = objects(value, "同順位リーグの抽選記録を読み取れませんでした。").map((raw) => {
    const groupId = text(raw.group_id, "抽選記録のグループIDを読み取れませんでした。");
    const group = groupById.get(groupId);
    const candidates = stringArray(raw.candidates, "抽選候補を読み取れませんでした。");
    const decidedOrder = stringArray(raw.decided_order, "抽選確定順を読み取れませんでした。");
    const seed = integer(raw.random_seed, "抽選番号を読み取れませんでした。");
    if (
      group === undefined
      || seed !== randomSeed
      || candidates.length < 2
      || duplicates(candidates).length > 0
      || duplicates(decidedOrder).length > 0
      || !sameMembers(candidates, decidedOrder)
      || candidates.some((teamId) => !group.teamIds.includes(teamId) || seen.has(teamId))
    ) {
      return fail("SAME_RANK_RESULTS_EXPORT_STANDINGS_INVALID", "抽選記録の候補、確定順、またはグループが順位表と一致しません。");
    }
    const rankedOrder = ordered.filter((row) => row.blockId === groupId && candidates.includes(row.teamId))
      .sort((left, right) => left.rank - right.rank).map((row) => row.teamId);
    if (!sameOrder(rankedOrder, decidedOrder)) {
      return fail("SAME_RANK_RESULTS_EXPORT_STANDINGS_INVALID", "抽選記録の確定順が保存済み順位と一致しません。");
    }
    const candidateValues = objects(raw.candidate_values, "抽選候補の監査値を読み取れませんでした。");
    if (
      duplicates(candidateValues.map((candidate) => String(candidate.team_id))).length > 0
      || !sameMembers(candidateValues.map((candidate) => String(candidate.team_id)), candidates)
      || candidateValues.some((candidate) => {
        const teamId = String(candidate.team_id);
        const standing = standings.get(teamId);
        return standing === undefined
          || !standing.tieBreak.includes("抽選")
          || !sameMetrics(metrics(candidate.head_to_head, teamId), standing.headToHead);
      })
    ) {
      return fail("SAME_RANK_RESULTS_EXPORT_STANDINGS_INVALID", "抽選候補の監査値が保存済み順位と一致しません。");
    }
    for (const teamId of candidates) seen.add(teamId);
    return { blockId: groupId, candidates, decidedOrder, randomSeed: seed };
  });
  const missing = ordered.filter((row) => row.tieBreak.includes("抽選") && !seen.has(row.teamId));
  if (missing.length > 0) {
    return fail("SAME_RANK_RESULTS_EXPORT_STANDINGS_INVALID", "抽選で決定した順位に対応する抽選記録がありません。");
  }
  return draws;
}

function validateSameRankResults(document: TournamentDocument): RoundRobinResultsWorkbookData {
  if (document.schemaVersion !== SCHEMA_VERSION) {
    return fail("SAME_RANK_RESULTS_EXPORT_UNAVAILABLE", "旧形式の大会データから同順位リーグ結果Excelは生成できません。");
  }
  const finalStage = object(document.tournament.input.final_stage, "決勝形式を読み取れませんでした。");
  if (finalStage.format !== "same_rank_league") {
    return fail("SAME_RANK_RESULTS_EXPORT_UNAVAILABLE", "同順位リーグを選択した大会だけが対象です。");
  }
  const result = document.tournament.result;
  if (
    result?.same_rank_plan === undefined
    || result.same_rank_league_results === undefined
    || result.same_rank_standings === undefined
  ) {
    return fail("SAME_RANK_RESULTS_EXPORT_UNAVAILABLE", "全試合の結果を入力し、総合最終順位を確定してからExcelへ出力してください。");
  }
  const teams = parseTeams(document.tournament.input);
  const plan = parsePlan(object(result.same_rank_plan, "同順位リーグ計画を読み取れませんでした。"), teams);
  const results = parseResults(result.same_rank_league_results, plan.matches);
  const rawFinal = object(result.same_rank_standings, "同順位リーグの確定順位を読み取れませんでした。");
  const parsed = parseStandings(rawFinal, plan.groups, plan.matches, results);
  const draws = parseDraws(rawFinal.draws, plan.groups, parsed.standings, parsed.ordered, plan.randomSeed);
  return { teams, blocks: plan.groups, matches: plan.matches, results, standings: parsed.standings, draws };
}

export function buildSameRankResultsWorkbook(document: TournamentDocument): WorkbookFile {
  return buildRoundRobinResultsWorkbook(document, validateSameRankResults(document), {
    fileNameSuffix: "2日目同順位リーグ結果",
    scopeLabel: "グループ",
    includeOverallRank: true,
  });
}
