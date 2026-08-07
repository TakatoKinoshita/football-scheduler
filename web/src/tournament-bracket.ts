import type { JsonObject } from "./types";
import {
  resolveTournamentProgress,
  type TournamentMatchProgress,
  type TournamentPoolName,
  type TournamentProgress,
} from "./tournament-results";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export interface TournamentBracketScheduleDetails {
  displayNumber: string;
  timeLabel: string;
  courtName: string;
}

export interface TournamentBracketInput {
  plan: JsonObject;
  pool: TournamentPoolName;
  teamNames: ReadonlyMap<string, string>;
  scheduleByMatchId?: ReadonlyMap<string, TournamentBracketScheduleDetails>;
  results?: readonly JsonObject[];
  finalStandings?: JsonObject;
}

export type TournamentBracketOutcome = "winner" | "loser";
export type TournamentBracketSideName = "home" | "away";

export interface TournamentBracketSide {
  primaryLabel: string;
  secondaryLabel?: string;
  fullLabel: string;
  scoreLabel?: string;
  winner: boolean;
  bye: boolean;
}

export interface TournamentBracketTerminal {
  outcome: TournamentBracketOutcome;
  rank: number;
  label: string;
  teamLabel?: string;
  confirmed: boolean;
  pendingConfirmation: boolean;
  x: number;
  y: number;
}

export interface TournamentBracketNode {
  id: string;
  roundNo: number;
  roundLabel: string;
  displayNumber: string;
  metaLabel?: string;
  rankRangeLabel?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  home: TournamentBracketSide;
  away: TournamentBracketSide;
  terminals: TournamentBracketTerminal[];
}

export interface TournamentBracketEdge {
  sourceMatchId: string;
  targetMatchId: string;
  targetSide: TournamentBracketSideName;
  outcome: TournamentBracketOutcome;
  path: string;
  labelX: number;
  labelY: number;
}

export interface TournamentBracketDirectPlacement {
  rank: number;
  label: string;
  confirmed: boolean;
}

export interface TournamentBracketLayer {
  roundNo: number;
  matchIds: readonly string[];
}

export interface TournamentBracketModel {
  pool: TournamentPoolName;
  participantCount: number;
  provisional: boolean;
  compact: boolean;
  width: number;
  height: number;
  nodes: readonly TournamentBracketNode[];
  edges: readonly TournamentBracketEdge[];
  layers: readonly TournamentBracketLayer[];
  directPlacements: readonly TournamentBracketDirectPlacement[];
  emptyMessage?: string;
}

export class TournamentBracketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TournamentBracketError";
  }
}

interface ParsedMatch {
  id: string;
  roundNo: number;
  roundLabel: string;
  raw: JsonObject;
  inputIndex: number;
}

interface ParsedReference {
  sourceMatchId: string;
  outcome: TournamentBracketOutcome;
}

