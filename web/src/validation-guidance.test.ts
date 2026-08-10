import { describe, expect, it, vi } from "vitest";

import { guideToInvalidField } from "./validation-guidance";

describe("生成エラーの入力誘導", () => {
  it("detailsを開いてpreventScrollでfocusし、表示範囲内ならscrollしない", () => {
    document.body.innerHTML = `<details><summary>詳細</summary><input id="target"></details>`;
    const details = document.querySelector("details")!;
    const field = document.querySelector<HTMLInputElement>("#target")!;
    const focus = vi.spyOn(field, "focus");
    const scrollIntoView = vi.fn();
    field.scrollIntoView = scrollIntoView;
    vi.spyOn(field, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 148,
    } as DOMRect);

    expect(guideToInvalidField(field, {
      viewportHeight: 600,
      reducedMotion: false,
    })).toEqual({ openedDetails: true, scrolled: false });
    expect(details.open).toBe(true);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("表示範囲外だけ中央へscrollし、reduced motionでは即時移動する", () => {
    document.body.innerHTML = `<input id="target">`;
    const field = document.querySelector<HTMLInputElement>("#target")!;
    const scrollIntoView = vi.fn();
    field.scrollIntoView = scrollIntoView;
    vi.spyOn(field, "getBoundingClientRect").mockReturnValue({
      top: 700,
      bottom: 748,
    } as DOMRect);

    expect(guideToInvalidField(field, {
      viewportHeight: 600,
      reducedMotion: true,
    })).toEqual({ openedDetails: false, scrolled: true });
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      inline: "nearest",
      behavior: "auto",
    });
  });
});
