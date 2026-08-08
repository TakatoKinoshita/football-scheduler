import {
  standardTournamentBracketLayout,
  TournamentBracketError,
  type TournamentBracketInput,
  type TournamentBracketLayoutStrategy,
  type TournamentBracketModel,
  type TournamentBracketOutcome,
} from "./tournament-bracket";
import {
  readTournamentLogicalLayout,
  type TournamentBranchAlignment,
  type TournamentLogicalLayout,
  type TournamentLogicalMatchPosition,
} from "./tournament-logical-layout";
import type { JsonObject } from "./types";

export type TournamentBracketExplorationOrientation = "vertical" | "horizontal";

export interface TournamentBracketExplorationPoint {
  x: number;
  y: number;
}

export interface TournamentBracketExplorationSlot {
  key: string;
  label: string;
  fullLabel: string;
  center: TournamentBracketExplorationPoint;
  width: number;
  height: number;
}

export interface TournamentBracketExplorationSegment {
  start: TournamentBracketExplorationPoint;
  end: TournamentBracketExplorationPoint;
  outcome: TournamentBracketOutcome;
  ownerId: string;
  slotAttachment?: {
    slotKey: string;
    outcome: TournamentBracketOutcome;
  };
}

export interface TournamentBracketExplorationMatchLabel {
  matchId: string;
  text: string;
  lines: readonly string[];
  center: TournamentBracketExplorationPoint;
  lineY: number;
}

export interface TournamentBracketExplorationGeometry {
  orientation: TournamentBracketExplorationOrientation;
  width: number;
  height: number;
  slots: readonly TournamentBracketExplorationSlot[];
  segments: readonly TournamentBracketExplorationSegment[];
  matchLabels: readonly TournamentBracketExplorationMatchLabel[];
}

export interface TournamentBracketExplorationModel extends TournamentBracketModel {
  explorationGeometry: TournamentBracketExplorationGeometry;
}

interface EntryReference {
  sourceMatchId: string;
  outcome: TournamentBracketOutcome;
}

interface ParsedMatch {
  id: string;
  roundNo: number;
  rangeStart: number;
  rangeEnd: number;
  home: JsonObject;
  away: JsonObject;
  inputIndex: number;
}

type MatchBranch = "opening" | TournamentBracketOutcome;

interface MatchPlan {
  match: ParsedMatch;
  branch: MatchBranch;
  score: number;
  opening: boolean;
}

interface MatchGeometry {
  id: string;
  branch: MatchBranch;
  score: number;
  opening: boolean;
  leftX: number;
  rightX: number;
  centerX: number;
  lineY: number;
  winnerLineY?: number;
  loserLineY?: number;
}

interface InputPoint extends TournamentBracketExplorationPoint {
  outcome: TournamentBracketOutcome;
  slotKey?: string;
}

interface ExplorationEntryDescription {
  primaryLabel: string;
  fullLabel: string;
}

interface LogicalLayoutIndex {
  layout: TournamentLogicalLayout;
  positionByMatchId: ReadonlyMap<string, TournamentLogicalMatchPosition>;
  alignmentByRange: ReadonlyMap<string, TournamentBranchAlignment>;
  matchById: ReadonlyMap<string, ParsedMatch>;
  spatialOrderByRange: Map<string, readonly ParsedMatch[]>;
}

const BOX_WIDTH = 106;
const BOX_HEIGHT = 58;
const SLOT_PITCH = 128;
const SHEET_MARGIN = 42;
const HORIZONTAL_FLOW_MARGIN = 80;
const OPENING_GAP = 30;
const HORIZONTAL_OPENING_GAP = 104;
const ROW_GAP = 96;
const SIXTEEN_TEAM_ROW_GAP = 104;
const INNER_STEP = 0.58;
const TERMINAL_ORDER_STEP = 0.5;
const RANK_LANDMARK_GAP = 0.35;
const TERMINAL_LENGTH = 24;
const SIXTEEN_TEAM_TERMINAL_LENGTH = 32;
const MATCH_LABEL_OFFSET = 18;
const MULTILINE_MATCH_LABEL_OFFSET = 24;
const HORIZONTAL_MATCH_LABEL_OFFSET = 40;
const TERMINAL_MATCH_LABEL_X_OFFSET = 60;

interface ExplorationBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function horizontalPoint(
  point: TournamentBracketExplorationPoint,
  sheetHeight: number,
): TournamentBracketExplorationPoint {
  return { x: sheetHeight - point.y, y: point.x };
}

function intersects(left: ExplorationBounds, right: ExplorationBounds): boolean {
  return left.left < right.right
    && left.right > right.left
    && left.top < right.bottom
    && left.bottom > right.top;
}

function horizontalSegmentBounds(
  segment: TournamentBracketExplorationSegment,
  sheetHeight: number,
): ExplorationBounds {
  const start = horizontalPoint(segment.start, sheetHeight);
  const end = horizontalPoint(segment.end, sheetHeight);
  const clearance = 3;
  return {
    left: Math.min(start.x, end.x) - clearance,
    right: Math.max(start.x, end.x) + clearance,
    top: Math.min(start.y, end.y) - clearance,
    bottom: Math.max(start.y, end.y) + clearance,
  };
}

function horizontalSlotBounds(
  slot: TournamentBracketExplorationSlot,
  sheetHeight: number,
): ExplorationBounds {
  const center = horizontalPoint(slot.center, sheetHeight);
  const clearance = 3;
  return {
    left: center.x - slot.width / 2 - clearance,
    right: center.x + slot.width / 2 + clearance,
    top: center.y - slot.height / 2 - clearance,
    bottom: center.y + slot.height / 2 + clearance,
  };
}