interface UnpositionedEdge {
  sourceMatchId: string;
  targetMatchId: string;
  targetSide: TournamentBracketSideName;
  outcome: TournamentBracketOutcome;
}

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function objectArray(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.map(objectValue).filter((item): item is JsonObject => item !== undefined)
    : [];
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function poolValue(plan: JsonObject, pool: TournamentPoolName): JsonObject {
  const value = objectValue(plan[pool]);
  if (value === undefined) {
    throw new TournamentBracketError("トーナメントの上下区分を読み取れませんでした。");
  }
  return value;
}

function entryKey(value: unknown): string {
  const entry = objectValue(value);
  if (entry?.type === "league_rank") {
    return `league_rank:${String(entry.block_id)}:${String(entry.rank)}`;
  }
  if (entry?.type === "concrete_team") {
    return `concrete_team:${String(entry.team_id)}`;
  }
  if (entry?.type === "winner_of" || entry?.type === "loser_of") {
    return `${String(entry.type)}:${String(entry.match_id)}`;
  }
  return "invalid";
}

function parsedReference(value: unknown): ParsedReference | undefined {
  const entry = objectValue(value);
  if (entry?.type !== "winner_of" && entry?.type !== "loser_of") return undefined;
  const sourceMatchId = identifier(entry.match_id);
  if (sourceMatchId === undefined) {
    throw new TournamentBracketError("勝敗参照の試合IDを読み取れませんでした。");
  }
  return {
    sourceMatchId,
    outcome: entry.type === "winner_of" ? "winner" : "loser",
  };
}

function validateEntry(value: unknown): void {
  const entry = objectValue(value);
  if (entry === undefined) {
    throw new TournamentBracketError("トーナメントの参加枠を読み取れませんでした。");
  }
  if (entry.type === "concrete_team" && identifier(entry.team_id) !== undefined) return;
  if (
    entry.type === "league_rank" &&
    identifier(entry.block_id) !== undefined &&
    positiveInteger(entry.rank) !== undefined
  ) {
    return;
  }
  if (
    (entry.type === "winner_of" || entry.type === "loser_of") &&
    identifier(entry.match_id) !== undefined
  ) {
    return;
  }
  throw new TournamentBracketError("未対応または不正なトーナメント参加枠があります。");
}

function validateAcyclic(matches: readonly ParsedMatch[], edges: readonly UnpositionedEdge[]): void {
  const targetsBySource = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = targetsBySource.get(edge.sourceMatchId) ?? [];
    targets.push(edge.targetMatchId);
    targetsBySource.set(edge.sourceMatchId, targets);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (matchId: string): void => {
    if (visiting.has(matchId)) {
      throw new TournamentBracketError("トーナメントの試合参照が循環しています。");
    }
    if (visited.has(matchId)) return;
    visiting.add(matchId);
    for (const target of targetsBySource.get(matchId) ?? []) visit(target);
    visiting.delete(matchId);
    visited.add(matchId);
  };
  for (const match of matches) visit(match.id);
}

function normalizedPosition(
  matchId: string,
  orders: ReadonlyMap<number, readonly ParsedMatch[]>,
  roundByMatchId: ReadonlyMap<string, number>,
): number | undefined {
  const round = roundByMatchId.get(matchId);
  if (round === undefined) return undefined;
  const layer = orders.get(round) ?? [];
  const index = layer.findIndex((match) => match.id === matchId);
  if (index < 0) return undefined;
  return layer.length <= 1 ? 0.5 : index / (layer.length - 1);
}

function reduceCrossings(
  rounds: readonly number[],
  initial: ReadonlyMap<number, readonly ParsedMatch[]>,
  edges: readonly UnpositionedEdge[],
): Map<number, ParsedMatch[]> {
  const orders = new Map<number, ParsedMatch[]>(
    [...initial].map(([round, matches]) => [round, [...matches]] as const),
  );
  const roundByMatchId = new Map(
    [...orders.values()].flat().map((match) => [match.id, match.roundNo] as const),
  );
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const sources = incoming.get(edge.targetMatchId) ?? [];
    sources.push(edge.sourceMatchId);
    incoming.set(edge.targetMatchId, sources);
    const targets = outgoing.get(edge.sourceMatchId) ?? [];
    targets.push(edge.targetMatchId);
    outgoing.set(edge.sourceMatchId, targets);
  }
  const reorder = (round: number, neighbors: ReadonlyMap<string, readonly string[]>): void => {
    const current = orders.get(round) ?? [];
    const previousIndex = new Map(current.map((match, index) => [match.id, index] as const));
    const score = (match: ParsedMatch): number | undefined => {
      const positions = (neighbors.get(match.id) ?? [])
        .map((neighbor) => normalizedPosition(neighbor, orders, roundByMatchId))
        .filter((position): position is number => position !== undefined);
      if (positions.length === 0) return undefined;
      return positions.reduce((sum, value) => sum + value, 0) / positions.length;
    };
    current.sort((left, right) => {
      const leftScore = score(left);
      const rightScore = score(right);
      if (leftScore !== undefined && rightScore !== undefined && leftScore !== rightScore) {
        return leftScore - rightScore;
      }
      if (leftScore !== undefined && rightScore === undefined) return -1;
      if (leftScore === undefined && rightScore !== undefined) return 1;
      return (previousIndex.get(left.id) ?? 0) - (previousIndex.get(right.id) ?? 0) ||
        left.id.localeCompare(right.id);
    });
  };
  for (let pass = 0; pass < 4; pass += 1) {
    for (const round of rounds.slice(1)) reorder(round, incoming);
    for (const round of rounds.slice(0, -1).reverse()) reorder(round, outgoing);
  }
  return orders;
}

