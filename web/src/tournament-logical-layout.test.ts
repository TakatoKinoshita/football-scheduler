import { describe, expect, it } from "vitest";

import upperSevenJson from "./fixtures/tournament-bracket-preview/upper-7-seeded.json";
import upperEightJson from "./fixtures/tournament-bracket-preview/upper-8.json";
import upperSixteenJson from "./fixtures/tournament-bracket-preview/upper-16.json";
import {
  readTournamentLogicalLayout,
  TournamentLogicalLayoutError,
} from "./tournament-logical-layout";
import type { JsonObject } from "./types";

function upperPool(fixture: unknown): JsonObject {
  const raw = fixture as { tournament_plan: { upper: JsonObject } };
  return structuredClone(raw.tournament_plan.upper);
}

describe("トーナメント論理配置契約", () => {
  it("8チームの勝者側・敗者側を鏡像として読み取る", () => {
    const layout = readTournamentLogicalLayout(upperPool(upperEightJson));

    expect(layout).toBeDefined();
    expect(layout!.layoutVersion).toBe("1");
    expect(layout!.symmetry).toBe("mirrored");
    expect(layout!.openingEntryOrder).toHaveLength(8);
    expect(layout!.matchPositions).toHaveLength(12);
    expect(layout!.branchAlignments).toHaveLength(3);
    expect(layout!.branchAlignments.every((alignment) =>
      alignment.loserToWinnerPermutation.every((value, index) => value === index + 1)
    )).toBe(true);
  });

  it("16チームの既知の順序差を置換として読み取る", () => {
    const layout = readTournamentLogicalLayout(upperPool(upperSixteenJson));
    const root = layout?.branchAlignments.find(
      (alignment) => alignment.rankRange[0] === 1 && alignment.rankRange[1] === 16,
    );

    expect(layout?.symmetry).toBe("permuted");
    expect(layout?.openingEntryOrder).toHaveLength(16);
    expect(layout?.matchPositions).toHaveLength(32);
    expect(root).toMatchObject({
      status: "permuted",
      loserToWinnerPermutation: [1, 4, 3, 8, 5, 2, 7, 6],
      diagnosticCode: "OUTCOME_BRANCH_ORDER_DIFFERS",
    });
    expect(root?.winnerSourceOrder).toEqual([
      "UT-RANK-1-16-M1",
      "UT-RANK-1-16-M5",
      "UT-RANK-1-16-M2",
      "UT-RANK-1-16-M6",
      "UT-RANK-1-16-M3",
      "UT-RANK-1-16-M4",
      "UT-RANK-1-16-M7",
      "UT-RANK-1-16-M8",
    ]);
    expect(root?.loserSourceOrder).toEqual([
      "UT-RANK-1-16-M1",
      "UT-RANK-1-16-M6",
      "UT-RANK-1-16-M2",
      "UT-RANK-1-16-M8",
      "UT-RANK-1-16-M3",
      "UT-RANK-1-16-M5",
      "UT-RANK-1-16-M7",
      "UT-RANK-1-16-M4",
    ]);
  });

  it("非2べき乗、null、フィールド欠落を旧形式として扱う", () => {
    const seven = upperPool(upperSevenJson);
    const missing = upperPool(upperEightJson);
    const nullLayout = upperPool(upperEightJson);
    delete missing.logical_layout;
    nullLayout.logical_layout = null;

    expect(readTournamentLogicalLayout(seven)).toBeUndefined();
    expect(readTournamentLogicalLayout(missing)).toBeUndefined();
    expect(readTournamentLogicalLayout(nullLayout)).toBeUndefined();
  });

  it("不完全な位置、誤った置換、矛盾した全体状態を拒否する", () => {
    const incomplete = upperPool(upperSixteenJson);
    const incompleteLayout = incomplete.logical_layout as JsonObject;
    (incompleteLayout.match_positions as JsonObject[]).pop();
    expect(() => readTournamentLogicalLayout(incomplete)).toThrow(TournamentLogicalLayoutError);

    const duplicate = upperPool(upperSixteenJson);
    const duplicateLayout = duplicate.logical_layout as JsonObject;
    const duplicatePositions = duplicateLayout.match_positions as JsonObject[];
    duplicatePositions.push(structuredClone(duplicatePositions[0]!));
    expect(() => readTournamentLogicalLayout(duplicate)).toThrow(/不足、重複/);

    const unknown = upperPool(upperSixteenJson);
    const unknownLayout = unknown.logical_layout as JsonObject;
    const unknownRoot = (unknownLayout.branch_alignments as JsonObject[])[0]!;
    (unknownRoot.winner_source_order as string[])[0] = "UNKNOWN";
    expect(() => readTournamentLogicalLayout(unknown)).toThrow(/同じ試合集合/);

    const invalidPermutation = upperPool(upperSixteenJson);
    const permutationLayout = invalidPermutation.logical_layout as JsonObject;
    const root = (permutationLayout.branch_alignments as JsonObject[])[0]!;
    root.loser_to_winner_permutation = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(() => readTournamentLogicalLayout(invalidPermutation)).toThrow(/置換情報/);

    const invalidSymmetry = upperPool(upperSixteenJson);
    const symmetryLayout = invalidSymmetry.logical_layout as JsonObject;
    symmetryLayout.symmetry = "mirrored";
    expect(() => readTournamentLogicalLayout(invalidSymmetry)).toThrow(/全体の対称性/);
  });
});
