import { describe, expect, it } from "vitest";
import type {
  TournamentResultEditorView,
  TournamentResultsRenderRow,
} from "./tournament-results-input";
import {
  createResultInputStateControl,
  type ResultInputEntryState,
} from "./result-input-state-control";
import {
  TOURNAMENT_RESULTS_CARD_BREAKPOINT_DEFAULT,
  tournamentResultsPreviewLayout,
  tournamentResultsPreviewLayouts,
} from "./tournament-results-preview-layouts";

function editor(state: string): TournamentResultEditorView {
  const regularHome = document.createElement("input");
  regularHome.className = "score-input";
  regularHome.dataset.scoreField = "regularHome";
  const regularAway = document.createElement("input");
  regularAway.className = "score-input";
  regularAway.dataset.scoreField = "regularAway";
  const penaltyHome = document.createElement("input");
  penaltyHome.className = "score-input";
  penaltyHome.dataset.scoreField = "penaltyHome";
  const penaltyAway = document.createElement("input");
  penaltyAway.className = "score-input";
  penaltyAway.dataset.scoreField = "penaltyAway";
  const regularFields = document.createElement("span");
  regularFields.append(regularHome, document.createTextNode(" - "), regularAway);
  const penaltyFields = document.createElement("span");
  penaltyFields.append(penaltyHome, document.createTextNode(" - "), penaltyAway);
  penaltyFields.hidden = true;
  const stateControl = createResultInputStateControl(state as ResultInputEntryState);
  const errorArea = document.createElement("span");
  errorArea.className = "tournament-result-error";
  return {
    regularFields,
    penaltyFields,
    stateControl,
    errorArea,
    inputs: [regularHome, regularAway, penaltyHome, penaltyAway],
  };
}

function row(ready: boolean): TournamentResultsRenderRow {
  return {
    match: {} as TournamentResultsRenderRow["match"],
    matchId: ready ? "PT-1-SF1" : "PT-1-F1",
    displayNumber: ready ? "A①" : "A②",
    timeLabel: "09:30〜10:05",
    courtName: "Aコート",
    ready,
    homeName: ready ? "チーム山の手" : "前提試合待ち",
    awayName: ready ? "Football9" : "前提試合待ち",
    editor: editor(ready ? "empty" : "waiting"),
  };
}

