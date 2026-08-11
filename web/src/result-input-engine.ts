import {
  evaluateResultDraft,
  type ResultDraft,
  type ResultDraftController,
  type ResultDraftRule,
  type ResultDraftUiState,
} from "./tournament-result-drafts";
import {
  renderIntegratedResultInputTable,
  renderResultInputCards,
  type ResultInputEditorView,
  type ResultInputPresentation,
  type ResultInputRenderRow,
} from "./result-input-layout";
import {
  createResultInputStateControl,
  type ResultInputEntryState,
} from "./result-input-state-control";

export interface SavedResultInputValue {
  regularHome: number;
  regularAway: number;
  penaltyHome?: number;
  penaltyAway?: number;
}

export interface ResultInputRowModel {
  matchId: string;
  displayNumber: string;
  timeLabel: string;
  courtName: string;
  ready: boolean;
  homeName: string;
  awayName: string;
  savedResult?: SavedResultInputValue;
  penaltySupported: boolean;
}

export interface ResultInputFocusSnapshot {
  matchId?: string;
  scoreField?: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  scrollX: number;
  scrollY: number;
}

export interface ResultInputCommitOutcome {
  announcement: string;
}

export interface ResultInputHostAdapter {
  drafts: ResultDraftController;
  persistDrafts: (state: ResultDraftUiState | undefined) => Promise<void>;
  commitResult: (
    row: ResultInputRowModel,
    value: SavedResultInputValue,
    draftState: ResultDraftUiState | undefined,
  ) => Promise<ResultInputCommitOutcome>;
  setSaveStatus: (message: string) => void;
  announce: (message: string) => void;
  refreshCompletion: () => void;
  rerender: (focus: ResultInputFocusSnapshot) => void;
}

export interface RenderResultInputOptions {
  content: HTMLElement;
  sectionId: string;
  heading: string;
  description: string;
  ariaLabel: string;
  rows: readonly ResultInputRowModel[];
  rule: ResultDraftRule;
  presentation: ResultInputPresentation;
  host: ResultInputHostAdapter;
}

interface ResultCommitQueueState {
  tail: Promise<void>;
  pendingCount: number;
  pendingSignatures: Set<string>;
  failed: boolean;
  focus: ResultInputFocusSnapshot;
}

const resultCommitQueues = new WeakMap<ResultDraftController, ResultCommitQueueState>();

function enqueueResultCommit(
  row: ResultInputRowModel,
  value: SavedResultInputValue,
  fingerprint: string,
  focus: ResultInputFocusSnapshot,
  inputs: readonly HTMLInputElement[],
  host: ResultInputHostAdapter,
): void {
  const signature = JSON.stringify([
    row.matchId,
    value.regularHome,
    value.regularAway,
    value.penaltyHome ?? null,
    value.penaltyAway ?? null,
  ]);
  let queue = resultCommitQueues.get(host.drafts);
  if (queue === undefined) {
    queue = {
      tail: Promise.resolve(),
      pendingCount: 0,
      pendingSignatures: new Set(),
      failed: false,
      focus,
    };
    resultCommitQueues.set(host.drafts, queue);
  }
  const state = queue;
  if (state.pendingSignatures.has(signature)) {
    state.focus = focus;
    return;
  }
  state.pendingCount += 1;
  state.pendingSignatures.add(signature);
  state.focus = focus;
  host.setSaveStatus("保存しています…");
  for (const input of inputs) input.disabled = true;

  const run = async (): Promise<void> => {
    try {
      if (host.drafts.planFingerprint !== fingerprint) {
        throw new Error("結果入力の対象が変更されました。");
      }
      const draftState = host.drafts.snapshotWithout([row.matchId]);
      const outcome = await host.commitResult(row, value, draftState);
      if (host.drafts.planFingerprint === fingerprint) host.drafts.delete(row.matchId);
      host.announce(outcome.announcement);
    } catch {
      state.failed = true;
    }
    try {
      host.refreshCompletion();
    } catch {
      state.failed = true;
    }
  };

  state.tail = state.tail.then(run, run).then(() => {
    state.pendingCount -= 1;
    state.pendingSignatures.delete(signature);
    if (state.pendingCount > 0) return;
    if (state.failed) {
      host.setSaveStatus("保存できませんでした");
      host.announce(
        "試合結果を保存できませんでした。入力途中の変更と以前の結果は保持されています。",
      );
    } else {
      host.setSaveStatus("この端末に保存済み");
    }
    host.rerender(state.focus);
    if (resultCommitQueues.get(host.drafts) === state) {
      resultCommitQueues.delete(host.drafts);
    }
  });
}

function appendTextElement<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tagName: K,
  value: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  element.textContent = value;
  if (className !== undefined) element.className = className;
  parent.append(element);
  return element;
}