function approximateLabelWidth(lines: readonly string[]): number {
  return Math.max(...lines.map((line) => [...line].reduce((width, character) => {
    return width + (/^[\x20-\x7e]$/u.test(character) ? 7 : 12);
  }, 0)));
}

function arrangeHorizontalMatchLabels(
  labels: readonly TournamentBracketExplorationMatchLabel[],
  segments: readonly TournamentBracketExplorationSegment[],
  slots: readonly TournamentBracketExplorationSlot[],
  sheetWidth: number,
  sheetHeight: number,
): TournamentBracketExplorationMatchLabel[] {
  const fixedObstacles = [
    ...segments.map((segment) => horizontalSegmentBounds(segment, sheetHeight)),
    ...slots.map((slot) => horizontalSlotBounds(slot, sheetHeight)),
  ];
  const placedLabels: ExplorationBounds[] = [];
  const candidateOffsets = [0, -24, 24, -48, 48, -72, 72, -96, 96];

  return labels.map((label) => {
    const original = horizontalPoint(label.center, sheetHeight);
    const lineX = sheetHeight - label.lineY;
    const preferredSide = original.x < lineX ? -1 : 1;
    const halfWidth = approximateLabelWidth(label.lines) / 2 + 3;
    const halfHeight = (label.lines.length > 1 ? 34 : 20) / 2;
    const lineOffsets = [40, 56, 72, 88].flatMap((distance) => [
      preferredSide * distance,
      -preferredSide * distance,
    ]);
    const candidates = lineOffsets.flatMap((lineOffset) => candidateOffsets.map((verticalOffset) => ({
      x: lineX + lineOffset,
      y: original.y + verticalOffset,
    })));
    const center = candidates.find((candidate) => {
      const bounds = {
        left: candidate.x - halfWidth,
        right: candidate.x + halfWidth,
        top: candidate.y - halfHeight,
        bottom: candidate.y + halfHeight,
      };
      if (bounds.left < 6 || bounds.right > sheetHeight - 6) return false;
      if (bounds.top < 6 || bounds.bottom > sheetWidth - 6) return false;
      return !fixedObstacles.some((obstacle) => intersects(bounds, obstacle))
        && !placedLabels.some((placed) => intersects(bounds, placed));
    }) ?? original;
    const bounds = {
      left: center.x - halfWidth,
      right: center.x + halfWidth,
      top: center.y - halfHeight,
      bottom: center.y + halfHeight,
    };
    placedLabels.push(bounds);
    return {
      ...label,
      center: { x: center.y, y: sheetHeight - center.x },
    };
  });
}

function objectValue(value: unknown, message: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TournamentBracketError(message);
  }
  return value as JsonObject;
}

function arrayValue(value: unknown, message: string): JsonObject[] {
  if (!Array.isArray(value)) throw new TournamentBracketError(message);
  return value.map((item) => objectValue(item, message));
}

function positiveInteger(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new TournamentBracketError(message);
  }
  return value;
}

function textValue(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TournamentBracketError(message);
  }
  return value;
}

function entryKey(value: unknown): string {
  const entry = objectValue(value, "トーナメント参加枠を読み取れませんでした。");
  if (entry.type === "league_rank") {
    return `league_rank:${String(entry.block_id)}:${String(entry.rank)}`;
  }
  if (entry.type === "concrete_team") return `concrete_team:${String(entry.team_id)}`;
  if (entry.type === "winner_of" || entry.type === "loser_of") {
    return `${String(entry.type)}:${String(entry.match_id)}`;
  }
  throw new TournamentBracketError("トーナメント参加枠の種類を読み取れませんでした。");
}

function rankRangeKey(start: number, end: number): string {
  return `${String(start)}:${String(end)}`;
}

function reference(value: unknown): EntryReference | undefined {
  const entry = objectValue(value, "トーナメント参加枠を読み取れませんでした。");
  if (entry.type !== "winner_of" && entry.type !== "loser_of") return undefined;
  return {
    sourceMatchId: textValue(entry.match_id, "参照元の試合IDを読み取れませんでした。"),
    outcome: entry.type === "winner_of" ? "winner" : "loser",
  };
}

function parsedMatches(plan: JsonObject, poolName: string): ParsedMatch[] {
  const pool = objectValue(plan[poolName], "上位トーナメントを読み取れませんでした。");
  return arrayValue(pool.matches, "上位トーナメント試合を読み取れませんでした。").map(
    (match, inputIndex) => {
      const range = Array.isArray(match.rank_range) ? match.rank_range : [];
      return {
        id: textValue(match.id, "試合IDを読み取れませんでした。"),
        roundNo: positiveInteger(match.round_no, "試合段階を読み取れませんでした。"),
        rangeStart: positiveInteger(range[0], "順位帯を読み取れませんでした。"),
        rangeEnd: positiveInteger(range[1], "順位帯を読み取れませんでした。"),
        home: objectValue(match.home, "ホーム参加枠を読み取れませんでした。"),
        away: objectValue(match.away, "アウェイ参加枠を読み取れませんでした。"),
        inputIndex,
      };
    },
  ).sort(
    (left, right) =>
      left.roundNo - right.roundNo ||
      left.inputIndex - right.inputIndex ||
      left.id.localeCompare(right.id),
  );
}

function explorationEntryDescription(
  entry: JsonObject,
  pool: JsonObject,
  teamNames: ReadonlyMap<string, string>,
): ExplorationEntryDescription {
  const key = entryKey(entry);
  const seed = arrayValue(pool.seeds, "上位トーナメントシードを読み取れませんでした。")
    .find((candidate) => entryKey(candidate.entry) === key);
  const teamId = entry.type === "concrete_team"
    ? textValue(entry.team_id, "チームIDを読み取れませんでした。")
    : typeof seed?.team_id === "string"
      ? seed.team_id
      : undefined;
  const teamName = teamId === undefined ? undefined : teamNames.get(teamId);
  if (teamName !== undefined) return { primaryLabel: teamName, fullLabel: teamName };
  if (entry.type === "league_rank") {
    const fallback = `${String(entry.block_id)}${String(entry.rank)}位`;
    return { primaryLabel: fallback, fullLabel: fallback };
  }
  throw new TournamentBracketError("探索用レイアウトのチーム名を読み取れませんでした。");
}

