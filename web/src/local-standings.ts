import {
  LocalStandingsError,
  rankRoundRobinGroup,
  type RoundRobinMatchResult,
} from "./round-robin-standings";
import type { JsonObject } from "./types";

const SCHEMA_VERSION = "0.2.0";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

interface LeagueMatch {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
}

interface LeagueBlock {
  id: string;
  teamIds: string[];
}

interface RankEntry {
  type: "league_rank";
  block_id: string;
  rank: number;
}

interface SameRankParticipant {
  entry: RankEntry;
  teamId: string;
}

interface SameRankMatch {
  id: string;
  groupId: string;
  round: string;
  roundNo: number;
  home: RankEntry;
  away: RankEntry;
  homeTeamId: string;
  awayTeamId: string;
}

interface SameRankRound {
  groupId: string;
  roundNo: number;
  matchIds: string[];
}

interface SameRankGroup {
  id: string;
  displayName: string;
  sourceRanks: number[];
  rankRange: [number, number];
  participants: SameRankParticipant[];
  matches: SameRankMatch[];
  rounds: SameRankRound[];
}

interface SameRankPlan {
  teamCount: number;
  blockCount: number;
  randomSeed: number;
  unevenPolicy: "strict_same_rank" | "merge_bottom";
  groups: SameRankGroup[];
  automaticStandings: JsonObject[];
  warnings: JsonObject[];
}

function object(value: unknown, message: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw schemaError(message);
  }
  return value as JsonObject;
}

function objects(value: unknown, message: string): JsonObject[] {
  if (!Array.isArray(value)) throw schemaError(message);
  return value.map((item) => object(item, message));
}

function strings(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw schemaError(message);
  }
  return value;
}

function identifier(value: unknown, message: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw schemaError(message);
  return value;
}

function nonEmptyText(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200) {
    throw schemaError(message);
  }
  return value;
}

function integer(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw schemaError(message);
  return value;
}

function positiveInteger(value: unknown, message: string): number {
  const parsed = integer(value, message);
  if (parsed < 1) throw schemaError(message);
  return parsed;
}

function score(value: unknown): number {
  const parsed = integer(value, "得点を読み取れませんでした。");
  if (parsed < 0) throw schemaError("得点欄に0以上の整数を入力してください。");
  return parsed;
}

function schemaError(message: string): LocalStandingsError {
  return new LocalStandingsError(
    "INPUT_SCHEMA_INVALID",
    message,
  );
}

function leaguePlanError(reason: string, details: JsonObject = {}): LocalStandingsError {
  return new LocalStandingsError(
    "LEAGUE_PLAN_INVALID",
    "リーグ日程とブロック情報の対応を確認できませんでした。日程を再生成してください。",
    { reason, ...details },
  );
}

function sameRankSourceError(reason: string, details: JsonObject = {}): LocalStandingsError {
  return new LocalStandingsError(
    "SAME_RANK_SOURCE_INVALID",
    "同順位リーグ計画を確認できませんでした。2日目の計画を作り直してください。",
    { reason, ...details },
  );
}

function sameRankPlanError(reason: string, details: JsonObject = {}): LocalStandingsError {
  return new LocalStandingsError(
    "SAME_RANK_PLAN_INVALID",
    "同順位リーグの構造を確認できませんでした。2日目の計画を作り直してください。",
    { reason, ...details },
  );
}

function duplicateValues(values: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].filter(([, count]) => count > 1).map(([value]) => value).sort();
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function arraysEqual(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (
    typeof left === "object" && left !== null && !Array.isArray(left) &&
    typeof right === "object" && right !== null && !Array.isArray(right)
  ) {
    const leftObject = left as Record<string, unknown>;
    const rightObject = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftObject).sort();
    const rightKeys = Object.keys(rightObject).sort();
    return arraysEqual(leftKeys, rightKeys) &&
      leftKeys.every((key) => deepEqual(leftObject[key], rightObject[key]));
  }
  return false;
}

function rankEntry(value: unknown): RankEntry {
  const entry = object(value, "同順位リーグの順位枠を読み取れませんでした。");
  if (entry.type !== "league_rank") {
    throw schemaError("同順位リーグの順位枠を読み取れませんでした。");
  }
  return {
    type: "league_rank",
    block_id: identifier(entry.block_id, "同順位リーグのブロックIDを読み取れませんでした。"),
    rank: positiveInteger(entry.rank, "同順位リーグのブロック順位を読み取れませんでした。"),
  };
}

function rankKey(entry: RankEntry): string {
  return `${entry.block_id}:${String(entry.rank)}`;
}

function concreteTeamId(value: unknown): string {
  const team = object(value, "同順位リーグの確定チームを読み取れませんでした。");
  if (team.type !== "concrete_team") {
    throw schemaError("同順位リーグの確定チームを読み取れませんでした。");
  }
  return identifier(team.team_id, "同順位リーグの確定チームを読み取れませんでした。");
}

