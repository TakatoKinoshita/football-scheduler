import { afterEach, describe, expect, it, vi } from "vitest";

import { createResultInputStateControl } from "./result-input-state-control";

function toggleEvent(state: "open" | "closed"): Event {
  return Object.assign(new Event("toggle"), { newState: state });
}

describe("結果入力の状態コントロール", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("draftがない状態は操作を持たない静的バッジとして表示する", () => {
    const control = createResultInputStateControl("saved");
    document.body.append(control.element);

    expect(control.element.querySelector("button")).toBeNull();
    expect(control.element.querySelector("[data-state='saved']")?.textContent).toBe("保存済");
    expect(control.element.querySelector("[data-state='saved']")?.getAttribute("aria-label"))
      .toBe("保存済み");

    control.setState("waiting");
    expect(control.element.querySelector("button")).toBeNull();
    expect(control.element.querySelector("[data-state='waiting']")?.getAttribute("aria-label"))
      .toBe("前提試合待ち");
  });

  it("draft操作を状態メニューとして公開し、開閉時のfocusを管理する", () => {
    const activate = vi.fn(async () => undefined);
    const control = createResultInputStateControl("editing");
    control.setDraftAction({
      label: "保存済の得点に戻す",
      accessibleName: "試合A① チーム甲 対 チーム乙の保存済の得点に戻す",
      onActivate: activate,
    });
    document.body.append(control.element);
    const trigger = control.element.querySelector<HTMLButtonElement>(
      ".result-input-state-trigger",
    )!;
    const popover = control.element.querySelector<HTMLElement>(
      ".result-input-draft-popover",
    )!;
    const action = control.element.querySelector<HTMLButtonElement>(
      ".result-input-draft-action",
    )!;

    expect(trigger.textContent).toContain("入力中");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(action.textContent).toBe("保存済の得点に戻す");
    expect(action.getAttribute("aria-label")).toContain("試合A①");

    popover.dispatchEvent(toggleEvent("open"));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(action);

    popover.dispatchEvent(toggleEvent("closed"));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);

    action.click();
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("処理中は状態メニューと操作を一時的に無効化する", () => {
    const control = createResultInputStateControl("invalid");
    control.setDraftAction({
      label: "入力をクリア",
      accessibleName: "試合B②の入力をクリア",
      onActivate: async () => undefined,
    });
    document.body.append(control.element);

    control.setBusy(true);
    expect(control.element.getAttribute("aria-busy")).toBe("true");
    expect([...control.element.querySelectorAll<HTMLButtonElement>("button")]
      .every((button) => button.disabled)).toBe(true);

    control.setBusy(false);
    expect(control.element.hasAttribute("aria-busy")).toBe(false);
    expect([...control.element.querySelectorAll<HTMLButtonElement>("button")]
      .every((button) => !button.disabled)).toBe(true);
  });

  it("同じ表示内容の更新では開いているメニューを置き換えず、最新の操作を使う", () => {
    const first = vi.fn(async () => undefined);
    const latest = vi.fn(async () => undefined);
    const control = createResultInputStateControl("editing");
    const presentation = {
      label: "入力をクリア",
      accessibleName: "試合C③ チーム甲 対 チーム乙の入力をクリア",
    };
    control.setDraftAction({ ...presentation, onActivate: first });
    const originalAction = control.element.querySelector<HTMLButtonElement>(
      ".result-input-draft-action",
    )!;

    control.setState("editing");
    control.setDraftAction({ ...presentation, onActivate: latest });

    expect(control.element.querySelector(".result-input-draft-action")).toBe(originalAction);
    originalAction.click();
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });
});
