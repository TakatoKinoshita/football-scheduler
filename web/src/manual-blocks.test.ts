import { describe, expect, it } from "vitest";

import {
  analyzeManualBlocks,
  assignTeamToBlock,
  expectedManualBlockIds,
  reconcileManualBlocks,
  reconcileNamedInputs,
} from "./manual-blocks";

describe("手動ブロック割当て", () => {
  it("26を超えるブロックIDも決定的に生成する", () => {
    expect(expectedManualBlockIds(28).slice(24)).toEqual(["Y", "Z", "AA", "AB"]);
  });

  it("削除ブロックだけを解除し、追加ブロックを空で作る", () => {
    const existing = [
      { id: "A", team_ids: ["T1", "T2"] },
      { id: "B", team_ids: ["T3", "T4"] },
    ];

    expect(reconcileManualBlocks(existing, ["T1", "T2", "T3", "T4"], 1)).toEqual([
      { id: "A", team_ids: ["T1", "T2"] },
    ]);
    expect(reconcileManualBlocks(existing, ["T1", "T2", "T3", "T4"], 3)).toEqual([
      { id: "A", team_ids: ["T1", "T2"] },
      { id: "B", team_ids: ["T3", "T4"] },
      { id: "C", team_ids: [] },
    ]);
  });

  it("チームを一度に1ブロックだけへ割り当て、参加順を保つ", () => {
    let blocks = reconcileManualBlocks([], ["T1", "T2", "T3"], 2);
    blocks = assignTeamToBlock(blocks, ["T1", "T2", "T3"], 2, "T3", "A");
    blocks = assignTeamToBlock(blocks, ["T1", "T2", "T3"], 2, "T1", "A");
    blocks = assignTeamToBlock(blocks, ["T1", "T2", "T3"], 2, "T3", "B");

    expect(blocks).toEqual([
      { id: "A", team_ids: ["T1"] },
      { id: "B", team_ids: ["T3"] },
    ]);
  });

  it("未割当て、不正参照、重複、人数不均衡を分析する", () => {
    const analysis = analyzeManualBlocks(
      [
        { id: "A", team_ids: ["T1", "T1", "unknown"] },
        { id: "C", team_ids: ["T2"] },
      ],
      ["T1", "T2", "T3", "T4"],
      2,
    );

    expect(analysis).toMatchObject({
      missingBlockIds: ["B"],
      unknownBlockIds: ["C"],
      unknownTeamIds: ["unknown"],
      duplicateTeamIds: ["T1"],
      unassignedTeamIds: ["T3", "T4"],
      valid: false,
    });
  });

  it("人数差1以内だけを有効とする", () => {
    expect(analyzeManualBlocks([
      { id: "A", team_ids: ["T1", "T3", "T5"] },
      { id: "B", team_ids: ["T2", "T4"] },
    ], ["T1", "T2", "T3", "T4", "T5"], 2).valid).toBe(true);
    expect(analyzeManualBlocks([
      { id: "A", team_ids: ["T1", "T2", "T3", "T4"] },
      { id: "B", team_ids: ["T5"] },
    ], ["T1", "T2", "T3", "T4", "T5"], 2).imbalancedBlockIds).toEqual(["A", "B"]);
  });

  it("不足は自動補完可能とし、人数超過だけを補完不能にする", () => {
    expect(analyzeManualBlocks([
      { id: "A", team_ids: ["T1"] },
      { id: "B", team_ids: [] },
    ], ["T1", "T2", "T3", "T4", "T5"], 2)).toMatchObject({
      unassignedTeamIds: ["T2", "T3", "T4", "T5"],
      completionPossible: true,
      valid: false,
    });
    expect(analyzeManualBlocks([
      { id: "A", team_ids: ["T1", "T2", "T3", "T4"] },
      { id: "B", team_ids: [] },
    ], ["T1", "T2", "T3", "T4", "T5"], 2)).toMatchObject({
      overCapacityBlockIds: ["A"],
      completionPossible: false,
    });
  });

  it("大人数側ブロックの上限超過を補完不能にする", () => {
    const analysis = analyzeManualBlocks([
      { id: "A", team_ids: ["T1", "T2"] },
      { id: "B", team_ids: ["T3", "T4"] },
      { id: "C", team_ids: ["T5", "T6"] },
      { id: "D", team_ids: [] },
    ], ["T1", "T2", "T3", "T4", "T5", "T6"], 4);

    expect(analysis.maximumLargeBlockCount).toBe(2);
    expect(analysis.excessLargeBlockIds).toEqual(["C"]);
    expect(analysis.completionPossible).toBe(false);
  });
});

describe("入力IDの維持", () => {
  const existing = [
    { id: "blue", name: "青" },
    { id: "red", name: "赤" },
    { id: "green", name: "緑" },
  ];

  it("並べ替え、追加、削除で同名チームのIDを保持する", () => {
    expect(reconcileNamedInputs(existing, ["緑", "青", "白"], "team")).toEqual([
      { id: "green", name: "緑" },
      { id: "blue", name: "青" },
      { id: "team-01", name: "白" },
    ]);
  });

  it("同数の名称変更では同じ行のIDを保持する", () => {
    expect(reconcileNamedInputs(existing, ["青", "紅", "緑"], "team")).toEqual([
      { id: "blue", name: "青" },
      { id: "red", name: "紅" },
      { id: "green", name: "緑" },
    ]);
  });

  it("名称変更と末尾追加を同時に行っても既存行のIDを保持する", () => {
    expect(reconcileNamedInputs(existing, ["青空", "赤", "緑", "白"], "team")).toEqual([
      { id: "blue", name: "青空" },
      { id: "red", name: "赤" },
      { id: "green", name: "緑" },
      { id: "team-01", name: "白" },
    ]);
  });
});
