import type { JsonObject } from "./types";

export type TournamentLogicalLayoutSymmetry = "mirrored" | "permuted";

export interface TournamentLogicalMatchPosition {
  matchId: string;
  rankRange: readonly [number, number];
  order: number;
}

export interface TournamentBranchAlignment {
  rankRange: readonly [number, number];
  status: TournamentLogicalLayoutSymmetry;
  winnerSourceOrder: readonly string[];
  loserSourceOrder: readonly string[];
  loserToWinnerPermutation: readonly number[];
  diagnosticCode: "OUTCOME_BRANCH_ORDER_DIFFERS" | null;
}

export interface TournamentLogicalLayout {
  layoutVersion: "1";
  symmetry: TournamentLogicalLayoutSymmetry;
  openingEntryOrder: readonly JsonObject[];
  matchPositions: readonly TournamentLogicalMatchPosition[];
  branchAlignments: readonly TournamentBranchAlignment[];
}

export class TournamentLogicalLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TournamentLogicalLayoutError";
  }
}

interface ParsedMatch {
  id: string;
  rankRange: readonly [number, number];
  home: JsonObject;
  away: JsonObject;
}

function objectValue(value: unknown, message: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TournamentLogicalLayoutError(message);
  }
  return value as JsonObject;
}

function objectArray(value: unknown, message: string): JsonObject[] {
  if (!Array.isArray(value)) throw new TournamentLogicalLayoutError(message);
  return value.map((item) => objectValue(item, message));
}

function textValue(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TournamentLogicalLayoutError(message);
  }
  return value;
}

function positiveInteger(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new TournamentLogicalLayoutError(message);
  }
  return value;
}

function rankRange(value: unknown, message: string): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TournamentLogicalLayoutError(message);
  }
  const start = positiveInteger(value[0], message);
  const end = positiveInteger(value[1], message);
  if (start > end) throw new TournamentLogicalLayoutError(message);
  return [start, end];
}

function rangeKey(value: readonly [number, number]): string {
  return `${String(value[0])}:${String(value[1])}`;
}

function entryKey(value: unknown): string {
  const entry = objectValue(value, "論理配置の参加枠を読み取れませんでした。");
  if (entry.type === "league_rank") {
    const blockId = textValue(entry.block_id, "ブロックIDを読み取れませんでした。");
    const rank = positiveInteger(entry.rank, "ブロック順位を読み取れませんでした。");
    return `league_rank:${blockId}:${String(rank)}`;
  }
  if (entry.type === "concrete_team") {
    return `concrete_team:${textValue(entry.team_id, "チームIDを読み取れませんでした。")}`;
  }
  if (entry.type === "winner_of" || entry.type === "loser_of") {
    return `${entry.type}:${textValue(entry.match_id, "参照元試合IDを読み取れませんでした。")}`;
  }
  throw new TournamentLogicalLayoutError("論理配置に未対応の参加枠があります。");
}