function pathBetween(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
): string {
  const middle = sourceX + (targetX - sourceX) / 2;
  return `M ${sourceX} ${sourceY} C ${middle} ${sourceY}, ${middle} ${targetY}, ${targetX} ${targetY}`;
}

function sourcePortY(node: TournamentBracketNode, outcome: TournamentBracketOutcome): number {
  return node.y + node.height * (outcome === "winner" ? 0.42 : 0.76);
}

function targetPortY(node: TournamentBracketNode, side: TournamentBracketSideName): number {
  return node.y + node.height * (side === "home" ? 0.46 : 0.79);
}

function scheduleMatchLabel(
  matchId: string,
  scheduleByMatchId: TournamentBracketInput["scheduleByMatchId"],
): string {
  return scheduleByMatchId?.get(matchId)?.displayNumber ?? matchId;
}

function rankLabel(entry: JsonObject): string | undefined {
  return entry.type === "league_rank" &&
      typeof entry.block_id === "string" &&
      positiveInteger(entry.rank) !== undefined
    ? `${entry.block_id}ブロック ${String(entry.rank)}位`
    : undefined;
}

function progressForMatch(
  progress: TournamentProgress | undefined,
  matchId: string,
): TournamentMatchProgress | undefined {
  return progress?.matchesById.get(matchId);
}

function finalTeamByPoolRank(
  finalStandings: JsonObject | undefined,
  pool: TournamentPoolName,
): Map<number, string> {
  const result = new Map<number, string>();
  for (const standing of objectArray(finalStandings?.standings)) {
    if (standing.pool !== pool) continue;
    const rank = positiveInteger(standing.pool_rank);
    const teamId = identifier(standing.team_id);
    if (rank !== undefined && teamId !== undefined) result.set(rank, teamId);
  }
  return result;
}

function fullTeamLabel(teamId: string, teamNames: ReadonlyMap<string, string>): string {
  return teamNames.get(teamId) ?? teamId;
}

