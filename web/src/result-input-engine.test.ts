import { describe, expect, it, vi } from "vitest";

import {
  renderResultInput,
  restoreResultInputFocus,
  type ResultInputHostAdapter,
} from "./result-input-engine";
import { ResultDraftController } from "./tournament-result-drafts";

function host(controller: ResultDraftController): ResultInputHostAdapter {
  return {
    drafts: controller,
    persistDrafts: vi.fn(),
    commitResult: vi.fn(async () => ({ announcement: "保存しました。" })),
    setSaveStatus: vi.fn(),
    announce: vi.fn(),
    refreshCompletion: vi.fn(),
    rerender: vi.fn(),
  };
}

function inputEvent(input: HTMLInputElement, type: "input" | "change"): void {
  input.dispatchEvent(new Event(type, { bubbles: true }));
}

describe("共通結果入力engine", () => {
  it("リーグの部分入力はdraftだけを保存し、同点が揃ったchangeで正式保存する", async () => {
    const controller = new ResultDraftController();
    controller.activate("league-plan");
    const adapter = host(controller);
    const content = document.createElement("div");
    renderResultInput({
      content,
      sectionId: "league-results",
      heading: "リーグ結果入力",
      description: "引き分けを認めます。",
      ariaLabel: "リーグ結果入力",
      rows: [{
        matchId: "LG-1",
        displayNumber: "A①",
        timeLabel: "09:30〜10:05",
        courtName: "Aコート",
        ready: true,
        homeName: "チーム甲",
        awayName: "チーム乙",
        penaltySupported: false,
      }],
      rule: "league",
      presentation: "table",
      host: adapter,
    });
    const [home, away] = [...content.querySelectorAll<HTMLInputElement>("input")];
    home!.value = "1";
    inputEvent(home!, "input");
    inputEvent(home!, "change");

    expect(controller.get("LG-1")?.regularHome).toBe("1");
    expect(adapter.commitResult).not.toHaveBeenCalled();
    expect(content.querySelector("[data-state='editing']")?.textContent).toBe("入力中");

    away!.value = "1";
    inputEvent(away!, "input");
    inputEvent(away!, "change");
    await Promise.resolve();

    expect(adapter.commitResult).toHaveBeenCalledWith(
      expect.objectContaining({ matchId: "LG-1" }),
      { regularHome: 1, regularAway: 1 },
      undefined,
    );
    expect(content.querySelector("[data-field='penalty-score']")).toBeNull();
  });

  it("保存済み結果を片側だけ空にしても以前の正式結果を維持する", () => {
    const controller = new ResultDraftController();
    controller.activate("league-plan");
    const adapter = host(controller);
    const content = document.createElement("div");
    renderResultInput({
      content,
      sectionId: "league-results",
      heading: "リーグ結果入力",
      description: "",
      ariaLabel: "リーグ結果入力",
      rows: [{
        matchId: "LG-1",
        displayNumber: "A①",
        timeLabel: "09:30〜10:05",
        courtName: "Aコート",
        ready: true,
        homeName: "チーム甲",
        awayName: "チーム乙",
        savedResult: { regularHome: 2, regularAway: 0 },
        penaltySupported: false,
      }],
      rule: "league",
      presentation: "cards",
      host: adapter,
    });
    const away = [...content.querySelectorAll<HTMLInputElement>("input")][1]!;
    away.value = "";
    inputEvent(away, "input");
    inputEvent(away, "change");

    expect(adapter.commitResult).not.toHaveBeenCalled();
    expect(controller.get("LG-1")?.regularHome).toBe("2");
    expect(content.querySelector("[data-state='editing']")?.textContent).toBe("入力中");
  });

  it("待機行では入力欄を作らない", () => {
    const controller = new ResultDraftController();
    controller.activate("tournament-plan");
    const content = document.createElement("div");
    renderResultInput({
      content,
      sectionId: "tournament-results",
      heading: "結果入力",
      description: "",
      ariaLabel: "結果入力",
      rows: [{
        matchId: "PT-2",
        displayNumber: "A②",
        timeLabel: "10:15〜10:50",
        courtName: "Aコート",
        ready: false,
        homeName: "前提試合待ち",
        awayName: "前提試合待ち",
        penaltySupported: true,
      }],
      rule: "placement-tournament",
      presentation: "table",
      host: host(controller),
    });

    expect(content.querySelector("input")).toBeNull();
    expect(content.textContent).toContain("待機中");
    expect(content.textContent).toContain("前提試合の結果待ち");
    expect(content.textContent).toContain("—");
  });

  it("同じ試合IDの日程badgeが先にあっても結果入力欄へfocusを復元する", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    const scheduleBadge = document.createElement("span");
    scheduleBadge.dataset.matchId = "LG-1";
    const entry = document.createElement("div");
    entry.dataset.matchId = "LG-1";
    const input = document.createElement("input");
    input.dataset.scoreField = "regularAway";
    entry.append(input);
    document.body.append(scheduleBadge, entry);

    restoreResultInputFocus({
      matchId: "LG-1",
      scoreField: "regularAway",
      selectionStart: 0,
      selectionEnd: 0,
      scrollX: 0,
      scrollY: 0,
    });

    expect(document.activeElement).toBe(input);
    scrollTo.mockRestore();
    document.body.replaceChildren();
  });
});