describe("tournament result preview layouts", () => {
  it("registers all four layout ids including the production strategy", () => {
    expect(Object.keys(tournamentResultsPreviewLayouts)).toEqual([
      "production-current",
      "compact-table",
      "integrated-status-table",
      "responsive-cards",
      "responsive-cards-quiet-table",
    ]);
    expect(tournamentResultsPreviewLayouts["production-current"].id)
      .toBe("production-current");
  });

  it("renders compact and integrated layouts with six and five columns", () => {
    const compactSection = document.createElement("section");
    tournamentResultsPreviewLayouts["compact-table"].render(compactSection, [row(true)]);
    expect(compactSection.querySelectorAll("thead th")).toHaveLength(6);
    expect(compactSection.querySelector('[data-field="result"] input')).not.toBeNull();

    const integratedSection = document.createElement("section");
    tournamentResultsPreviewLayouts["integrated-status-table"].render(
      integratedSection,
      [row(true)],
    );
    expect(integratedSection.querySelectorAll("thead th")).toHaveLength(5);
    expect(integratedSection.querySelector('[data-field="match"] [data-state="empty"]'))
      .not.toBeNull();
  });

  it("groups each score pair with a centered separator", () => {
    const section = document.createElement("section");
    tournamentResultsPreviewLayouts["integrated-status-table"].render(
      section,
      [row(true)],
    );
    const pair = section.querySelector(".results-preview-score-pair");
    expect(pair?.children).toHaveLength(3);
    expect(pair?.children[0]?.getAttribute("data-score-field")).toBe("regularHome");
    expect(pair?.children[1]?.classList.contains("results-preview-score-separator"))
      .toBe(true);
    expect(pair?.children[1]?.textContent).toBe("−");
    expect(pair?.children[2]?.getAttribute("data-score-field")).toBe("regularAway");
  });

  it("uses three-kanji visible labels while preserving full accessible names", () => {
    const saved = row(true);
    saved.editor.stateControl.setState("saved");
    const waiting = row(false);
    const section = document.createElement("section");
    tournamentResultsPreviewLayouts["integrated-status-table"].render(
      section,
      [saved, waiting],
    );
    const savedLabel = section.querySelector<HTMLElement>('[data-state="saved"]');
    expect(savedLabel?.textContent).toBe("保存済");
    expect(savedLabel?.getAttribute("aria-label")).toBe("保存済み");
    const waitingLabel = section.querySelector<HTMLElement>('[data-state="waiting"]');
    expect(waitingLabel?.textContent).toBe("待機中");
    expect(waitingLabel?.getAttribute("aria-label")).toBe("前提試合待ち");
  });

  it("does not put score inputs in candidate waiting entries", () => {
    for (const id of ["compact-table", "integrated-status-table"] as const) {
      const section = document.createElement("section");
      tournamentResultsPreviewLayouts[id].render(section, [row(false)]);
      expect(section.querySelector("input")).toBeNull();
      expect(section.textContent).toContain("前提試合の結果待ち");
    }
  });

  it("switches responsive cards at the explicit breakpoint", () => {
    const narrow = tournamentResultsPreviewLayout(
      "responsive-cards",
      TOURNAMENT_RESULTS_CARD_BREAKPOINT_DEFAULT,
    );
    const narrowSection = document.createElement("section");
    narrow?.render(narrowSection, [row(true), row(false)]);
    expect(narrowSection.dataset.responsivePresentation).toBe("cards");
    expect(narrowSection.querySelectorAll("ol > li > article")).toHaveLength(2);
    expect(narrowSection.querySelector("article fieldset legend")?.textContent)
      .toBe("試合結果");
    expect(narrowSection.querySelector('[data-match-id="PT-1-F1"] input')).toBeNull();
    expect(narrowSection.querySelector('[data-match-id="PT-1-F1"] [data-state="waiting"]')
      ?.textContent).toBe("待機中");

    const wide = tournamentResultsPreviewLayout(
      "responsive-cards",
      TOURNAMENT_RESULTS_CARD_BREAKPOINT_DEFAULT + 1,
    );
    const wideSection = document.createElement("section");
    wide?.render(wideSection, [row(true)]);
    expect(wideSection.dataset.responsivePresentation).toBe("table");
    expect(wideSection.querySelectorAll("thead th")).toHaveLength(5);
  });

  it("hides state badges only in the quiet variant table", () => {
    const narrow = tournamentResultsPreviewLayout(
      "responsive-cards-quiet-table",
      TOURNAMENT_RESULTS_CARD_BREAKPOINT_DEFAULT,
    );
    const narrowSection = document.createElement("section");
    narrow?.render(narrowSection, [row(true)]);
    expect(narrowSection.dataset.responsivePresentation).toBe("cards");
    expect(narrowSection.querySelector(".results-preview-state-label--visually-hidden"))
      .toBeNull();

    const wide = tournamentResultsPreviewLayout(
      "responsive-cards-quiet-table",
      TOURNAMENT_RESULTS_CARD_BREAKPOINT_DEFAULT + 1,
    );
    const wideSection = document.createElement("section");
    wide?.render(wideSection, [row(true)]);
    expect(wideSection.dataset.responsivePresentation).toBe("table");
    expect(wideSection.querySelector(".results-preview-state-label--visually-hidden")?.textContent)
      .toBe("未入力");
  });

  it("returns undefined for an unknown layout", () => {
    expect(tournamentResultsPreviewLayout("unknown", 768)).toBeUndefined();
  });
});