export function buildTournamentBracketModel(
  input: TournamentBracketInput,
): TournamentBracketModel {
  const pool = poolValue(input.plan, input.pool);
  const participantCount = nonNegativeInteger(pool.participant_count);
  if (participantCount === undefined || participantCount > 32) {
    throw new TournamentBracketError("トーナメント参加数を読み取れませんでした。");
  }
  const provisional = input.plan.participant_resolution === "provisional";
  const parsedMatches: ParsedMatch[] = [];
  const matchById = new Map<string, ParsedMatch>();
  for (const [inputIndex, raw] of objectArray(pool.matches).entries()) {
    const id = identifier(raw.id);
    const roundNo = positiveInteger(raw.round_no);
    if (id === undefined || roundNo === undefined) {
      throw new TournamentBracketError("トーナメントの試合IDまたは段階を読み取れませんでした。");
    }
    if (matchById.has(id)) {
      throw new TournamentBracketError(`トーナメントの試合ID「${id}」が重複しています。`);
    }
    validateEntry(raw.home);
    validateEntry(raw.away);
    const parsed: ParsedMatch = {
      id,
      roundNo,
      roundLabel: typeof raw.round === "string" ? raw.round : `第${String(roundNo)}段階`,
      raw,
      inputIndex,
    };
    parsedMatches.push(parsed);
    matchById.set(id, parsed);
  }

  const edges: UnpositionedEdge[] = [];
  for (const match of parsedMatches) {
    for (const side of ["home", "away"] as const) {
      const reference = parsedReference(match.raw[side]);
      if (reference === undefined) continue;
      const source = matchById.get(reference.sourceMatchId);
      if (source === undefined) {
        throw new TournamentBracketError(
          `参照先の試合「${reference.sourceMatchId}」が見つかりません。`,
        );
      }
      edges.push({
        sourceMatchId: source.id,
        targetMatchId: match.id,
        targetSide: side,
        outcome: reference.outcome,
      });
    }
  }
  validateAcyclic(parsedMatches, edges);
  if (
    edges.some((edge) =>
      matchById.get(edge.sourceMatchId)!.roundNo >= matchById.get(edge.targetMatchId)!.roundNo
    )
  ) {
    throw new TournamentBracketError("前後関係が不正なトーナメント試合参照があります。");
  }

  const seedTeamByRank = new Map<string, string>();
  const rankByTeam = new Map<string, string>();
  for (const seed of objectArray(pool.seeds)) {
    const blockId = identifier(seed.block_id);
    const blockRank = positiveInteger(seed.block_rank);
    const teamId = identifier(seed.team_id);
    if (blockId !== undefined && blockRank !== undefined && teamId !== undefined) {
      const label = `${blockId}ブロック ${String(blockRank)}位`;
      seedTeamByRank.set(`${blockId}:${String(blockRank)}`, teamId);
      rankByTeam.set(teamId, label);
    }
  }

  let progress: TournamentProgress | undefined;
  if (!provisional) {
    try {
      progress = resolveTournamentProgress(input.plan, input.results ?? []);
    } catch (error) {
      throw new TournamentBracketError(
        error instanceof Error
          ? `試合結果をブラケットへ反映できませんでした。${error.message}`
          : "試合結果をブラケットへ反映できませんでした。",
      );
    }
  }

  const teamForEntry = (value: unknown): string | undefined => {
    const entry = objectValue(value);
    if (entry?.type === "concrete_team") return identifier(entry.team_id);
    if (entry?.type === "league_rank") {
      return provisional
        ? undefined
        : seedTeamByRank.get(`${String(entry.block_id)}:${String(entry.rank)}`);
    }
    if (entry?.type === "winner_of" || entry?.type === "loser_of") {
      const source = progressForMatch(progress, String(entry.match_id));
      return entry.type === "winner_of" ? source?.winnerTeamId : source?.loserTeamId;
    }
    return undefined;
  };
  const entryDescription = (value: unknown): Omit<TournamentBracketSide, "scoreLabel" | "winner" | "bye"> => {
    const entry = objectValue(value);
    if (entry === undefined) {
      return { primaryLabel: "対戦結果で決定", fullLabel: "対戦結果で決定" };
    }
    const teamId = teamForEntry(entry);
    const sourceRank = rankLabel(entry) ?? (teamId === undefined ? undefined : rankByTeam.get(teamId));
    let sourceLabel: string | undefined;
    if (entry.type === "winner_of") {
      sourceLabel = `${scheduleMatchLabel(String(entry.match_id), input.scheduleByMatchId)}の勝者`;
    } else if (entry.type === "loser_of") {
      sourceLabel = `${scheduleMatchLabel(String(entry.match_id), input.scheduleByMatchId)}の敗者`;
    } else {
      sourceLabel = sourceRank;
    }
    if (teamId !== undefined) {
      const name = fullTeamLabel(teamId, input.teamNames);
      return {
        primaryLabel: name,
        ...(sourceLabel === undefined ? {} : { secondaryLabel: sourceLabel }),
        fullLabel: sourceLabel === undefined ? name : `${name}（${sourceLabel}）`,
      };
    }
    const unresolved = sourceLabel ?? "対戦結果で決定";
    return { primaryLabel: unresolved, fullLabel: unresolved };
  };

  const byeSides = new Set<string>();
  for (const bye of objectArray(pool.byes)) {
    const nextMatchId = identifier(bye.next_match_id);
    if (nextMatchId === undefined || !matchById.has(nextMatchId)) {
      throw new TournamentBracketError("不戦通過の進行先を読み取れませんでした。");
    }
    validateEntry(bye.entry);
    const nextMatch = matchById.get(nextMatchId)!;
    const key = entryKey(bye.entry);
    const sides = (["home", "away"] as const).filter(
      (side) => entryKey(nextMatch.raw[side]) === key,
    );
    if (sides.length !== 1) {
      throw new TournamentBracketError("不戦通過の参加枠と進行先が一致しません。");
    }
    byeSides.add(`${nextMatchId}:${sides[0]}`);
  }

  const matchesByRound = new Map<number, ParsedMatch[]>();
  for (const match of parsedMatches) {
    const layer = matchesByRound.get(match.roundNo) ?? [];
    layer.push(match);
    matchesByRound.set(match.roundNo, layer);
  }
  for (const layer of matchesByRound.values()) {
    layer.sort((left, right) => left.inputIndex - right.inputIndex || left.id.localeCompare(right.id));
  }
  const rounds = [...matchesByRound.keys()].sort((left, right) => left - right);
  const orderedLayers = reduceCrossings(rounds, matchesByRound, edges);
  const compact = participantCount > 16;
  const nodeWidth = compact ? 160 : 220;
  const nodeHeight = compact ? 48 : 78;
  const rowGap = compact ? 8 : 18;
  const layerGap = compact ? 92 : 118;
  const marginX = compact ? 22 : 30;
  const marginY = compact ? 22 : 30;
  const maximumRows = Math.max(1, ...[...orderedLayers.values()].map((layer) => layer.length));
  const height = marginY * 2 + maximumRows * nodeHeight + (maximumRows - 1) * rowGap;
  const width = marginX * 2 +
    Math.max(1, rounds.length) * nodeWidth +
    Math.max(0, rounds.length - 1) * layerGap +
    (parsedMatches.length > 0 ? layerGap : 0);

  const finalTeams = finalTeamByPoolRank(input.finalStandings, input.pool);
  const upperCount = nonNegativeInteger(objectValue(input.plan.upper)?.participant_count) ?? 0;
  const overallRank = (poolRank: number): number =>
    input.pool === "upper" ? poolRank : upperCount + poolRank;
  const placementsByMatch = new Map<
    string,
    Array<{
      outcome: TournamentBracketOutcome;
      rank: number;
      teamId?: string;
      confirmed: boolean;
      pendingConfirmation: boolean;
    }>
  >();
  const directPlacements: TournamentBracketDirectPlacement[] = [];
  const placementRanks = new Set<number>();
  for (const placement of objectArray(pool.placements)) {
    const poolRank = positiveInteger(placement.rank);
    if (
      poolRank === undefined ||
      poolRank > participantCount ||
      placementRanks.has(poolRank)
    ) {
      throw new TournamentBracketError("最終順位を読み取れませんでした。");
    }
    placementRanks.add(poolRank);
    validateEntry(placement.entry);
    const reference = parsedReference(placement.entry);
    const confirmedTeamId = finalTeams.get(poolRank);
    const teamId = confirmedTeamId ?? teamForEntry(placement.entry);
    const rank = overallRank(poolRank);
    if (reference === undefined) {
      directPlacements.push({
        rank,
        label: teamId === undefined
          ? entryDescription(placement.entry).fullLabel
          : fullTeamLabel(teamId, input.teamNames),
        confirmed: confirmedTeamId !== undefined,
      });
      continue;
    }
    if (!matchById.has(reference.sourceMatchId)) {
      throw new TournamentBracketError(
        `最終順位が未知の試合「${reference.sourceMatchId}」を参照しています。`,
      );
    }
    const terminals = placementsByMatch.get(reference.sourceMatchId) ?? [];
    terminals.push({
      outcome: reference.outcome,
      rank,
      ...(teamId === undefined ? {} : { teamId }),
      confirmed: confirmedTeamId !== undefined,
      pendingConfirmation: progress?.complete === true && confirmedTeamId === undefined,
    });
    placementsByMatch.set(reference.sourceMatchId, terminals);
  }
  if (placementRanks.size !== participantCount) {
    throw new TournamentBracketError("トーナメントの最終順位枠に不足があります。");
  }

  const nodeById = new Map<string, TournamentBracketNode>();
  const nodes: TournamentBracketNode[] = [];
  for (const [layerIndex, round] of rounds.entries()) {
    const layer = orderedLayers.get(round) ?? [];
    for (const [rowIndex, match] of layer.entries()) {
      const centerY = layer.length <= 1
        ? height / 2
        : marginY + nodeHeight / 2 +
          rowIndex * ((height - marginY * 2 - nodeHeight) / (layer.length - 1));
      const matchProgress = progressForMatch(progress, match.id);
      const result = matchProgress?.result;
      const homeDescription = entryDescription(match.raw.home);
      const awayDescription = entryDescription(match.raw.away);
      const schedule = input.scheduleByMatchId?.get(match.id);
      const rawRange = Array.isArray(match.raw.rank_range) ? match.raw.rank_range : [];
      const rangeStart = positiveInteger(rawRange[0]);
      const rangeEnd = positiveInteger(rawRange[1]);
      const rankRangeLabel = rangeStart === undefined || rangeEnd === undefined
        ? undefined
        : `${String(overallRank(rangeStart))}〜${String(overallRank(rangeEnd))}位`;
      const node: TournamentBracketNode = {
        id: match.id,
        roundNo: match.roundNo,
        roundLabel: match.roundLabel,
        displayNumber: schedule?.displayNumber ?? match.id,
        ...(schedule === undefined
          ? {}
          : { metaLabel: `${schedule.timeLabel} ${schedule.courtName}` }),
        ...(rankRangeLabel === undefined ? {} : { rankRangeLabel }),
        x: marginX + layerIndex * (nodeWidth + layerGap),
        y: centerY - nodeHeight / 2,
        width: nodeWidth,
        height: nodeHeight,
        home: {
          ...homeDescription,
          ...(result === undefined
            ? {}
            : {
                scoreLabel: `${String(result.regular_score_home)}${result.penalty_score_home === undefined ? "" : ` (PK ${String(result.penalty_score_home)})`}`,
              }),
          winner: matchProgress?.winner === "home",
          bye: byeSides.has(`${match.id}:home`),
        },
        away: {
          ...awayDescription,
          ...(result === undefined
            ? {}
            : {
                scoreLabel: `${String(result.regular_score_away)}${result.penalty_score_away === undefined ? "" : ` (PK ${String(result.penalty_score_away)})`}`,
              }),
          winner: matchProgress?.winner === "away",
          bye: byeSides.has(`${match.id}:away`),
        },
        terminals: [],
      };
      node.terminals = (placementsByMatch.get(match.id) ?? [])
        .sort((left, right) => left.rank - right.rank)
        .map((terminal) => {
          const y = sourcePortY(node, terminal.outcome);
          const state = terminal.confirmed
            ? "確定"
            : terminal.pendingConfirmation
              ? "・未確定"
              : "";
          return {
            outcome: terminal.outcome,
            rank: terminal.rank,
            label: `${terminal.outcome === "winner" ? "勝" : "敗"}→${String(terminal.rank)}位${state}`,
            ...(terminal.teamId === undefined
              ? {}
              : { teamLabel: fullTeamLabel(terminal.teamId, input.teamNames) }),
            confirmed: terminal.confirmed,
            pendingConfirmation: terminal.pendingConfirmation,
            x: node.x + node.width + 22,
            y,
          };
        });
      nodes.push(node);
      nodeById.set(node.id, node);
    }
  }

  const positionedEdges = edges.map((edge): TournamentBracketEdge => {
    const source = nodeById.get(edge.sourceMatchId);
    const target = nodeById.get(edge.targetMatchId);
    if (source === undefined || target === undefined) {
      throw new TournamentBracketError("トーナメントの進行線を配置できませんでした。");
    }
    const sourceX = source.x + source.width;
    const sourceY = sourcePortY(source, edge.outcome);
    const targetX = target.x;
    const targetY = targetPortY(target, edge.targetSide);
    return {
      ...edge,
      path: pathBetween(sourceX, sourceY, targetX, targetY),
      labelX: sourceX + 6,
      labelY: sourceY - 4,
    };
  });

  return {
    pool: input.pool,
    participantCount,
    provisional,
    compact,
    width,
    height,
    nodes,
    edges: positionedEdges,
    layers: rounds.map((roundNo) => ({
      roundNo,
      matchIds: (orderedLayers.get(roundNo) ?? []).map((match) => match.id),
    })),
    directPlacements: directPlacements.sort((left, right) => left.rank - right.rank),
    ...(participantCount === 0 ? { emptyMessage: "該当チームなし" } : {}),
  };
}