function validateLeaguePlan(rawPlan: JsonObject): {
  blocks: LeagueBlock[];
  matches: LeagueMatch[];
  matchToBlock: Map<string, string>;
} {
  if (rawPlan.schema_version !== SCHEMA_VERSION) {
    throw schemaError("リーグ日程のschema versionを確認できませんでした。");
  }
  if (
    rawPlan.assignment_mode !== "random" && rawPlan.assignment_mode !== "seeded_snake" &&
    rawPlan.assignment_mode !== "manual"
  ) {
    throw schemaError("リーグ日程のブロック分け方式を読み取れませんでした。");
  }
  integer(rawPlan.random_seed, "リーグ日程の抽選番号を読み取れませんでした。");
  const blocks = objects(rawPlan.blocks, "リーグブロックを読み取れませんでした。").map(
    (raw): LeagueBlock => ({
      id: identifier(raw.id, "リーグブロックIDを読み取れませんでした。"),
      teamIds: strings(raw.team_ids, "リーグブロックのチームを読み取れませんでした。").map(
        (teamId) => identifier(teamId, "リーグブロックのチームIDを読み取れませんでした。"),
      ),
    }),
  );
  const blockIds = blocks.map((block) => block.id);
  if (!unique(blockIds)) throw leaguePlanError("duplicate_block_id");
  const teamToBlock = new Map<string, string>();
  for (const block of blocks) {
    if (!unique(block.teamIds)) throw leaguePlanError("duplicate_team_in_block", { block_id: block.id });
    for (const teamId of block.teamIds) {
      if (teamToBlock.has(teamId)) throw leaguePlanError("team_in_multiple_blocks", { team_id: teamId });
      teamToBlock.set(teamId, block.id);
    }
  }
  const matches = objects(rawPlan.matches, "リーグ試合を読み取れませんでした。").map(
    (raw): LeagueMatch => {
      const home = strings(raw.possible_home_team_ids, "リーグ試合のホームチームを読み取れませんでした。");
      const away = strings(raw.possible_away_team_ids, "リーグ試合のアウェーチームを読み取れませんでした。");
      if (home.length !== 1 || away.length !== 1) {
        throw leaguePlanError("unresolved_team_reference", { match_id: raw.id ?? null });
      }
      return {
        id: identifier(raw.id, "リーグ試合IDを読み取れませんでした。"),
        homeTeamId: identifier(home[0], "リーグ試合のホームチームを読み取れませんでした。"),
        awayTeamId: identifier(away[0], "リーグ試合のアウェーチームを読み取れませんでした。"),
      };
    },
  );
  const matchIds = matches.map((match) => match.id);
  if (!unique(matchIds)) throw leaguePlanError("duplicate_match_id");
  const matchById = new Map(matches.map((match) => [match.id, match]));
  const matchToBlock = new Map<string, string>();
  for (const round of objects(rawPlan.logical_rounds, "リーグの論理ラウンドを読み取れませんでした。")) {
    const blockId = identifier(round.block_id, "論理ラウンドのブロックIDを読み取れませんでした。");
    positiveInteger(round.round_no, "論理ラウンド番号を読み取れませんでした。");
    if (!blockIds.includes(blockId)) throw leaguePlanError("unknown_round_block", { block_id: blockId });
    const roundMatchIds = strings(round.match_ids, "論理ラウンドの試合IDを読み取れませんでした。");
    if (roundMatchIds.length === 0) throw schemaError("論理ラウンドに試合がありません。");
    const roundTeams: string[] = [];
    for (const rawMatchId of roundMatchIds) {
      const matchId = identifier(rawMatchId, "論理ラウンドの試合IDを読み取れませんでした。");
      if (!matchById.has(matchId)) throw leaguePlanError("unknown_round_match", { match_id: matchId });
      if (matchToBlock.has(matchId)) throw leaguePlanError("match_in_multiple_rounds", { match_id: matchId });
      matchToBlock.set(matchId, blockId);
      const match = matchById.get(matchId)!;
      roundTeams.push(match.homeTeamId, match.awayTeamId);
    }
    if (!unique(roundTeams)) throw leaguePlanError("team_repeated_in_round", { block_id: blockId });
  }
  const missingMatches = matchIds.filter((matchId) => !matchToBlock.has(matchId)).sort();
  if (missingMatches.length > 0) throw leaguePlanError("match_without_round", { match_ids: missingMatches });
  for (const match of matches) {
    const blockId = matchToBlock.get(match.id)!;
    const raw = objects(rawPlan.matches, "リーグ試合を読み取れませんでした。").find(
      (candidate) => candidate.id === match.id,
    )!;
    if (raw.phase !== "league") throw leaguePlanError("non_league_match", { match_id: match.id });
    if (
      match.homeTeamId === match.awayTeamId ||
      teamToBlock.get(match.homeTeamId) !== blockId ||
      teamToBlock.get(match.awayTeamId) !== blockId
    ) {
      throw leaguePlanError("team_outside_match_block", { match_id: match.id });
    }
  }
  for (const block of blocks) {
    const expectedPairs = new Set<string>();
    for (let left = 0; left < block.teamIds.length; left += 1) {
      for (let right = left + 1; right < block.teamIds.length; right += 1) {
        expectedPairs.add([block.teamIds[left]!, block.teamIds[right]!].sort().join("|"));
      }
    }
    const actualPairs = matches
      .filter((match) => matchToBlock.get(match.id) === block.id)
      .map((match) => [match.homeTeamId, match.awayTeamId].sort().join("|"));
    if (
      !unique(actualPairs) || actualPairs.length !== expectedPairs.size ||
      actualPairs.some((pair) => !expectedPairs.has(pair))
    ) {
      throw leaguePlanError("round_robin_pairs_invalid", { block_id: block.id });
    }
  }
  return { blocks, matches, matchToBlock };
}

