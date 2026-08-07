import type { JsonObject } from "./types";
import {
  resolveTournamentProgress,
  type TournamentMatchProgress,
  type TournamentPoolName,
  type TournamentProgress,
} from "./tournament-results";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const SLOT_HEIGHT = 56;
const REGULAR_SLOT_PITCH = 122;
const REGULAR_SLOT_WIDTH = 108;
const COMPACT_SLOT_PITCH = 92;
const COMPACT_SLOT_WIDTH = 80;
const REGULAR_ROW_PITCH = 88;
const COMPACT_ROW_PITCH = 72;
const SHEET_MARGIN_X = 38;
const SHEET_MARGIN_TOP = 112;
const PORT_OFFSET = 14;

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

export interface TournamentBracketBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TournamentBracketNode {
  id: string;
  sheetId: string;
  roundNo: number;
  roundLabel: string;
  displayNumber: string;
  metaLabel?: string;
  resultLabel?: string;
  rankRangeLabel: string;
  x: number;
  y: number;
  width: number;
  height: number;
  homeX: number;
  awayX: number;
  centerX: number;
  lineY: number;
  labelBox: TournamentBracketBox;
  narrow: boolean;
  home: TournamentBracketSide;
  away: TournamentBracketSide;
  terminals: TournamentBracketTerminal[];
}

export interface TournamentBracketSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  ownerId: string;
  role: "match" | "entry" | "winner" | "loser" | "terminal";
}

export interface TournamentBracketEdge {
  sourceMatchId: string;
  targetMatchId: string;
  targetSide: TournamentBracketSideName;
  outcome: TournamentBracketOutcome;
  sourceSheetId: string;
  targetSheetId: string;
  continuation: boolean;
  path: string;
  segments: readonly TournamentBracketSegment[];
  labelX: number;
  labelY: number;
}

export interface TournamentBracketSlot {
  id: string;
  entryKey: string;
  primaryLabel: string;
  secondaryLabel?: string;
  fullLabel: string;
  bye: boolean;
  continuation: boolean;
  continuationLabel?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
}

export interface TournamentBracketContinuation {
  id: string;
  sourceMatchId?: string;
  targetMatchId?: string;
  outcome?: TournamentBracketOutcome;
  label: string;
  x: number;
  y: number;
  direction: "outgoing" | "bye";
}

export interface TournamentBracketDirectPlacement {
  rank: number;
  label: string;
  confirmed: boolean;
  entryKey: string;
}

export interface TournamentBracketSheet {
  id: string;
  title: string;
  kind: "complete" | "opening_overview" | "rank_band";
  rankStart: number;
  rankEnd: number;
  width: number;
  height: number;
  nodes: TournamentBracketNode[];
  edges: TournamentBracketEdge[];
  slots: TournamentBracketSlot[];
  continuations: TournamentBracketContinuation[];
  directPlacements: TournamentBracketDirectPlacement[];
  segments: TournamentBracketSegment[];
}

