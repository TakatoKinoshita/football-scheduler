import type { JsonObject } from "./types";

export interface NamedInput {
  id: string;
  name: string;
}

export interface ManualBlockInput {
  id: string;
  team_ids: string[];
}

export interface ManualBlockAnalysis {
  expectedBlockIds: string[];
  missingBlockIds: string[];
  unknownBlockIds: string[];
  duplicateBlockIds: string[];
  unknownTeamIds: string[];
  duplicateTeamIds: string[];
  unassignedTeamIds: string[];
  blockSizes: Record<string, number>;
  minimumSize: number;
  maximumSize: number;
  imbalancedBlockIds: string[];
  valid: boolean;
}

function objectArray(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is JsonObject =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
}

export function automaticBlockId(index: number): string {
  let result = "";
  let value = index + 1;
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode("A".charCodeAt(0) + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

export function expectedManualBlockIds(blockCount: number): string[] {
  if (!Number.isInteger(blockCount) || blockCount < 1) return [];
  return Array.from({ length: blockCount }, (_, index) => automaticBlockId(index));
}

export function manualBlocksFromUnknown(value: unknown): ManualBlockInput[] {
  return objectArray(value).map((block) => ({
    id: typeof block.id === "string" ? block.id : "",
    team_ids: Array.isArray(block.team_ids)
      ? block.team_ids.filter((teamId): teamId is string => typeof teamId === "string")
      : [],
  }));
}

/**
 * チーム追加・削除とブロック数変更で、残せる所属だけを保持する。
 * ブロック内の順番は常に参加チーム一覧の順番へ正規化する。
 */
export function reconcileManualBlocks(
  value: unknown,
  teamIds: readonly string[],
  blockCount: number,
): ManualBlockInput[] {
  const expectedBlockIds = expectedManualBlockIds(blockCount);
  const expectedBlocks = new Set(expectedBlockIds);
  const knownTeams = new Set(teamIds);
  const assignment = new Map<string, string>();
  for (const block of manualBlocksFromUnknown(value)) {
    if (!expectedBlocks.has(block.id)) continue;
    for (const teamId of block.team_ids) {
      if (knownTeams.has(teamId) && !assignment.has(teamId)) assignment.set(teamId, block.id);
    }
  }
  return expectedBlockIds.map((blockId) => ({
    id: blockId,
    team_ids: teamIds.filter((teamId) => assignment.get(teamId) === blockId),
  }));
}

export function assignmentByTeam(value: unknown): Map<string, string> {
  const result = new Map<string, string>();
  for (const block of manualBlocksFromUnknown(value)) {
    for (const teamId of block.team_ids) {
      if (!result.has(teamId)) result.set(teamId, block.id);
    }
  }
  return result;
}

export function assignTeamToBlock(
  value: unknown,
  teamIds: readonly string[],
  blockCount: number,
  teamId: string,
  blockId: string | undefined,
): ManualBlockInput[] {
  const blocks = reconcileManualBlocks(value, teamIds, blockCount);
  for (const block of blocks) {
    block.team_ids = block.team_ids.filter((candidate) => candidate !== teamId);
  }
  if (blockId !== undefined) {
    const target = blocks.find((block) => block.id === blockId);
    if (target !== undefined && teamIds.includes(teamId)) target.team_ids.push(teamId);
  }
  const order = new Map(teamIds.map((candidate, index) => [candidate, index]));
  for (const block of blocks) {
    block.team_ids.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
  }
  return blocks;
}

export function analyzeManualBlocks(
  value: unknown,
  teamIds: readonly string[],
  blockCount: number,
): ManualBlockAnalysis {
  const blocks = manualBlocksFromUnknown(value);
  const expectedBlockIds = expectedManualBlockIds(blockCount);
  const expectedBlocks = new Set(expectedBlockIds);
  const blockIds = blocks.map((block) => block.id);
  const duplicateBlockIds = [...new Set(blockIds.filter((id, index) => blockIds.indexOf(id) !== index))]
    .sort();
  const missingBlockIds = expectedBlockIds.filter((blockId) => !blockIds.includes(blockId));
  const unknownBlockIds = [...new Set(blockIds.filter((blockId) => !expectedBlocks.has(blockId)))]
    .sort();
  const knownTeams = new Set(teamIds);
  const assigned = blocks.flatMap((block) => block.team_ids);
  const unknownTeamIds = [...new Set(assigned.filter((teamId) => !knownTeams.has(teamId)))]
    .sort();
  const duplicateTeamIds = [...new Set(
    assigned.filter((teamId, index) => assigned.indexOf(teamId) !== index),
  )].sort();
  const unassignedTeamIds = teamIds.filter((teamId) => !assigned.includes(teamId));
  const blockSizes = Object.fromEntries(
    expectedBlockIds.map((blockId) => [
      blockId,
      blocks.find((block) => block.id === blockId)?.team_ids.length ?? 0,
    ]),
  );
  const minimumSize = blockCount > 0 ? Math.floor(teamIds.length / blockCount) : 0;
  const maximumSize = blockCount > 0
    ? minimumSize + (teamIds.length % blockCount === 0 ? 0 : 1)
    : 0;
  const imbalancedBlockIds = expectedBlockIds.filter((blockId) => {
    const size = blockSizes[blockId] ?? 0;
    return size < minimumSize || size > maximumSize;
  });
  const valid = expectedBlockIds.length === blockCount
    && missingBlockIds.length === 0
    && unknownBlockIds.length === 0
    && duplicateBlockIds.length === 0
    && unknownTeamIds.length === 0
    && duplicateTeamIds.length === 0
    && unassignedTeamIds.length === 0
    && imbalancedBlockIds.length === 0;
  return {
    expectedBlockIds,
    missingBlockIds,
    unknownBlockIds,
    duplicateBlockIds,
    unknownTeamIds,
    duplicateTeamIds,
    unassignedTeamIds,
    blockSizes,
    minimumSize,
    maximumSize,
    imbalancedBlockIds,
    valid,
  };
}

/**
 * 同名の既存項目を優先してIDを保ち、名称変更では同じ行のIDを使う。
 * 追加分には、その編集前にも使われていなかった新しいIDを発行する。
 */
export function reconcileNamedInputs(
  existingValue: unknown,
  names: readonly string[],
  prefix: "team" | "court",
): NamedInput[] {
  const existing = objectArray(existingValue).filter(
    (item): item is JsonObject & { id: string } => typeof item.id === "string" && item.id.length > 0,
  );
  const usedExisting = new Set<number>();
  const result: Array<NamedInput | undefined> = Array.from({ length: names.length });

  for (const [newIndex, name] of names.entries()) {
    const matchIndex = existing.findIndex(
      (item, index) => !usedExisting.has(index) && item.name === name,
    );
    if (matchIndex >= 0) {
      usedExisting.add(matchIndex);
      result[newIndex] = { id: existing[matchIndex]!.id, name };
    }
  }

  for (const [index, name] of names.entries()) {
    if (
      result[index] !== undefined ||
      existing[index] === undefined ||
      usedExisting.has(index)
    ) continue;
    usedExisting.add(index);
    result[index] = { id: existing[index].id, name };
  }

  const reserved = new Set(existing.map((item) => item.id));
  const usedIds = new Set(result.flatMap((item) => item === undefined ? [] : [item.id]));
  let candidateNumber = 1;
  for (const [index, name] of names.entries()) {
    if (result[index] !== undefined) continue;
    let id: string;
    do {
      id = `${prefix}-${String(candidateNumber).padStart(2, "0")}`;
      candidateNumber += 1;
    } while (reserved.has(id) || usedIds.has(id));
    usedIds.add(id);
    result[index] = { id, name };
  }
  return result as NamedInput[];
}