function orderedWinnerLeaves(matches: readonly ParsedMatch[], participantCount: number): JsonObject[] {
  const matchById = new Map(matches.map((match) => [match.id, match]));
  const root = matches.find((match) => match.rangeStart === 1 && match.rangeEnd === 2);
  if (root === undefined) {
    throw new TournamentBracketError("優勝決定戦から参加枠をたどれませんでした。");
  }
  const leaves: JsonObject[] = [];
  const visit = (entry: JsonObject): void => {
    const inputReference = reference(entry);
    if (inputReference === undefined) {
      leaves.push(entry);
      return;
    }
    if (inputReference.outcome !== "winner") {
      throw new TournamentBracketError("勝ち上がり経路に敗者参照があります。");
    }
    const source = matchById.get(inputReference.sourceMatchId);
    if (source === undefined) {
      throw new TournamentBracketError("勝ち上がり経路の参照元試合を読み取れませんでした。");
    }
    visit(source.home);
    visit(source.away);
  };
  visit(root.home);
  visit(root.away);
  const unique = new Map(leaves.map((entry) => [entryKey(entry), entry]));
  if (unique.size !== participantCount) {
    throw new TournamentBracketError("16チーム用の参加枠を一意に並べられませんでした。");
  }
  return [...unique.values()];
}

function logicalLayoutIndex(
  layout: TournamentLogicalLayout,
  matches: readonly ParsedMatch[],
): LogicalLayoutIndex {
  return {
    layout,
    positionByMatchId: new Map(layout.matchPositions.map((position) => [position.matchId, position])),
    alignmentByRange: new Map(
      layout.branchAlignments.map((alignment) => [
        rankRangeKey(alignment.rankRange[0], alignment.rankRange[1]),
        alignment,
      ]),
    ),
    matchById: new Map(matches.map((match) => [match.id, match])),
    spatialOrderByRange: new Map(),
  };
}

function logicalMatchesForRange(
  matches: readonly ParsedMatch[],
  rangeStart: number,
  rangeEnd: number,
  index: LogicalLayoutIndex,
): ParsedMatch[] {
  return matches
    .filter((match) => match.rangeStart === rangeStart && match.rangeEnd === rangeEnd)
    .sort((left, right) => {
      const leftPosition = index.positionByMatchId.get(left.id);
      const rightPosition = index.positionByMatchId.get(right.id);
      if (leftPosition === undefined || rightPosition === undefined) {
        throw new TournamentBracketError("論理配置から試合順を読み取れませんでした。");
      }
      return leftPosition.order - rightPosition.order;
    });
}

function spatialMatchOrder(
  matches: readonly ParsedMatch[],
  rangeStart: number,
  rangeEnd: number,
  index: LogicalLayoutIndex,
): readonly ParsedMatch[] {
  const key = rankRangeKey(rangeStart, rangeEnd);
  const cached = index.spatialOrderByRange.get(key);
  if (cached !== undefined) return cached;
  const logicalMatches = logicalMatchesForRange(matches, rangeStart, rangeEnd, index);
  if (rangeEnd - rangeStart + 1 <= 2) {
    index.spatialOrderByRange.set(key, logicalMatches);
    return logicalMatches;
  }
  const midpoint = (rangeStart + rangeEnd - 1) / 2;
  const upperMatches = logicalMatchesForRange(matches, rangeStart, midpoint, index);
  const upperSpatialOrder = spatialMatchOrder(matches, rangeStart, midpoint, index);
  const alignment = index.alignmentByRange.get(key);
  if (alignment === undefined || alignment.winnerSourceOrder.length !== upperMatches.length * 2) {
    throw new TournamentBracketError("勝者側の論理配置順を読み取れませんでした。");
  }
  const sourcesByUpperMatch = new Map(
    upperMatches.map((match, matchIndex) => [
      match.id,
      alignment.winnerSourceOrder.slice(matchIndex * 2, matchIndex * 2 + 2),
    ]),
  );
  const sourceIds = upperSpatialOrder.flatMap((match) => {
    const sourcePair = sourcesByUpperMatch.get(match.id);
    if (sourcePair === undefined) {
      throw new TournamentBracketError("勝者側の試合位置と参照順が一致しませんでした。");
    }
    return sourcePair;
  });
  const result = sourceIds.map((matchId) => {
    const match = index.matchById.get(matchId);
    if (match === undefined || match.rangeStart !== rangeStart || match.rangeEnd !== rangeEnd) {
      throw new TournamentBracketError("勝者側の論理配置に未知の試合があります。");
    }
    return match;
  });
  if (result.length !== logicalMatches.length || new Set(result.map((match) => match.id)).size !== result.length) {
    throw new TournamentBracketError("勝者側の論理配置順に不足または重複があります。");
  }
  index.spatialOrderByRange.set(key, result);
  return result;
}

function openingEntriesInSpatialOrder(
  matches: readonly ParsedMatch[],
  participantCount: number,
  index: LogicalLayoutIndex,
): JsonObject[] {
  const logicalOpeningMatches = logicalMatchesForRange(matches, 1, participantCount, index);
  if (index.layout.openingEntryOrder.length !== logicalOpeningMatches.length * 2) {
    throw new TournamentBracketError("初戦参加枠の論理配置順を読み取れませんでした。");
  }
  const entriesByMatchId = new Map(
    logicalOpeningMatches.map((match, matchIndex) => [
      match.id,
      index.layout.openingEntryOrder.slice(matchIndex * 2, matchIndex * 2 + 2),
    ]),
  );
  return spatialMatchOrder(matches, 1, participantCount, index).flatMap((match) => {
    const entries = entriesByMatchId.get(match.id);
    if (entries === undefined) {
      throw new TournamentBracketError("初戦の試合位置と参加枠が一致しませんでした。");
    }
    return entries;
  });
}

