import { describe, expect, it, vi } from "vitest";

import { TournamentResultDraftController } from "./tournament-result-drafts";
import { tournamentResultsPreviewScenario } from "./tournament-results-preview-fixtures";
import {
  renderTournamentResultsInput,
  responsiveTournamentResultsLayout,
  type TournamentResultsInputHost,
} from "./tournament-results-input";
import type { JsonObject } from "./types";

function dispatchScore(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.focus();
  input.setSelectionRange(value.length, value.length);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("順位決定トーナメント結果入力", () => {
  it("保存済み結果のdraftだけを状態メニューから破棄し、正式結果・後続結果・他draftを保持する", async () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    const scenario = tournamentResultsPreviewScenario("winner-change")!;
    const drafts = new TournamentResultDraftController();
    drafts.activate("discard-saved-test");
    const otherMatchId = "PT-2-RANK-7-8-M1";
    drafts.set(otherMatchId, {
      regularHome: "",
      regularAway: "2",
      penaltyHome: "",
      penaltyAway: "",
    });
    const originalResults = structuredClone(scenario.results) as JsonObject[];
    const persistedDrafts: Array<ReturnType<TournamentResultDraftController["snapshot"]>> = [];
    let releaseDraftSave: (() => void) | undefined;
    const persistDrafts = vi.fn((state: ReturnType<TournamentResultDraftController["snapshot"]>) => {
      persistedDrafts.push(state);
      if (persistedDrafts.length !== 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        releaseDraftSave = resolve;
      });
    });
    const host: TournamentResultsInputHost = {
      drafts,
      currentResults: () => originalResults,
      persistDrafts,
      commitResults: vi.fn(),
      setSaveStatus: vi.fn(),
      announce: vi.fn(),
      refreshCompletion: vi.fn(),
      rerender: vi.fn(),
    };
    const content = document.createElement("div");
    document.body.append(content);
    renderTournamentResultsInput({
      content,
      plan: scenario.plan,
      results: originalResults,
      schedule: scenario.schedule,
      teamNames: new Map(scenario.teams.map((team) => [team.id, team.name])),
      layout: responsiveTournamentResultsLayout("table"),
      host,
    });
    const matchId = "PT-1-RANK-3-4-M1";
    const row = content.querySelector<HTMLElement>(
      `.result-input-entry[data-match-id="${matchId}"]`,
    )!;
    const regularHome = row.querySelector<HTMLInputElement>(
      'input[data-score-field="regularHome"]',
    )!;
    regularHome.value = "";
    regularHome.focus();
    regularHome.setSelectionRange(0, 0);
    regularHome.dispatchEvent(new Event("input", { bubbles: true }));

    const action = row.querySelector<HTMLButtonElement>(".result-input-draft-action")!;
    expect(action.textContent).toBe("保存済の得点に戻す");
    expect(action.getAttribute("aria-label")).toBe(
      "試合番号 C②、チーム6 対 北町サッカー：保存済の得点に戻す",
    );
    expect(row.querySelector(".result-input-state-trigger")).not.toBeNull();
    await vi.waitFor(() => expect(persistDrafts).toHaveBeenCalledTimes(1));
    action.click();
    await Promise.resolve();
    expect(persistDrafts).toHaveBeenCalledTimes(1);
    expect(drafts.get(matchId)).toBeDefined();
    expect(row.getAttribute("aria-busy")).toBe("true");
    releaseDraftSave!();

    await vi.waitFor(() => expect(drafts.get(matchId)).toBeUndefined());
    expect(regularHome.value).toBe("0");
    expect(row.querySelector(".result-input-state-trigger")).toBeNull();
    expect(row.querySelector(".tournament-result-state-label")?.textContent).toBe("保存済");
    expect(document.activeElement).toBe(regularHome);
    expect(regularHome.selectionStart).toBe(0);
    expect(row.hasAttribute("aria-busy")).toBe(false);
    expect(drafts.get(otherMatchId)).toEqual({
      regularHome: "",
      regularAway: "2",
      penaltyHome: "",
      penaltyAway: "",
    });
    expect(persistedDrafts.at(-1)?.drafts).toEqual({
      [otherMatchId]: {
        regularHome: "",
        regularAway: "2",
        penaltyHome: "",
        penaltyAway: "",
      },
    });
    expect(host.commitResults).not.toHaveBeenCalled();
    expect(host.rerender).not.toHaveBeenCalled();
    expect(host.refreshCompletion).toHaveBeenCalled();
    expect(originalResults).toEqual(scenario.results);
    scrollTo.mockRestore();
  });

  it("未保存試合では入力クリアを表示し、draft永続化失敗時は値と操作を保持する", async () => {
    const scenario = tournamentResultsPreviewScenario("mixed")!;
    const matchId = "PT-2-RANK-5-8-M1";
    const drafts = new TournamentResultDraftController();
    drafts.activate("discard-unsaved-failure-test", {
      [matchId]: scenario.drafts[matchId]!,
    });
    const persistDrafts = vi.fn(async () => {
      throw new Error("draft storage failure");
    });
    const host: TournamentResultsInputHost = {
      drafts,
      currentResults: () => scenario.results,
      persistDrafts,
      commitResults: vi.fn(),
      setSaveStatus: vi.fn(),
      announce: vi.fn(),
      refreshCompletion: vi.fn(),
      rerender: vi.fn(),
    };
    const content = document.createElement("div");
    document.body.append(content);
    renderTournamentResultsInput({
      content,
      plan: scenario.plan,
      results: scenario.results,
      schedule: scenario.schedule,
      teamNames: new Map(scenario.teams.map((team) => [team.id, team.name])),
      layout: responsiveTournamentResultsLayout("table"),
      host,
    });
    const row = content.querySelector<HTMLElement>(
      `.result-input-entry[data-match-id="${matchId}"]`,
    )!;
    const regularHome = row.querySelector<HTMLInputElement>(
      'input[data-score-field="regularHome"]',
    )!;
    const action = row.querySelector<HTMLButtonElement>(".result-input-draft-action")!;
    expect(action.textContent).toBe("入力をクリア");
    expect(action.getAttribute("aria-label")).toBe(
      "試合番号 B①、チーム3 対 チーム8：入力をクリア",
    );
    action.click();

    await vi.waitFor(() => expect(host.announce).toHaveBeenCalledWith(
      "入力途中の変更を破棄できませんでした。入力内容は保持されています。もう一度お試しください。",
    ));
    expect(drafts.get(matchId)).toEqual(scenario.drafts[matchId]);
    expect(regularHome.value).toBe("2");
    expect(row.querySelector(".result-input-draft-action")?.textContent).toBe("入力をクリア");
    expect(row.hasAttribute("aria-busy")).toBe(false);
    expect(regularHome.disabled).toBe(false);
    expect(host.commitResults).not.toHaveBeenCalled();
    expect(host.rerender).not.toHaveBeenCalled();
  });

  it("複数行の保存を直列化し、実行時の結果とdraftから次のatomic保存を組み立てる", async () => {
    const scenario = tournamentResultsPreviewScenario("winner-change")!;
    const drafts = new TournamentResultDraftController();
    drafts.activate("queue-test");
    let currentResults = structuredClone(scenario.results) as JsonObject[];
    const pendingCommits: Array<{
      results: JsonObject[];
      resolve: () => void;
    }> = [];
    const persistedDrafts: Array<ReturnType<TournamentResultDraftController["snapshot"]>> = [];
    const host: TournamentResultsInputHost = {
      drafts,
      currentResults: () => currentResults,
      persistDrafts: async (state) => {
        persistedDrafts.push(state);
      },
      commitResults: vi.fn((results) => new Promise<void>((resolve) => {
        pendingCommits.push({
          results: structuredClone(results) as JsonObject[],
          resolve: () => {
            currentResults = structuredClone(results) as JsonObject[];
            resolve();
          },
        });
      })),
      setSaveStatus: vi.fn(),
      announce: vi.fn(),
      refreshCompletion: vi.fn(),
      rerender: vi.fn(),
    };
    const content = document.createElement("div");
    document.body.append(content);
    renderTournamentResultsInput({
      content,
      plan: scenario.plan,
      results: currentResults,
      schedule: scenario.schedule,
      teamNames: new Map(scenario.teams.map((team) => [team.id, team.name])),
      layout: responsiveTournamentResultsLayout("table"),
      host,
    });
    const input = (matchId: string, field: string): HTMLInputElement =>
      content.querySelector<HTMLInputElement>(
        `.result-input-entry[data-match-id="${matchId}"] input[data-score-field="${field}"]`,
      )!;

    dispatchScore(input("PT-1-RANK-3-4-M1", "regularAway"), "2");
    await vi.waitFor(() => expect(pendingCommits).toHaveLength(1));
    dispatchScore(input("PT-2-RANK-7-8-M1", "regularAway"), "3");
    await Promise.resolve();
    expect(pendingCommits).toHaveLength(1);

    pendingCommits[0]!.resolve();
    await vi.waitFor(() => expect(pendingCommits).toHaveLength(2));
    expect(persistedDrafts.at(-1)?.drafts).toHaveProperty("PT-2-RANK-7-8-M1");
    const secondResults = pendingCommits[1]!.results;
    expect(secondResults.find((item) => item.match_id === "PT-1-RANK-3-4-M1"))
      .toMatchObject({ regular_score_away: 2 });
    expect(secondResults.find((item) => item.match_id === "PT-2-RANK-7-8-M1"))
      .toMatchObject({ regular_score_away: 3 });

    const liveFocus = input("PT-2-RANK-5-6-M1", "regularHome");
    liveFocus.focus();
    liveFocus.setSelectionRange(1, 1);
    pendingCommits[1]!.resolve();
    await vi.waitFor(() => expect(host.rerender).toHaveBeenCalledTimes(1));
    expect(host.rerender).toHaveBeenCalledWith(expect.objectContaining({
      matchId: "PT-2-RANK-5-6-M1",
      scoreField: "regularHome",
      selectionStart: 1,
      selectionEnd: 1,
    }));
    expect(drafts.snapshot()).toBeUndefined();
    expect(currentResults.find((item) => item.match_id === "PT-1-RANK-3-4-M1"))
      .toMatchObject({ regular_score_away: 2 });
    expect(currentResults.find((item) => item.match_id === "PT-2-RANK-7-8-M1"))
      .toMatchObject({ regular_score_away: 3 });
  });

  it("draft永続化の完了前に正式結果のatomic保存を開始する", async () => {
    const scenario = tournamentResultsPreviewScenario("winner-change")!;
    const drafts = new TournamentResultDraftController();
    drafts.activate("immediate-commit-test");
    let releaseDraftPersistence: (() => void) | undefined;
    const draftPersistence = new Promise<void>((resolve) => {
      releaseDraftPersistence = resolve;
    });
    const host: TournamentResultsInputHost = {
      drafts,
      currentResults: () => scenario.results,
      persistDrafts: vi.fn(() => draftPersistence),
      commitResults: vi.fn(async () => undefined),
      setSaveStatus: vi.fn(),
      announce: vi.fn(),
      refreshCompletion: vi.fn(),
      rerender: vi.fn(),
    };
    const content = document.createElement("div");
    document.body.append(content);
    renderTournamentResultsInput({
      content,
      plan: scenario.plan,
      results: scenario.results,
      schedule: scenario.schedule,
      teamNames: new Map(scenario.teams.map((team) => [team.id, team.name])),
      layout: responsiveTournamentResultsLayout("table"),
      host,
    });
    const input = content.querySelector<HTMLInputElement>(
      '.result-input-entry[data-match-id="PT-1-RANK-3-4-M1"] input[data-score-field="regularAway"]',
    )!;

    dispatchScore(input, "2");

    await vi.waitFor(() => expect(host.commitResults).toHaveBeenCalledTimes(1));
    expect(host.persistDrafts).toHaveBeenCalled();
    releaseDraftPersistence!();
  });

  it("先行保存が失敗しても後続を実行し、失敗draftと最終focusを保持する", async () => {
    const scenario = tournamentResultsPreviewScenario("winner-change")!;
    const drafts = new TournamentResultDraftController();
    drafts.activate("queue-failure-test");
    let currentResults = structuredClone(scenario.results) as JsonObject[];
    const settle: Array<{ reject: () => void; resolve: () => void }> = [];
    const host: TournamentResultsInputHost = {
      drafts,
      currentResults: () => currentResults,
      persistDrafts: async () => undefined,
      commitResults: vi.fn((results) => new Promise<void>((resolve, reject) => {
        settle.push({
          reject: () => reject(new Error("保存失敗")),
          resolve: () => {
            currentResults = structuredClone(results) as JsonObject[];
            resolve();
          },
        });
      })),
      setSaveStatus: vi.fn(),
      announce: vi.fn(),
      refreshCompletion: vi.fn(),
      rerender: vi.fn(),
    };
    const content = document.createElement("div");
    document.body.append(content);
    renderTournamentResultsInput({
      content,
      plan: scenario.plan,
      results: currentResults,
      schedule: scenario.schedule,
      teamNames: new Map(scenario.teams.map((team) => [team.id, team.name])),
      layout: responsiveTournamentResultsLayout("table"),
      host,
    });
    const input = (matchId: string): HTMLInputElement => content.querySelector<HTMLInputElement>(
      `.result-input-entry[data-match-id="${matchId}"] input[data-score-field="regularAway"]`,
    )!;

    dispatchScore(input("PT-1-RANK-3-4-M1"), "2");
    dispatchScore(input("PT-2-RANK-7-8-M1"), "3");
    await vi.waitFor(() => expect(settle).toHaveLength(1));
    settle[0]!.reject();
    await vi.waitFor(() => expect(settle).toHaveLength(2));
    settle[1]!.resolve();

    await vi.waitFor(() => expect(host.rerender).toHaveBeenCalledTimes(1));
    expect(drafts.get("PT-1-RANK-3-4-M1")).toBeDefined();
    expect(drafts.get("PT-2-RANK-7-8-M1")).toBeUndefined();
    expect(host.setSaveStatus).toHaveBeenLastCalledWith("保存できませんでした");
    expect(host.announce).toHaveBeenLastCalledWith(
      "試合結果を保存できませんでした。入力途中の変更と以前の結果は保持されています。",
    );
    expect(host.rerender).toHaveBeenLastCalledWith(expect.objectContaining({
      matchId: "PT-2-RANK-7-8-M1",
      scoreField: "regularAway",
    }));
  });
});
