import { afterEach, describe, expect, it, vi } from "vitest";

import {
  renderResultInput,
  restoreResultInputFocus,
  type ResultInputCommitOutcome,
  type ResultInputHostAdapter,
} from "./result-input-engine";
import { ResultDraftController } from "./tournament-result-drafts";

function host(controller: ResultDraftController): ResultInputHostAdapter {
  return {
    drafts: controller,
    persistDrafts: vi.fn(async () => undefined),
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

function leagueRow(matchId: string, index: number) {
  return {
    matchId,
    displayNumber: `A${String(index)}`,
    timeLabel: `${String(8 + index).padStart(2, "0")}:30〜${String(9 + index).padStart(2, "0")}:05`,
    courtName: "Aコート",
    ready: true,
    homeName: `ホーム${String(index)}`,
    awayName: `アウェー${String(index)}`,
    penaltySupported: false,
  };
}

function enterCompleteResult(content: HTMLElement, matchId: string): void {
  const row = content.querySelector<HTMLElement>(
    `.result-input-entry[data-match-id="${matchId}"]`,
  )!;
  const [home, away] = [...row.querySelectorAll<HTMLInputElement>("input")];
  home!.value = "1";
  inputEvent(home!, "input");
  away!.value = "0";
  inputEvent(away!, "input");
  away!.focus();
  inputEvent(away!, "change");
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

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
    expect(content.querySelector("[data-state='editing']")?.firstChild?.textContent).toBe("入力中");

    away!.value = "1";
    inputEvent(away!, "input");
    inputEvent(away!, "change");
    await vi.waitFor(() => expect(adapter.commitResult).toHaveBeenCalledTimes(1));

    expect(adapter.commitResult).toHaveBeenCalledWith(
      expect.objectContaining({ matchId: "LG-1" }),
      { regularHome: 1, regularAway: 1 },
      undefined,
    );
    expect(home?.getAttribute("aria-label")).toBe("チーム甲 対 チーム乙・チーム甲の得点");
    expect(away?.getAttribute("aria-label")).toBe("チーム甲 対 チーム乙・チーム乙の得点");
    expect(content.querySelector("[data-field='penalty-score']")).toBeNull();
  });

  it.each(["table", "cards"] as const)(
    "awayを左へ表示する%sでもdraft復元と正式保存を正本のhome/awayへ対応させる",
    async (presentation) => {
      const controller = new ResultDraftController();
      controller.activate("league-plan", {
        "LG-1": {
          regularHome: "2",
          regularAway: "4",
          penaltyHome: "",
          penaltyAway: "",
        },
      });
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
          displayAwayFirst: true,
          savedResult: { regularHome: 1, regularAway: 3 },
          penaltySupported: false,
        }],
        rule: "league",
        presentation,
        host: adapter,
      });
      document.body.append(content);

      const entry = content.querySelector<HTMLElement>('[data-match-id="LG-1"]')!;
      expect(entry.querySelector('[data-field="teams"]')?.textContent).toBe(
        "チーム乙 対 チーム甲",
      );
      const [left, right] = [...entry.querySelectorAll<HTMLInputElement>("input")];
      expect([left?.dataset.scoreField, right?.dataset.scoreField]).toEqual([
        "regularAway",
        "regularHome",
      ]);
      expect([left?.value, right?.value]).toEqual(["4", "2"]);
      expect(left?.getAttribute("aria-label")).toBe(
        "チーム乙 対 チーム甲・チーム乙の得点",
      );
      expect(right?.getAttribute("aria-label")).toBe(
        "チーム乙 対 チーム甲・チーム甲の得点",
      );

      left!.value = "5";
      inputEvent(left!, "input");
      right!.value = "1";
      inputEvent(right!, "input");
      right!.focus();
      inputEvent(right!, "change");

      await vi.waitFor(() => expect(adapter.commitResult).toHaveBeenCalledTimes(1));
      expect(adapter.commitResult).toHaveBeenCalledWith(
        expect.objectContaining({ matchId: "LG-1", displayAwayFirst: true }),
        { regularHome: 1, regularAway: 5 },
        undefined,
      );
      await vi.waitFor(() => expect(adapter.rerender).toHaveBeenCalledTimes(1));
      content.remove();
    },
  );

  it("複数行の正式保存を直列化し、後続adapterは最新状態から実行する", async () => {
    const controller = new ResultDraftController();
    controller.activate("league-plan");
    const adapter = host(controller);
    const committed: string[] = [];
    const observed: string[][] = [];
    const complete: Array<() => void> = [];
    adapter.commitResult = vi.fn((row) => {
      observed.push([...committed]);
      return new Promise<ResultInputCommitOutcome>((resolve) => {
        complete.push(() => {
          committed.push(row.matchId);
          resolve({ announcement: `${row.matchId}を保存しました。` });
        });
      });
    });
    const content = document.createElement("div");
    renderResultInput({
      content,
      sectionId: "league-results",
      heading: "リーグ結果入力",
      description: "",
      ariaLabel: "リーグ結果入力",
      rows: [leagueRow("LG-1", 1), leagueRow("LG-2", 2)],
      rule: "league",
      presentation: "table",
      host: adapter,
    });
    document.body.append(content);

    enterCompleteResult(content, "LG-1");
    enterCompleteResult(content, "LG-2");

    await vi.waitFor(() => expect(adapter.commitResult).toHaveBeenCalledTimes(1));
    expect(adapter.commitResult).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ matchId: "LG-1" }),
      { regularHome: 1, regularAway: 0 },
      {
        planFingerprint: "league-plan",
        drafts: {
          "LG-2": { regularHome: "1", regularAway: "0", penaltyHome: "", penaltyAway: "" },
        },
      },
    );
    expect(observed).toEqual([[]]);
    expect(adapter.rerender).not.toHaveBeenCalled();

    complete[0]!();
    await vi.waitFor(() => expect(adapter.commitResult).toHaveBeenCalledTimes(2));
    expect(observed).toEqual([[], ["LG-1"]]);
    expect(adapter.commitResult).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ matchId: "LG-2" }),
      { regularHome: 1, regularAway: 0 },
      undefined,
    );
    expect(adapter.rerender).not.toHaveBeenCalled();

    complete[1]!();
    await vi.waitFor(() => expect(adapter.rerender).toHaveBeenCalledTimes(1));
    expect(adapter.rerender).toHaveBeenCalledWith(expect.objectContaining({ matchId: "LG-2" }));
    expect(controller.snapshot()).toBeUndefined();
    expect(adapter.setSaveStatus).toHaveBeenLastCalledWith("この端末に保存済み");
    content.remove();
  });

  it("同じ試合・同じ得点のchangeが保存中に重なっても正式保存を重複させない", async () => {
    const controller = new ResultDraftController();
    controller.activate("league-plan");
    const adapter = host(controller);
    let complete!: (value: ResultInputCommitOutcome) => void;
    adapter.commitResult = vi.fn(() => new Promise<ResultInputCommitOutcome>((resolve) => {
      complete = resolve;
    }));
    const content = document.createElement("div");
    renderResultInput({
      content,
      sectionId: "league-results",
      heading: "リーグ結果入力",
      description: "",
      ariaLabel: "リーグ結果入力",
      rows: [leagueRow("LG-1", 1)],
      rule: "league",
      presentation: "table",
      host: adapter,
    });

    enterCompleteResult(content, "LG-1");
    const away = content.querySelector<HTMLInputElement>(
      '[data-match-id="LG-1"] input[data-score-field="regularAway"]',
    )!;
    inputEvent(away, "change");

    await vi.waitFor(() => expect(adapter.commitResult).toHaveBeenCalledTimes(1));
    complete({ announcement: "保存しました。" });
    await vi.waitFor(() => expect(adapter.rerender).toHaveBeenCalledTimes(1));
    expect(adapter.commitResult).toHaveBeenCalledTimes(1);
  });

  it("先行保存が失敗してもqueueを続け、失敗draftと最後のfocusを保持する", async () => {
    const controller = new ResultDraftController();
    controller.activate("league-plan");
    const adapter = host(controller);
    const settle: Array<() => void> = [];
    adapter.commitResult = vi.fn((row) => new Promise<ResultInputCommitOutcome>((resolve, reject) => {
      settle.push(() => {
        if (row.matchId === "LG-1") reject(new Error("保存失敗"));
        else resolve({ announcement: `${row.matchId}を保存しました。` });
      });
    }));
    const content = document.createElement("div");
    renderResultInput({
      content,
      sectionId: "league-results",
      heading: "リーグ結果入力",
      description: "",
      ariaLabel: "リーグ結果入力",
      rows: [leagueRow("LG-1", 1), leagueRow("LG-2", 2)],
      rule: "league",
      presentation: "table",
      host: adapter,
    });
    document.body.append(content);

    enterCompleteResult(content, "LG-1");
    enterCompleteResult(content, "LG-2");
    await vi.waitFor(() => expect(adapter.commitResult).toHaveBeenCalledTimes(1));
    settle[0]!();
    await vi.waitFor(() => expect(adapter.commitResult).toHaveBeenCalledTimes(2));
    expect(adapter.commitResult).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ matchId: "LG-2" }),
      { regularHome: 1, regularAway: 0 },
      {
        planFingerprint: "league-plan",
        drafts: {
          "LG-1": { regularHome: "1", regularAway: "0", penaltyHome: "", penaltyAway: "" },
        },
      },
    );
    settle[1]!();

    await vi.waitFor(() => expect(adapter.rerender).toHaveBeenCalledTimes(1));
    expect(controller.get("LG-1")).toEqual({
      regularHome: "1",
      regularAway: "0",
      penaltyHome: "",
      penaltyAway: "",
    });
    expect(controller.get("LG-2")).toBeUndefined();
    expect(adapter.setSaveStatus).toHaveBeenLastCalledWith("保存できませんでした");
    expect(adapter.announce).toHaveBeenLastCalledWith(
      "試合結果を保存できませんでした。入力途中の変更と以前の結果は保持されています。",
    );
    expect(adapter.rerender).toHaveBeenCalledWith(expect.objectContaining({ matchId: "LG-2" }));
    content.remove();
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
    expect(content.querySelector("[data-state='editing']")?.firstChild?.textContent).toBe("入力中");
  });

  it("draftがある行だけに保存状態に応じた取消操作を表示する", () => {
    const controller = new ResultDraftController();
    controller.activate("league-plan");
    controller.set("LG-saved-draft", {
      regularHome: "3", regularAway: "1", penaltyHome: "", penaltyAway: "",
    });
    controller.set("LG-new-draft", {
      regularHome: "2", regularAway: "", penaltyHome: "", penaltyAway: "",
    });
    const content = document.createElement("div");
    renderResultInput({
      content,
      sectionId: "league-results",
      heading: "リーグ結果入力",
      description: "",
      ariaLabel: "リーグ結果入力",
      rows: [
        { ...leagueRow("LG-saved", 1), savedResult: { regularHome: 1, regularAway: 0 } },
        leagueRow("LG-new", 2),
        {
          ...leagueRow("LG-saved-draft", 3),
          savedResult: { regularHome: 1, regularAway: 0 },
        },
        leagueRow("LG-new-draft", 4),
      ],
      rule: "league",
      presentation: "table",
      host: host(controller),
    });

    expect(content.querySelector('[data-match-id="LG-saved"] button')).toBeNull();
    expect(content.querySelector('[data-match-id="LG-new"] button')).toBeNull();
    expect(
      content.querySelector('[data-match-id="LG-saved-draft"] .result-input-draft-action')
        ?.textContent,
    ).toBe("保存済の得点に戻す");
    expect(
      content.querySelector('[data-match-id="LG-new-draft"] .result-input-draft-action')
        ?.textContent,
    ).toBe("入力をクリア");
    expect(
      content.querySelector('[data-match-id="LG-saved-draft"] .result-input-draft-action')
        ?.getAttribute("aria-label"),
    ).toBe("試合番号 A3、ホーム3 対 アウェー3：保存済の得点に戻す");
  });

  it("保存済への取消は対象draftだけを永続化後に削除し、行DOMと最後のfocusを復元する", async () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    const controller = new ResultDraftController();
    controller.activate("league-plan");
    controller.set("LG-1", {
      regularHome: "2", regularAway: "9", penaltyHome: "", penaltyAway: "",
    });
    controller.set("LG-2", {
      regularHome: "4", regularAway: "", penaltyHome: "", penaltyAway: "",
    });
    let finishPersist!: () => void;
    const adapter = host(controller);
    adapter.persistDrafts = vi.fn(() => new Promise<void>((resolve) => {
      finishPersist = resolve;
    }));
    const content = document.createElement("div");
    document.body.append(content);
    renderResultInput({
      content,
      sectionId: "league-results",
      heading: "リーグ結果入力",
      description: "",
      ariaLabel: "リーグ結果入力",
      rows: [{
        ...leagueRow("LG-1", 1),
        savedResult: { regularHome: 2, regularAway: 1 },
      }],
      rule: "league",
      presentation: "table",
      host: adapter,
    });
    const row = content.querySelector<HTMLElement>('[data-match-id="LG-1"]')!;
    const away = row.querySelector<HTMLInputElement>('[data-score-field="regularAway"]')!;

    row.querySelector<HTMLButtonElement>(".result-input-draft-action")!.click();
    await vi.waitFor(() => expect(adapter.persistDrafts).toHaveBeenCalledTimes(1));
    expect(adapter.persistDrafts).toHaveBeenCalledWith({
      planFingerprint: "league-plan",
      drafts: {
        "LG-2": { regularHome: "4", regularAway: "", penaltyHome: "", penaltyAway: "" },
      },
    });
    expect(controller.get("LG-1")?.regularAway).toBe("9");
    expect(row.getAttribute("aria-busy")).toBe("true");
    expect(away.disabled).toBe(true);

    finishPersist();
    await vi.waitFor(() => expect(controller.get("LG-1")).toBeUndefined());
    expect(controller.get("LG-2")?.regularHome).toBe("4");
    expect(row.querySelector<HTMLInputElement>('[data-score-field="regularHome"]')?.value).toBe("2");
    expect(away.value).toBe("1");
    expect(row.querySelector(".result-input-draft-action")).toBeNull();
    expect(row.querySelector("[data-state='saved']")).not.toBeNull();
    expect(row.hasAttribute("aria-busy")).toBe(false);
    expect(away.disabled).toBe(false);
    expect(document.activeElement).toBe(away);
    expect(adapter.commitResult).not.toHaveBeenCalled();
    expect(adapter.rerender).not.toHaveBeenCalled();
    content.remove();
  });

  it("draft取消の永続化失敗時は入力とdraftを保持する", async () => {
    const controller = new ResultDraftController();
    controller.activate("league-plan");
    controller.set("LG-1", {
      regularHome: "8", regularAway: "", penaltyHome: "", penaltyAway: "",
    });
    const adapter = host(controller);
    adapter.persistDrafts = vi.fn(async () => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    const content = document.createElement("div");
    renderResultInput({
      content,
      sectionId: "league-results",
      heading: "リーグ結果入力",
      description: "",
      ariaLabel: "リーグ結果入力",
      rows: [leagueRow("LG-1", 1)],
      rule: "league",
      presentation: "cards",
      host: adapter,
    });
    const row = content.querySelector<HTMLElement>('[data-match-id="LG-1"]')!;
    row.querySelector<HTMLButtonElement>(".result-input-draft-action")!.click();

    await vi.waitFor(() => expect(adapter.announce).toHaveBeenCalledWith(
      "入力途中の変更を破棄できませんでした。入力内容は保持されています。もう一度お試しください。",
    ));
    expect(controller.get("LG-1")?.regularHome).toBe("8");
    expect(row.querySelector<HTMLInputElement>('[data-score-field="regularHome"]')?.value).toBe("8");
    expect(row.querySelector(".result-input-draft-action")).not.toBeNull();
    expect(row.hasAttribute("aria-busy")).toBe(false);
    expect(adapter.commitResult).not.toHaveBeenCalled();
    expect(adapter.rerender).not.toHaveBeenCalled();
  });

  it("正式保存完了時はTab移動後の実際のfocusを再描画に引き継ぐ", async () => {
    const controller = new ResultDraftController();
    controller.activate("league-plan");
    const adapter = host(controller);
    let finishCommit!: (outcome: ResultInputCommitOutcome) => void;
    adapter.commitResult = vi.fn(() => new Promise<ResultInputCommitOutcome>((resolve) => {
      finishCommit = resolve;
    }));
    const content = document.createElement("div");
    document.body.append(content);
    renderResultInput({
      content,
      sectionId: "league-results",
      heading: "リーグ結果入力",
      description: "",
      ariaLabel: "リーグ結果入力",
      rows: [leagueRow("LG-1", 1), leagueRow("LG-2", 2)],
      rule: "league",
      presentation: "table",
      host: adapter,
    });
    enterCompleteResult(content, "LG-1");
    await vi.waitFor(() => expect(adapter.commitResult).toHaveBeenCalledTimes(1));
    const nextHome = content.querySelector<HTMLInputElement>(
      '[data-match-id="LG-2"] [data-score-field="regularHome"]',
    )!;
    nextHome.focus();
    nextHome.setSelectionRange(0, 0);

    finishCommit({ announcement: "保存しました。" });
    await vi.waitFor(() => expect(adapter.rerender).toHaveBeenCalledTimes(1));
    expect(adapter.rerender).toHaveBeenCalledWith(expect.objectContaining({
      matchId: "LG-2",
      scoreField: "regularHome",
    }));
    content.remove();
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