function alignedSourceOrder(
  matches: readonly ParsedMatch[],
  childMatches: readonly ParsedMatch[],
  index: LogicalLayoutIndex,
): readonly string[] | undefined {
  const firstMatch = childMatches[0];
  if (firstMatch === undefined) return undefined;
  const firstReference = reference(firstMatch.home);
  if (firstReference === undefined) return undefined;
  const sourceMatch = index.matchById.get(firstReference.sourceMatchId);
  if (sourceMatch === undefined) {
    throw new TournamentBracketError("勝敗分岐の参照元試合を読み取れませんでした。");
  }
  const alignment = index.alignmentByRange.get(
    rankRangeKey(sourceMatch.rangeStart, sourceMatch.rangeEnd),
  );
  if (alignment === undefined) {
    throw new TournamentBracketError("勝敗分岐の論理対応を読み取れませんでした。");
  }
  const logicalChildren = logicalMatchesForRange(
    matches,
    firstMatch.rangeStart,
    firstMatch.rangeEnd,
    index,
  );
  const sourceOrder = firstReference.outcome === "winner"
    ? alignment.winnerSourceOrder
    : alignment.loserSourceOrder;
  if (sourceOrder.length !== logicalChildren.length * 2) {
    throw new TournamentBracketError("勝敗分岐の参照順と試合数が一致しませんでした。");
  }
  const sourcesByChildMatch = new Map(
    logicalChildren.map((match, matchIndex) => [
      match.id,
      sourceOrder.slice(matchIndex * 2, matchIndex * 2 + 2),
    ]),
  );
  return childMatches.flatMap((match) => {
    const sources = sourcesByChildMatch.get(match.id);
    if (sources === undefined) {
      throw new TournamentBracketError("勝敗分岐の試合位置と参照順が一致しませんでした。");
    }
    return sources;
  });
}

function explorationBaseModel(
  input: TournamentBracketInput,
  matches: readonly ParsedMatch[],
  logicalOpeningEntries?: readonly JsonObject[],
): TournamentBracketModel {
  const pool = objectValue(input.plan[input.pool], "上位トーナメントを読み取れませんでした。");
  const participantCount = positiveInteger(
    pool.participant_count,
    "トーナメント参加数を読み取れませんでした。",
  );
  if (logicalOpeningEntries === undefined && participantCount <= 9) {
    return standardTournamentBracketLayout.build(input);
  }

  const byeKeys = new Set(
    arrayValue(pool.byes, "不戦通過を読み取れませんでした。").map((bye) => entryKey(bye.entry)),
  );
  const openingEntries = logicalOpeningEntries ?? orderedWinnerLeaves(matches, participantCount);
  const slots = openingEntries.map((entry, index) => {
    const description = explorationEntryDescription(entry, pool, input.teamNames);
    return {
      id: `exploration-slot-${String(index + 1)}`,
      entryKey: entryKey(entry),
      ...description,
      bye: byeKeys.has(entryKey(entry)),
      continuation: false,
      x: 0,
      y: 0,
      width: BOX_WIDTH,
      height: BOX_HEIGHT,
      centerX: 0,
    };
  });
  const sheet = {
    id: "exploration",
    title: "探索用トーナメント表",
    kind: "complete" as const,
    rankStart: 1,
    rankEnd: participantCount,
    width: 0,
    height: 0,
    nodes: [],
    edges: [],
    slots,
    continuations: [],
    directPlacements: [],
    segments: [],
  };
  return {
    pool: input.pool,
    participantCount,
    provisional: input.plan.participant_resolution === "provisional",
    compact: false,
    width: 0,
    height: 0,
    nodes: [],
    edges: [],
    sheets: [sheet],
    references: [],
    directPlacements: [],
  };
}

function topRankCount(participantCount: number): number {
  const power = 2 ** Math.floor(Math.log2(participantCount));
  if (power === participantCount) return participantCount / 2;
  return Math.min(power, 4);
}

function branchFor(
  match: ParsedMatch,
  topCount: number,
  participantCount: number,
): MatchBranch {
  const entries = [match.home, match.away];
  if (
    match.rangeEnd === participantCount &&
    entries.every((entry) => reference(entry) === undefined)
  ) {
    return "opening";
  }
  return match.rangeEnd <= topCount ? "winner" : "loser";
}

function matchPlans(
  matches: readonly ParsedMatch[],
  topCount: number,
  participantCount: number,
): Map<string, MatchPlan> {
  const plans = new Map<string, MatchPlan>();
  for (const match of matches) {
    const branch = branchFor(match, topCount, participantCount);
    if (branch === "opening") {
      plans.set(match.id, { match, branch, score: 0, opening: true });
      continue;
    }
    const preferredOutcome: TournamentBracketOutcome = branch;
    const candidates = [match.home, match.away].map((entry) => {
      const inputReference = reference(entry);
      if (inputReference === undefined) return 1;
      const source = plans.get(inputReference.sourceMatchId);
      if (source === undefined) {
        throw new TournamentBracketError("試合の前後関係に沿って配置できませんでした。");
      }
      if (source.branch === "opening") return 1;
      return source.score + (inputReference.outcome === preferredOutcome ? 1 : INNER_STEP);
    });
    plans.set(match.id, {
      match,
      branch,
      score: Math.max(...candidates),
      opening: false,
    });
  }
  return plans;
}