export interface TournamentBracketReference {
  sourceMatchId: string;
  targetMatchId: string;
  targetSide: TournamentBracketSideName;
  outcome: TournamentBracketOutcome;
  sourceSheetId: string;
  targetSheetId: string;
  continuation: boolean;
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
  sheets: readonly TournamentBracketSheet[];
  references: readonly TournamentBracketReference[];
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
  rangeStart: number;
  rangeEnd: number;
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

interface RankRangeGroup {
  key: string;
  start: number;
  end: number;
  matches: ParsedMatch[];
}

interface PlacementRecord {
  poolRank: number;
  rank: number;
  entry: JsonObject;
  reference?: ParsedReference;
  teamId?: string;
  confirmed: boolean;
  pendingConfirmation: boolean;
}

interface EntryDescription {
  primaryLabel: string;
  secondaryLabel?: string;
  fullLabel: string;
}

interface LayoutContext {
  matchById: ReadonlyMap<string, ParsedMatch>;
  edges: readonly UnpositionedEdge[];
  groupByMatchId: ReadonlyMap<string, RankRangeGroup>;
  describeEntry: (value: unknown) => EntryDescription;
  sideFor: (match: ParsedMatch, side: TournamentBracketSideName) => TournamentBracketSide;
  resultLabelFor: (matchId: string) => string | undefined;
  scheduleByMatchId?: ReadonlyMap<string, TournamentBracketScheduleDetails>;
  placementsByMatch: ReadonlyMap<string, readonly PlacementRecord[]>;
  byeEntryKeys: ReadonlySet<string>;
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

function validateEntry(value: unknown): JsonObject {
  const entry = objectValue(value);
  if (entry === undefined) {
    throw new TournamentBracketError("トーナメントの参加枠を読み取れませんでした。");
  }
  if (entry.type === "concrete_team" && identifier(entry.team_id) !== undefined) return entry;
  if (
    entry.type === "league_rank" &&
    identifier(entry.block_id) !== undefined &&
    positiveInteger(entry.rank) !== undefined
  ) {
    return entry;
  }
  if (
    (entry.type === "winner_of" || entry.type === "loser_of") &&
    identifier(entry.match_id) !== undefined
  ) {
    return entry;
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

function rangeKey(start: number, end: number): string {
  return `${String(start)}:${String(end)}`;
}

function rangeLabel(start: number, end: number): string {
  return start === end ? `${String(start)}位` : `${String(start)}〜${String(end)}位`;
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

function compactEntryLabel(
  entry: JsonObject,
  scheduleByMatchId: TournamentBracketInput["scheduleByMatchId"],
): string | undefined {
  if (
    entry.type === "league_rank" &&
    typeof entry.block_id === "string" &&
    positiveInteger(entry.rank) !== undefined
  ) {
    return `${entry.block_id}${String(entry.rank)}位`;
  }
  if (entry.type === "winner_of" && typeof entry.match_id === "string") {
    return `${scheduleMatchLabel(entry.match_id, scheduleByMatchId)}勝`;
  }
  if (entry.type === "loser_of" && typeof entry.match_id === "string") {
    return `${scheduleMatchLabel(entry.match_id, scheduleByMatchId)}敗`;
  }
  return undefined;
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

function scoreLabel(progress: TournamentMatchProgress | undefined, side: TournamentBracketSideName): string | undefined {
  const result = progress?.result;
  if (result === undefined) return undefined;
  const regular = side === "home" ? result.regular_score_home : result.regular_score_away;
  const penalty = side === "home" ? result.penalty_score_home : result.penalty_score_away;
  return `${String(regular)}${penalty === undefined ? "" : ` (PK ${String(penalty)})`}`;
}

function combinedScoreLabel(progress: TournamentMatchProgress | undefined): string | undefined {
  const result = progress?.result;
  if (result === undefined) return undefined;
  const regular = `${String(result.regular_score_home)} - ${String(result.regular_score_away)}`;
  return result.penalty_score_home === undefined
    ? regular
    : `${regular}（PK ${String(result.penalty_score_home)}-${String(result.penalty_score_away)}）`;
}

function pathFromSegments(segments: readonly TournamentBracketSegment[]): string {
  if (segments.length === 0) return "";
  const first = segments[0]!;
  let path = `M ${String(first.x1)} ${String(first.y1)}`;
  for (const segment of segments) {
    path += segment.x1 === segment.x2
      ? ` V ${String(segment.y2)}`
      : ` H ${String(segment.x2)}`;
  }
  return path;
}

function expandEntry(
  value: unknown,
  matchById: ReadonlyMap<string, ParsedMatch>,
  allowedMatchIds: ReadonlySet<string>,
  visiting = new Set<string>(),
): JsonObject[] {
  const entry = validateEntry(value);
  const reference = parsedReference(entry);
  if (reference === undefined || !allowedMatchIds.has(reference.sourceMatchId)) return [entry];
  if (visiting.has(reference.sourceMatchId)) {
    throw new TournamentBracketError("トーナメントの試合参照が循環しています。");
  }
  const source = matchById.get(reference.sourceMatchId);
  if (source === undefined) {
    throw new TournamentBracketError(`参照先の試合「${reference.sourceMatchId}」が見つかりません。`);
  }
  const nextVisiting = new Set(visiting);
  nextVisiting.add(reference.sourceMatchId);
  return [
    ...expandEntry(source.raw.home, matchById, allowedMatchIds, nextVisiting),
    ...expandEntry(source.raw.away, matchById, allowedMatchIds, nextVisiting),
  ];
}

function uniqueEntries(entries: readonly JsonObject[]): JsonObject[] {
  const seen = new Set<string>();
  const result: JsonObject[] = [];
  for (const entry of entries) {
    const key = entryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function groupsInDependencyOrder(
  root: RankRangeGroup,
  matches: readonly ParsedMatch[],
  edges: readonly UnpositionedEdge[],
  groupByMatchId: ReadonlyMap<string, RankRangeGroup>,
): { upper: RankRangeGroup[]; lower: RankRangeGroup[] } {
  const matchIds = new Set(matches.map((match) => match.id));
  const children = new Map<string, Array<{ group: RankRangeGroup; outcome: TournamentBracketOutcome }>>();
  for (const edge of edges) {
    if (!matchIds.has(edge.sourceMatchId) || !matchIds.has(edge.targetMatchId)) continue;
    const sourceGroup = groupByMatchId.get(edge.sourceMatchId)!;
    const targetGroup = groupByMatchId.get(edge.targetMatchId)!;
    if (sourceGroup.key === targetGroup.key) continue;
    const current = children.get(sourceGroup.key) ?? [];
    if (!current.some((item) => item.group.key === targetGroup.key)) {
      current.push({ group: targetGroup, outcome: edge.outcome });
      current.sort(
        (left, right) =>
          (left.outcome === "winner" ? 0 : 1) - (right.outcome === "winner" ? 0 : 1) ||
          left.group.start - right.group.start,
      );
      children.set(sourceGroup.key, current);
    }
  }
  const roots = children.get(root.key) ?? [];
  const postOrder = (group: RankRangeGroup, output: RankRangeGroup[]): void => {
    for (const child of children.get(group.key) ?? []) postOrder(child.group, output);
    output.push(group);
  };
  const preOrder = (group: RankRangeGroup, output: RankRangeGroup[]): void => {
    output.push(group);
    for (const child of [...(children.get(group.key) ?? [])].reverse()) {
      preOrder(child.group, output);
    }
  };
  const upper: RankRangeGroup[] = [];
  const lower: RankRangeGroup[] = [];
  for (const child of roots) {
    if (child.outcome === "winner") postOrder(child.group, upper);
    else preOrder(child.group, lower);
  }
  const positioned = new Set([root.key, ...upper.map((group) => group.key), ...lower.map((group) => group.key)]);
  const remaining = new Set(matches.map((match) => groupByMatchId.get(match.id)!.key));
  if ([...remaining].some((key) => !positioned.has(key))) {
    throw new TournamentBracketError("順位帯の勝者側・敗者側の配置を決定できませんでした。");
  }
  return { upper, lower };
}

function boxesOverlap(left: TournamentBracketBox, right: TournamentBracketBox): boolean {
  return left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y;
}

function validateSheetGeometry(sheet: TournamentBracketSheet): void {
  const inside = (box: TournamentBracketBox): boolean =>
    box.x >= 0 && box.y >= 0 && box.x + box.width <= sheet.width && box.y + box.height <= sheet.height;
  for (const slot of sheet.slots) {
    if (!inside(slot)) throw new TournamentBracketError("参加枠が図の表示範囲外へ配置されました。");
  }
  for (const node of sheet.nodes) {
    if (!inside(node.labelBox)) {
      throw new TournamentBracketError("試合情報が図の表示範囲外へ配置されました。");
    }
  }
  for (const [index, slot] of sheet.slots.entries()) {
    for (const other of sheet.slots.slice(index + 1)) {
      if (boxesOverlap(slot, other)) {
        throw new TournamentBracketError("参加枠が重なって配置されました。");
      }
    }
  }
  for (const [index, node] of sheet.nodes.entries()) {
    for (const other of sheet.nodes.slice(index + 1)) {
      if (boxesOverlap(node.labelBox, other.labelBox)) {
        throw new TournamentBracketError(
          `試合情報が重なって配置されました（${node.id} ${String(node.centerX)},${String(node.lineY)} / ${other.id} ${String(other.centerX)},${String(other.lineY)}）。`,
        );
      }
    }
  }
  for (const segment of sheet.segments) {
    if (
      Math.min(segment.x1, segment.x2) < 0 ||
      Math.max(segment.x1, segment.x2) > sheet.width ||
      Math.min(segment.y1, segment.y2) < 0 ||
      Math.max(segment.y1, segment.y2) > sheet.height
    ) {
      throw new TournamentBracketError(
        `進行線が図の表示範囲外へ配置されました（${segment.ownerId}: ${String(segment.x1)},${String(segment.y1)} → ${String(segment.x2)},${String(segment.y2)} / ${String(sheet.width)}×${String(sheet.height)}）。`,
      );
    }
  }
}

function rerouteEdgesAroundMatchLines(sheet: TournamentBracketSheet): void {
  const matchSegments = sheet.segments.filter((segment) => segment.role === "match");
  sheet.segments = sheet.segments.filter(
    (segment) => segment.role !== "winner" && segment.role !== "loser",
  );
  const nodeById = new Map(sheet.nodes.map((node) => [node.id, node]));
  const routedSegments: TournamentBracketSegment[] = [];
  for (const edge of sheet.edges) {
    const source = nodeById.get(edge.sourceMatchId)!;
    const target = nodeById.get(edge.targetMatchId)!;
    const targetX = edge.targetSide === "home" ? target.homeX : target.awayX;
    const minimumY = Math.min(source.lineY, target.lineY);
    const maximumY = Math.max(source.lineY, target.lineY);
    const forbidden = matchSegments
      .filter(
        (segment) =>
          segment.ownerId !== source.id &&
          segment.ownerId !== target.id &&
          minimumY < segment.y1 &&
          segment.y1 < maximumY,
      )
      .map((segment) => ({
        start: Math.min(segment.x1, segment.x2) - 7,
        end: Math.max(segment.x1, segment.x2) + 7,
      }));
    for (const slot of sheet.slots) {
      if (slot.y < maximumY && minimumY < slot.y + slot.height) {
        forbidden.push({ start: slot.x - 7, end: slot.x + slot.width + 7 });
      }
    }
    const routedHorizontal = routedSegments.filter((segment) => segment.y1 === segment.y2);
    const routedVertical = [
      ...sheet.segments.filter(
        (segment) => segment.role === "entry" && segment.x1 === segment.x2,
      ),
      ...routedSegments.filter((segment) => segment.x1 === segment.x2),
    ];
    const crossesRoutedVertical = (fromX: number, toX: number, y: number): boolean =>
      routedVertical.some((segment) => {
        const minimumX = Math.min(fromX, toX);
        const maximumX = Math.max(fromX, toX);
        const segmentMinimumY = Math.min(segment.y1, segment.y2);
        const segmentMaximumY = Math.max(segment.y1, segment.y2);
        return minimumX < segment.x1 && segment.x1 < maximumX &&
          segmentMinimumY < y && y < segmentMaximumY;
      });
    const available = (x: number): boolean =>
      12 <= x && x <= sheet.width - 12 &&
      forbidden.every((interval) => x <= interval.start || interval.end <= x) &&
      routedHorizontal.every((segment) => {
        const segmentMinimumX = Math.min(segment.x1, segment.x2);
        const segmentMaximumX = Math.max(segment.x1, segment.x2);
        return !(minimumY < segment.y1 && segment.y1 < maximumY) ||
          x <= segmentMinimumX || segmentMaximumX <= x;
      }) &&
      !crossesRoutedVertical(source.centerX, x, source.lineY) &&
      !crossesRoutedVertical(x, targetX, target.lineY);
    const candidates = [
      source.centerX,
      targetX,
      ...forbidden.flatMap((interval) => [interval.start, interval.end]),
      ...Array.from(
        { length: Math.max(0, Math.floor((sheet.width - 24) / 7) + 1) },
        (_value, index) => 12 + index * 7,
      ),
      12,
      sheet.width - 12,
    ].filter(available);
    const laneX = candidates.sort(
      (left, right) =>
        Math.abs(left - source.centerX) - Math.abs(right - source.centerX) || left - right,
    )[0];
    const segments: TournamentBracketSegment[] = [];
    const ownerId = `${source.id}:${edge.outcome}`;
    if (laneX === undefined) {
      if (source.lineY !== target.lineY) {
        segments.push({
          x1: source.centerX,
          y1: source.lineY,
          x2: source.centerX,
          y2: target.lineY,
          ownerId,
          role: edge.outcome,
        });
      }
      if (source.centerX !== targetX) {
        segments.push({
          x1: source.centerX,
          y1: target.lineY,
          x2: targetX,
          y2: target.lineY,
          ownerId,
          role: edge.outcome,
        });
      }
      edge.segments = segments;
      edge.path = pathFromSegments(segments);
      edge.labelX = (source.centerX + targetX) / 2;
      edge.labelY = target.lineY - 5;
      sheet.segments.push(...segments);
      routedSegments.push(...segments);
      continue;
    }
    if (source.centerX !== laneX) {
      segments.push({
        x1: source.centerX,
        y1: source.lineY,
        x2: laneX,
        y2: source.lineY,
        ownerId,
        role: edge.outcome,
      });
    }
    segments.push({
      x1: laneX,
      y1: source.lineY,
      x2: laneX,
      y2: target.lineY,
      ownerId,
      role: edge.outcome,
    });
    if (laneX !== targetX) {
      segments.push({
        x1: laneX,
        y1: target.lineY,
        x2: targetX,
        y2: target.lineY,
        ownerId,
        role: edge.outcome,
      });
    }
    edge.segments = segments;
    edge.path = pathFromSegments(segments);
    edge.labelX = laneX + (laneX < target.centerX ? -13 : 6);
    edge.labelY = source.lineY + (target.lineY < source.lineY ? -5 : 13);
    sheet.segments.push(...segments);
    routedSegments.push(...segments);
  }
}

function layoutSheet(
  specification: {
    id: string;
    title: string;
    kind: TournamentBracketSheet["kind"];
    rankStart: number;
    rankEnd: number;
    matches: readonly ParsedMatch[];
    leafEntries: readonly JsonObject[];
    directPlacements: readonly TournamentBracketDirectPlacement[];
  },
  context: LayoutContext,
): TournamentBracketSheet {
  const sheet: TournamentBracketSheet = {
    id: specification.id,
    title: specification.title,
    kind: specification.kind,
    rankStart: specification.rankStart,
    rankEnd: specification.rankEnd,
    width: 360,
    height: 220,
    nodes: [],
    edges: [],
    slots: [],
    continuations: [],
    directPlacements: [...specification.directPlacements],
    segments: [],
  };
  const matchIds = new Set(specification.matches.map((match) => match.id));
  const leafEntries = uniqueEntries(specification.leafEntries);
  const compactLayout = leafEntries.length > 8;
  const slotPitch = compactLayout ? COMPACT_SLOT_PITCH : REGULAR_SLOT_PITCH;
  const slotWidth = compactLayout ? COMPACT_SLOT_WIDTH : REGULAR_SLOT_WIDTH;
  const rowPitch = compactLayout ? COMPACT_ROW_PITCH : REGULAR_ROW_PITCH;
  const nodeLabelWidth = compactLayout ? 150 : 200;
  sheet.width = Math.max(
    360,
    SHEET_MARGIN_X * 2 + Math.max(1, leafEntries.length - 1) * slotPitch + slotWidth,
  );
  const entryX = new Map<string, number>();
  const slotYByEntryKey = new Map<string, number>();
  for (const [index, entry] of leafEntries.entries()) {
    entryX.set(entryKey(entry), SHEET_MARGIN_X + slotWidth / 2 + index * slotPitch);
  }

  if (specification.matches.length === 0) {
    const slotY = 72;
    for (const entry of leafEntries) {
      const description = context.describeEntry(entry);
      const centerX = entryX.get(entryKey(entry))!;
      sheet.slots.push({
        id: `${sheet.id}-slot-${String(sheet.slots.length + 1)}`,
        entryKey: entryKey(entry),
        ...description,
        bye: context.byeEntryKeys.has(entryKey(entry)),
        continuation: parsedReference(entry) !== undefined,
        x: centerX - slotWidth / 2,
        y: slotY,
        width: slotWidth,
        height: SLOT_HEIGHT,
        centerX,
      });
    }
    sheet.height = 190;
    validateSheetGeometry(sheet);
    return sheet;
  }

  const root = specification.matches
    .map((match) => context.groupByMatchId.get(match.id)!)
    .find(
      (group) => group.start === specification.rankStart && group.end === specification.rankEnd,
    );
  if (root === undefined) {
    throw new TournamentBracketError("順位帯の起点となる試合を読み取れませんでした。");
  }
  const { upper, lower } = groupsInDependencyOrder(
    root,
    specification.matches,
    context.edges,
    context.groupByMatchId,
  );
  const rootY = SHEET_MARGIN_TOP + upper.length * rowPitch;
  const slotY = rootY + 24;
  const lowerStartY = slotY + SLOT_HEIGHT + 72;
  const yByGroup = new Map<string, number>([[root.key, rootY]]);
  for (const [index, group] of upper.entries()) {
    yByGroup.set(group.key, SHEET_MARGIN_TOP + index * rowPitch);
  }
  for (const [index, group] of lower.entries()) {
    yByGroup.set(group.key, lowerStartY + index * rowPitch);
  }
  sheet.height = Math.max(
    slotY + SLOT_HEIGHT + 64,
    (lower.length === 0 ? lowerStartY : lowerStartY + (lower.length - 1) * rowPitch) + 72,
  );

  for (const entry of leafEntries) {
    const description = context.describeEntry(entry);
    const centerX = entryX.get(entryKey(entry))!;
    slotYByEntryKey.set(entryKey(entry), slotY);
    sheet.slots.push({
      id: `${sheet.id}-slot-${String(sheet.slots.length + 1)}`,
      entryKey: entryKey(entry),
      ...description,
      bye: context.byeEntryKeys.has(entryKey(entry)),
      continuation: parsedReference(entry) !== undefined,
      x: centerX - slotWidth / 2,
      y: slotY,
      width: slotWidth,
      height: SLOT_HEIGHT,
      centerX,
    });
  }

  const nodeById = new Map<string, TournamentBracketNode>();
  const sortedMatches = [...specification.matches].sort(
    (left, right) => left.roundNo - right.roundNo || left.inputIndex - right.inputIndex || left.id.localeCompare(right.id),
  );
  const rawInputX = (value: unknown): number => {
    const reference = parsedReference(value);
    if (reference !== undefined && matchIds.has(reference.sourceMatchId)) {
      const source = nodeById.get(reference.sourceMatchId);
      if (source === undefined) {
        throw new TournamentBracketError("試合の前後関係に沿って進行線を配置できませんでした。");
      }
      return source.centerX;
    }
    const valueX = entryX.get(entryKey(value));
    if (valueX === undefined) {
      throw new TournamentBracketError("順位帯ページの参加枠が不足しています。");
    }
    return valueX;
  };
  for (const match of sortedMatches) {
    const group = context.groupByMatchId.get(match.id)!;
    const lineY = yByGroup.get(group.key);
    if (lineY === undefined) {
      throw new TournamentBracketError("順位帯の試合位置を決定できませんでした。");
    }
    const rawHomeX = rawInputX(match.raw.home);
    const rawAwayX = rawInputX(match.raw.away);
    const pairCenter = (rawHomeX + rawAwayX) / 2;
    const adjustedInputX = (value: unknown, rawX: number): number => {
      const reference = parsedReference(value);
      if (reference === undefined || !matchIds.has(reference.sourceMatchId) || rawHomeX === rawAwayX) {
        return rawX;
      }
      const direction = rawX < pairCenter ? -1 : 1;
      return reference.outcome === "winner"
        ? rawX + direction * PORT_OFFSET
        : rawX - direction * PORT_OFFSET;
    };
    const homeX = adjustedInputX(match.raw.home, rawHomeX);
    const awayX = adjustedInputX(match.raw.away, rawAwayX);
    const centerX = (homeX + awayX) / 2;
    const schedule = context.scheduleByMatchId?.get(match.id);
    const home = context.sideFor(match, "home");
    const away = context.sideFor(match, "away");
    const node: TournamentBracketNode = {
      id: match.id,
      sheetId: sheet.id,
      roundNo: match.roundNo,
      roundLabel: match.roundLabel,
      displayNumber: schedule?.displayNumber ?? match.id,
      ...(schedule === undefined ? {} : { metaLabel: `${schedule.timeLabel} ${schedule.courtName}` }),
      ...(context.resultLabelFor(match.id) === undefined
        ? {}
        : { resultLabel: context.resultLabelFor(match.id) }),
      rankRangeLabel: rangeLabel(match.rangeStart, match.rangeEnd),
      x: centerX - nodeLabelWidth / 2,
      y: lineY - 49,
      width: nodeLabelWidth,
      height: 68,
      homeX,
      awayX,
      centerX,
      lineY,
      labelBox: {
        x: centerX - nodeLabelWidth / 2,
        y: lineY - 52,
        width: nodeLabelWidth,
        height: 72,
      },
      narrow: false,
      home,
      away,
      terminals: [],
    };
    node.terminals = [...(context.placementsByMatch.get(match.id) ?? [])]
      .sort((left, right) => left.rank - right.rank)
      .map((placement, index) => {
        const champion = placement.poolRank === 1;
        const x = champion
          ? centerX
          : Math.max(28, Math.min(sheet.width - 28, index === 0
            ? Math.min(homeX, awayX) - 34
            : Math.max(homeX, awayX) + 34));
        const y = champion ? lineY - 78 : lineY;
        const state = placement.confirmed
          ? "確定"
          : placement.pendingConfirmation
            ? "・未確定"
            : "";
        return {
          outcome: placement.reference!.outcome,
          rank: placement.rank,
          label: `${String(placement.rank)}位${state}`,
          ...(placement.teamId === undefined
            ? {}
            : { teamLabel: context.describeEntry(placement.entry).primaryLabel }),
          confirmed: placement.confirmed,
          pendingConfirmation: placement.pendingConfirmation,
          x,
          y,
        };
      });
    sheet.nodes.push(node);
    nodeById.set(node.id, node);
    sheet.segments.push({
      x1: homeX,
      y1: lineY,
      x2: awayX,
      y2: lineY,
      ownerId: match.id,
      role: "match",
    });

    for (const [sideName, value, targetX] of [
      ["home", match.raw.home, homeX],
      ["away", match.raw.away, awayX],
    ] as const) {
      const reference = parsedReference(value);
      if (reference !== undefined && matchIds.has(reference.sourceMatchId)) {
        const source = nodeById.get(reference.sourceMatchId)!;
        const segments: TournamentBracketSegment[] = [];
        if (source.centerX !== targetX) {
          segments.push({
            x1: source.centerX,
            y1: source.lineY,
            x2: targetX,
            y2: source.lineY,
            ownerId: `${source.id}:${reference.outcome}`,
            role: reference.outcome,
          });
        }
        segments.push({
          x1: targetX,
          y1: source.lineY,
          x2: targetX,
          y2: lineY,
          ownerId: `${source.id}:${reference.outcome}`,
          role: reference.outcome,
        });
        const edge: TournamentBracketEdge = {
          sourceMatchId: source.id,
          targetMatchId: match.id,
          targetSide: sideName,
          outcome: reference.outcome,
          sourceSheetId: sheet.id,
          targetSheetId: sheet.id,
          continuation: false,
          path: pathFromSegments(segments),
          segments,
          labelX: targetX + (targetX < centerX ? -13 : 6),
          labelY: source.lineY + (lineY < source.lineY ? -5 : 13),
        };
        sheet.edges.push(edge);
        sheet.segments.push(...segments);
      } else {
        const key = entryKey(value);
        const sourceX = entryX.get(key)!;
        const sourceY = slotYByEntryKey.get(key)!;
        if (sourceX !== targetX) {
          sheet.segments.push({
            x1: sourceX,
            y1: sourceY,
            x2: targetX,
            y2: sourceY,
            ownerId: `${match.id}:${sideName}:entry`,
            role: "entry",
          });
        }
        sheet.segments.push({
          x1: targetX,
          y1: sourceY,
          x2: targetX,
          y2: lineY,
          ownerId: `${match.id}:${sideName}:entry`,
          role: "entry",
        });
      }
    }
    for (const terminal of node.terminals) {
      if (terminal.y !== lineY) {
        sheet.segments.push({
          x1: centerX,
          y1: lineY,
          x2: terminal.x,
          y2: terminal.y,
          ownerId: `${match.id}:rank:${String(terminal.rank)}`,
          role: "terminal",
        });
      }
    }
  }
  for (const node of sheet.nodes) {
    const nearestDistance = Math.min(
      ...sheet.nodes
        .filter((other) => other.id !== node.id && other.lineY === node.lineY)
        .map((other) => Math.abs(other.centerX - node.centerX)),
      Number.POSITIVE_INFINITY,
    );
    const availableWidth = Number.isFinite(nearestDistance)
      ? Math.max(72, nearestDistance - 8)
      : node.width;
    if (availableWidth < node.width) {
      node.width = availableWidth;
      node.x = node.centerX - availableWidth / 2;
      node.labelBox = {
        ...node.labelBox,
        x: node.x,
        width: availableWidth,
      };
      node.narrow = availableWidth < 120;
    }
  }
  rerouteEdgesAroundMatchLines(sheet);
  validateSheetGeometry(sheet);
  return sheet;
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
    const rankRange = Array.isArray(raw.rank_range) ? raw.rank_range : [];
    const rangeStart = positiveInteger(rankRange[0]);
    const rangeEnd = positiveInteger(rankRange[1]);
    if (
      id === undefined ||
      roundNo === undefined ||
      rangeStart === undefined ||
      rangeEnd === undefined ||
      rangeStart > rangeEnd ||
      rangeEnd > participantCount
    ) {
      throw new TournamentBracketError("トーナメントの試合ID、段階または順位帯を読み取れませんでした。");
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
      rangeStart,
      rangeEnd,
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
        throw new TournamentBracketError(`参照先の試合「${reference.sourceMatchId}」が見つかりません。`);
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

  const groupsByKey = new Map<string, RankRangeGroup>();
  const groupByMatchId = new Map<string, RankRangeGroup>();
  for (const match of parsedMatches) {
    const key = rangeKey(match.rangeStart, match.rangeEnd);
    const group = groupsByKey.get(key) ?? {
      key,
      start: match.rangeStart,
      end: match.rangeEnd,
      matches: [],
    };
    group.matches.push(match);
    groupsByKey.set(key, group);
    groupByMatchId.set(match.id, group);
  }
  const groups = [...groupsByKey.values()];
  for (const [index, group] of groups.entries()) {
    for (const other of groups.slice(index + 1)) {
      const overlaps = group.start <= other.end && other.start <= group.end;
      const nested =
        (group.start <= other.start && other.end <= group.end) ||
        (other.start <= group.start && group.end <= other.end);
      if (overlaps && !nested) {
        throw new TournamentBracketError("順位帯が交差するトーナメント試合があります。");
      }
    }
  }
  for (const edge of edges) {
    const source = groupByMatchId.get(edge.sourceMatchId)!;
    const target = groupByMatchId.get(edge.targetMatchId)!;
    if (
      target.start < source.start ||
      target.end > source.end ||
      (target.start === source.start && target.end === source.end)
    ) {
      throw new TournamentBracketError(
        `順位帯の包含関係が不正な試合参照があります（${edge.sourceMatchId} ${source.key} → ${edge.targetMatchId} ${target.key}）。`,
      );
    }
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
  const describeEntry = (value: unknown): EntryDescription => {
    const entry = objectValue(value);
    if (entry === undefined) return { primaryLabel: "対戦結果で決定", fullLabel: "対戦結果で決定" };
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
    return {
      primaryLabel: compactEntryLabel(entry, input.scheduleByMatchId) ?? unresolved,
      fullLabel: unresolved,
    };
  };

  const byeEntryKeys = new Set<string>();
  for (const bye of objectArray(pool.byes)) {
    const nextMatchId = identifier(bye.next_match_id);
    if (nextMatchId === undefined || !matchById.has(nextMatchId)) {
      throw new TournamentBracketError("不戦通過の進行先を読み取れませんでした。");
    }
    const entry = validateEntry(bye.entry);
    const nextMatch = matchById.get(nextMatchId)!;
    const key = entryKey(entry);
    const sides = (["home", "away"] as const).filter(
      (side) => entryKey(nextMatch.raw[side]) === key,
    );
    if (sides.length !== 1) {
      throw new TournamentBracketError("不戦通過の参加枠と進行先が一致しません。");
    }
    byeEntryKeys.add(key);
  }

  const finalTeams = finalTeamByPoolRank(input.finalStandings, input.pool);
  const upperCount = nonNegativeInteger(objectValue(input.plan.upper)?.participant_count) ?? 0;
  const overallRank = (poolRank: number): number =>
    input.pool === "upper" ? poolRank : upperCount + poolRank;
  const placements: PlacementRecord[] = [];
  const placementRanks = new Set<number>();
  for (const placement of objectArray(pool.placements)) {
    const poolRank = positiveInteger(placement.rank);
    if (poolRank === undefined || poolRank > participantCount || placementRanks.has(poolRank)) {
      throw new TournamentBracketError("最終順位を読み取れませんでした。");
    }
    placementRanks.add(poolRank);
    const entry = validateEntry(placement.entry);
    const reference = parsedReference(entry);
    if (reference !== undefined && !matchById.has(reference.sourceMatchId)) {
      throw new TournamentBracketError(`最終順位が未知の試合「${reference.sourceMatchId}」を参照しています。`);
    }
    const confirmedTeamId = finalTeams.get(poolRank);
    const teamId = confirmedTeamId ?? teamForEntry(entry);
    placements.push({
      poolRank,
      rank: overallRank(poolRank),
      entry,
      ...(reference === undefined ? {} : { reference }),
      ...(teamId === undefined ? {} : { teamId }),
      confirmed: confirmedTeamId !== undefined,
      pendingConfirmation: progress?.complete === true && confirmedTeamId === undefined,
    });
  }
  if (placementRanks.size !== participantCount) {
    throw new TournamentBracketError("トーナメントの最終順位枠に不足があります。");
  }
  const placementsByMatch = new Map<string, PlacementRecord[]>();
  for (const placement of placements) {
    if (placement.reference === undefined) continue;
    const list = placementsByMatch.get(placement.reference.sourceMatchId) ?? [];
    list.push(placement);
    placementsByMatch.set(placement.reference.sourceMatchId, list);
  }
  const directPlacement = (placement: PlacementRecord): TournamentBracketDirectPlacement => ({
    rank: placement.rank,
    label: placement.teamId === undefined
      ? describeEntry(placement.entry).fullLabel
      : fullTeamLabel(placement.teamId, input.teamNames),
    confirmed: placement.confirmed,
    entryKey: entryKey(placement.entry),
  });
  const sideFor = (match: ParsedMatch, side: TournamentBracketSideName): TournamentBracketSide => {
    const description = describeEntry(match.raw[side]);
    const matchProgress = progressForMatch(progress, match.id);
    return {
      ...description,
      ...(scoreLabel(matchProgress, side) === undefined
        ? {}
        : { scoreLabel: scoreLabel(matchProgress, side) }),
      winner: matchProgress?.winner === side,
      bye: byeEntryKeys.has(entryKey(match.raw[side])),
    };
  };
  const context: LayoutContext = {
    matchById,
    edges,
    groupByMatchId,
    describeEntry,
    sideFor,
    resultLabelFor: (matchId) => combinedScoreLabel(progressForMatch(progress, matchId)),
    ...(input.scheduleByMatchId === undefined ? {} : { scheduleByMatchId: input.scheduleByMatchId }),
    placementsByMatch,
    byeEntryKeys,
  };

  if (participantCount === 0) {
    return {
      pool: input.pool,
      participantCount,
      provisional,
      compact: false,
      width: 360,
      height: 160,
      nodes: [],
      edges: [],
      sheets: [],
      references: [],
      directPlacements: [],
      emptyMessage: "該当チームなし",
    };
  }

  const placementByPoolRank = new Map(placements.map((placement) => [placement.poolRank, placement]));
  const anchorEntries = (
    rankStart: number,
    allowedMatchIds: ReadonlySet<string>,
  ): JsonObject[] => {
    const anchor = placementByPoolRank.get(rankStart);
    if (anchor === undefined) {
      throw new TournamentBracketError("順位帯の先頭順位を読み取れませんでした。");
    }
    return uniqueEntries(expandEntry(anchor.entry, matchById, allowedMatchIds));
  };

  const sheets: TournamentBracketSheet[] = [];
  const allMatchIds = new Set(parsedMatches.map((match) => match.id));
  if (participantCount <= 16) {
    const leafEntries = anchorEntries(1, allMatchIds);
    if (leafEntries.length !== participantCount) {
      throw new TournamentBracketError("初戦の参加枠を全チーム分たどれませんでした。");
    }
    sheets.push(layoutSheet({
      id: `${input.pool}-complete`,
      title: `${rangeLabel(overallRank(1), overallRank(participantCount))}・全体`,
      kind: "complete",
      rankStart: 1,
      rankEnd: participantCount,
      matches: parsedMatches,
      leafEntries,
      directPlacements: placements.filter((placement) => placement.reference === undefined).map(directPlacement),
    }, context));
  } else {
    const root = groupsByKey.get(rangeKey(1, participantCount));
    if (root === undefined) {
      throw new TournamentBracketError("初戦の順位帯を読み取れませんでした。");
    }
    const rootMatchIds = new Set(root.matches.map((match) => match.id));
    const fullLeafEntries = anchorEntries(1, allMatchIds);
    if (fullLeafEntries.length !== participantCount) {
      throw new TournamentBracketError("初戦の参加枠を全チーム分たどれませんでした。");
    }
    const leafIndex = new Map(fullLeafEntries.map((entry, index) => [entryKey(entry), index]));
    const rootItems: Array<{ matches: ParsedMatch[]; entries: JsonObject[]; order: number }> = root.matches.map((match) => {
      const entries = [validateEntry(match.raw.home), validateEntry(match.raw.away)];
      return {
        matches: [match],
        entries,
        order: Math.min(...entries.map((entry) => leafIndex.get(entryKey(entry)) ?? Number.MAX_SAFE_INTEGER)),
      };
    });
    const rootInputKeys = new Set(rootItems.flatMap((item) => item.entries.map(entryKey)));
    for (const entry of fullLeafEntries) {
      if (!rootInputKeys.has(entryKey(entry))) {
        rootItems.push({ matches: [], entries: [entry], order: leafIndex.get(entryKey(entry))! });
      }
    }
    rootItems.sort((left, right) => left.order - right.order);
    let chunk: typeof rootItems = [];
    let chunkSize = 0;
    const flushChunk = (): void => {
      if (chunk.length === 0) return;
      const sheetNumber = sheets.length + 1;
      const matches = chunk.flatMap((item) => item.matches);
      const entries = chunk.flatMap((item) => item.entries);
      const rangeStart = 1;
      const rangeEnd = participantCount;
      sheets.push(layoutSheet({
        id: `${input.pool}-opening-${String(sheetNumber)}`,
        title: `初戦概要 ${String(sheetNumber)}`,
        kind: "opening_overview",
        rankStart: rangeStart,
        rankEnd: rangeEnd,
        matches,
        leafEntries: entries,
        directPlacements: [],
      }, context));
      chunk = [];
      chunkSize = 0;
    };
    for (const item of rootItems) {
      if (chunkSize + item.entries.length > 16) flushChunk();
      chunk.push(item);
      chunkSize += item.entries.length;
    }
    flushChunk();

    const childGroups = new Map<string, RankRangeGroup>();
    for (const edge of edges) {
      if (!rootMatchIds.has(edge.sourceMatchId)) continue;
      const group = groupByMatchId.get(edge.targetMatchId)!;
      childGroups.set(group.key, group);
    }
    const descendantGroups = (group: RankRangeGroup): RankRangeGroup[] =>
      groups.filter(
        (candidate) =>
          group.start <= candidate.start && candidate.end <= group.end,
      );
    const maximalChildGroups = [...childGroups.values()].filter(
      (candidate) =>
        ![...childGroups.values()].some(
          (other) =>
            other.key !== candidate.key &&
            other.start <= candidate.start &&
            candidate.end <= other.end,
        ),
    );
    for (const group of maximalChildGroups.sort((left, right) => left.start - right.start)) {
      const selectedGroups = descendantGroups(group);
      const matches = selectedGroups.flatMap((candidate) => candidate.matches);
      const selectedIds = new Set(matches.map((match) => match.id));
      const leafEntries = anchorEntries(group.start, selectedIds);
      if (leafEntries.length > 16) {
        throw new TournamentBracketError("順位帯ページの参加枠が16を超えました。");
      }
      sheets.push(layoutSheet({
        id: `${input.pool}-rank-${String(group.start)}-${String(group.end)}`,
        title: `${rangeLabel(overallRank(group.start), overallRank(group.end))}決定`,
        kind: "rank_band",
        rankStart: group.start,
        rankEnd: group.end,
        matches,
        leafEntries,
        directPlacements: placements
          .filter(
            (placement) =>
              placement.reference === undefined &&
              group.start <= placement.poolRank &&
              placement.poolRank <= group.end,
          )
          .map(directPlacement),
      }, context));
    }
    const coveredPlacementRanks = new Set(
      maximalChildGroups.flatMap((group) =>
        placements
          .filter((placement) => group.start <= placement.poolRank && placement.poolRank <= group.end)
          .map((placement) => placement.poolRank)
      ),
    );
    for (const placement of placements.filter((item) => !coveredPlacementRanks.has(item.poolRank))) {
      if (placement.reference === undefined || !rootMatchIds.has(placement.reference.sourceMatchId)) continue;
      sheets.push(layoutSheet({
        id: `${input.pool}-rank-${String(placement.poolRank)}`,
        title: `${String(placement.rank)}位決定`,
        kind: "rank_band",
        rankStart: placement.poolRank,
        rankEnd: placement.poolRank,
        matches: [],
        leafEntries: [placement.entry],
        directPlacements: [directPlacement(placement)],
      }, context));
    }
  }

  const sheetByMatchId = new Map<string, TournamentBracketSheet>();
  for (const sheet of sheets) {
    for (const node of sheet.nodes) {
      if (sheetByMatchId.has(node.id)) {
        throw new TournamentBracketError(`試合「${node.id}」が複数ページへ配置されました。`);
      }
      sheetByMatchId.set(node.id, sheet);
    }
  }
  if (sheetByMatchId.size !== parsedMatches.length) {
    throw new TournamentBracketError("すべての試合をブラケットページへ配置できませんでした。");
  }
  const references: TournamentBracketReference[] = edges.map((edge) => {
    const sourceSheet = sheetByMatchId.get(edge.sourceMatchId)!;
    const targetSheet = sheetByMatchId.get(edge.targetMatchId)!;
    const continuation = sourceSheet.id !== targetSheet.id;
    if (continuation) {
      const sourceNode = sourceSheet.nodes.find((node) => node.id === edge.sourceMatchId)!;
      const targetRange = rangeLabel(overallRank(targetSheet.rankStart), overallRank(targetSheet.rankEnd));
      const displayNumber = scheduleMatchLabel(edge.sourceMatchId, input.scheduleByMatchId);
      sourceSheet.continuations.push({
        id: `${edge.sourceMatchId}:${edge.outcome}:${edge.targetMatchId}`,
        sourceMatchId: edge.sourceMatchId,
        targetMatchId: edge.targetMatchId,
        outcome: edge.outcome,
        label: `${displayNumber}${edge.outcome === "winner" ? "勝者" : "敗者"} → ${targetRange}`,
        x: sourceNode.centerX,
        y: edge.outcome === "winner" ? sourceNode.lineY - 18 : sourceNode.lineY + SLOT_HEIGHT + 44,
        direction: "outgoing",
      });
      const targetSlot = targetSheet.slots.find(
        (slot) => slot.entryKey === `${edge.outcome}_of:${edge.sourceMatchId}`,
      );
      if (targetSlot !== undefined) {
        targetSlot.continuationLabel = `${displayNumber}${edge.outcome === "winner" ? "勝者" : "敗者"}`;
      }
    }
    return {
      ...edge,
      sourceSheetId: sourceSheet.id,
      targetSheetId: targetSheet.id,
      continuation,
    };
  });
  for (const sheet of sheets.filter((candidate) => candidate.kind === "opening_overview")) {
    for (const slot of sheet.slots.filter((candidate) => candidate.bye)) {
      const targetSheet = sheets.find(
        (candidate) =>
          candidate.kind === "rank_band" &&
          candidate.slots.some((targetSlot) => targetSlot.entryKey === slot.entryKey),
      );
      if (targetSheet === undefined) continue;
      slot.continuationLabel = `予備戦免除 → ${rangeLabel(overallRank(targetSheet.rankStart), overallRank(targetSheet.rankEnd))}`;
      sheet.continuations.push({
        id: `${sheet.id}:bye:${slot.entryKey}`,
        label: slot.continuationLabel,
        x: slot.centerX,
        y: slot.y - 14,
        direction: "bye",
      });
    }
  }

  const nodes = sheets.flatMap((sheet) => sheet.nodes);
  const internalEdges = sheets.flatMap((sheet) => sheet.edges);
  const continuationEdges: TournamentBracketEdge[] = references
    .filter((reference) => reference.continuation)
    .map((reference) => ({
      ...reference,
      path: "",
      segments: [],
      labelX: 0,
      labelY: 0,
    }));
  return {
    pool: input.pool,
    participantCount,
    provisional,
    compact: participantCount > 16,
    width: Math.max(...sheets.map((sheet) => sheet.width)),
    height: Math.max(...sheets.map((sheet) => sheet.height)),
    nodes,
    edges: [...internalEdges, ...continuationEdges],
    sheets,
    references,
    directPlacements: sheets.flatMap((sheet) => sheet.directPlacements),
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

function renderSheet(
  model: TournamentBracketModel,
  sheet: TournamentBracketSheet,
  heading: string,
  index: number,
): HTMLElement {
  const section = document.createElement("section");
  section.className = "tournament-bracket-sheet";
  section.dataset.sheetId = sheet.id;
  section.dataset.sheetKind = sheet.kind;
  const sheetHeading = document.createElement("h5");
  sheetHeading.textContent = sheet.title;
  const legend = document.createElement("p");
  legend.className = "bracket-line-legend";
  legend.textContent = "実線：勝者の進路　破線：敗者の進路";
  section.append(sheetHeading, legend);
  const wrapper = document.createElement("div");
  wrapper.className = "tournament-bracket-scroll";
  const titleId = `tournament-bracket-${model.pool}-${String(index)}-title`;
  const descriptionId = `tournament-bracket-${model.pool}-${String(index)}-description`;
  const svg = svgElement("svg", {
    viewBox: `0 0 ${String(sheet.width)} ${String(sheet.height)}`,
    width: sheet.width,
    height: sheet.height,
    role: "img",
    "aria-labelledby": `${titleId} ${descriptionId}`,
    preserveAspectRatio: "xMinYMin meet",
    class: "tournament-bracket-svg standard",
    "data-sheet-id": sheet.id,
  });
  const title = svgElement("title", { id: titleId });
  title.textContent = `${heading} ${sheet.title}`;
  const description = svgElement("desc", { id: descriptionId });
  description.textContent =
    "参加枠から直交線をたどり、上側に勝者、下側に敗者の順位決定戦を示す標準的なトーナメント表です。完全な文字情報は続く一覧表でも確認できます。";
  svg.append(title, description);
  appendSvgText(svg, sheet.title, 16, 24, "bracket-sheet-title", 32);
  for (const segment of sheet.segments.filter((item) => item.role === "entry")) {
    const path = segment.x1 === segment.x2
      ? `M ${String(segment.x1)} ${String(segment.y1)} V ${String(segment.y2)}`
      : `M ${String(segment.x1)} ${String(segment.y1)} H ${String(segment.x2)}`;
    svg.append(svgElement("path", {
      d: path,
      class: "bracket-entry-line",
    }));
  }
  for (const edge of sheet.edges) {
    const path = svgElement("path", {
      d: edge.path,
      class: `bracket-connector ${edge.outcome}`,
      "data-source-match-id": edge.sourceMatchId,
      "data-target-match-id": edge.targetMatchId,
      "data-target-side": edge.targetSide,
    });
    const edgeTitle = svgElement("title");
    edgeTitle.textContent = `${edge.sourceMatchId}の${edge.outcome === "winner" ? "勝者" : "敗者"}が${edge.targetMatchId}へ進みます`;
    path.append(edgeTitle);
    svg.append(path);
  }
  for (const slot of sheet.slots) {
    const group = svgElement("g", {
      class: `bracket-entry-slot${slot.bye ? " bye" : ""}${slot.continuation ? " continuation" : ""}`,
      "data-entry-key": slot.entryKey,
      "aria-label": `${slot.fullLabel}${slot.bye ? " 予備戦免除" : ""}`,
    });
    group.append(svgElement("rect", {
      x: slot.x,
      y: slot.y,
      width: slot.width,
      height: slot.height,
      rx: 3,
      class: "bracket-entry-card",
    }));
    appendSvgText(
      group,
      slot.primaryLabel,
      slot.centerX,
      slot.y + 22,
      "bracket-entry-name",
      slot.width <= COMPACT_SLOT_WIDTH ? 4 : 7,
    )
      .setAttribute("text-anchor", "middle");
    if (slot.secondaryLabel !== undefined) {
      appendSvgText(group, slot.secondaryLabel, slot.centerX, slot.y + 39, "bracket-entry-source", 9)
        .setAttribute("text-anchor", "middle");
    }
    if (slot.bye) {
      appendSvgText(group, "予備戦免除", slot.centerX, slot.y + 51, "bracket-bye", 6)
        .setAttribute("text-anchor", "middle");
    }
    svg.append(group);
  }
  for (const node of sheet.nodes) {
    const group = svgElement("g", {
      class: `bracket-match-node standard${node.narrow ? " narrow" : ""}`,
      "data-match-id": node.id,
      "data-round-no": node.roundNo,
      "aria-label": `${node.displayNumber} ${node.roundLabel}、${sideAriaLabel(node.home)} 対 ${sideAriaLabel(node.away)}`,
    });
    const groupTitle = svgElement("title");
    groupTitle.textContent = `${node.displayNumber} ${node.roundLabel}${node.metaLabel === undefined ? "" : ` ${node.metaLabel}`}：${sideAriaLabel(node.home)} 対 ${sideAriaLabel(node.away)}`;
    group.append(groupTitle);
    group.append(svgElement("path", {
      d: `M ${String(node.homeX)} ${String(node.lineY)} H ${String(node.awayX)}`,
      class: "bracket-match-line",
    }));
    appendSvgText(
      group,
      node.roundLabel,
      node.centerX,
      node.lineY - 47,
      "bracket-match-heading",
      node.narrow ? 5 : 10,
    ).setAttribute("text-anchor", "middle");
    appendSvgText(
      group,
      `${node.displayNumber} ${node.metaLabel ?? node.rankRangeLabel}`,
      node.centerX,
      node.lineY - 28,
      "bracket-match-meta",
      node.narrow ? 9 : 17,
    ).setAttribute("text-anchor", "middle");
    const matchup = `${node.home.primaryLabel} 対 ${node.away.primaryLabel}`;
    appendSvgText(
      group,
      matchup,
      node.centerX,
      node.lineY - 9,
      "bracket-matchup",
      node.narrow ? 7 : 15,
    )
      .setAttribute("text-anchor", "middle");
    if (node.resultLabel !== undefined || node.home.winner || node.away.winner) {
      const winnerLabel = node.home.winner
        ? node.home.primaryLabel
        : node.away.winner
          ? node.away.primaryLabel
          : undefined;
      appendSvgText(
        group,
        `${node.resultLabel ?? ""}${winnerLabel === undefined ? "" : `　勝者：${winnerLabel}`}`,
        node.centerX,
        node.lineY + 18,
        "bracket-winner-label",
        28,
      ).setAttribute("text-anchor", "middle");
    }
    svg.append(group);
    for (const terminal of node.terminals) {
      if (terminal.y !== node.lineY) {
        svg.append(svgElement("path", {
          d: `M ${String(node.centerX)} ${String(node.lineY)} V ${String(terminal.y)}`,
          class: `bracket-terminal-line ${terminal.outcome}`,
          "data-source-match-id": node.id,
          "data-rank": terminal.rank,
        }));
      }
      const label = appendSvgText(
        svg,
        terminal.label,
        terminal.x,
        terminal.y + (terminal.outcome === "winner" ? -3 : 12),
        `bracket-terminal ${terminal.confirmed ? "confirmed" : terminal.pendingConfirmation ? "pending" : ""}`.trim(),
        14,
      );
      label.dataset.rank = String(terminal.rank);
      label.setAttribute("text-anchor", "middle");
    }
  }
  for (const continuation of sheet.continuations) {
    appendSvgText(
      svg,
      continuation.label,
      continuation.x,
      continuation.y,
      `bracket-continuation ${continuation.direction}`,
      20,
    ).setAttribute("text-anchor", "middle");
  }
  for (const [index, placement] of sheet.directPlacements.entries()) {
    appendSvgText(
      svg,
      `${String(placement.rank)}位${placement.confirmed ? "確定" : "・未確定"}：${placement.label}`,
      sheet.width / 2,
      sheet.height - 28 - index * 17,
      "bracket-direct-label",
      36,
    ).setAttribute("text-anchor", "middle");
  }
  wrapper.append(svg);
  section.append(wrapper);
  return section;
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
  caption.textContent = model.provisional && !heading.includes("仮") ? `${heading}（仮）` : heading;
  figure.append(caption);
  if (model.emptyMessage !== undefined) {
    const message = document.createElement("p");
    message.className = "muted tournament-bracket-empty";
    message.textContent = model.emptyMessage;
    figure.append(message);
    return figure;
  }
  for (const [index, sheet] of model.sheets.entries()) {
    figure.append(renderSheet(model, sheet, heading, index + 1));
  }
  return figure;
}