function leagueResults(
  rawResults: readonly JsonObject[],
  matches: readonly LeagueMatch[],
): Map<string, { homeScore: number; awayScore: number }> {
  const supplied = rawResults.map((raw) => identifier(raw.match_id, "リーグ試合結果のIDを読み取れませんでした。"));
  const duplicates = duplicateValues(supplied);
  if (duplicates.length > 0) {
    throw new LocalStandingsError(
      "DUPLICATE_LEAGUE_RESULT",
      "同じ試合の結果が重複しています。",
      { match_ids: duplicates },
    );
  }
  const known = new Set(matches.map((match) => match.id));
  const unknown = [...new Set(supplied.filter((matchId) => !known.has(matchId)))].sort();
  if (unknown.length > 0) {
    throw new LocalStandingsError(
      "UNKNOWN_LEAGUE_MATCH",
      "日程にないリーグ試合の結果が含まれています。",
      { match_ids: unknown },
    );
  }
  const missing = [...known].filter((matchId) => !supplied.includes(matchId)).sort();
  if (missing.length > 0) {
    throw new LocalStandingsError(
      "LEAGUE_RESULTS_INCOMPLETE",
      "すべてのリーグ試合の結果を入力してから順位を確定してください。",
      { missing_match_ids: missing, missing_count: missing.length },
    );
  }
  return new Map(rawResults.map((raw) => [String(raw.match_id), {
    homeScore: score(raw.home_score),
    awayScore: score(raw.away_score),
  }]));
}

export async function calculateLocalLeagueStandings(input: {
  leaguePlan: JsonObject;
  results: readonly JsonObject[];
  randomSeed?: number;
}): Promise<JsonObject> {
  const { blocks, matches, matchToBlock } = validateLeaguePlan(input.leaguePlan);
  const results = leagueResults(input.results, matches);
  const randomSeed = input.randomSeed === undefined
    ? 20260803
    : integer(input.randomSeed, "抽選番号を読み取れませんでした。");
  const standings: JsonObject[] = [];
  const draws: JsonObject[] = [];
  for (const block of blocks) {
    const blockMatches = matches.filter((match) => matchToBlock.get(match.id) === block.id);
    const ranking = await rankRoundRobinGroup({
      scopeId: block.id,
      teamIds: block.teamIds,
      matches: blockMatches.map((match): RoundRobinMatchResult => ({
        homeTeamId: match.homeTeamId,
        awayTeamId: match.awayTeamId,
        homeScore: results.get(match.id)!.homeScore,
        awayScore: results.get(match.id)!.awayScore,
      })),
      randomSeed,
    });
    standings.push(...ranking.standings.map((row, index): JsonObject => ({
      block_id: block.id,
      rank: index + 1,
      team_id: row.teamId,
      played: row.played,
      wins: row.wins,
      draws: row.draws,
      losses: row.losses,
      goals_for: row.goalsFor,
      goals_against: row.goalsAgainst,
      goal_difference: row.goalDifference,
      points: row.points,
      tie_break: row.tieBreak,
      head_to_head: row.headToHead,
    })));
    draws.push(...ranking.draws.map((draw): JsonObject => ({
      block_id: block.id,
      candidates: draw.candidates,
      decided_order: draw.decidedOrder,
      random_seed: draw.randomSeed,
      candidate_values: draw.candidateValues.map((candidate) => ({
        team_id: candidate.teamId,
        head_to_head: candidate.headToHead,
      })),
    })));
  }
  return {
    schema_version: SCHEMA_VERSION,
    status: "COMPLETE",
    standings,
    draws,
  };
}

