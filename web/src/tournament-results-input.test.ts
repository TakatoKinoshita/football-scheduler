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

    pendingCommits[1]!.resolve();
    await vi.waitFor(() => expect(host.rerender).toHaveBeenCalledTimes(1));
    expect(host.rerender).toHaveBeenCalledWith(expect.objectContaining({
      matchId: "PT-2-RANK-7-8-M1",
      scoreField: "regularAway",
    }));
    expect(drafts.snapshot()).toBeUndefined();
    expect(currentResults.find((item) => item.match_id === "PT-1-RANK-3-4-M1"))
      .toMatchObject({ regular_score_away: 2 });
    expect(currentResults.find((item) => item.match_id === "PT-2-RANK-7-8-M1"))
      .toMatchObject({ regular_score_away: 3 });
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
