import { describe, expect, it } from "vitest";

import {
  evaluateTournamentResultDraft,
  TournamentResultDraftController,
  tournamentPlanFingerprint,
  type TournamentResultDraft,
} from "./tournament-result-drafts";

const draft = (values: Partial<TournamentResultDraft> = {}): TournamentResultDraft => ({
  regularHome: "",
  regularAway: "",
  penaltyHome: "",
  penaltyAway: "",
  ...values,
});

describe("トーナメント結果draft", () => {
  it("通常得点またはPKの片側だけなら入力中として扱う", () => {
    expect(evaluateTournamentResultDraft(draft({ regularHome: "1" }))).toEqual({
      status: "inputting",
      penaltyRequired: false,
    });
    expect(evaluateTournamentResultDraft(draft({
      regularHome: "1",
      regularAway: "1",
      penaltyHome: "4",
    }))).toEqual({ status: "inputting", penaltyRequired: true });
  });

  it("両側が揃ってから整数とPK勝敗を検証する", () => {
    expect(evaluateTournamentResultDraft(draft({ regularHome: "-1", regularAway: "0" })))
      .toMatchObject({ status: "invalid", message: expect.stringContaining("通常得点") });
    expect(evaluateTournamentResultDraft(draft({
      regularHome: "1",
      regularAway: "1",
      penaltyHome: "3",
      penaltyAway: "3",
    }))).toMatchObject({ status: "invalid", message: expect.stringContaining("勝敗") });
    expect(evaluateTournamentResultDraft(draft({ regularHome: "2", regularAway: "1" })))
      .toEqual({
        status: "ready",
        penaltyRequired: false,
        regularHome: 2,
        regularAway: 1,
      });
  });

  it("plan fingerprintはキー順に依存せず、内容変更で変化する", () => {
    const left = tournamentPlanFingerprint({ status: "COMPLETE", pools: [{ pool_id: "one" }] });
    const reordered = tournamentPlanFingerprint({ pools: [{ pool_id: "one" }], status: "COMPLETE" });
    const changed = tournamentPlanFingerprint({ pools: [{ pool_id: "two" }], status: "COMPLETE" });

    expect(reordered).toBe(left);
    expect(changed).not.toBe(left);
  });

  it("復元値をコピーし、snapshotにも参照を漏らさない", () => {
    const controller = new TournamentResultDraftController();
    const restored = { "PT-1": draft({ regularHome: "1" }) };
    controller.activate("plan-one", restored);
    restored["PT-1"].regularHome = "9";

    expect(controller.get("PT-1")?.regularHome).toBe("1");
    const snapshot = controller.snapshot();
    expect(snapshot).toEqual({ planFingerprint: "plan-one", drafts: {
      "PT-1": draft({ regularHome: "1" }),
    } });
    snapshot!.drafts["PT-1"]!.regularHome = "8";
    expect(controller.get("PT-1")?.regularHome).toBe("1");
  });

  it("確定した試合と影響を受ける後続だけを削除できる", () => {
    const controller = new TournamentResultDraftController();
    controller.activate("plan-one", {
      first: draft({ regularHome: "1" }),
      child: draft({ regularHome: "2" }),
      other: draft({ regularHome: "3" }),
    });

    controller.delete("first");
    controller.deleteMany(["child"]);

    expect(controller.snapshot()?.drafts).toEqual({
      other: draft({ regularHome: "3" }),
    });
  });
});
