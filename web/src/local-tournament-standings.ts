import type { JsonObject } from "./types";

const SCHEMA_VERSION = "0.2.0";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

type Entry =
  | { type: "concrete_team"; team_id: string }
  | { type: "league_rank"; block_id: string; rank: number }
  | { type: "winner_of" | "loser_of"; match_id: string };

interface Seed {
  seedNo: number;
  teamId: string;
  blockId: string;
  blockRank: number;
  entry: Extract<Entry, { type: "league_rank" }>;
}

interface Match {
  id: string;
  poolId: string;
  round: string;
  roundNo: number;
  home: Entry;
  away: Entry;
  rankRange: [number, number];
  raw: JsonObject;
}

interface Pool {
  id: string;
  index: number;
  displayName: string;
  participantCount: number;
  overallRange: [number, number];
  seeds: Seed[];
  matches: Match[];
  placements: Array<{ rank: number; poolRank: number; entry: Entry }>;
  raw: JsonObject;
}

interface ParsedPlan {
  randomSeed: number;
  pools: Pool[];
  matches: Map<string, Match>;
  teamByRank: Map<string, string>;
  teamIds: Set<string>;
}

interface EntryState {
  entry: Entry;
  blockIds: Set<string>;
  hasPlayed: boolean;
}

interface PlacementNode {
  blockIds: Set<string>;
  openingPairIndex?: number;
  left?: PlacementNode;
  right?: PlacementNode;
}

interface MatchAudit {
  matchId: string;
  roundNo: number;
  firstSameBlock: boolean;
  possibleSameBlock: boolean;
}

interface CanonicalResult {
  match_id: string;
  home_team_id: string;
  away_team_id: string;
  regular_score_home: number;
  regular_score_away: number;
  penalty_score_home: number | null;
  penalty_score_away: number | null;
  winner: "home" | "away";
  winner_team_id: string;
  loser_team_id: string;
  decision: "regular_time" | "penalty_shootout";
}

export class LocalTournamentStandingsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: JsonObject = {},
  ) {
    super(message);
    this.name = "LocalTournamentStandingsError";
  }
}

function sourceError(reason: string, details: JsonObject = {}): LocalTournamentStandingsError {
  return new LocalTournamentStandingsError(
    "TOURNAMENT_SOURCE_INVALID",
    "順位決定トーナメント計画を確認できませんでした。2日目の計画を作り直してください。",
    { reason, ...details },
  );
}

function referenceError(reason: string, details: JsonObject = {}): LocalTournamentStandingsError {
  return new LocalTournamentStandingsError(
    "TOURNAMENT_RESULT_REFERENCE_INVALID",
    "トーナメント表の参照を解決できません。トーナメント表を作り直してください。",
    { reason, ...details },
  );
}

function schemaError(message: string, details: JsonObject = {}): LocalTournamentStandingsError {
  return new LocalTournamentStandingsError("INPUT_SCHEMA_INVALID", message, details);
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

function keys(value: JsonObject, allowed: readonly string[], message: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw schemaError(message);
}

function identifier(value: unknown, message: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw schemaError(message);
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

function nonNegativeInteger(value: unknown, message: string): number {
  const parsed = integer(value, message);
  if (parsed < 0) throw schemaError(message);
  return parsed;
}

function pair(value: unknown, message: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw schemaError(message);
  return [positiveInteger(value[0], message), positiveInteger(value[1], message)];
}

function entry(value: unknown): Entry {
  const raw = object(value, "トーナメントの参加枠を読み取れませんでした。");
  if (raw.type === "concrete_team") {
    keys(raw, ["type", "team_id"], "確定チーム参照に未対応の項目が含まれています。");
    return {
      type: "concrete_team",
      team_id: identifier(raw.team_id, "確定チーム参照を読み取れませんでした。"),
    };
  }
  if (raw.type === "league_rank") {
    keys(raw, ["type", "block_id", "rank"], "リーグ順位枠に未対応の項目が含まれています。");
    return {
      type: "league_rank",
      block_id: identifier(raw.block_id, "リーグ順位枠のブロックIDを読み取れませんでした。"),
      rank: positiveInteger(raw.rank, "リーグ順位枠の順位を読み取れませんでした。"),
    };
  }
  if (raw.type === "winner_of" || raw.type === "loser_of") {
    keys(raw, ["type", "match_id"], "勝敗参照に未対応の項目が含まれています。");
    return {
      type: raw.type,
      match_id: identifier(raw.match_id, "勝敗参照の試合IDを読み取れませんでした。"),
    };
  }
  throw schemaError("未対応のトーナメント参照が含まれています。");
}

function entryJson(value: Entry): JsonObject {
  return { ...value };
}

function rankKey(value: Extract<Entry, { type: "league_rank" }>): string {
  return `${value.block_id}:${String(value.rank)}`;
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
    const leftObject = left as JsonObject;
    const rightObject = right as JsonObject;
    const leftKeys = Object.keys(leftObject).sort();
    const rightKeys = Object.keys(rightObject).sort();
    return deepEqual(leftKeys, rightKeys) &&
      leftKeys.every((key) => deepEqual(leftObject[key], rightObject[key]));
  }
  return false;
}

function duplicateValues(values: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].filter(([, count]) => count > 1).map(([value]) => value).sort();
}

