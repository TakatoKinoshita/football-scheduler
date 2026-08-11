import { afterEach, describe, expect, it, vi } from "vitest";

import {
  observeResultInputPresentation,
  renderIntegratedResultInputTable,
  renderResultInputCards,
  resultInputPresentationForWidth,
  type ResultInputRenderRow,
} from "./result-input-layout";
import { restoreResultInputFocus } from "./result-input-engine";
import { restoreTournamentScoreFocus } from "./tournament-results-input";

function row(ready = true): ResultInputRenderRow {
  const regularFields = document.createElement("span");
  for (const name of ["home", "away"]) {
    const input = document.createElement("input");
    input.setAttribute("aria-label", name);
    regularFields.append(input);
  }
  const stateLabel = document.createElement("span");
  stateLabel.className = "tournament-result-state-label";
  stateLabel.dataset.state = ready ? "saved" : "waiting";
  stateLabel.textContent = ready ? "保存済" : "待機中";
  const cancelDraft = document.createElement("button");
  cancelDraft.hidden = true;
  return {
    matchId: "M-1",
    displayNumber: "A①",
    timeLabel: "09:30〜10:05",
    courtName: "Aコート",
    ready,
    homeName: "チーム甲",
    awayName: "チーム乙",
    editor: {
      regularFields,
      penaltyFields: document.createElement("span"),
      stateLabel,
      errorArea: document.createElement("span"),
      cancelDraft,
      inputs: [...regularFields.querySelectorAll("input")],
    },
  };
}

describe("共通結果入力layout", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("900pxを境界にカードと5列表を切り替える", () => {
    expect(resultInputPresentationForWidth(899, 900)).toBe("cards");
    expect(resultInputPresentationForWidth(900, 900)).toBe("table");
  });

  it("表は5列で状態を試合セルへ統合する", () => {
    const section = document.createElement("section");
    renderIntegratedResultInputTable(section, [row()], "結果入力");

    expect(section.querySelectorAll("thead th")).toHaveLength(5);
    expect(section.querySelector('[data-field="match"] .tournament-result-state-label'))
      .not.toBeNull();
    expect(section.querySelector('[data-field="result"] .result-input-score-separator')?.textContent)
      .toBe("−");
  });

  it("待機カードは状態と対戦待ちとダッシュだけを示しinputを生成しない", () => {
    const section = document.createElement("section");
    const waiting = row(false);
    waiting.editor.regularFields.replaceChildren();
    renderResultInputCards(section, [waiting], "結果入力");

    expect(section.textContent).toContain("待機中");
    expect(section.textContent).toContain("前提試合の結果待ち");
    expect(section.textContent).toContain("—");
    expect(section.querySelector("input")).toBeNull();
  });

  it("ResizeObserverはborder-boxの900px境界を越えたときだけ表示を変更する", () => {
    let callback: ResizeObserverCallback | undefined;
    class FakeResizeObserver {
      constructor(next: ResizeObserverCallback) {
        callback = next;
      }
      disconnect(): void {}
      observe(): void {}
      unobserve(): void {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const root = document.createElement("div");
    const onChange = vi.fn();
    observeResultInputPresentation(root, "table", onChange);
    const notify = (width: number): void => {
      callback?.([{
        borderBoxSize: [{ inlineSize: width }],
        contentRect: { width: width - 32 },
      } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    };

    notify(1002);
    notify(900);
    expect(onChange).not.toHaveBeenCalled();
    notify(0);
    expect(onChange).not.toHaveBeenCalled();
    notify(899);
    notify(768);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("cards");
    notify(900);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith("table");
  });

  it("同じ試合IDを持つ表示行が先にあっても入力へフォーカスとキャレットを戻す", () => {
    const scheduleRow = document.createElement("div");
    scheduleRow.dataset.matchId = "M-1";
    const resultRow = document.createElement("div");
    resultRow.dataset.matchId = "M-1";
    const input = document.createElement("input");
    input.dataset.scoreField = "regularHome";
    input.value = "12";
    resultRow.append(input);
    document.body.append(scheduleRow, resultRow);
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    const snapshot = {
      matchId: "M-1",
      scoreField: "regularHome",
      selectionStart: 1,
      selectionEnd: 2,
      scrollX: 10,
      scrollY: 20,
    };

    restoreResultInputFocus(snapshot);
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 2]);
    expect(scrollTo).toHaveBeenLastCalledWith(10, 20);

    scheduleRow.focus();
    restoreTournamentScoreFocus(snapshot);
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 2]);
    expect(scrollTo).toHaveBeenLastCalledWith(10, 20);
  });
});