function sameRankMatch(raw: JsonObject): SameRankMatch {
  if (raw.phase !== "same_rank_league") {
    throw schemaError("同順位リーグ以外の試合が含まれています。");
  }
  return {
    id: identifier(raw.id, "同順位リーグの試合IDを読み取れませんでした。"),
    groupId: identifier(raw.group_id, "同順位リーグのグループIDを読み取れませんでした。"),
    round: nonEmptyText(raw.round, "同順位リーグのラウンド名を読み取れませんでした。"),
    roundNo: positiveInteger(raw.round_no, "同順位リーグのラウンド番号を読み取れませんでした。"),
    home: rankEntry(raw.home),
    away: rankEntry(raw.away),
    homeTeamId: concreteTeamId(raw.home_team),
    awayTeamId: concreteTeamId(raw.away_team),
  };
}

function sameRankGroup(raw: JsonObject): SameRankGroup {
  const range = raw.overall_rank_range;
  if (!Array.isArray(range) || range.length !== 2) {
    throw schemaError("同順位リーグの全体順位範囲を読み取れませんでした。");
  }
  return {
    id: identifier(raw.id, "同順位リーグのグループIDを読み取れませんでした。"),
    displayName: nonEmptyText(raw.display_name, "同順位リーグの表示名を読み取れませんでした。"),
    sourceRanks: Array.isArray(raw.source_block_ranks)
      ? raw.source_block_ranks.map((value) => positiveInteger(value, "同順位リーグの対象順位を読み取れませんでした。"))
      : (() => { throw schemaError("同順位リーグの対象順位を読み取れませんでした。"); })(),
    rankRange: [
      positiveInteger(range[0], "同順位リーグの全体順位範囲を読み取れませんでした。"),
      positiveInteger(range[1], "同順位リーグの全体順位範囲を読み取れませんでした。"),
    ],
    participants: objects(raw.participants, "同順位リーグの参加枠を読み取れませんでした。").map(
      (participant): SameRankParticipant => ({
        entry: rankEntry(participant.entry),
        teamId: concreteTeamId(participant.team),
      }),
    ),
    matches: objects(raw.matches, "同順位リーグの試合を読み取れませんでした。").map(sameRankMatch),
    rounds: objects(raw.logical_rounds, "同順位リーグの論理ラウンドを読み取れませんでした。").map(
      (round): SameRankRound => ({
        groupId: identifier(round.group_id, "同順位リーグの論理ラウンドを読み取れませんでした。"),
        roundNo: positiveInteger(round.round_no, "同順位リーグの論理ラウンドを読み取れませんでした。"),
        matchIds: strings(round.match_ids, "同順位リーグの論理ラウンドを読み取れませんでした。").map(
          (matchId) => identifier(matchId, "同順位リーグの論理ラウンドを読み取れませんでした。"),
        ),
      }),
    ),
  };
}

function expectedSameRankGroups(
  blockOrder: readonly string[],
  sizes: ReadonlyMap<string, number>,
  quotient: number,
  remainder: number,
  policy: "strict_same_rank" | "merge_bottom",
): Array<{ id: string; displayName: string; sourceRanks: number[]; entries: RankEntry[] }> {
  const entriesAt = (rank: number): RankEntry[] => blockOrder
    .filter((blockId) => (sizes.get(blockId) ?? 0) >= rank)
    .map((blockId) => ({ type: "league_rank", block_id: blockId, rank }));
  if (policy === "merge_bottom" && remainder > 0) {
    return [
      ...Array.from({ length: quotient - 1 }, (_, index) => {
        const rank = index + 1;
        return {
          id: `same-rank-${String(rank)}`,
          displayName: `予選${String(rank)}位リーグ`,
          sourceRanks: [rank],
          entries: entriesAt(rank),
        };
      }),
      {
        id: "same-rank-bottom",
        displayName: `予選${String(quotient)}・${String(quotient + 1)}位リーグ`,
        sourceRanks: [quotient, quotient + 1],
        entries: [...entriesAt(quotient), ...entriesAt(quotient + 1)],
      },
    ];
  }
  const groups = Array.from({ length: quotient }, (_, index) => {
    const rank = index + 1;
    return {
      id: `same-rank-${String(rank)}`,
      displayName: `予選${String(rank)}位リーグ`,
      sourceRanks: [rank],
      entries: entriesAt(rank),
    };
  });
  if (remainder > 0) {
    const rank = quotient + 1;
    groups.push({
      id: `same-rank-${String(rank)}`,
      displayName: `予選${String(rank)}位リーグ`,
      sourceRanks: [rank],
      entries: entriesAt(rank),
    });
  }
  return groups;
}

