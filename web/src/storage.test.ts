import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AutosaveController,
  StorageUpgradeBlockedError,
  TournamentStorage,
} from "./storage";
import type { TournamentResultDraftUiState } from "./tournament-result-drafts";
import { LEGACY_SCHEMA_VERSION, createTournamentDocument } from "./types";

function requestDone(request: IDBRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve());
    request.addEventListener("error", () => reject(request.error));
  });
}

async function createVersionOneDatabase(
  indexedDb: IDBFactory,
  document = createTournamentDocument(),
  keepOpen = false,
): Promise<IDBDatabase | undefined> {
  const open = indexedDb.open("football-scheduler", 1);
  open.addEventListener("upgradeneeded", () => {
    open.result.createObjectStore("documents", { keyPath: "key" });
  });
  await requestDone(open);
  const transaction = open.result.transaction("documents", "readwrite");
  transaction.objectStore("documents").put({ key: "draft", document });
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => reject(transaction.error));
  });
  if (keepOpen) return open.result;
  open.result.close();
  return undefined;
}

const resultDraftState = (
  planFingerprint = "plan-one",
): TournamentResultDraftUiState => ({
  planFingerprint,
  drafts: {
    "PT-1": {
      regularHome: "1",
      regularAway: "",
      penaltyHome: "",
      penaltyAway: "",
    },
  },
});

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

  it("閲覧専用のschema 0.1.0文書も内容を変えずに復元する", async () => {
    const document = createTournamentDocument();
    document.schemaVersion = LEGACY_SCHEMA_VERSION;
    document.tournament.input.schema_version = LEGACY_SCHEMA_VERSION;
    document.tournament.result = { status: "OPTIMAL", slots: [] };

    await storage.replaceImported(document);

    expect(await storage.loadLatest()).toEqual(document);
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

  it("version 1のdocumentsを保持したままui-state storeを追加する", async () => {
    const indexedDb = new IDBFactory();
    const document = createTournamentDocument();
    document.tournament.name = "移行前大会";
    await createVersionOneDatabase(indexedDb, document);
    storage = new TournamentStorage(indexedDb);

    expect((await storage.loadLatest())?.tournament.name).toBe("移行前大会");
    await storage.saveTournamentResultDrafts(resultDraftState());
    expect(await storage.loadTournamentResultDrafts("plan-one"))
      .toEqual(resultDraftState().drafts);
  });

  it("旧versionを開いた別タブがある場合は案内可能なエラーにし、閉じた後は移行できる", async () => {
    const indexedDb = new IDBFactory();
    const document = createTournamentDocument();
    document.tournament.name = "旧タブで編集中";
    const legacyConnection = await createVersionOneDatabase(indexedDb, document, true);
    expect(legacyConnection).toBeDefined();

    storage = new TournamentStorage(indexedDb);
    await expect(storage.loadLatest()).rejects.toBeInstanceOf(StorageUpgradeBlockedError);

    legacyConnection!.close();
    const migratedStorage = new TournamentStorage(indexedDb);
    expect((await migratedStorage.loadLatest())?.tournament.name).toBe("旧タブで編集中");
    await migratedStorage.saveTournamentResultDrafts(resultDraftState());
    expect(await migratedStorage.loadTournamentResultDrafts("plan-one"))
      .toEqual(resultDraftState().drafts);
  });

  it("plan fingerprintが一致するdraftだけを復元する", async () => {
    await storage.saveTournamentResultDrafts(resultDraftState());

    expect(await storage.loadTournamentResultDrafts("plan-one"))
      .toEqual(resultDraftState().drafts);
    expect(await storage.loadTournamentResultDrafts("plan-two")).toBeUndefined();
  });

  it("正式結果と入力途中状態を同じtransactionで更新する", async () => {
    const before = createTournamentDocument();
    before.tournament.name = "更新前";
    await storage.saveDraft(before);
    await storage.saveTournamentResultDrafts(resultDraftState());
    const after = createTournamentDocument();
    after.tournament.name = "更新後";

    await storage.commitTournamentResults(after, undefined);

    expect((await storage.loadLatest())?.tournament.name).toBe("更新後");
    expect(await storage.loadTournamentResultDrafts("plan-one")).toBeUndefined();
  });

  it("JSON読込みと大会削除では内部draftも消去する", async () => {
    await storage.saveTournamentResultDrafts(resultDraftState());
    await storage.replaceImported(createTournamentDocument());
    expect(await storage.loadTournamentResultDrafts("plan-one")).toBeUndefined();

    await storage.saveTournamentResultDrafts(resultDraftState());
    await storage.deleteCurrent();
    expect(await storage.loadTournamentResultDrafts("plan-one")).toBeUndefined();
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