function stringOrder(value: unknown, message: string): string[] {
  if (!Array.isArray(value)) throw new TournamentLogicalLayoutError(message);
  return value.map((item) => textValue(item, message));
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function parseMatches(pool: JsonObject): ParsedMatch[] {
  return objectArray(pool.matches, "論理配置の検証対象となる試合を読み取れませんでした。").map(
    (match) => ({
      id: textValue(match.id, "試合IDを読み取れませんでした。"),
      rankRange: rankRange(match.rank_range, "試合の順位帯を読み取れませんでした。"),
      home: objectValue(match.home, "ホーム参加枠を読み取れませんでした。"),
      away: objectValue(match.away, "アウェイ参加枠を読み取れませんでした。"),
    }),
  );
}

export function readTournamentLogicalLayout(
  pool: JsonObject,
): TournamentLogicalLayout | undefined {
  if (pool.logical_layout === undefined || pool.logical_layout === null) return undefined;
  const participantCount = positiveInteger(
    pool.participant_count,
    "論理配置の参加数を読み取れませんでした。",
  );
  if (participantCount < 2 || (participantCount & (participantCount - 1)) !== 0) {
    throw new TournamentLogicalLayoutError("論理配置は2のべき乗の参加数にだけ指定できます。");
  }
  const raw = objectValue(pool.logical_layout, "トーナメントの論理配置を読み取れませんでした。");
  if (raw.layout_version !== "1") {
    throw new TournamentLogicalLayoutError("未対応の論理配置バージョンです。");
  }
  if (raw.symmetry !== "mirrored" && raw.symmetry !== "permuted") {
    throw new TournamentLogicalLayoutError("トーナメント全体の対称性を読み取れませんでした。");
  }

  const matches = parseMatches(pool);
  const matchById = new Map(matches.map((match) => [match.id, match]));
  if (matchById.size !== matches.length) {
    throw new TournamentLogicalLayoutError("論理配置の検証対象となる試合IDが重複しています。");
  }
  const matchPositions = objectArray(
    raw.match_positions,
    "論理配置の試合位置を読み取れませんでした。",
  ).map((position): TournamentLogicalMatchPosition => ({
    matchId: textValue(position.match_id, "論理配置の試合IDを読み取れませんでした。"),
    rankRange: rankRange(position.rank_range, "論理配置の順位帯を読み取れませんでした。"),
    order: positiveInteger(position.order, "論理配置の試合順を読み取れませんでした。"),
  }));
  const positionById = new Map(matchPositions.map((position) => [position.matchId, position]));
  if (
    positionById.size !== matchPositions.length ||
    positionById.size !== matchById.size ||
    [...matchById.keys()].some((matchId) => !positionById.has(matchId))
  ) {
    throw new TournamentLogicalLayoutError("論理配置の試合位置に不足、重複または未知の参照があります。");
  }

  const positionsByRange = new Map<string, TournamentLogicalMatchPosition[]>();
  for (const position of matchPositions) {
    const match = matchById.get(position.matchId);
    if (match === undefined || rangeKey(match.rankRange) !== rangeKey(position.rankRange)) {
      throw new TournamentLogicalLayoutError("論理配置の順位帯が試合と一致しません。");
    }
    const key = rangeKey(position.rankRange);
    positionsByRange.set(key, [...(positionsByRange.get(key) ?? []), position]);
  }
  for (const positions of positionsByRange.values()) {
    const orders = positions.map((position) => position.order).sort((left, right) => left - right);
    if (orders.some((order, index) => order !== index + 1)) {
      throw new TournamentLogicalLayoutError("同一順位帯の論理順に不足または重複があります。");
    }
  }

  const orderedMatches = (value: readonly [number, number]): ParsedMatch[] =>
    [...(positionsByRange.get(rangeKey(value)) ?? [])]
      .sort((left, right) => left.order - right.order)
      .map((position) => matchById.get(position.matchId)!);

  const openingEntryOrder = objectArray(
    raw.opening_entry_order,
    "初戦参加枠の論理順を読み取れませんでした。",
  );
  const expectedOpeningEntries = orderedMatches([1, participantCount]).flatMap((match) => [
    match.home,
    match.away,
  ]);
  const openingKeys = openingEntryOrder.map(entryKey);
  if (
    openingEntryOrder.length !== participantCount ||
    new Set(openingKeys).size !== participantCount ||
    !sameOrder(openingKeys, expectedOpeningEntries.map(entryKey))
  ) {
    throw new TournamentLogicalLayoutError("初戦参加枠の論理順が試合位置と一致しません。");
  }

  const branchAlignments = objectArray(
    raw.branch_alignments,
    "勝敗分岐の論理対応を読み取れませんでした。",
  ).map((alignment): TournamentBranchAlignment => {
    const alignmentRange = rankRange(
      alignment.rank_range,
      "勝敗分岐の順位帯を読み取れませんでした。",
    );
    const status = alignment.status;
    if (status !== "mirrored" && status !== "permuted") {
      throw new TournamentLogicalLayoutError("勝敗分岐の対称性を読み取れませんでした。");
    }
    const winnerSourceOrder = stringOrder(
      alignment.winner_source_order,
      "勝者側の論理順を読み取れませんでした。",
    );
    const loserSourceOrder = stringOrder(
      alignment.loser_source_order,
      "敗者側の論理順を読み取れませんでした。",
    );
    if (
      winnerSourceOrder.length < 2 ||
      new Set(winnerSourceOrder).size !== winnerSourceOrder.length ||
      loserSourceOrder.length !== winnerSourceOrder.length ||
      new Set(loserSourceOrder).size !== loserSourceOrder.length ||
      loserSourceOrder.some((matchId) => !winnerSourceOrder.includes(matchId))
    ) {
      throw new TournamentLogicalLayoutError("勝敗側の論理順が同じ試合集合になっていません。");
    }
    if (!Array.isArray(alignment.loser_to_winner_permutation)) {
      throw new TournamentLogicalLayoutError("勝敗側の置換情報を読み取れませんでした。");
    }
    const loserToWinnerPermutation = alignment.loser_to_winner_permutation.map((value) =>
      positiveInteger(value, "勝敗側の置換情報を読み取れませんでした。"),
    );
    const expectedPermutation = loserSourceOrder.map(
      (matchId) => winnerSourceOrder.indexOf(matchId) + 1,
    );
    if (
      loserToWinnerPermutation.length !== expectedPermutation.length ||
      loserToWinnerPermutation.some((value, index) => value !== expectedPermutation[index])
    ) {
      throw new TournamentLogicalLayoutError("勝敗側の論理順と置換情報が一致しません。");
    }
    const mirrored = expectedPermutation.every((value, index) => value === index + 1);
    const expectedStatus = mirrored ? "mirrored" : "permuted";
    const expectedDiagnostic: TournamentBranchAlignment["diagnosticCode"] = mirrored
      ? null
      : "OUTCOME_BRANCH_ORDER_DIFFERS";
    if (status !== expectedStatus || alignment.diagnostic_code !== expectedDiagnostic) {
      throw new TournamentLogicalLayoutError("勝敗側の対称性と診断情報が一致しません。");
    }
    return {
      rankRange: alignmentRange,
      status,
      winnerSourceOrder,
      loserSourceOrder,
      loserToWinnerPermutation,
      diagnosticCode: expectedDiagnostic,
    };
  });

  const alignmentByRange = new Map(
    branchAlignments.map((alignment) => [rangeKey(alignment.rankRange), alignment]),
  );
  const expectedAlignmentKeys = new Set(
    [...positionsByRange.keys()].filter((key) => {
      const [start, end] = key.split(":").map(Number) as [number, number];
      return end - start + 1 >= 4;
    }),
  );
  if (
    alignmentByRange.size !== branchAlignments.length ||
    alignmentByRange.size !== expectedAlignmentKeys.size ||
    [...expectedAlignmentKeys].some((key) => !alignmentByRange.has(key))
  ) {
    throw new TournamentLogicalLayoutError("勝敗分岐の論理対応に不足または未知の順位帯があります。");
  }

  for (const alignment of branchAlignments) {
    const [start, end] = alignment.rankRange;
    const half = (end - start + 1) / 2;
    const sourceIds = new Set(orderedMatches(alignment.rankRange).map((match) => match.id));
    const sourceOrder = (
      childRange: readonly [number, number],
      expectedType: "winner_of" | "loser_of",
    ): string[] =>
      orderedMatches(childRange).flatMap((match) =>
        [match.home, match.away].map((entry) => {
          if (
            entry.type !== expectedType ||
            typeof entry.match_id !== "string" ||
            !sourceIds.has(entry.match_id)
          ) {
            throw new TournamentLogicalLayoutError(
              "勝敗分岐が親順位帯の試合を正しく参照していません。",
            );
          }
          return entry.match_id;
        }),
      );
    const expectedWinnerOrder = sourceOrder([start, start + half - 1], "winner_of");
    const expectedLoserOrder = sourceOrder([start + half, end], "loser_of");
    if (
      !sameOrder(alignment.winnerSourceOrder, expectedWinnerOrder) ||
      !sameOrder(alignment.loserSourceOrder, expectedLoserOrder)
    ) {
      throw new TournamentLogicalLayoutError("勝敗分岐の論理順が実際の試合参照と一致しません。");
    }
  }

  const expectedSymmetry = branchAlignments.some((alignment) => alignment.status === "permuted")
    ? "permuted"
    : "mirrored";
  if (raw.symmetry !== expectedSymmetry) {
    throw new TournamentLogicalLayoutError(
      "分岐ごとの状態とトーナメント全体の対称性が一致しません。",
    );
  }
  return {
    layoutVersion: "1",
    symmetry: raw.symmetry,
    openingEntryOrder,
    matchPositions,
    branchAlignments,
  };
}