function expectedRoundRobin(
  groupId: string,
  displayName: string,
  participants: readonly SameRankParticipant[],
): { matches: SameRankMatch[]; rounds: SameRankRound[] } {
  if (participants.length < 2) return { matches: [], rounds: [] };
  let rotating: Array<SameRankParticipant | null> = [...participants];
  if (rotating.length % 2 === 1) rotating.push(null);
  const matches: SameRankMatch[] = [];
  const rounds: SameRankRound[] = [];
  let matchNumber = 1;
  for (let roundIndex = 0; roundIndex < rotating.length - 1; roundIndex += 1) {
    const matchIds: string[] = [];
    for (let pairIndex = 0; pairIndex < rotating.length / 2; pairIndex += 1) {
      const left = rotating[pairIndex];
      const right = rotating[rotating.length - pairIndex - 1];
      if (left === null || left === undefined || right === null || right === undefined) continue;
      const [home, away] = roundIndex % 2 === 0 ? [left, right] : [right, left];
      const suffix = groupId.startsWith("same-rank-")
        ? groupId.slice("same-rank-".length).toUpperCase()
        : groupId.toUpperCase();
      const id = `SR-${suffix}-M${String(matchNumber)}`;
      matches.push({
        id,
        groupId,
        round: `${displayName} 第${String(roundIndex + 1)}ラウンド`,
        roundNo: roundIndex + 1,
        home: home.entry,
        away: away.entry,
        homeTeamId: home.teamId,
        awayTeamId: away.teamId,
      });
      matchIds.push(id);
      matchNumber += 1;
    }
    if (matchIds.length > 0) rounds.push({ groupId, roundNo: roundIndex + 1, matchIds });
    rotating = [rotating[0]!, rotating[rotating.length - 1]!, ...rotating.slice(1, -1)];
  }
  return { matches, rounds };
}