function orderWinnerTerminals(
  plans: Map<string, MatchPlan>,
  terminalMatchIds: ReadonlySet<string>,
): void {
  const terminalPlans = [...terminalMatchIds]
    .map((matchId) => plans.get(matchId))
    .filter((plan): plan is MatchPlan => plan !== undefined && plan.branch === "winner")
    .sort((left, right) => left.match.rangeStart - right.match.rangeStart);
  let lowerTerminalScore: number | undefined;
  for (const plan of [...terminalPlans].reverse()) {
    if (lowerTerminalScore !== undefined) {
      plan.score = Math.max(plan.score, lowerTerminalScore + TERMINAL_ORDER_STEP);
    }
    lowerTerminalScore = plan.score;
  }
}

function orderLoserTerminals(
  plans: Map<string, MatchPlan>,
  terminalMatchIds: ReadonlySet<string>,
): void {
  const terminalPlans = [...terminalMatchIds]
    .map((matchId) => plans.get(matchId))
    .filter((plan): plan is MatchPlan => plan !== undefined && plan.branch === "loser")
    .sort((left, right) => left.match.rangeStart - right.match.rangeStart);
  let higherTerminalScore: number | undefined;
  for (const plan of terminalPlans) {
    if (higherTerminalScore !== undefined) {
      plan.score = Math.max(plan.score, higherTerminalScore + TERMINAL_ORDER_STEP);
    }
    higherTerminalScore = plan.score;
  }
}

function orderRankLandmarks(
  plans: Map<string, MatchPlan>,
  terminalMatchIds: ReadonlySet<string>,
  participantCount: number,
  rowGap: number,
  terminalLength: number,
): void {
  if (participantCount < 16) return;
  const consumersByMatchId = new Map<string, Set<string>>();
  for (const consumer of plans.values()) {
    for (const entry of [consumer.match.home, consumer.match.away]) {
      const inputReference = reference(entry);
      if (inputReference === undefined) continue;
      const consumers = consumersByMatchId.get(inputReference.sourceMatchId) ?? new Set();
      consumers.add(consumer.match.id);
      consumersByMatchId.set(inputReference.sourceMatchId, consumers);
    }
  }
  const splitPlans = [...plans.values()].filter((plan) => {
    if (plan.opening || terminalMatchIds.has(plan.match.id)) return false;
    const consumerIds = [...(consumersByMatchId.get(plan.match.id) ?? [])];
    return consumerIds.length === 2 &&
      consumerIds.every((matchId) => terminalMatchIds.has(matchId));
  });
  const terminalLengthScore = terminalLength / rowGap;
  for (const branch of ["winner", "loser"] as const) {
    const groups = new Map<number, { terminal: boolean; plans: MatchPlan[] }>();
    // 上側は確定する高順位、下側は確定する低順位を基準にし、中央を挟んだ鏡像にする。
    for (const matchId of terminalMatchIds) {
      const plan = plans.get(matchId);
      if (plan === undefined || plan.branch !== branch) continue;
      const rank = branch === "winner"
        ? plan.match.rangeStart
        : plan.match.rangeEnd;
      const group = groups.get(rank) ?? { terminal: true, plans: [] };
      group.plans.push(plan);
      groups.set(rank, group);
    }
    for (const plan of splitPlans.filter((candidate) => candidate.branch === branch)) {
      const rank = branch === "winner"
        ? plan.match.rangeEnd
        : plan.match.rangeStart;
      const group = groups.get(rank) ?? { terminal: false, plans: [] };
      group.plans.push(plan);
      groups.set(rank, group);
    }
    const orderedGroups = [...groups.entries()].sort(([leftRank], [rightRank]) =>
      branch === "winner" ? rightRank - leftRank : leftRank - rightRank
    );
    let previousOuterPosition: number | undefined;
    for (const [, group] of orderedGroups) {
      const offset = group.terminal ? terminalLengthScore : 0;
      const currentInnerPosition = Math.max(...group.plans.map((plan) => plan.score));
      const innerPosition = previousOuterPosition === undefined
        ? currentInnerPosition
        : Math.max(currentInnerPosition, previousOuterPosition + RANK_LANDMARK_GAP);
      for (const plan of group.plans) {
        plan.score = Math.max(plan.score, innerPosition);
      }
      previousOuterPosition = innerPosition + offset;
    }
  }
}

function outcomePortX(
  source: MatchGeometry,
  outcome: TournamentBracketOutcome,
  sheetCenterX: number,
): number {
  if (source.opening) return source.centerX;
  const oneThird = source.leftX + (source.rightX - source.leftX) / 3;
  const twoThirds = source.leftX + (source.rightX - source.leftX) * 2 / 3;
  const outer = source.centerX <= sheetCenterX ? oneThird : twoThirds;
  const inner = outer === oneThird ? twoThirds : oneThird;
  const preferredOutcome: TournamentBracketOutcome = source.branch === "loser" ? "loser" : "winner";
  return outcome === preferredOutcome ? outer : inner;
}