function compareArrays(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1;
  }
  return left.length - right.length;
}

function compareCosts(
  left: readonly [number, number, bigint],
  right: readonly [number, number, bigint],
): number {
  if (left[0] !== right[0]) return left[0] - right[0];
  if (left[1] !== right[1]) return left[1] - right[1];
  return left[2] < right[2] ? -1 : left[2] > right[2] ? 1 : 0;
}

function union(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  return new Set([...left, ...right]);
}

function intersectionSize(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
}

async function digestPrefix(value: string): Promise<bigint> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new LocalTournamentStandingsError(
      "WEB_CRYPTO_UNAVAILABLE",
      "このブラウザでは安全なトーナメント検証を実行できません。対応ブラウザで開き直してください。",
    );
  }
  const digest = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let result = 0n;
  for (const byte of digest.slice(0, 8)) result = (result << 8n) | BigInt(byte);
  return result;
}

async function bestPairAssignment(
  left: readonly EntryState[],
  right: readonly EntryState[],
  salt: string,
): Promise<number[]> {
  const tieBreaks = await Promise.all(left.map((_, leftIndex) =>
    Promise.all(right.map((__, rightIndex) => digestPrefix(`${salt}:${String(leftIndex)}:${String(rightIndex)}`)))
  ));
  const memo = new Map<string, { cost: [number, number, bigint]; assignment: number[] }>();
  const visit = (position: number, usedMask: number): { cost: [number, number, bigint]; assignment: number[] } => {
    if (position === left.length) return { cost: [0, 0, 0n], assignment: [] };
    const key = `${String(position)}:${String(usedMask)}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let best: { cost: [number, number, bigint]; assignment: number[] } | undefined;
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const bit = 1 << rightIndex;
      if ((usedMask & bit) !== 0) continue;
      const remaining = visit(position + 1, usedMask | bit);
      const overlap = intersectionSize(left[position]!.blockIds, right[rightIndex]!.blockIds);
      const current: [number, number, bigint] = [
        Number(overlap > 0 && !left[position]!.hasPlayed && !right[rightIndex]!.hasPlayed),
        overlap,
        tieBreaks[position]![rightIndex]!,
      ];
      const candidate = {
        cost: [
          current[0] + remaining.cost[0],
          current[1] + remaining.cost[1],
          current[2] + remaining.cost[2],
        ] as [number, number, bigint],
        assignment: [rightIndex, ...remaining.assignment],
      };
      if (
        best === undefined || compareCosts(candidate.cost, best.cost) < 0 ||
        (compareCosts(candidate.cost, best.cost) === 0 &&
          compareArrays(candidate.assignment, best.assignment) < 0)
      ) best = candidate;
    }
    if (best === undefined) throw sourceError("pool_match_graph_invalid");
    memo.set(key, best);
    return best;
  };
  return visit(0, 0).assignment;
}

async function bestNextRoundOrder(
  entries: readonly { blockIds: Set<string> }[],
  salt: string,
): Promise<number[]> {
  if (entries.length % 2 !== 0) return entries.map((_, index) => index);
  const tieBreaks = await Promise.all(entries.map((_, first) =>
    Promise.all(entries.map((__, second) =>
      second > first ? digestPrefix(`${salt}:${String(first)}:${String(second)}`) : Promise.resolve(0n)
    ))
  ));
  const memo = new Map<number, { cost: [number, bigint]; pairs: Array<[number, number]> }>();
  const visit = (mask: number): { cost: [number, bigint]; pairs: Array<[number, number]> } => {
    if (mask === 0) return { cost: [0, 0n], pairs: [] };
    const cached = memo.get(mask);
    if (cached !== undefined) return cached;
    let first = 0;
    while ((mask & (1 << first)) === 0) first += 1;
    const withoutFirst = mask & ~(1 << first);
    let best: { cost: [number, bigint]; pairs: Array<[number, number]> } | undefined;
    for (let second = first + 1; second < entries.length; second += 1) {
      if ((withoutFirst & (1 << second)) === 0) continue;
      const remaining = visit(withoutFirst & ~(1 << second));
      const candidate = {
        cost: [
          intersectionSize(entries[first]!.blockIds, entries[second]!.blockIds) + remaining.cost[0],
          tieBreaks[first]![second]! + remaining.cost[1],
        ] as [number, bigint],
        pairs: [[first, second] as [number, number], ...remaining.pairs],
      };
      const candidateFlat = candidate.pairs.flat();
      const bestFlat = best?.pairs.flat() ?? [];
      if (
        best === undefined || candidate.cost[0] < best.cost[0] ||
        (candidate.cost[0] === best.cost[0] && candidate.cost[1] < best.cost[1]) ||
        (candidate.cost[0] === best.cost[0] && candidate.cost[1] === best.cost[1] &&
          compareArrays(candidateFlat, bestFlat) < 0)
      ) best = candidate;
    }
    if (best === undefined) throw sourceError("pool_match_graph_invalid");
    memo.set(mask, best);
    return best;
  };
  const pairs = visit((1 << entries.length) - 1).pairs;
  return [...pairs.map(([first]) => first), ...pairs.map(([, second]) => second)];
}

async function positionOpeningNodes(
  nodes: PlacementNode[],
  salt: string,
  depth = 1,
): Promise<PlacementNode[]> {
  if (nodes.length <= 1) return nodes;
  const order = await bestNextRoundOrder(nodes, `${salt}:depth:${String(depth)}`);
  const ordered = order.map((index) => nodes[index]!);
  const half = ordered.length / 2;
  const parents = Array.from({ length: half }, (_, index): PlacementNode => ({
    blockIds: union(ordered[index]!.blockIds, ordered[index + half]!.blockIds),
    left: ordered[index],
    right: ordered[index + half],
  }));
  const positioned = await positionOpeningNodes(parents, salt, depth + 1);
  return [
    ...positioned.map((node) => node.left!),
    ...positioned.map((node) => node.right!),
  ];
}

function logicalLayout(matches: readonly JsonObject[], overallRange: [number, number]): JsonObject {
  const rangeKey = (range: unknown): string => JSON.stringify(range);
  const counts = new Map<string, number>();
  const positions = matches.map((match) => {
    const key = rangeKey(match.rank_range);
    const order = (counts.get(key) ?? 0) + 1;
    counts.set(key, order);
    return { match_id: match.id, rank_range: match.rank_range, order };
  });
  const orderedMatches = (range: [number, number]): JsonObject[] => {
    const key = rangeKey(range);
    return matches.filter((match) => rangeKey(match.rank_range) === key);
  };
  const root = orderedMatches(overallRange);
  const opening = root.flatMap((match) => [match.home, match.away]);
  const alignments: JsonObject[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const range = match.rank_range as [number, number];
    const key = rangeKey(range);
    if (seen.has(key) || range[1] - range[0] + 1 < 4) continue;
    seen.add(key);
    const half = (range[1] - range[0] + 1) / 2;
    const sources = new Set(orderedMatches(range).map((source) => String(source.id)));
    const sourceOrder = (childRange: [number, number], type: "winner_of" | "loser_of") =>
      orderedMatches(childRange).flatMap((child) => [child.home, child.away]).map((rawEntry) => {
        const parsed = rawEntry as JsonObject;
        if (parsed.type !== type || !sources.has(String(parsed.match_id))) {
          throw sourceError("pool_match_graph_invalid");
        }
        return String(parsed.match_id);
      });
    const winners = sourceOrder([range[0], range[0] + half - 1], "winner_of");
    const losers = sourceOrder([range[0] + half, range[1]], "loser_of");
    const winnerPositions = new Map(winners.map((matchId, index) => [matchId, index + 1]));
    const permutation = losers.map((matchId) => winnerPositions.get(matchId)!);
    const mirrored = permutation.every((value, index) => value === index + 1);
    alignments.push({
      rank_range: range,
      status: mirrored ? "mirrored" : "permuted",
      winner_source_order: winners,
      loser_source_order: losers,
      loser_to_winner_permutation: permutation,
      diagnostic_code: mirrored ? null : "OUTCOME_BRANCH_ORDER_DIFFERS",
    });
  }
  return {
    layout_version: "1",
    symmetry: alignments.some((alignment) => alignment.status === "permuted")
      ? "permuted"
      : "mirrored",
    opening_entry_order: opening,
    match_positions: positions,
    branch_alignments: alignments,
  };
}

async function regeneratePool(pool: Pool, randomSeed: number): Promise<{
  projection: JsonObject;
  warning?: JsonObject;
}> {
  const initialEntries: EntryState[] = pool.seeds.map((seed) => ({
    entry: seed.entry,
    blockIds: new Set([seed.blockId]),
    hasPlayed: false,
  }));
  const half = initialEntries.length / 2;
  const higher = initialEntries.slice(0, half);
  const lower = initialEntries.slice(half);
  const assignment = await bestPairAssignment(
    higher,
    lower,
    `${String(randomSeed)}:${pool.id}:RANK:1:${String(initialEntries.length)}:1`,
  );
  const openingPairs = higher.map((home, index) => [home, lower[assignment[index]!]!] as const);
  const nodes: PlacementNode[] = openingPairs.map(([home, away], index) => ({
    blockIds: union(home.blockIds, away.blockIds),
    openingPairIndex: index,
  }));
  const positionedNodes = await positionOpeningNodes(
    nodes,
    `${String(randomSeed)}:${pool.id}:canonical:${String(initialEntries.length)}`,
  );
  const positionedPairs = positionedNodes.map((node) => openingPairs[node.openingPairIndex!]!);
  const positionedEntries = [
    ...positionedPairs.map(([home]) => home),
    ...positionedPairs.map(([, away]) => away),
  ];
  const matches: JsonObject[] = [];
  const placements: JsonObject[] = [];
  const audits: MatchAudit[] = [];
  const idCounts = new Map<string, number>();
  const recordMatch = (
    home: EntryState,
    away: EntryState,
    rankStart: number,
    rankEnd: number,
    roundNo: number,
    label: string,
  ): [EntryState, EntryState] => {
    const idKey = `${String(rankStart)}:${String(rankEnd)}`;
    const number = (idCounts.get(idKey) ?? 0) + 1;
    idCounts.set(idKey, number);
    const matchId = `PT-${String(pool.index)}-RANK-${String(rankStart)}-${String(rankEnd)}-M${String(number)}`;
    matches.push({
      id: matchId,
      phase: "placement_tournament",
      pool_id: pool.id,
      round: label,
      round_no: roundNo,
      home: entryJson(home.entry),
      away: entryJson(away.entry),
      rank_range: [rankStart, rankEnd],
    });
    const overlap = intersectionSize(home.blockIds, away.blockIds);
    audits.push({
      matchId,
      roundNo,
      firstSameBlock: overlap > 0 && !home.hasPlayed && !away.hasPlayed,
      possibleSameBlock: overlap > 0,
    });
    const blockIds = union(home.blockIds, away.blockIds);
    return [
      { entry: { type: "winner_of", match_id: matchId }, blockIds, hasPlayed: true },
      { entry: { type: "loser_of", match_id: matchId }, blockIds, hasPlayed: true },
    ];
  };
  const build = (states: EntryState[], rankStart: number, roundNo: number): void => {
    if (states.length === 1) {
      placements.push({
        rank: rankStart,
        pool_rank: rankStart - pool.overallRange[0] + 1,
        entry: entryJson(states[0]!.entry),
      });
      return;
    }
    const rankEnd = rankStart + states.length - 1;
    const label = rankStart === 1 && states.length === 2
      ? "優勝決定戦"
      : states.length === 2
        ? `${String(rankStart)}位決定戦`
        : `${String(rankStart)}〜${String(rankEnd)}位 順位決定`;
    const stateHalf = states.length / 2;
    const winners: EntryState[] = [];
    const losers: EntryState[] = [];
    for (let index = 0; index < stateHalf; index += 1) {
      const [winner, loser] = recordMatch(
        states[index]!, states[index + stateHalf]!, rankStart, rankEnd, roundNo, label,
      );
      winners.push(winner);
      losers.push(loser);
    }
    build(winners, rankStart, roundNo + 1);
    build(losers, rankStart + stateHalf, roundNo + 1);
  };
  build(positionedEntries, pool.overallRange[0], 1);
  placements.sort((left, right) => Number(left.rank) - Number(right.rank));
  const possible = audits.filter((audit) => audit.possibleSameBlock);
  const first = audits.filter((audit) => audit.firstSameBlock);
  const evaluation = {
    first_match_same_block_count: first.length,
    possible_same_block_match_count: possible.length,
    earliest_possible_same_block_round: possible.length === 0
      ? null
      : Math.min(...possible.map((audit) => audit.roundNo)),
  };
  return {
    projection: {
      pool_id: pool.id,
      pool_index: pool.index,
      display_name: pool.displayName,
      participant_count: pool.participantCount,
      pool_rank_range: [1, pool.participantCount],
      overall_rank_range: pool.overallRange,
      seeds: pool.raw.seeds,
      matches,
      placements,
      evaluation,
      logical_layout: logicalLayout(matches, pool.overallRange),
    },
    ...(first.length === 0 ? {} : {
      warning: {
        code: "SAME_BLOCK_FIRST_MATCH_UNAVOIDABLE",
        message: "初戦の同一ブロック対戦をすべて避けられないため、対戦数が最少になる組合せを採用しました。",
        pool_id: pool.id,
        match_ids: first.map((audit) => audit.matchId),
      },
    }),
  };
}

function rawDependencies(plan: JsonObject): void {
  const rawMatches = objects(plan.pools, "順位帯を読み取れませんでした。")
    .flatMap((pool) => objects(pool.matches, "トーナメント試合を読み取れませんでした。"));
  const matchIds = rawMatches.map((match) => identifier(match.id, "試合IDを読み取れませんでした。"));
  const duplicates = duplicateValues(matchIds);
  if (duplicates.length > 0) throw referenceError("duplicate_match_id", { match_ids: duplicates });
  const byId = new Map(rawMatches.map((match) => [String(match.id), match]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (matchId: string): void => {
    if (visited.has(matchId)) return;
    if (visiting.has(matchId)) {
      throw new LocalTournamentStandingsError(
        "TOURNAMENT_DEPENDENCY_CYCLE",
        "トーナメントの試合参照が循環しています。トーナメント表を作り直してください。",
        { match_id: matchId },
      );
    }
    const match = byId.get(matchId);
    if (match === undefined) throw referenceError("unknown_dependency", { match_id: matchId });
    visiting.add(matchId);
    for (const side of [match.home, match.away]) {
      const parsed = entry(side);
      if (parsed.type === "winner_of" || parsed.type === "loser_of") visit(parsed.match_id);
    }
    visiting.delete(matchId);
    visited.add(matchId);
  };
  matchIds.forEach(visit);
}

async function parseAndValidatePlan(rawPlan: JsonObject): Promise<ParsedPlan> {
  rawDependencies(rawPlan);
  keys(rawPlan, [
    "schema_version", "format", "status", "participant_resolution", "tournament_count",
    "tournament_names", "random_seed", "pools", "seed_draws", "warnings",
  ], "順位決定トーナメント計画に未対応の項目が含まれています。");
  if (
    rawPlan.schema_version !== SCHEMA_VERSION || rawPlan.format !== "placement_tournament" ||
    rawPlan.status !== "COMPLETE"
  ) throw sourceError("placement_configuration_invalid");
  const randomSeed = integer(rawPlan.random_seed, "トーナメントの抽選番号を読み取れませんでした。");
  const tournamentCount = positiveInteger(rawPlan.tournament_count, "トーナメント数を読み取れませんでした。");
  const rawPools = objects(rawPlan.pools, "順位帯を読み取れませんでした。");
  if (rawPools.length !== tournamentCount) throw sourceError("pool_count_invalid");
  if (rawPlan.tournament_names !== undefined && !Array.isArray(rawPlan.tournament_names)) {
    throw schemaError("トーナメント名を読み取れませんでした。");
  }
  const names = rawPlan.tournament_names === undefined ? [] : rawPlan.tournament_names as unknown[];
  if (names.length !== 0 && (
    names.length !== tournamentCount || names.some((name) => typeof name !== "string" || name.length === 0)
  )) throw sourceError("pool_derivation_invalid");
  const pools: Pool[] = rawPools.map((raw, index): Pool => {
    keys(raw, [
      "pool_id", "pool_index", "display_name", "participant_count", "pool_rank_range",
      "overall_rank_range", "seeds", "matches", "placements", "evaluation", "logical_layout",
    ], "順位帯に未対応の項目が含まれています。");
    const participantCount = positiveInteger(raw.participant_count, "順位帯参加数を読み取れませんでした。");
    const seeds = objects(raw.seeds, "順位帯シードを読み取れませんでした。").map((rawSeed): Seed => {
      keys(rawSeed, ["seed_no", "team_id", "block_id", "block_rank", "entry", "team"],
        "順位帯シードに未対応の項目が含まれています。");
      const blockId = identifier(rawSeed.block_id, "シードのブロックIDを読み取れませんでした。");
      const blockRank = positiveInteger(rawSeed.block_rank, "シードのブロック順位を読み取れませんでした。");
      const parsedEntry = entry(rawSeed.entry);
      const teamId = identifier(rawSeed.team_id, "確定シードのチームIDを読み取れませんでした。");
      const team = entry(rawSeed.team);
      if (
        parsedEntry.type !== "league_rank" || parsedEntry.block_id !== blockId ||
        parsedEntry.rank !== blockRank || team.type !== "concrete_team" || team.team_id !== teamId
      ) throw sourceError("seed_rank_refs_invalid");
      return {
        seedNo: positiveInteger(rawSeed.seed_no, "シード番号を読み取れませんでした。"),
        teamId,
        blockId,
        blockRank,
        entry: parsedEntry,
      };
    });
    const poolId = identifier(raw.pool_id, "順位帯IDを読み取れませんでした。");
    const matches = objects(raw.matches, "順位帯試合を読み取れませんでした。").map((rawMatch): Match => {
      keys(rawMatch, ["id", "phase", "pool_id", "round", "round_no", "home", "away", "rank_range"],
        "順位帯試合に未対応の項目が含まれています。");
      return {
        id: identifier(rawMatch.id, "試合IDを読み取れませんでした。"),
        poolId: identifier(rawMatch.pool_id, "試合の順位帯IDを読み取れませんでした。"),
        round: typeof rawMatch.round === "string" && rawMatch.round.length > 0
          ? rawMatch.round
          : (() => { throw schemaError("試合のラウンド名を読み取れませんでした。"); })(),
        roundNo: positiveInteger(rawMatch.round_no, "試合のラウンド番号を読み取れませんでした。"),
        home: entry(rawMatch.home),
        away: entry(rawMatch.away),
        rankRange: pair(rawMatch.rank_range, "試合の順位範囲を読み取れませんでした。"),
        raw: rawMatch,
      };
    });
    return {
      id: poolId,
      index: positiveInteger(raw.pool_index, "順位帯番号を読み取れませんでした。"),
      displayName: typeof raw.display_name === "string" && raw.display_name.length > 0
        ? raw.display_name
        : (() => { throw schemaError("順位帯名を読み取れませんでした。"); })(),
      participantCount,
      overallRange: pair(raw.overall_rank_range, "順位帯の全体順位範囲を読み取れませんでした。"),
      seeds,
      matches,
      placements: objects(raw.placements, "最終順位参照を読み取れませんでした。").map((placement) => {
        keys(placement, ["rank", "pool_rank", "entry"], "最終順位参照に未対応の項目が含まれています。");
        return {
          rank: positiveInteger(placement.rank, "最終順位を読み取れませんでした。"),
          poolRank: positiveInteger(placement.pool_rank, "順位帯内順位を読み取れませんでした。"),
          entry: entry(placement.entry),
        };
      }),
      raw,
    };
  });
  const teamCount = pools.reduce((sum, pool) => sum + pool.participantCount, 0);
  const allSeeds = pools.flatMap((pool) => pool.seeds);
  if (allSeeds.length !== teamCount) throw sourceError("participant_count_mismatch");
  const blockOrder = [...new Set(allSeeds.map((seed) => seed.blockId))];
  if (blockOrder.length === 0 || teamCount % blockOrder.length !== 0) {
    throw sourceError("seed_block_count_invalid");
  }
  const blockSize = teamCount / blockOrder.length;
  const rankKeys = allSeeds.map((seed) => rankKey(seed.entry));
  const expectedRankKeys = blockOrder.flatMap((blockId) =>
    Array.from({ length: blockSize }, (_, index) => `${blockId}:${String(index + 1)}`)
  );
  if (
    duplicateValues(rankKeys).length > 0 || rankKeys.length !== expectedRankKeys.length ||
    expectedRankKeys.some((key) => !rankKeys.includes(key))
  ) throw sourceError("seed_rank_refs_invalid");
  const allowedBlocks = new Map<string, readonly number[]>([
    ["8:2", [2, 4]], ["16:2", [2, 4, 8]], ["24:3", [2, 4, 8]],
    ["32:2", [2, 4, 8, 16]], ["32:4", [2, 4, 8]],
  ]).get(`${String(teamCount)}:${String(tournamentCount)}`);
  if (allowedBlocks === undefined || !allowedBlocks.includes(blockOrder.length)) {
    throw sourceError("placement_configuration_invalid");
  }
  if (teamCount % tournamentCount !== 0 || blockSize % tournamentCount !== 0) {
    throw sourceError("rank_band_not_divisible");
  }
  const participantCount = teamCount / tournamentCount;
  const bandWidth = blockSize / tournamentCount;
  const teamIds = allSeeds.map((seed) => seed.teamId);
  if (duplicateValues(teamIds).length > 0) throw referenceError("duplicate_seed");
  const rawDraws = objects(rawPlan.seed_draws, "シード抽選記録を読み取れませんでした。");
  rawDraws.forEach((draw) => {
    keys(draw, [
      "pool_id", "block_rank", "candidates", "decided_order", "candidate_rank_refs",
      "decided_rank_refs", "random_seed",
    ], "シード抽選記録に未対応の項目が含まれています。");
    identifier(draw.pool_id, "抽選記録の順位帯IDを読み取れませんでした。");
    positiveInteger(draw.block_rank, "抽選記録のブロック順位を読み取れませんでした。");
    integer(draw.random_seed, "抽選記録の抽選番号を読み取れませんでした。");
  });
  const drawKeys = rawDraws.map((draw) => `${String(draw.pool_id)}:${String(draw.block_rank)}`);
  const expectedDrawKeys = pools.flatMap((pool, index) =>
    Array.from({ length: bandWidth }, (_, offset) => `${pool.id}:${String(index * bandWidth + offset + 1)}`)
  );
  if (
    duplicateValues(drawKeys).length > 0 || drawKeys.length !== expectedDrawKeys.length ||
    expectedDrawKeys.some((key) => !drawKeys.includes(key)) ||
    rawDraws.some((draw) => draw.random_seed !== randomSeed)
  ) throw sourceError("seed_draws_invalid");
  const drawByKey = new Map(drawKeys.map((key, index) => [key, rawDraws[index]!]));
  const expectedWarnings: JsonObject[] = [];
  for (const [zeroIndex, pool] of pools.entries()) {
    const poolIndex = zeroIndex + 1;
    const expectedName = names.length > 0 ? String(names[zeroIndex]) : `第${String(poolIndex)}順位決定トーナメント`;
    const rangeStart = zeroIndex * bandWidth + 1;
    const rangeEnd = poolIndex * bandWidth;
    const expectedPoolKeys = blockOrder.flatMap((blockId) =>
      Array.from({ length: bandWidth }, (_, offset) => `${blockId}:${String(rangeStart + offset)}`)
    );
    const actualPoolKeys = pool.seeds.map((seed) => rankKey(seed.entry));
    if (
      pool.id !== `placement-${String(poolIndex)}` || pool.index !== poolIndex ||
      pool.displayName !== expectedName || pool.participantCount !== participantCount ||
      !deepEqual(pool.raw.pool_rank_range, [1, participantCount]) ||
      !deepEqual(pool.overallRange, [zeroIndex * participantCount + 1, poolIndex * participantCount]) ||
      actualPoolKeys.length !== expectedPoolKeys.length || expectedPoolKeys.some((key) => !actualPoolKeys.includes(key)) ||
      pool.seeds.some((seed, index) => seed.seedNo !== index + 1)
    ) throw sourceError("pool_derivation_invalid", { pool_id: pool.id });
    const decidedEntries = Array.from({ length: bandWidth }, (_, offset) => {
      const draw = drawByKey.get(`${pool.id}:${String(rangeStart + offset)}`)!;
      const candidateRefs = objects(draw.candidate_rank_refs, "抽選順位枠候補を読み取れませんでした。").map(entry);
      const decidedRefs = objects(draw.decided_rank_refs, "抽選順位枠確定順を読み取れませんでした。").map(entry);
      const expectedCandidates = blockOrder.map((blockId) => ({
        type: "league_rank", block_id: blockId, rank: rangeStart + offset,
      }));
      if (
        candidateRefs.some((item) => item.type !== "league_rank") ||
        decidedRefs.some((item) => item.type !== "league_rank") ||
        candidateRefs.length !== expectedCandidates.length ||
        expectedCandidates.some((candidate) =>
          !candidateRefs.some((item) => deepEqual(entryJson(item), candidate))
        ) ||
        decidedRefs.length !== expectedCandidates.length ||
        expectedCandidates.some((candidate) =>
          !decidedRefs.some((item) => deepEqual(entryJson(item), candidate))
        )
      ) throw sourceError("seed_draws_invalid");
      const decidedTeamIds = decidedRefs.map((item) =>
        allSeeds.find((seed) => item.type === "league_rank" && rankKey(seed.entry) === rankKey(item))!.teamId
      );
      const candidateTeamIds = [...decidedTeamIds].sort();
      if (!deepEqual(draw.candidates, candidateTeamIds) || !deepEqual(draw.decided_order, decidedTeamIds)) {
        throw sourceError("seed_draws_invalid");
      }
      return decidedRefs;
    }).flat();
    if (!deepEqual(pool.seeds.map((seed) => entryJson(seed.entry)), decidedEntries.map(entryJson))) {
      throw sourceError("pool_seed_order_invalid", { pool_id: pool.id });
    }
    const regenerated = await regeneratePool(pool, randomSeed);
    const actualProjection = {
      pool_id: pool.raw.pool_id,
      pool_index: pool.raw.pool_index,
      display_name: pool.raw.display_name,
      participant_count: pool.raw.participant_count,
      pool_rank_range: pool.raw.pool_rank_range,
      overall_rank_range: pool.raw.overall_rank_range,
      seeds: pool.raw.seeds,
      matches: pool.raw.matches,
      placements: pool.raw.placements,
      evaluation: pool.raw.evaluation,
      logical_layout: pool.raw.logical_layout ?? null,
    };
    if (!deepEqual(actualProjection, regenerated.projection)) {
      throw sourceError("pool_match_graph_invalid", { pool_id: pool.id });
    }
    if (regenerated.warning !== undefined) expectedWarnings.push(regenerated.warning);
  }
  if (!deepEqual(rawPlan.warnings, expectedWarnings)) throw sourceError("tournament_warnings_invalid");
  if (rawPlan.participant_resolution !== "resolved") {
    throw new LocalTournamentStandingsError(
      "TOURNAMENT_RESULTS_REQUIRE_RESOLVED_PLAN",
      "リーグ順位を確定してから2日目の試合結果を入力してください。",
    );
  }
  const matches = new Map(pools.flatMap((pool) => pool.matches).map((match) => [match.id, match]));
  const teamByRank = new Map(allSeeds.map((seed) => [rankKey(seed.entry), seed.teamId]));
  return { randomSeed, pools, matches, teamByRank, teamIds: new Set(teamIds) };
}

function parseResult(raw: JsonObject): {
  matchId: string;
  homeTeamId: string;
  awayTeamId: string;
  regularHome: number;
  regularAway: number;
  penaltyHome: number | null;
  penaltyAway: number | null;
} {
  keys(raw, [
    "match_id", "home_team_id", "away_team_id", "regular_score_home", "regular_score_away",
    "penalty_score_home", "penalty_score_away",
  ], "2日目の試合結果に未対応の項目が含まれています。");
  const matchId = identifier(raw.match_id, "2日目の試合結果IDを読み取れませんでした。");
  const penaltyHome = raw.penalty_score_home == null
    ? null
    : nonNegativeInteger(raw.penalty_score_home, "PK得点に0以上の整数を入力してください。");
  const penaltyAway = raw.penalty_score_away == null
    ? null
    : nonNegativeInteger(raw.penalty_score_away, "PK得点に0以上の整数を入力してください。");
  return {
    matchId,
    homeTeamId: identifier(raw.home_team_id, "2日目のホームチームを読み取れませんでした。"),
    awayTeamId: identifier(raw.away_team_id, "2日目のアウェーチームを読み取れませんでした。"),
    regularHome: nonNegativeInteger(raw.regular_score_home, "通常得点に0以上の整数を入力してください。"),
    regularAway: nonNegativeInteger(raw.regular_score_away, "通常得点に0以上の整数を入力してください。"),
    penaltyHome,
    penaltyAway,
  };
}

function canonicalResult(raw: ReturnType<typeof parseResult>): CanonicalResult {
  let homeWins: boolean;
  let decision: CanonicalResult["decision"];
  if (raw.regularHome !== raw.regularAway) {
    if (raw.penaltyHome !== null || raw.penaltyAway !== null) {
      throw new LocalTournamentStandingsError(
        "TOURNAMENT_RESULT_INVALID",
        "通常得点が同点でない試合にPK得点は入力できません。",
        { match_id: raw.matchId, reason: "penalty_for_non_draw" },
      );
    }
    homeWins = raw.regularHome > raw.regularAway;
    decision = "regular_time";
  } else {
    if (raw.penaltyHome === null || raw.penaltyAway === null) {
      throw new LocalTournamentStandingsError(
        "TOURNAMENT_RESULT_INVALID",
        "通常得点が同点のため、両チームのPK得点を入力してください。",
        { match_id: raw.matchId, reason: "penalty_required" },
      );
    }
    if (raw.penaltyHome === raw.penaltyAway) {
      throw new LocalTournamentStandingsError(
        "TOURNAMENT_RESULT_INVALID",
        "PK戦は勝敗が決まるまで入力してください。",
        { match_id: raw.matchId, reason: "penalty_still_tied" },
      );
    }
    homeWins = raw.penaltyHome > raw.penaltyAway;
    decision = "penalty_shootout";
  }
  return {
    match_id: raw.matchId,
    home_team_id: raw.homeTeamId,
    away_team_id: raw.awayTeamId,
    regular_score_home: raw.regularHome,
    regular_score_away: raw.regularAway,
    penalty_score_home: raw.penaltyHome,
    penalty_score_away: raw.penaltyAway,
    winner: homeWins ? "home" : "away",
    winner_team_id: homeWins ? raw.homeTeamId : raw.awayTeamId,
    loser_team_id: homeWins ? raw.awayTeamId : raw.homeTeamId,
    decision,
  };
}

export async function calculateLocalTournamentStandings(input: {
  tournamentPlan: JsonObject;
  results: readonly JsonObject[];
}): Promise<JsonObject> {
  const plan = await parseAndValidatePlan(input.tournamentPlan);
  const parsedResults = input.results.map(parseResult);
  const suppliedIds = parsedResults.map((result) => result.matchId);
  const duplicates = duplicateValues(suppliedIds);
  if (duplicates.length > 0) {
    throw new LocalTournamentStandingsError(
      "DUPLICATE_TOURNAMENT_RESULT",
      "同じトーナメント試合の結果が重複しています。",
      { match_ids: duplicates },
    );
  }
  const unknown = [...new Set(suppliedIds.filter((matchId) => !plan.matches.has(matchId)))].sort();
  if (unknown.length > 0) {
    throw new LocalTournamentStandingsError(
      "UNKNOWN_TOURNAMENT_MATCH",
      "日程にないトーナメント試合の結果が含まれています。",
      { match_ids: unknown },
    );
  }
  const missing = [...plan.matches.keys()].filter((matchId) => !suppliedIds.includes(matchId)).sort();
  if (missing.length > 0) {
    throw new LocalTournamentStandingsError(
      "TOURNAMENT_RESULTS_INCOMPLETE",
      "すべての2日目試合の結果を入力してから最終順位を確定してください。",
      { missing_match_ids: missing, missing_count: missing.length },
    );
  }
  const inputs = new Map(parsedResults.map((result) => [result.matchId, result]));
  const resolved = new Map<string, CanonicalResult>();
  const resolving = new Set<string>();
  const orderedResults: CanonicalResult[] = [];
  const resolveEntry = (value: Entry): string => {
    if (value.type === "concrete_team") return value.team_id;
    if (value.type === "league_rank") {
      const teamId = plan.teamByRank.get(rankKey(value));
      if (teamId === undefined) {
        throw referenceError("unknown_league_rank", { block_id: value.block_id, rank: value.rank });
      }
      return teamId;
    }
    const source = resolveMatch(value.match_id);
    return value.type === "winner_of" ? source.winner_team_id : source.loser_team_id;
  };
  const resolveMatch = (matchId: string): CanonicalResult => {
    const existing = resolved.get(matchId);
    if (existing !== undefined) return existing;
    const match = plan.matches.get(matchId);
    if (match === undefined) throw referenceError("unknown_dependency", { match_id: matchId });
    if (resolving.has(matchId)) {
      throw new LocalTournamentStandingsError(
        "TOURNAMENT_DEPENDENCY_CYCLE",
        "トーナメントの試合参照が循環しています。トーナメント表を作り直してください。",
        { match_id: matchId },
      );
    }
    resolving.add(matchId);
    try {
      const homeTeamId = resolveEntry(match.home);
      const awayTeamId = resolveEntry(match.away);
      if (homeTeamId === awayTeamId) {
        throw referenceError("same_team_match", { match_id: matchId, team_id: homeTeamId });
      }
      const supplied = inputs.get(matchId)!;
      if (supplied.homeTeamId !== homeTeamId || supplied.awayTeamId !== awayTeamId) {
        throw new LocalTournamentStandingsError(
          "TOURNAMENT_RESULT_PARTICIPANT_MISMATCH",
          "対戦チームが現在のトーナメント進行と一致しません。後続試合の結果を入力し直してください。",
          {
            match_id: matchId,
            expected_home_team_id: homeTeamId,
            expected_away_team_id: awayTeamId,
            supplied_home_team_id: supplied.homeTeamId,
            supplied_away_team_id: supplied.awayTeamId,
          },
        );
      }
      const canonical = canonicalResult(supplied);
      resolved.set(matchId, canonical);
      orderedResults.push(canonical);
      return canonical;
    } finally {
      resolving.delete(matchId);
    }
  };
  for (const matchId of plan.matches.keys()) resolveMatch(matchId);
  const standings = plan.pools.flatMap((pool) => pool.placements.map((placement) => ({
    rank: placement.rank,
    pool_id: pool.id,
    pool_rank: placement.poolRank,
    team_id: resolveEntry(placement.entry),
    entry: entryJson(placement.entry),
  }))).sort((left, right) => left.rank - right.rank);
  const ranks = standings.map((standing) => standing.rank);
  const finalTeamIds = standings.map((standing) => standing.team_id);
  const expectedRanks = Array.from({ length: standings.length }, (_, index) => index + 1);
  if (
    !deepEqual(ranks, expectedRanks) || new Set(finalTeamIds).size !== finalTeamIds.length ||
    finalTeamIds.some((teamId) => !plan.teamIds.has(teamId)) || finalTeamIds.length !== plan.teamIds.size
  ) throw referenceError("invalid_final_standings", { expected_ranks: expectedRanks, actual_ranks: ranks });
  return {
    schema_version: SCHEMA_VERSION,
    status: "COMPLETE",
    match_results: orderedResults,
    standings,
  };
}