function validateSameRankPlan(rawPlan: JsonObject): SameRankPlan {
  if (
    rawPlan.schema_version !== SCHEMA_VERSION || rawPlan.format !== "same_rank_league" ||
    rawPlan.status !== "COMPLETE"
  ) {
    throw schemaError("同順位リーグ計画の形式を読み取れませんでした。");
  }
  if (rawPlan.participant_resolution !== "resolved") {
    throw new LocalStandingsError(
      "SAME_RANK_RESULTS_REQUIRE_RESOLVED_PLAN",
      "予選順位を確定してから同順位リーグの結果を入力してください。",
    );
  }
  if (rawPlan.uneven_policy !== "strict_same_rank" && rawPlan.uneven_policy !== "merge_bottom") {
    throw schemaError("同順位リーグの端数処理方針を読み取れませんでした。");
  }
  const plan: SameRankPlan = {
    teamCount: positiveInteger(rawPlan.team_count, "同順位リーグのチーム数を読み取れませんでした。"),
    blockCount: positiveInteger(rawPlan.block_count, "同順位リーグのブロック数を読み取れませんでした。"),
    randomSeed: integer(rawPlan.random_seed, "同順位リーグの抽選番号を読み取れませんでした。"),
    unevenPolicy: rawPlan.uneven_policy,
    groups: objects(rawPlan.groups, "同順位リーグのグループを読み取れませんでした。").map(sameRankGroup),
    automaticStandings: objects(rawPlan.automatic_standings, "同順位リーグの自動順位を読み取れませんでした。"),
    warnings: objects(rawPlan.warnings, "同順位リーグの警告を読み取れませんでした。"),
  };
  if (
    plan.teamCount < 4 || plan.teamCount > 32 || plan.blockCount < 2 || plan.blockCount > 16 ||
    plan.groups.length === 0
  ) {
    throw schemaError("同順位リーグ計画の参加数を読み取れませんでした。");
  }
  const quotient = Math.floor(plan.teamCount / plan.blockCount);
  const remainder = plan.teamCount % plan.blockCount;
  if (quotient < 2) throw sameRankSourceError("block_size_below_minimum");
  if (remainder === 0 && plan.unevenPolicy !== "strict_same_rank") {
    throw sameRankSourceError("uneven_policy_for_even_blocks");
  }
  const groupIds = plan.groups.map((group) => group.id);
  if (!unique(groupIds)) throw schemaError("同順位グループIDが重複しています。");
  const matchIds = plan.groups.flatMap((group) => group.matches.map((match) => match.id));
  if (!unique(matchIds)) throw schemaError("同順位リーグ全体で試合IDが重複しています。");

  for (const group of plan.groups) {
    if (group.rankRange[1] < group.rankRange[0] ||
      group.rankRange[1] - group.rankRange[0] + 1 !== group.participants.length) {
      throw schemaError("同順位グループの全体順位範囲が参加枠数と一致しません。");
    }
    const entryKeys = group.participants.map((participant) => rankKey(participant.entry));
    const teamIds = group.participants.map((participant) => participant.teamId);
    if (!unique(entryKeys) || !unique(teamIds) || !unique(group.sourceRanks.map(String))) {
      throw schemaError("同順位グループの参加枠またはチームが重複しています。");
    }
    if (!arraysEqual([...new Set(group.participants.map((item) => item.entry.rank))].sort((a, b) => a - b),
      [...group.sourceRanks].sort((a, b) => a - b))) {
      throw schemaError("同順位グループの対象順位と参加順位枠が一致しません。");
    }
    const expectedMatchCount = group.participants.length * (group.participants.length - 1) / 2;
    if (group.matches.length !== expectedMatchCount) {
      throw schemaError("同順位グループの総当たり試合数が正しくありません。");
    }
    const groupMatchIds = group.matches.map((match) => match.id);
    const roundMatchIds = group.rounds.flatMap((round) => round.matchIds);
    if (!unique(groupMatchIds) || !unique(roundMatchIds) ||
      !arraysEqual([...groupMatchIds].sort(), [...roundMatchIds].sort())) {
      throw schemaError("同順位グループの論理ラウンドと試合が一致しません。");
    }
    const participantsByEntry = new Map(group.participants.map((participant) => [
      rankKey(participant.entry), participant,
    ]));
    const pairs = new Set<string>();
    for (const match of group.matches) {
      const homeKey = rankKey(match.home);
      const awayKey = rankKey(match.away);
      const home = participantsByEntry.get(homeKey);
      const away = participantsByEntry.get(awayKey);
      if (
        match.groupId !== group.id || home === undefined || away === undefined || homeKey === awayKey ||
        match.homeTeamId !== home.teamId || match.awayTeamId !== away.teamId
      ) {
        throw schemaError("同順位グループの試合と確定チーム注記が一致しません。");
      }
      const pair = [homeKey, awayKey].sort().join("|");
      if (pairs.has(pair)) throw schemaError("同順位グループの対戦が重複しています。");
      pairs.add(pair);
    }
    for (const round of group.rounds) {
      if (round.groupId !== group.id) throw schemaError("同順位グループIDと論理ラウンドが一致しません。");
      const roundEntries = round.matchIds.flatMap((id) => {
        const match = group.matches.find((candidate) => candidate.id === id)!;
        return [rankKey(match.home), rankKey(match.away)];
      });
      if (!unique(roundEntries)) throw schemaError("同一論理ラウンドで同じ参加順位枠が重複しています。");
    }
  }

  const allParticipants = plan.groups.flatMap((group) => group.participants);
  const allEntryKeys = allParticipants.map((participant) => rankKey(participant.entry));
  const allTeamIds = allParticipants.map((participant) => participant.teamId);
  if (!unique(allEntryKeys) || allEntryKeys.length !== plan.teamCount ||
    !unique(allTeamIds) || allTeamIds.length !== plan.teamCount) {
    throw schemaError("同順位グループが全参加順位枠を一意に覆っていません。");
  }
  const ranks = plan.groups.flatMap((group) => Array.from(
    { length: group.rankRange[1] - group.rankRange[0] + 1 },
    (_, index) => group.rankRange[0] + index,
  ));
  if (!arraysEqual([...ranks].sort((a, b) => a - b),
    Array.from({ length: plan.teamCount }, (_, index) => index + 1))) {
    throw schemaError("同順位グループの全体順位範囲に欠落または重複があります。");
  }

  const firstGroupBlocks = plan.groups[0]!.participants
    .filter((participant) => participant.entry.rank === 1)
    .map((participant) => participant.entry.block_id);
  if (firstGroupBlocks.length !== plan.blockCount || !unique(firstGroupBlocks)) {
    throw sameRankSourceError("rank_one_blocks_invalid");
  }
  const sizes = new Map(firstGroupBlocks.map((blockId) => [
    blockId,
    allParticipants.filter((participant) => participant.entry.block_id === blockId).length,
  ]));
  const expectedSizes = [
    ...Array.from({ length: remainder }, () => quotient + 1),
    ...Array.from({ length: plan.blockCount - remainder }, () => quotient),
  ].sort((a, b) => a - b);
  const actualSizes = [...sizes.values()].sort((a, b) => a - b);
  if (!arraysEqual(actualSizes, expectedSizes)) {
    throw sameRankSourceError("plan_block_sizes_invalid", {
      expected_block_sizes: expectedSizes,
      actual_block_sizes: actualSizes,
    });
  }
  const expectedEntries = new Set(firstGroupBlocks.flatMap((blockId) =>
    Array.from({ length: sizes.get(blockId)! }, (_, index) => `${blockId}:${String(index + 1)}`)
  ));
  if (expectedEntries.size !== allEntryKeys.length || allEntryKeys.some((key) => !expectedEntries.has(key))) {
    throw sameRankSourceError("rank_refs_invalid");
  }
  const expectedGroups = expectedSameRankGroups(
    firstGroupBlocks,
    sizes,
    quotient,
    remainder,
    plan.unevenPolicy,
  );
  if (expectedGroups.length !== plan.groups.length) throw sameRankSourceError("group_count_invalid");
  let rankStart = 1;
  for (let index = 0; index < expectedGroups.length; index += 1) {
    const expected = expectedGroups[index]!;
    const group = plan.groups[index]!;
    const rankEnd = rankStart + expected.entries.length - 1;
    if (
      group.id !== expected.id || group.displayName !== expected.displayName ||
      !arraysEqual(group.sourceRanks, expected.sourceRanks) ||
      !arraysEqual(group.rankRange, [rankStart, rankEnd]) ||
      !arraysEqual(group.participants.map((item) => rankKey(item.entry)), expected.entries.map(rankKey))
    ) {
      throw sameRankSourceError("group_derivation_invalid", { group_id: group.id });
    }
    const expectedRounds = expectedRoundRobin(group.id, group.displayName, group.participants);
    if (!deepEqual(group.matches, expectedRounds.matches) || !deepEqual(group.rounds, expectedRounds.rounds)) {
      throw sameRankSourceError("group_round_robin_invalid", { group_id: group.id });
    }
    rankStart = rankEnd + 1;
  }

  const singletonGroups = plan.groups.filter((group) => group.participants.length === 1);
  if (singletonGroups.length !== plan.automaticStandings.length) {
    throw schemaError("1チームグループと自動順位確定が一致しません。");
  }
  for (let index = 0; index < singletonGroups.length; index += 1) {
    const group = singletonGroups[index]!;
    const standing = plan.automaticStandings[index]!;
    const participant = group.participants[0]!;
    if (
      standing.group_id !== group.id || standing.overall_rank !== group.rankRange[0] ||
      rankKey(rankEntry(standing.entry)) !== rankKey(participant.entry) ||
      concreteTeamId(standing.team) !== participant.teamId
    ) {
      throw schemaError("1チームグループの自動順位確定が参加枠と一致しません。");
    }
  }
  const expectedWarningCodes = [
    ...(remainder > 0 ? ["SAME_RANK_UNEVEN_BLOCKS"] : []),
    ...(singletonGroups.length > 0 ? ["SAME_RANK_SINGLETON_GROUP"] : []),
  ];
  if (!arraysEqual(plan.warnings.map((warning) => warning.code), expectedWarningCodes)) {
    throw sameRankSourceError("warning_codes_invalid");
  }
  if (remainder > 0) {
    const warning = plan.warnings[0]!;
    const expectedDetails = {
      team_count: plan.teamCount,
      block_count: plan.blockCount,
      uneven_policy: plan.unevenPolicy,
      block_sizes: firstGroupBlocks.map((blockId) => sizes.get(blockId)!),
      groups: plan.groups.map((group) => ({
        group_id: group.id,
        participant_count: group.participants.length,
        source_block_ranks: group.sourceRanks,
        overall_rank_range: group.rankRange,
      })),
    };
    if (warning.group_id != null || !deepEqual(warning.details, expectedDetails)) {
      throw sameRankSourceError("uneven_warning_invalid");
    }
  }
  if (singletonGroups.length > 0) {
    const singleton = singletonGroups[0]!;
    const warning = plan.warnings[plan.warnings.length - 1]!;
    if (warning.group_id !== singleton.id || !deepEqual(warning.details, {
      overall_rank: singleton.rankRange[0],
    })) {
      throw sameRankSourceError("singleton_warning_invalid");
    }
  }
  return plan;
}