function buildExplorationModel(
  input: TournamentBracketInput,
  orientation: TournamentBracketExplorationOrientation,
): TournamentBracketExplorationModel {
  const matches = parsedMatches(input.plan, input.pool);
  const pool = objectValue(input.plan[input.pool], "上位トーナメントを読み取れませんでした。");
  const logicalLayout = readTournamentLogicalLayout(pool);
  const logicalIndex = logicalLayout === undefined
    ? undefined
    : logicalLayoutIndex(logicalLayout, matches);
  const participantCount = positiveInteger(
    pool.participant_count,
    "トーナメント参加数を読み取れませんでした。",
  );
  const logicalOpeningEntries = logicalIndex === undefined
    ? undefined
    : openingEntriesInSpatialOrder(matches, participantCount, logicalIndex);
  const base = explorationBaseModel(input, matches, logicalOpeningEntries);
  if (base.participantCount < 2 || base.participantCount > 16 || base.sheets.length !== 1) {
    throw new TournamentBracketError("探索用レイアウトは2〜16チームの単一ページに対応します。");
  }
  const baseSheet = base.sheets[0]!;
  const rowGap = base.participantCount >= 16 ? SIXTEEN_TEAM_ROW_GAP : ROW_GAP;
  const terminalLength = base.participantCount >= 16
    ? SIXTEEN_TEAM_TERMINAL_LENGTH
    : TERMINAL_LENGTH;
  const terminalMatchIds = new Set(
    arrayValue(pool.placements, "最終順位を読み取れませんでした。").flatMap((placement) => {
      const placementReference = reference(placement.entry);
      return placementReference === undefined ? [] : [placementReference.sourceMatchId];
    }),
  );
  const plans = matchPlans(
    matches,
    topRankCount(base.participantCount),
    base.participantCount,
  );
  orderWinnerTerminals(plans, terminalMatchIds);
  orderLoserTerminals(plans, terminalMatchIds);
  orderRankLandmarks(
    plans,
    terminalMatchIds,
    base.participantCount,
    rowGap,
    terminalLength,
  );
  const powerOfTwo = (base.participantCount & (base.participantCount - 1)) === 0;
  const maximumWinnerScore = Math.max(
    0,
    ...[...plans.values()].filter((plan) => plan.branch === "winner").map((plan) => plan.score),
  );
  const rawMaximumLoserScore = Math.max(
    0,
    ...[...plans.values()].filter((plan) => plan.branch === "loser").map((plan) => plan.score),
  );
  const maximumLoserScore = powerOfTwo
    ? Math.max(rawMaximumLoserScore, maximumWinnerScore)
    : rawMaximumLoserScore;
  const openingGap = orientation === "horizontal" ? HORIZONTAL_OPENING_GAP : OPENING_GAP;
  const flowMargin = orientation === "horizontal" ? HORIZONTAL_FLOW_MARGIN : SHEET_MARGIN;
  const boxY = flowMargin + terminalLength + openingGap + maximumWinnerScore * rowGap;
  const width = Math.max(
    360,
    SHEET_MARGIN * 2 + BOX_WIDTH + Math.max(0, baseSheet.slots.length - 1) * SLOT_PITCH,
  );
  const height =
    boxY + BOX_HEIGHT + openingGap + maximumLoserScore * rowGap + terminalLength + flowMargin;
  const slots: TournamentBracketExplorationSlot[] = baseSheet.slots.map((slot, index) => ({
    key: slot.entryKey,
    label: slot.primaryLabel,
    fullLabel: slot.fullLabel,
    center: {
      x: SHEET_MARGIN + BOX_WIDTH / 2 + index * SLOT_PITCH,
      y: boxY + BOX_HEIGHT / 2,
    },
    width: BOX_WIDTH,
    height: BOX_HEIGHT,
  }));
  const slotByKey = new Map(slots.map((slot) => [slot.key, slot]));
  const openingWinnerY = boxY - openingGap;
  const openingLoserY = boxY + BOX_HEIGHT + openingGap;
  const segments: TournamentBracketExplorationSegment[] = [];
  const matchGeometry = new Map<string, MatchGeometry>();
  const sheetCenterX = width / 2;
  const openingMatches = logicalIndex === undefined
    ? matches.filter((match) => plans.get(match.id)?.branch === "opening")
    : [...spatialMatchOrder(matches, 1, base.participantCount, logicalIndex)];

  for (const match of openingMatches) {
    const plan = plans.get(match.id)!;
    if (!plan.opening) {
      throw new TournamentBracketError("初戦の論理配置に初戦以外の試合があります。");
    }
    const homeSlot = slotByKey.get(entryKey(match.home));
    const awaySlot = slotByKey.get(entryKey(match.away));
    if (homeSlot === undefined || awaySlot === undefined) {
      throw new TournamentBracketError("初戦のチーム枠を読み取れませんでした。");
    }
    const leftX = Math.min(homeSlot.center.x, awaySlot.center.x);
    const rightX = Math.max(homeSlot.center.x, awaySlot.center.x);
    const centerX = (leftX + rightX) / 2;
    for (const slot of [homeSlot, awaySlot]) {
      segments.push({
        start: { x: slot.center.x, y: boxY },
        end: { x: slot.center.x, y: openingWinnerY },
        outcome: "winner",
        ownerId: `${match.id}:opening:winner`,
        slotAttachment: { slotKey: slot.key, outcome: "winner" },
      });
      segments.push({
        start: { x: slot.center.x, y: boxY + BOX_HEIGHT },
        end: { x: slot.center.x, y: openingLoserY },
        outcome: "loser",
        ownerId: `${match.id}:opening:loser`,
        slotAttachment: { slotKey: slot.key, outcome: "loser" },
      });
    }
    segments.push({
      start: { x: leftX, y: openingWinnerY },
      end: { x: rightX, y: openingWinnerY },
      outcome: "winner",
      ownerId: `${match.id}:opening:winner`,
    });
    segments.push({
      start: { x: leftX, y: openingLoserY },
      end: { x: rightX, y: openingLoserY },
      outcome: "loser",
      ownerId: `${match.id}:opening:loser`,
    });
    matchGeometry.set(match.id, {
      id: match.id,
      branch: "opening",
      score: 0,
      opening: true,
      leftX,
      rightX,
      centerX,
      lineY: openingWinnerY,
      winnerLineY: openingWinnerY,
      loserLineY: openingLoserY,
    });
  }

  const inputPoint = (
    entry: JsonObject,
    branch: TournamentBracketOutcome,
  ): InputPoint => {
    const inputReference = reference(entry);
    if (inputReference === undefined) {
      const slot = slotByKey.get(entryKey(entry));
      if (slot === undefined) throw new TournamentBracketError("シード枠を読み取れませんでした。");
      return {
        x: slot.center.x,
        y: branch === "winner" ? boxY : boxY + BOX_HEIGHT,
        outcome: branch,
        slotKey: slot.key,
      };
    }
    const source = matchGeometry.get(inputReference.sourceMatchId);
    if (source === undefined) {
      throw new TournamentBracketError("参照元試合の位置を読み取れませんでした。");
    }
    if (source.opening) {
      return {
        x: source.centerX,
        y: inputReference.outcome === "winner" ? source.winnerLineY! : source.loserLineY!,
        outcome: inputReference.outcome,
      };
    }
    return {
      x: outcomePortX(source, inputReference.outcome, sheetCenterX),
      y: source.lineY,
      outcome: inputReference.outcome,
    };
  };

  const groupedMatches = new Map<string, ParsedMatch[]>();
  for (const match of matches.filter((candidate) => !plans.get(candidate.id)?.opening)) {
    const key = rankRangeKey(match.rangeStart, match.rangeEnd);
    groupedMatches.set(key, [...(groupedMatches.get(key) ?? []), match]);
  }

  for (const rangeMatches of groupedMatches.values()) {
    const firstMatch = rangeMatches[0]!;
    const orderedMatches = logicalIndex === undefined
      ? rangeMatches
      : [...spatialMatchOrder(
          matches,
          firstMatch.rangeStart,
          firstMatch.rangeEnd,
          logicalIndex,
        )];
    const preparedMatches = orderedMatches.map((match) => {
      const plan = plans.get(match.id);
      if (plan === undefined || plan.opening) {
        throw new TournamentBracketError("初戦以外の試合配置を読み取れませんでした。");
      }
      const branch = plan.branch as TournamentBracketOutcome;
      const lineY = branch === "winner"
        ? openingWinnerY - plan.score * rowGap
        : openingLoserY + plan.score * rowGap;
      return {
        match,
        plan,
        branch,
        lineY,
        inputs: [inputPoint(match.home, branch), inputPoint(match.away, branch)],
      };
    });
    const targetXBySourceId = new Map<string, number>();
    if (logicalIndex !== undefined) {
      const requiredSourceOrder = alignedSourceOrder(matches, orderedMatches, logicalIndex);
      if (requiredSourceOrder !== undefined) {
        const inputBySourceId = new Map<string, InputPoint>();
        for (const prepared of preparedMatches) {
          for (const [inputIndex, entry] of [prepared.match.home, prepared.match.away].entries()) {
            const inputReference = reference(entry);
            if (inputReference !== undefined) {
              inputBySourceId.set(inputReference.sourceMatchId, prepared.inputs[inputIndex]!);
            }
          }
        }
        if (
          inputBySourceId.size !== requiredSourceOrder.length ||
          requiredSourceOrder.some((sourceId) => !inputBySourceId.has(sourceId))
        ) {
          throw new TournamentBracketError("勝敗分岐の論理順と入力試合が一致しませんでした。");
        }
        const targetXs = [...inputBySourceId.values()]
          .map((point) => point.x)
          .sort((left, right) => left - right);
        requiredSourceOrder.forEach((sourceId, sourceIndex) => {
          targetXBySourceId.set(sourceId, targetXs[sourceIndex]!);
        });
      }
    }
    const routedInputs = preparedMatches.flatMap((prepared) =>
      prepared.inputs.map((point, inputIndex) => {
        const entry = inputIndex === 0 ? prepared.match.home : prepared.match.away;
        const inputReference = reference(entry);
        return {
          matchId: prepared.match.id,
          inputIndex,
          point,
          targetX: inputReference === undefined
            ? point.x
            : targetXBySourceId.get(inputReference.sourceMatchId) ?? point.x,
        };
      })
    );
    const movedInputs = routedInputs
      .filter((input) => Math.abs(input.point.x - input.targetX) > 0.001)
      .sort((left, right) => left.point.x - right.point.x || left.targetX - right.targetX);
    const routeIndexByInput = new Map(
      movedInputs.map((input, routeIndex) => [
        `${input.matchId}:${String(input.inputIndex)}`,
        routeIndex,
      ]),
    );

    for (const prepared of preparedMatches) {
      const positionedInputs = routedInputs.filter((input) => input.matchId === prepared.match.id);
      const leftX = Math.min(...positionedInputs.map((input) => input.targetX));
      const rightX = Math.max(...positionedInputs.map((input) => input.targetX));
      const centerX = (leftX + rightX) / 2;
      for (const { point, inputIndex, targetX } of positionedInputs) {
        const ownerId = `${prepared.match.id}:input:${String(inputIndex + 1)}`;
        const routeIndex = routeIndexByInput.get(
          `${prepared.match.id}:${String(inputIndex)}`,
        );
        if (routeIndex !== undefined) {
          const routeY = point.y + (prepared.lineY - point.y) *
            (routeIndex + 1) / (movedInputs.length + 1);
          if (point.y !== routeY) {
            segments.push({
              start: { x: point.x, y: point.y },
              end: { x: point.x, y: routeY },
              outcome: point.outcome,
              ownerId,
            });
          }
          segments.push({
            start: { x: point.x, y: routeY },
            end: { x: targetX, y: routeY },
            outcome: point.outcome,
            ownerId,
          });
          if (routeY !== prepared.lineY) {
            segments.push({
              start: { x: targetX, y: routeY },
              end: { x: targetX, y: prepared.lineY },
              outcome: point.outcome,
              ownerId,
            });
          }
        } else if (point.y !== prepared.lineY) {
          segments.push({
            start: { x: point.x, y: point.y },
            end: { x: targetX, y: prepared.lineY },
            outcome: point.outcome,
            ownerId,
            ...(point.slotKey === undefined
              ? {}
              : { slotAttachment: { slotKey: point.slotKey, outcome: point.outcome } }),
          });
        }
        if (targetX !== centerX) {
          segments.push({
            start: { x: targetX, y: prepared.lineY },
            end: { x: centerX, y: prepared.lineY },
            outcome: point.outcome,
            ownerId,
          });
        }
      }
      matchGeometry.set(prepared.match.id, {
        id: prepared.match.id,
        branch: prepared.branch,
        score: prepared.plan.score,
        opening: false,
        leftX,
        rightX,
        centerX,
        lineY: prepared.lineY,
      });
    }
  }

  const terminalReferences = new Map<string, Set<TournamentBracketOutcome>>();
  for (const placement of arrayValue(pool.placements, "最終順位を読み取れませんでした。")) {
    const placementReference = reference(placement.entry);
    if (placementReference === undefined) continue;
    const outcomes = terminalReferences.get(placementReference.sourceMatchId) ?? new Set();
    outcomes.add(placementReference.outcome);
    terminalReferences.set(placementReference.sourceMatchId, outcomes);
  }
  for (const matchId of terminalMatchIds) {
    const source = matchGeometry.get(matchId);
    if (source === undefined) continue;
    if (source.branch === "opening") {
      for (const outcome of terminalReferences.get(matchId) ?? []) {
        const sourceY = outcome === "winner" ? source.winnerLineY : source.loserLineY;
        if (sourceY === undefined) continue;
        const direction = outcome === "winner" ? -1 : 1;
        segments.push({
          start: { x: source.centerX, y: sourceY },
          end: { x: source.centerX, y: sourceY + direction * terminalLength },
          outcome,
          ownerId: `${matchId}:terminal:${outcome}`,
        });
      }
      continue;
    }
    const outcome: TournamentBracketOutcome = source.branch;
    const direction = outcome === "winner" ? -1 : 1;
    segments.push({
      start: { x: source.centerX, y: source.lineY },
      end: { x: source.centerX, y: source.lineY + direction * terminalLength },
      outcome,
      ownerId: `${matchId}:terminal`,
    });
  }

  const finalMatch = matches.find(
    (match) => match.rangeStart === 1 && match.rangeEnd === 2,
  );
  const thirdPlaceMatch = matches.find(
    (match) => match.rangeStart === 3 && match.rangeEnd === 4,
  );
  const sourceMatchIds = (match: ParsedMatch | undefined): Set<string> =>
    new Set(
      match === undefined
        ? []
        : [match.home, match.away].flatMap((entry) => {
            const inputReference = reference(entry);
            return inputReference === undefined ? [] : [inputReference.sourceMatchId];
          }),
    );
  const finalSourceIds = sourceMatchIds(finalMatch);
  const thirdPlaceSourceIds = sourceMatchIds(thirdPlaceMatch);
  const semifinalMatchIds = new Set(
    [...finalSourceIds].filter((matchId) => thirdPlaceSourceIds.has(matchId)),
  );
  const stageLabel = (match: ParsedMatch): string | undefined => {
    if (match.id === finalMatch?.id) return "決勝";
    if (match.id === thirdPlaceMatch?.id) return "3位決定戦";
    if (semifinalMatchIds.has(match.id)) return "準決勝";
    return undefined;
  };
  const initialMatchLabels: TournamentBracketExplorationMatchLabel[] = matches.flatMap((match) => {
    const geometry = matchGeometry.get(match.id);
    if (geometry === undefined) return [];
    const schedule = input.scheduleByMatchId?.get(match.id);
    const stage = stageLabel(match);
    const scheduleLabel = [schedule?.displayNumber, schedule?.timeLabel]
      .filter((part): part is string => part !== undefined)
      .join("　");
    const lines = [stage, scheduleLabel.length === 0 ? undefined : scheduleLabel]
      .filter((part): part is string => part !== undefined);
    if (lines.length === 0) return [];
    const lineY = geometry.opening ? geometry.winnerLineY! : geometry.lineY;
    const direction = geometry.branch === "loser" ? -1 : 1;
    const offset = orientation === "horizontal"
      ? HORIZONTAL_MATCH_LABEL_OFFSET
      : lines.length > 1 ? MULTILINE_MATCH_LABEL_OFFSET : MATCH_LABEL_OFFSET;
    const terminalIndex = Math.floor((match.rangeStart - 1) / 2);
    const terminalXOffset = terminalMatchIds.has(match.id)
      ? (terminalIndex % 2 === 0 ? 1 : -1) * TERMINAL_MATCH_LABEL_X_OFFSET
      : 0;
    return [{
      matchId: match.id,
      text: lines.join(" "),
      lines,
      center: {
        x: geometry.centerX + terminalXOffset,
        y: lineY + direction * offset,
      },
      lineY,
    }];
  });
  const matchLabels = orientation === "horizontal"
    ? arrangeHorizontalMatchLabels(initialMatchLabels, segments, slots, width, height)
    : initialMatchLabels;

  return {
    ...base,
    width: orientation === "vertical" ? width : height,
    height: orientation === "vertical" ? height : width,
    explorationGeometry: { orientation, width, height, slots, segments, matchLabels },
  };
}

export const verticalTournamentBracketLayout: TournamentBracketLayoutStrategy = {
  id: "vertical",
  build: (input) => buildExplorationModel(input, "vertical"),
};

export const horizontalTournamentBracketLayout: TournamentBracketLayoutStrategy = {
  id: "horizontal",
  build: (input) => buildExplorationModel(input, "horizontal"),
};

export function isTournamentBracketExplorationModel(
  model: TournamentBracketModel,
): model is TournamentBracketExplorationModel {
  return "explorationGeometry" in model;
}