function svgElement<K extends keyof SVGElementTagNameMap>(
  name: K,
  attributes: Readonly<Record<string, string | number>> = {},
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NAMESPACE, name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  return element;
}

function appendSvgText(
  parent: SVGElement,
  value: string,
  x: number,
  y: number,
  className: string,
  maximumCharacters = 24,
): SVGTextElement {
  const text = svgElement("text", { x, y, class: className });
  const characters = [...value];
  text.textContent = characters.length <= maximumCharacters
    ? value
    : `${characters.slice(0, Math.max(1, maximumCharacters - 1)).join("")}…`;
  if (text.textContent !== value) {
    const title = svgElement("title");
    title.textContent = value;
    text.append(title);
  }
  parent.append(text);
  return text;
}

function sideAriaLabel(side: TournamentBracketSide): string {
  return `${side.fullLabel}${side.scoreLabel === undefined ? "" : ` ${side.scoreLabel}`}${side.winner ? " 勝者" : ""}${side.bye ? " 予備戦免除" : ""}`;
}

export function renderTournamentBracket(
  model: TournamentBracketModel,
  heading: string,
): HTMLElement {
  const figure = document.createElement("figure");
  figure.className = "tournament-bracket";
  figure.dataset.pool = model.pool;
  figure.dataset.participantCount = String(model.participantCount);
  const caption = document.createElement("figcaption");
  caption.textContent = heading;
  figure.append(caption);
  if (model.emptyMessage !== undefined) {
    const message = document.createElement("p");
    message.className = "muted tournament-bracket-empty";
    message.textContent = model.emptyMessage;
    figure.append(message);
    return figure;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "tournament-bracket-scroll";
  const titleId = `tournament-bracket-${model.pool}-title`;
  const descriptionId = `tournament-bracket-${model.pool}-description`;
  const svg = svgElement("svg", {
    viewBox: `0 0 ${model.width} ${model.height}`,
    role: "img",
    "aria-labelledby": `${titleId} ${descriptionId}`,
    preserveAspectRatio: "xMinYMin meet",
    class: model.compact ? "tournament-bracket-svg compact" : "tournament-bracket-svg",
  });
  const title = svgElement("title", { id: titleId });
  title.textContent = heading;
  const description = svgElement("desc", { id: descriptionId });
  description.textContent =
    "試合枠を線で結び、実線の勝者と破線の敗者が次に進む試合または最終順位を示します。完全な文字情報は続く一覧表でも確認できます。";
  svg.append(title, description);
  if (model.provisional) {
    appendSvgText(svg, "仮", model.width / 2, model.height / 2, "bracket-watermark", 2);
  }
  for (const edge of model.edges) {
    const path = svgElement("path", {
      d: edge.path,
      class: `bracket-edge ${edge.outcome}`,
      "data-source-match-id": edge.sourceMatchId,
      "data-target-match-id": edge.targetMatchId,
      "data-target-side": edge.targetSide,
    });
    const edgeTitle = svgElement("title");
    edgeTitle.textContent = `${edge.sourceMatchId}の${edge.outcome === "winner" ? "勝者" : "敗者"}が${edge.targetMatchId}へ進みます`;
    path.append(edgeTitle);
    svg.append(path);
    appendSvgText(
      svg,
      edge.outcome === "winner" ? "勝" : "敗",
      edge.labelX,
      edge.labelY,
      `bracket-edge-label ${edge.outcome}`,
      1,
    );
  }
  for (const node of model.nodes) {
    const group = svgElement("g", {
      class: "bracket-match-node",
      "data-match-id": node.id,
      "data-round-no": node.roundNo,
      "aria-label": `${node.displayNumber} ${node.roundLabel}、${sideAriaLabel(node.home)} 対 ${sideAriaLabel(node.away)}`,
    });
    const groupTitle = svgElement("title");
    groupTitle.textContent = `${node.displayNumber} ${node.roundLabel}${node.metaLabel === undefined ? "" : ` ${node.metaLabel}`}：${sideAriaLabel(node.home)} 対 ${sideAriaLabel(node.away)}`;
    group.append(groupTitle);
    group.append(svgElement("rect", {
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      rx: model.compact ? 3 : 5,
      class: "bracket-match-card",
    }));
    const headerHeight = model.compact ? 15 : 20;
    group.append(svgElement("line", {
      x1: node.x,
      y1: node.y + headerHeight,
      x2: node.x + node.width,
      y2: node.y + headerHeight,
      class: "bracket-card-divider",
    }));
    appendSvgText(
      group,
      `${node.displayNumber} ${node.roundLabel}`,
      node.x + 6,
      node.y + (model.compact ? 11 : 14),
      "bracket-match-heading",
      model.compact ? 18 : 26,
    );
    if (!model.compact && node.metaLabel !== undefined) {
      appendSvgText(
        group,
        node.metaLabel,
        node.x + node.width - 6,
        node.y + 14,
        "bracket-match-meta",
        20,
      ).setAttribute("text-anchor", "end");
    }
    const sideRows: Array<readonly [TournamentBracketSideName, TournamentBracketSide, number]> =
      model.compact
        ? [["home", node.home, node.y + 29], ["away", node.away, node.y + 43]]
        : [["home", node.home, node.y + 37], ["away", node.away, node.y + 65]];
    for (const [sideName, side, baseline] of sideRows) {
      const sideGroup = svgElement("g", {
        class: `bracket-team-row ${side.winner ? "winner" : ""}`.trim(),
        "data-side": sideName,
      });
      if (side.winner) {
        sideGroup.append(svgElement("rect", {
          x: node.x + 1,
          y: baseline - (model.compact ? 11 : 14),
          width: node.width - 2,
          height: model.compact ? 14 : 24,
          class: "bracket-winner-highlight",
        }));
      }
      const prefix = `${side.winner ? "勝 " : ""}${side.primaryLabel}`;
      const hasRightLabel = side.scoreLabel !== undefined || side.bye;
      appendSvgText(
        sideGroup,
        prefix,
        node.x + 7,
        baseline,
        "bracket-team-name",
        hasRightLabel ? (model.compact ? 8 : 10) : model.compact ? 16 : 22,
      );
      if (!model.compact && side.secondaryLabel !== undefined) {
        appendSvgText(
          sideGroup,
          side.secondaryLabel,
          node.x + 7,
          baseline + 10,
          "bracket-team-source",
          27,
        );
      }
      if (side.scoreLabel !== undefined) {
        appendSvgText(
          sideGroup,
          side.scoreLabel,
          node.x + node.width - 7,
          baseline,
          "bracket-score",
          12,
        ).setAttribute("text-anchor", "end");
      } else if (side.bye) {
        appendSvgText(
          sideGroup,
          "予備戦免除",
          node.x + node.width - 7,
          baseline,
          "bracket-bye",
          6,
        ).setAttribute("text-anchor", "end");
      }
      group.append(sideGroup);
    }
    svg.append(group);
    for (const terminal of node.terminals) {
      svg.append(svgElement("path", {
        d: `M ${node.x + node.width} ${terminal.y} H ${terminal.x - 5}`,
        class: `bracket-edge terminal ${terminal.outcome}`,
        "data-source-match-id": node.id,
        "data-rank": terminal.rank,
      }));
      const label = appendSvgText(
        svg,
        terminal.label,
        terminal.x,
        terminal.y + 4,
        `bracket-terminal ${terminal.confirmed ? "confirmed" : terminal.pendingConfirmation ? "pending" : ""}`.trim(),
        model.compact ? 10 : 14,
      );
      label.dataset.rank = String(terminal.rank);
      if (terminal.teamLabel !== undefined) {
        const terminalTitle = svgElement("title");
        terminalTitle.textContent = `${terminal.label}：${terminal.teamLabel}`;
        label.append(terminalTitle);
        if (!model.compact) {
          appendSvgText(
            svg,
            terminal.teamLabel,
            terminal.x,
            terminal.y + 13,
            "bracket-terminal-team",
            14,
          );
        }
      }
    }
  }
  for (const [placementIndex, placement] of model.directPlacements.entries()) {
    const placementY = 40 + placementIndex * 54;
    const group = svgElement("g", {
      class: "bracket-direct-placement",
      "data-rank": placement.rank,
    });
    group.append(svgElement("rect", {
      x: 30,
      y: placementY,
      width: Math.max(260, model.width - 60),
      height: 42,
      rx: 5,
      class: "bracket-match-card",
    }));
    appendSvgText(
      group,
      `${String(placement.rank)}位${placement.confirmed ? "確定" : "・未確定"}：${placement.label}`,
      42,
      placementY + 27,
      "bracket-direct-label",
      40,
    );
    svg.append(group);
  }
  wrapper.append(svg);
  figure.append(wrapper);
  return figure;
}