function parseSameRankResults(
  rawResults: readonly JsonObject[],
  groups: readonly SameRankGroup[],
): Map<string, {
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
}> {
  const matchIds = groups.flatMap((group) => group.matches.map((match) => match.id));
  const supplied = rawResults.map((raw) => identifier(raw.match_id, "同順位リーグの試合結果IDを読み取れませんでした。"));
  const duplicates = duplicateValues(supplied);
  if (duplicates.length > 0) {
    throw new LocalStandingsError(
      "DUPLICATE_SAME_RANK_RESULT",
      "同じ同順位リーグ試合の結果が重複しています。",
      { match_ids: duplicates },
    );
  }
  const known = new Set(matchIds);
  const unknown = [...new Set(supplied.filter((matchId) => !known.has(matchId)))].sort();
  if (unknown.length > 0) {
    throw new LocalStandingsError(
      "UNKNOWN_SAME_RANK_MATCH",
      "日程にない同順位リーグ試合の結果が含まれています。",
      { match_ids: unknown },
    );
  }
  const missing = matchIds.filter((matchId) => !supplied.includes(matchId)).sort();
  if (missing.length > 0) {
    throw new LocalStandingsError(
      "SAME_RANK_RESULTS_INCOMPLETE",
      "すべての同順位リーグ試合の結果を入力してから順位を確定してください。",
      { missing_match_ids: missing, missing_count: missing.length },
    );
  }
  return new Map(rawResults.map((raw) => {
    if (raw.penalty_score_home != null || raw.penalty_score_away != null) {
      throw new LocalStandingsError(
        "SAME_RANK_PENALTY_NOT_ALLOWED",
        "同順位リーグではPK戦を行いません。通常得点だけを入力してください。",
        { match_id: raw.match_id ?? null },
      );
    }
    return [String(raw.match_id), {
      homeTeamId: identifier(raw.home_team_id, "同順位リーグ結果のホームチームを読み取れませんでした。"),
      awayTeamId: identifier(raw.away_team_id, "同順位リーグ結果のアウェーチームを読み取れませんでした。"),
      homeScore: score(raw.regular_score_home),
      awayScore: score(raw.regular_score_away),
    }];
  }));
}

