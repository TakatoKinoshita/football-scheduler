import { cloneDocument, type TournamentDocument } from "./types";
import type {
  TournamentResultDrafts,
  TournamentResultDraftUiState,
} from "./tournament-result-drafts";

const DATABASE_NAME = "football-scheduler";
const DATABASE_VERSION = 2;
const STORE_NAME = "documents";
const UI_STATE_STORE_NAME = "ui-state";
const TOURNAMENT_RESULT_DRAFTS_KEY = "tournament-result-drafts";

type StorageKey = "draft" | "confirmed" | "previous";

interface StoredDocument {
  key: StorageKey;
  document: TournamentDocument;
}

interface StoredTournamentResultDrafts extends TournamentResultDraftUiState {
  key: typeof TOURNAMENT_RESULT_DRAFTS_KEY;
}

export class StorageUpgradeBlockedError extends Error {
  constructor() {
    super("別タブで以前の画面が開かれているため、保存場所を更新できません。");
    this.name = "StorageUpgradeBlockedError";
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("保存処理に失敗しました。")));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("保存処理を中断しました。")));
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("保存処理に失敗しました。")));
  });
}

export class TournamentStorage {
  private databasePromise?: Promise<IDBDatabase>;

  constructor(private readonly indexedDb: IDBFactory = indexedDB) {}

  private database(): Promise<IDBDatabase> {
    if (this.databasePromise === undefined) {
      this.databasePromise = new Promise((resolve, reject) => {
        const request = this.indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
        let upgradeBlocked = false;
        request.addEventListener("upgradeneeded", () => {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) {
            request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
          }
          if (!request.result.objectStoreNames.contains(UI_STATE_STORE_NAME)) {
            request.result.createObjectStore(UI_STATE_STORE_NAME, { keyPath: "key" });
          }
        });
        request.addEventListener("blocked", () => {
          upgradeBlocked = true;
          reject(new StorageUpgradeBlockedError());
        });
        request.addEventListener("success", () => {
          if (upgradeBlocked) {
            request.result.close();
            return;
          }
          request.result.addEventListener("versionchange", () => request.result.close());
          resolve(request.result);
        });
        request.addEventListener("error", () => reject(request.error ?? new Error("保存場所を開けませんでした。")));
      });
    }
    return this.databasePromise;
  }

  async get(key: StorageKey): Promise<TournamentDocument | undefined> {
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const value = await requestResult(
      transaction.objectStore(STORE_NAME).get(key) as IDBRequest<StoredDocument | undefined>,
    );
    await transactionDone(transaction);
    return value === undefined ? undefined : cloneDocument(value.document);
  }

  async loadLatest(): Promise<TournamentDocument | undefined> {
    return (await this.get("draft")) ?? (await this.get("confirmed"));
  }

  async saveDraft(document: TournamentDocument): Promise<void> {
    await this.put("draft", document);
  }

  async confirm(document: TournamentDocument): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const current = await requestResult(
      store.get("confirmed") as IDBRequest<StoredDocument | undefined>,
    );
    if (current !== undefined) {
      store.put({ key: "previous", document: current.document } satisfies StoredDocument);
    }
    store.put({ key: "confirmed", document: cloneDocument(document) } satisfies StoredDocument);
    store.put({ key: "draft", document: cloneDocument(document) } satisfies StoredDocument);
    await transactionDone(transaction);
  }

  async replaceImported(document: TournamentDocument): Promise<void> {
    await this.confirm(document);
    await this.clearTournamentResultDrafts();
  }

  async deleteCurrent(): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction([STORE_NAME, UI_STATE_STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const current =
      (await requestResult(store.get("draft") as IDBRequest<StoredDocument | undefined>)) ??
      (await requestResult(store.get("confirmed") as IDBRequest<StoredDocument | undefined>));
    if (current !== undefined) {
      store.put({ key: "previous", document: current.document } satisfies StoredDocument);
    }
    store.delete("draft");
    store.delete("confirmed");
    transaction.objectStore(UI_STATE_STORE_NAME).delete(TOURNAMENT_RESULT_DRAFTS_KEY);
    await transactionDone(transaction);
  }

  async loadTournamentResultDrafts(
    planFingerprint: string,
  ): Promise<TournamentResultDrafts | undefined> {
    const database = await this.database();
    const transaction = database.transaction(UI_STATE_STORE_NAME, "readonly");
    const value = await requestResult(
      transaction.objectStore(UI_STATE_STORE_NAME).get(TOURNAMENT_RESULT_DRAFTS_KEY) as
        IDBRequest<StoredTournamentResultDrafts | undefined>,
    );
    await transactionDone(transaction);
    return value?.planFingerprint === planFingerprint
      ? structuredClone(value.drafts)
      : undefined;
  }

  async saveTournamentResultDrafts(state: TournamentResultDraftUiState): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(UI_STATE_STORE_NAME, "readwrite");
    transaction.objectStore(UI_STATE_STORE_NAME).put({
      key: TOURNAMENT_RESULT_DRAFTS_KEY,
      planFingerprint: state.planFingerprint,
      drafts: structuredClone(state.drafts),
    } satisfies StoredTournamentResultDrafts);
    await transactionDone(transaction);
  }

  async commitTournamentResults(
    document: TournamentDocument,
    draftState: TournamentResultDraftUiState | undefined,
  ): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction([STORE_NAME, UI_STATE_STORE_NAME], "readwrite");
    transaction.objectStore(STORE_NAME).put({
      key: "draft",
      document: cloneDocument(document),
    } satisfies StoredDocument);
    const uiStateStore = transaction.objectStore(UI_STATE_STORE_NAME);
    if (draftState === undefined) {
      uiStateStore.delete(TOURNAMENT_RESULT_DRAFTS_KEY);
    } else {
      uiStateStore.put({
        key: TOURNAMENT_RESULT_DRAFTS_KEY,
        planFingerprint: draftState.planFingerprint,
        drafts: structuredClone(draftState.drafts),
      } satisfies StoredTournamentResultDrafts);
    }
    await transactionDone(transaction);
  }

  async clearTournamentResultDrafts(): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(UI_STATE_STORE_NAME, "readwrite");
    transaction.objectStore(UI_STATE_STORE_NAME).delete(TOURNAMENT_RESULT_DRAFTS_KEY);
    await transactionDone(transaction);
  }

  async restorePrevious(): Promise<TournamentDocument | undefined> {
    const previous = await this.get("previous");
    if (previous === undefined) return undefined;
    await this.confirm(previous);
    return previous;
  }

  private async put(key: StorageKey, document: TournamentDocument): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({ key, document: cloneDocument(document) } satisfies StoredDocument);
    await transactionDone(transaction);
  }
}

export class AutosaveController {
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly save: (document: TournamentDocument) => Promise<void>,
    private readonly delayMilliseconds = 500,
  ) {}

  schedule(document: TournamentDocument, onSaved: () => void, onError: (error: unknown) => void): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    const snapshot = cloneDocument(document);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.save(snapshot).then(onSaved).catch(onError);
    }, this.delayMilliseconds);
  }

  cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