function scoreInput(label: string, value: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "numeric";
  input.pattern = "[0-9]*";
  input.className = "score-input";
  input.setAttribute("aria-label", label);
  input.value = value;
  return input;
}

function parsedScore(input: HTMLInputElement): number | null | undefined {
  if (input.value.trim() === "") return null;
  const value = Number(input.value);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function captureResultInputFocus(): ResultInputFocusSnapshot {
  const active = document.activeElement;
  const entry = active instanceof HTMLInputElement
    ? active.closest<HTMLElement>("[data-match-id]")
    : null;
  return {
    matchId: entry?.dataset.matchId,
    scoreField: active instanceof HTMLInputElement ? active.dataset.scoreField : undefined,
    selectionStart: active instanceof HTMLInputElement ? active.selectionStart : null,
    selectionEnd: active instanceof HTMLInputElement ? active.selectionEnd : null,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
}

export function restoreResultInputFocus(
  snapshot: ResultInputFocusSnapshot,
  root: ParentNode = document,
): void {
  if (snapshot.matchId === undefined || snapshot.scoreField === undefined) return;
  const input = [...root.querySelectorAll<HTMLInputElement>(
    `input[data-score-field="${snapshot.scoreField}"]`,
  )].find((candidate) =>
    candidate.closest<HTMLElement>("[data-match-id]")?.dataset.matchId === snapshot.matchId
  );
  if (input === undefined || input === null) return;
  input.focus({ preventScroll: true });
  if (snapshot.selectionStart !== null && snapshot.selectionEnd !== null) {
    input.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
  }
  window.scrollTo(snapshot.scrollX, snapshot.scrollY);
}

function emptyEditor(state: "waiting" | "empty"): ResultInputEditorView {
  return {
    regularFields: document.createElement("span"),
    penaltyFields: document.createElement("span"),
    stateControl: createResultInputStateControl(state),
    errorArea: document.createElement("span"),
    inputs: [],
  };
}

function editorForRow(
  row: ResultInputRowModel,
  rule: ResultDraftRule,
  host: ResultInputHostAdapter,
): ResultInputEditorView {
  if (!row.ready) return emptyEditor("waiting");
  const saved = row.savedResult;
  const restored = host.drafts.get(row.matchId);
  const regularScoreKind = row.penaltySupported ? "通常得点" : "得点";
  const regularHome = scoreInput(
    `${row.homeName} 対 ${row.awayName}・${row.homeName}の${regularScoreKind}`,
    restored?.regularHome ?? (saved === undefined ? "" : String(saved.regularHome)),
  );
  regularHome.dataset.scoreField = "regularHome";
  const regularAway = scoreInput(
    `${row.homeName} 対 ${row.awayName}・${row.awayName}の${regularScoreKind}`,
    restored?.regularAway ?? (saved === undefined ? "" : String(saved.regularAway)),
  );
  regularAway.dataset.scoreField = "regularAway";
  const regularFields = document.createElement("span");
  regularFields.append(regularHome, regularAway);

  const penaltyFields = document.createElement("span");
  const penaltyInputs: HTMLInputElement[] = [];
  if (row.penaltySupported) {
    const penaltyHome = scoreInput(
      `${row.homeName} 対 ${row.awayName}・${row.homeName}のPK得点`,
      restored?.penaltyHome ?? (saved?.penaltyHome === undefined ? "" : String(saved.penaltyHome)),
    );
    penaltyHome.dataset.scoreField = "penaltyHome";
    const penaltyAway = scoreInput(
      `${row.homeName} 対 ${row.awayName}・${row.awayName}のPK得点`,
      restored?.penaltyAway ?? (saved?.penaltyAway === undefined ? "" : String(saved.penaltyAway)),
    );
    penaltyAway.dataset.scoreField = "penaltyAway";
    penaltyFields.append(penaltyHome, penaltyAway);
    penaltyInputs.push(penaltyHome, penaltyAway);
  }
  const inputs = [regularHome, regularAway, ...penaltyInputs];
  const stateControl = createResultInputStateControl(
    restored === undefined ? (saved === undefined ? "empty" : "saved") : "editing",
  );
  const errorArea = document.createElement("span");
  errorArea.className = "tournament-result-error";
  errorArea.id = `result-input-error-${row.matchId}`;
  errorArea.setAttribute("aria-live", "polite");
  for (const input of inputs) input.setAttribute("aria-describedby", errorArea.id);

  const savedDraft: ResultDraft = {
    regularHome: saved === undefined ? "" : String(saved.regularHome),
    regularAway: saved === undefined ? "" : String(saved.regularAway),
    penaltyHome: saved?.penaltyHome === undefined ? "" : String(saved.penaltyHome),
    penaltyAway: saved?.penaltyAway === undefined ? "" : String(saved.penaltyAway),
  };
  const draftFromInputs = (): ResultDraft => ({
    regularHome: regularHome.value,
    regularAway: regularAway.value,
    penaltyHome: penaltyInputs[0]?.value ?? "",
    penaltyAway: penaltyInputs[1]?.value ?? "",
  });
  const updatePenaltyVisibility = (): void => {
    if (!row.penaltySupported) return;
    const home = parsedScore(regularHome);
    const away = parsedScore(regularAway);
    const tied = typeof home === "number" && typeof away === "number" && home === away;
    penaltyFields.hidden = !tied;
    if (typeof home === "number" && typeof away === "number" && !tied) {
      penaltyInputs[0]!.value = "";
      penaltyInputs[1]!.value = "";
    }
  };
  const renderDraftState = (draft = host.drafts.get(row.matchId)): void => {
    for (const input of inputs) input.removeAttribute("aria-invalid");
    errorArea.textContent = "";
    if (draft === undefined) {
      stateControl.setState(saved === undefined ? "empty" : "saved");
      return;
    }
    const evaluation = evaluateResultDraft(draft, rule);
    stateControl.setState(
      (evaluation.status === "invalid" ? "invalid" : "editing") satisfies ResultInputEntryState,
    );
    if (evaluation.status !== "invalid") return;
    errorArea.textContent = evaluation.message;
    const regularError = evaluation.message.startsWith("通常得点");
    if (regularError) {
      regularHome.toggleAttribute("aria-invalid", parsedScore(regularHome) === undefined);
      regularAway.toggleAttribute("aria-invalid", parsedScore(regularAway) === undefined);
    } else {
      const tied = evaluation.message.startsWith("PK戦");
      penaltyInputs[0]?.toggleAttribute("aria-invalid", tied || parsedScore(penaltyInputs[0]) === undefined);
      penaltyInputs[1]?.toggleAttribute("aria-invalid", tied || parsedScore(penaltyInputs[1]) === undefined);
    }
  };
  const recordDraft = (): ResultDraft => {
    updatePenaltyVisibility();
    const draft = draftFromInputs();
    const changed = (Object.keys(savedDraft) as (keyof ResultDraft)[])
      .some((key) => draft[key] !== savedDraft[key]);
    if (changed) host.drafts.set(row.matchId, draft);
    else host.drafts.delete(row.matchId);
    void host.persistDrafts(host.drafts.snapshot()).catch(() => {
      host.announce(
        "入力途中の得点を保存できませんでした。正式に保存済みの結果は保持されています。",
      );
    });
    renderDraftState(changed ? draft : undefined);
    host.refreshCompletion();
    return draft;
  };

  updatePenaltyVisibility();
  renderDraftState(restored);
  for (const input of inputs) input.addEventListener("input", recordDraft);
  const commitDraft = (event: Event): void => {
    const changedInput = event.currentTarget as HTMLInputElement;
    const capturedFocus = captureResultInputFocus();
    const focus = capturedFocus.matchId === undefined || capturedFocus.scoreField === undefined
      ? {
          matchId: row.matchId,
          scoreField: changedInput.dataset.scoreField,
          selectionStart: changedInput.selectionStart,
          selectionEnd: changedInput.selectionEnd,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        }
      : capturedFocus;
    const draft = recordDraft();
    if (saved !== undefined && host.drafts.get(row.matchId) === undefined) return;
    const evaluation = evaluateResultDraft(draft, rule);
    if (evaluation.status !== "ready") return;
    const value: SavedResultInputValue = {
      regularHome: evaluation.regularHome,
      regularAway: evaluation.regularAway,
      ...(evaluation.penaltyHome === undefined ? {} : { penaltyHome: evaluation.penaltyHome }),
      ...(evaluation.penaltyAway === undefined ? {} : { penaltyAway: evaluation.penaltyAway }),
    };
    const fingerprint = host.drafts.planFingerprint;
    if (fingerprint === undefined) return;
    enqueueResultCommit(row, value, fingerprint, focus, inputs, host);
  };
  for (const input of inputs) input.addEventListener("change", commitDraft);
  return { regularFields, penaltyFields, stateControl, errorArea, inputs };
}

export function renderResultInput(options: RenderResultInputOptions): HTMLElement {
  const section = document.createElement("section");
  section.id = options.sectionId;
  section.className = "result-input-root";
  appendTextElement(section, "h3", options.heading);
  appendTextElement(section, "p", options.description, "muted");
  const rows: ResultInputRenderRow[] = options.rows.map((row) => ({
    ...row,
    editor: editorForRow(row, options.rule, options.host),
  }));
  if (options.presentation === "cards") {
    renderResultInputCards(section, rows, options.ariaLabel);
  } else {
    renderIntegratedResultInputTable(section, rows, options.ariaLabel);
  }
  options.content.append(section);
  return section;
}
