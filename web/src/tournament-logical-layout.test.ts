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

  it("16チームの全分岐を鏡像として読み取る", () => {
    const layout = readTournamentLogicalLayout(upperPool(upperSixteenJson));

    expect(layout?.symmetry).toBe("mirrored");
    expect(layout?.openingEntryOrder).toHaveLength(16);
    expect(layout?.matchPositions).toHaveLength(32);
    expect(layout?.branchAlignments).toHaveLength(7);
    expect(layout?.branchAlignments.every((alignment) =>
      alignment.status === "mirrored" &&
      alignment.diagnosticCode === null &&
      alignment.loserToWinnerPermutation.every((value, index) => value === index + 1)
    )).toBe(true);
  });

  it("敗者側参照が異なる旧permutedデータを読み取る", () => {
    const legacy = upperPool(upperSixteenJson);
    const matches = legacy.matches as JsonObject[];
    const loserMatch = matches.find((match) => {
      const range = match.rank_range as number[];
      return range[0] === 9 && range[1] === 16;
    })!;
    [loserMatch.home, loserMatch.away] = [loserMatch.away, loserMatch.home];
    const layout = legacy.logical_layout as JsonObject;
    const root = (layout.branch_alignments as JsonObject[]).find((alignment) => {
      const range = alignment.rank_range as number[];
      return range[0] === 1 && range[1] === 16;
    })!;
    const loserOrder = [...(root.winner_source_order as string[])];
    [loserOrder[0], loserOrder[1]] = [loserOrder[1]!, loserOrder[0]!];
    root.status = "permuted";
    root.loser_source_order = loserOrder;
    root.loser_to_winner_permutation = [2, 1, 3, 4, 5, 6, 7, 8];
    root.diagnostic_code = "OUTCOME_BRANCH_ORDER_DIFFERS";
    layout.symmetry = "permuted";

    const restored = readTournamentLogicalLayout(legacy);

    expect(restored?.symmetry).toBe("permuted");
    expect(restored?.branchAlignments.find((alignment) =>
      alignment.rankRange[0] === 1 && alignment.rankRange[1] === 16
    )).toMatchObject({
      status: "permuted",
      loserToWinnerPermutation: [2, 1, 3, 4, 5, 6, 7, 8],
      diagnosticCode: "OUTCOME_BRANCH_ORDER_DIFFERS",
    });
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
    root.loser_to_winner_permutation = [2, 1, 3, 4, 5, 6, 7, 8];
    expect(() => readTournamentLogicalLayout(invalidPermutation)).toThrow(/置換情報/);

    const invalidSymmetry = upperPool(upperSixteenJson);
    const symmetryLayout = invalidSymmetry.logical_layout as JsonObject;
    symmetryLayout.symmetry = "permuted";
    expect(() => readTournamentLogicalLayout(invalidSymmetry)).toThrow(/全体の対称性/);
  });
});