export async function calculateLocalSameRankStandings(input: {
  sameRankPlan: JsonObject;
  results: readonly JsonObject[];
}): Promise<JsonObject> {
  const plan = validateSameRankPlan(input.sameRankPlan);
  const results = parseSameRankResults(input.results, plan.groups);
  const canonicalResults: JsonObject[] = [];
  const standings: JsonObject[] = [];
  const draws: JsonObject[] = [];
  for (const group of plan.groups) {
    const entryByTeam = new Map(group.participants.map((participant) => [
      participant.teamId, participant.entry,
    ]));
    const rankedMatches: RoundRobinMatchResult[] = [];
    for (const match of group.matches) {
      const supplied = results.get(match.id)!;
      if (supplied.homeTeamId !== match.homeTeamId || supplied.awayTeamId !== match.awayTeamId) {
        throw new LocalStandingsError(
          "SAME_RANK_RESULT_PARTICIPANT_MISMATCH",
          "対戦チームが現在の同順位リーグと一致しません。結果を入力し直してください。",
          {
            match_id: match.id,
            expected_home_team_id: match.homeTeamId,
            expected_away_team_id: match.awayTeamId,
            supplied_home_team_id: supplied.homeTeamId,
            supplied_away_team_id: supplied.awayTeamId,
          },
        );
      }
      canonicalResults.push({
        match_id: match.id,
        home_team_id: match.homeTeamId,
        away_team_id: match.awayTeamId,
        regular_score_home: supplied.homeScore,
        regular_score_away: supplied.awayScore,
        outcome: supplied.homeScore > supplied.awayScore
          ? "home_win"
          : supplied.homeScore < supplied.awayScore ? "away_win" : "draw",
      });
      rankedMatches.push({
        homeTeamId: match.homeTeamId,
        awayTeamId: match.awayTeamId,
        homeScore: supplied.homeScore,
        awayScore: supplied.awayScore,
      });
    }
    const ranking = await rankRoundRobinGroup({
      scopeId: group.id,
      teamIds: group.participants.map((participant) => participant.teamId),
      matches: rankedMatches,
      randomSeed: plan.randomSeed,
    });
    standings.push(...ranking.standings.map((row, index): JsonObject => ({
      rank: group.rankRange[0] + index,
      group_id: group.id,
      group_rank: index + 1,
      team_id: row.teamId,
      entry: entryByTeam.get(row.teamId)!,
      played: row.played,
      wins: row.wins,
      draws: row.draws,
      losses: row.losses,
      goals_for: row.goalsFor,
      goals_against: row.goalsAgainst,
      goal_difference: row.goalDifference,
      points: row.points,
      tie_break: row.tieBreak,
      head_to_head: row.headToHead,
      automatic: group.participants.length === 1,
    })));
    draws.push(...ranking.draws.map((draw): JsonObject => ({
      group_id: group.id,
      candidates: draw.candidates,
      decided_order: draw.decidedOrder,
      random_seed: draw.randomSeed,
      candidate_values: draw.candidateValues.map((candidate) => ({
        team_id: candidate.teamId,
        head_to_head: candidate.headToHead,
      })),
    })));
  }
  standings.sort((left, right) => Number(left.rank) - Number(right.rank));
  const ranks = standings.map((standing) => Number(standing.rank));
  const teamIds = standings.map((standing) => String(standing.team_id));
  if (
    !arraysEqual(ranks, Array.from({ length: plan.teamCount }, (_, index) => index + 1)) ||
    !unique(teamIds)
  ) {
    throw sameRankPlanError("invalid_final_standings", { actual_ranks: ranks, team_ids: teamIds });
  }
  return {
    schema_version: SCHEMA_VERSION,
    status: "COMPLETE",
    match_results: canonicalResults,
    standings,
    draws,
  };
}

export { LocalStandingsError } from "./round-robin-standings";
