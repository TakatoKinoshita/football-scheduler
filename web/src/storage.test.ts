import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AutosaveController, TournamentStorage } from "./storage";
import { createTournamentDocument } from "./types";

describe("ブラウザ内保存", () => {
  let storage: TournamentStorage;

  beforeEach(() => {
    storage = new TournamentStorage(new IDBFactory());
  });

  it("下書きを再読み込み後に復元する", async () => {
    const document = createTournamentDocument();
    document.tournament.name = "自動保存大会";
    await storage.saveDraft(document);
    expect((await storage.loadLatest())?.tournament.name).toBe("自動保存大会");
  });

  it("直前の確定状態を1世代だけ復元する", async () => {
    const first = createTournamentDocument();
    first.tournament.name = "第1版";
    const second = createTournamentDocument();
    second.tournament.name = "第2版";
    await storage.confirm(first);
    await storage.confirm(second);
    expect((await storage.restorePrevious())?.tournament.name).toBe("第1版");
    expect((await storage.loadLatest())?.tournament.name).toBe("第1版");
  });

  it("削除した内容を直前状態として取り消せる", async () => {
    const document = createTournamentDocument();
    document.tournament.name = "削除前";
    await storage.saveDraft(document);
    await storage.deleteCurrent();
    expect(await storage.loadLatest()).toBeUndefined();
    expect((await storage.restorePrevious())?.tournament.name).toBe("削除前");
  });
});

describe("自動保存の間引き", () => {
  it("連続変更の最後だけを保存する", async () => {
    vi.useFakeTimers();
    const saved: string[] = [];
    const controller = new AutosaveController(async (document) => {
      saved.push(document.tournament.name);
    }, 500);
    const first = createTournamentDocument();
    first.tournament.name = "途中";
    const last = createTournamentDocument();
    last.tournament.name = "最後";
    controller.schedule(first, () => undefined, () => undefined);
    controller.schedule(last, () => undefined, () => undefined);
    await vi.advanceTimersByTimeAsync(500);
    expect(saved).toEqual(["最後"]);
    vi.useRealTimers();
  });

  it("保存容量エラーを呼び出し元へ通知する", async () => {
    vi.useFakeTimers();
    const error = new DOMException("quota", "QuotaExceededError");
    const onError = vi.fn();
    const controller = new AutosaveController(async () => Promise.reject(error), 500);
    controller.schedule(createTournamentDocument(), () => undefined, onError);
    await vi.advanceTimersByTimeAsync(500);
    expect(onError).toHaveBeenCalledWith(error);
    vi.useRealTimers();
  });

  it("復元操作前に取り消した保留中の保存は実行しない", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => undefined);
    const controller = new AutosaveController(save, 500);
    controller.schedule(createTournamentDocument(), () => undefined, () => undefined);

    controller.cancel();
    await vi.advanceTimersByTimeAsync(500);

    expect(save).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
