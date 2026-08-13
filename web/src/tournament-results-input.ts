import {
  evaluateTournamentResultDraft,
  type TournamentResultDraft,
  type TournamentResultDraftController,
  type TournamentResultDraftUiState,
} from "./tournament-result-drafts";
import {
  applyTournamentResultChange,
  resolveTournamentProgress,
  tournamentMatchDescendants,
  type TournamentMatchProgress,
} from "./tournament-results";
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
import type { JsonObject } from "./types";

export type TournamentResultsLayoutId =
  | "production-current"
  | "compact-table"
  | "integrated-status-table"
  | "responsive-cards"
  | "responsive-cards-quiet-table";

export type TournamentResultEntryState =
  | "waiting"
  | "empty"
  | "editing"
  | "invalid"
  | "saved";

export interface TournamentResultScheduleDetails {
  matchId: string;
  displayNumber: string;
  timeLabel: string;
  courtName: string;
}

export interface ScoreFocusSnapshot {
  matchId?: string;
  scoreField?: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  scrollX: number;
  scrollY: number;
}

export interface TournamentResultsInputHost {
  drafts: TournamentResultDraftController;
  currentResults: () => readonly JsonObject[];
  persistDrafts: (state: TournamentResultDraftUiState | undefined) => Promise<void>;
  commitResults: (
    results: JsonObject[],
    draftState: TournamentResultDraftUiState | undefined,
  ) => Promise<void>;
  setSaveStatus: (message: string) => void;
  announce: (message: string) => void;
  refreshCompletion: () => void;
  rerender: (focus: ScoreFocusSnapshot) => void;
}

interface TournamentResultCommitQueue {
  tail: Promise<void>;
  commitTail: Promise<void>;
  latestRequest: number;
  failed: boolean;
}

const tournamentResultCommitQueues = new WeakMap<
  TournamentResultDraftController,
  TournamentResultCommitQueue
>();

function commitQueue(controller: TournamentResultDraftController): TournamentResultCommitQueue {
  const current = tournamentResultCommitQueues.get(controller);
  if (current !== undefined) return current;
  const created = {
    tail: Promise.resolve(),
    commitTail: Promise.resolve(),
    latestRequest: 0,
    failed: false,
  };
  tournamentResultCommitQueues.set(controller, created);
  return created;
}

function trackResultOperation(
  queue: TournamentResultCommitQueue,
  operation: Promise<void>,
): void {
  queue.tail = Promise.all([queue.tail, operation.catch(() => undefined)])
    .then(() => undefined);
}

function sameDraft(
  left: TournamentResultDraft | undefined,
  right: TournamentResultDraft,
): left is TournamentResultDraft {
  return left !== undefined &&
    left.regularHome === right.regularHome &&
    left.regularAway === right.regularAway &&
    left.penaltyHome === right.penaltyHome &&
    left.penaltyAway === right.penaltyAway;
}

export type TournamentResultEditorView = ResultInputEditorView;

export interface TournamentResultsRenderRow extends ResultInputRenderRow {
  match: TournamentMatchProgress;
}

export interface TournamentResultsLayoutStrategy {
  id: TournamentResultsLayoutId;
  invalidStateLabel: "入力中" | "要確認";
  renderWaitingInputs: boolean;
  render: (section: HTMLElement, rows: readonly TournamentResultsRenderRow[]) => void;
}

export interface RenderTournamentResultsInputOptions {
  content: HTMLElement;
  plan: JsonObject;
  results: readonly JsonObject[];
  schedule: readonly TournamentResultScheduleDetails[];
  teamNames: ReadonlyMap<string, string>;
  layout: TournamentResultsLayoutStrategy;
  host: TournamentResultsInputHost;
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

function appendMatchDisplayNumber(
  parent: HTMLElement,
  matchId: string,
  displayNumber: string,
): HTMLElement {
  const badge = appendTextElement(parent, "span", displayNumber, "match-display-number");
  badge.dataset.matchId = matchId;
  badge.dataset.displayNumber = displayNumber;
  badge.setAttribute("aria-label", `試合番号 ${displayNumber}`);
  return badge;
}

function scoreInput(label: string, value: string, disabled: boolean): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "numeric";
  input.pattern = "[0-9]*";
  input.className = "score-input";
  input.setAttribute("aria-label", label);
  input.value = value;
  input.disabled = disabled;
  return input;
}

function scoreValue(input: HTMLInputElement): number | null | undefined {
  if (input.value.trim() === "") return null;
  const value = Number(input.value);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function captureTournamentScoreFocus(): ScoreFocusSnapshot {
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

export function scoreFocusForMatch(
  matchId: string,
  scoreField = "regularHome",
): ScoreFocusSnapshot {
  return {
    matchId,
    scoreField,
    selectionStart: null,
    selectionEnd: null,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
}

export function restoreTournamentScoreFocus(
  snapshot: ScoreFocusSnapshot,
  root: ParentNode = document,
): void {
  if (snapshot.matchId === undefined || snapshot.scoreField === undefined) return;
  const replacement = [...root.querySelectorAll<HTMLInputElement>(
    `input[data-score-field="${snapshot.scoreField}"]`,
  )].find((candidate) =>
    candidate.closest<HTMLElement>("[data-match-id]")?.dataset.matchId === snapshot.matchId
  );
  if (replacement === undefined || replacement === null) return;
  replacement.focus({ preventScroll: true });
  if (snapshot.selectionStart !== null && snapshot.selectionEnd !== null) {
    replacement.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
  }
  window.scrollTo(snapshot.scrollX, snapshot.scrollY);
}

function productionTableLayout(
  section: HTMLElement,
  rows: readonly TournamentResultsRenderRow[],
): void {
  const wrapper = document.createElement("div");
  wrapper.className = "table-wrap";
  const table = document.createElement("table");
  table.className = "tournament-results-table";
  table.setAttribute("aria-label", "2日目の試合結果入力");
  const head = document.createElement("thead");
  const heading = document.createElement("tr");
  for (const [field, label] of [
    ["match", "試合"],
    ["time", "時間"],
    ["court", "コート"],
    ["teams", "対戦"],
    ["regular-score", "通常得点"],
    ["penalty-score", "PK"],
    ["state", "保存状態"],
  ] as const) {
    const cell = appendTextElement(heading, "th", label);
    cell.scope = "col";
    cell.dataset.field = field;
  }
  head.append(heading);
  table.append(head);
  const body = document.createElement("tbody");
  for (const item of rows) {
    const row = document.createElement("tr");
    row.dataset.matchId = item.matchId;
    row.className = "tournament-result-entry";
    const numberCell = document.createElement("td");
    numberCell.dataset.field = "match";
    appendMatchDisplayNumber(numberCell, item.matchId, item.displayNumber);
    row.append(numberCell);
    const timeCell = appendTextElement(row, "td", item.timeLabel);
    timeCell.dataset.field = "time";
    const courtCell = appendTextElement(row, "td", item.courtName);
    courtCell.dataset.field = "court";
    const teamsCell = appendTextElement(
      row,
      "td",
      item.ready ? `${item.homeName} 対 ${item.awayName}` : "前提試合の結果待ち",
    );
    teamsCell.dataset.field = "teams";
    const regularCell = document.createElement("td");
    regularCell.dataset.field = "regular-score";
    regularCell.append(item.editor.regularFields);
    row.append(regularCell);
    const penaltyCell = document.createElement("td");
    penaltyCell.dataset.field = "penalty-score";
    penaltyCell.append(item.editor.penaltyFields);
    row.append(penaltyCell);
    const stateCell = document.createElement("td");
    stateCell.dataset.field = "state";
    stateCell.className = "tournament-result-state-cell";
    stateCell.append(
      item.editor.stateControl.element,
      item.editor.errorArea,
    );
    row.append(stateCell);
    body.append(row);
  }
  table.append(body);
  wrapper.append(table);
  section.append(wrapper);
}

export const productionCurrentTournamentResultsLayout: TournamentResultsLayoutStrategy = {
  id: "production-current",
  invalidStateLabel: "入力中",
  renderWaitingInputs: true,
  render: productionTableLayout,
};

export function responsiveTournamentResultsLayout(
  presentation: ResultInputPresentation,
): TournamentResultsLayoutStrategy {
  return {
    id: "responsive-cards",
    invalidStateLabel: "要確認",
    renderWaitingInputs: false,
    render: (section, rows) => {
      section.classList.add("result-input-root");
      if (presentation === "cards") {
        renderResultInputCards(section, rows, "2日目の試合結果入力");
      } else {
        renderIntegratedResultInputTable(section, rows, "2日目の試合結果入力");
      }
    },
  };
}

function buildEditor(
  match: TournamentMatchProgress,
  ready: boolean,
  displayNumber: string,
  homeName: string,
  awayName: string,
  options: RenderTournamentResultsInputOptions,
): TournamentResultEditorView {
  const { host, layout, plan } = options;
  const matchId = match.matchId;
  const draft = host.drafts.get(matchId);
  if (!ready && !layout.renderWaitingInputs) {
    const stateControl = createResultInputStateControl("waiting", layout.invalidStateLabel);
    const errorArea = document.createElement("span");
    errorArea.className = "tournament-result-error";
    return {
      regularFields: document.createElement("span"),
      penaltyFields: document.createElement("span"),
      stateControl,
      errorArea,
      inputs: [],
    };
  }
  const regularHome = scoreInput(
    `${homeName} 対 ${awayName}・${homeName}の通常得点`,
    draft?.regularHome ??
      (match.result === undefined ? "" : String(match.result.regular_score_home)),
    !ready,
  );
  regularHome.dataset.scoreField = "regularHome";
  const regularAway = scoreInput(
    `${homeName} 対 ${awayName}・${awayName}の通常得点`,
    draft?.regularAway ??
      (match.result === undefined ? "" : String(match.result.regular_score_away)),
    !ready,
  );
  regularAway.dataset.scoreField = "regularAway";
  const regularFields = document.createElement("span");
  regularFields.className = "tournament-result-score-fields";
  regularFields.append(regularHome, document.createTextNode(" - "), regularAway);

  const penaltyHome = scoreInput(
    `${homeName} 対 ${awayName}・${homeName}のPK得点`,
    draft?.penaltyHome ??
      (match.result?.penalty_score_home === undefined
        ? ""
        : String(match.result.penalty_score_home)),
    !ready,
  );
  penaltyHome.dataset.scoreField = "penaltyHome";
  const penaltyAway = scoreInput(
    `${homeName} 対 ${awayName}・${awayName}のPK得点`,
    draft?.penaltyAway ??
      (match.result?.penalty_score_away === undefined
        ? ""
        : String(match.result.penalty_score_away)),
    !ready,
  );
  penaltyAway.dataset.scoreField = "penaltyAway";
  const penaltyFields = document.createElement("span");
  penaltyFields.className = "penalty-score-fields";
  penaltyFields.append(penaltyHome, document.createTextNode(" - "), penaltyAway);

  const stateControl = createResultInputStateControl(
    draft === undefined ? (match.result === undefined ? "empty" : "saved") : "editing",
    layout.invalidStateLabel,
  );
  const errorArea = document.createElement("span");
  errorArea.className = "tournament-result-error";
  errorArea.id = `tournament-result-error-${matchId}`;
  errorArea.setAttribute("aria-live", "polite");
  const inputs = [regularHome, regularAway, penaltyHome, penaltyAway] as const;
  for (const input of inputs) input.setAttribute("aria-describedby", errorArea.id);

  const savedDraft: TournamentResultDraft | undefined = match.result === undefined
    ? undefined
    : {
        regularHome: String(match.result.regular_score_home),
        regularAway: String(match.result.regular_score_away),
        penaltyHome: match.result.penalty_score_home === undefined
          ? ""
          : String(match.result.penalty_score_home),
        penaltyAway: match.result.penalty_score_away === undefined
          ? ""
          : String(match.result.penalty_score_away),
      };
  const baselineDraft: TournamentResultDraft = savedDraft ?? {
    regularHome: "",
    regularAway: "",
    penaltyHome: "",
    penaltyAway: "",
  };
  type ScoreField = keyof TournamentResultDraft;
  const inputByField: Record<ScoreField, HTMLInputElement> = {
    regularHome,
    regularAway,
    penaltyHome,
    penaltyAway,
  };
  const firstChangedField = (currentDraft: TournamentResultDraft): ScoreField =>
    (Object.keys(baselineDraft) as ScoreField[]).find(
      (field) => currentDraft[field] !== baselineDraft[field],
    ) ?? "regularHome";
  let lastEditedField: ScoreField = draft === undefined
    ? "regularHome"
    : firstChangedField(draft);
  const selections = new Map<ScoreField, { start: number | null; end: number | null }>();
  for (const [field, input] of Object.entries(inputByField) as Array<
    [ScoreField, HTMLInputElement]
  >) {
    const rememberSelection = (): void => {
      lastEditedField = field;
      selections.set(field, { start: input.selectionStart, end: input.selectionEnd });
    };
    input.addEventListener("focus", rememberSelection);
    input.addEventListener("select", rememberSelection);
    input.addEventListener("input", rememberSelection);
  }

  const updatePenaltyVisibility = (): void => {
    const home = scoreValue(regularHome);
    const away = scoreValue(regularAway);
    const tied = typeof home === "number" && typeof away === "number" && home === away;
    penaltyFields.hidden = !tied;
    if (typeof home === "number" && typeof away === "number" && !tied) {
      penaltyHome.value = "";
      penaltyAway.value = "";
    }
  };
  const draftFromInputs = (): TournamentResultDraft => ({
    regularHome: regularHome.value,
    regularAway: regularAway.value,
    penaltyHome: penaltyHome.value,
    penaltyAway: penaltyAway.value,
  });
  let discardDraft: () => Promise<void>;
  const renderDraftState = (currentDraft = host.drafts.get(matchId)): void => {
    for (const input of inputs) input.removeAttribute("aria-invalid");
    errorArea.textContent = "";
    if (!ready) {
      stateControl.setState("waiting", layout.invalidStateLabel);
      return;
    }
    if (currentDraft === undefined) {
      stateControl.setDraftAction(undefined);
      stateControl.setState(
        match.result === undefined ? "empty" : "saved",
        layout.invalidStateLabel,
      );
      return;
    }
    const evaluation = evaluateTournamentResultDraft(currentDraft);
    const actionLabel = match.result === undefined ? "入力をクリア" : "保存済の得点に戻す";
    const accessibleName = `試合番号 ${displayNumber}、${homeName} 対 ${awayName}：${actionLabel}`;
    stateControl.setDraftAction({
      label: actionLabel,
      accessibleName,
      onActivate: () => discardDraft(),
    });
    stateControl.setState(
      (evaluation.status === "invalid" ? "invalid" : "editing") satisfies ResultInputEntryState,
      layout.invalidStateLabel,
    );
    if (evaluation.status !== "invalid") return;
    errorArea.textContent = evaluation.message;
    const markInvalid = (input: HTMLInputElement, invalid: boolean): void => {
      if (invalid) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    };
    if (evaluation.message.startsWith("通常得点")) {
      markInvalid(regularHome, scoreValue(regularHome) === undefined);
      markInvalid(regularAway, scoreValue(regularAway) === undefined);
    } else {
      const tiedPenalty = evaluation.message.startsWith("PK戦");
      markInvalid(penaltyHome, tiedPenalty || scoreValue(penaltyHome) === undefined);
      markInvalid(penaltyAway, tiedPenalty || scoreValue(penaltyAway) === undefined);
    }
  };
  const queueDraftPersistence = (
    state: TournamentResultDraftUiState | undefined,
  ): Promise<void> => {
    const queue = commitQueue(host.drafts);
    // Start the IndexedDB transaction immediately. A formal result commit started by the
    // following change event is then queued after this transaction by IndexedDB itself,
    // even when the page is reloaded before this promise settles.
    const operation = host.persistDrafts(state);
    trackResultOperation(queue, operation);
    return operation;
  };
  const recordDraft = (): TournamentResultDraft => {
    updatePenaltyVisibility();
    const currentDraft = draftFromInputs();
    const changed = Object.keys(baselineDraft).some(
      (key) => currentDraft[key as keyof TournamentResultDraft] !==
        baselineDraft[key as keyof TournamentResultDraft],
    );
    if (changed) host.drafts.set(matchId, currentDraft);
    else host.drafts.delete(matchId);
    void queueDraftPersistence(host.drafts.snapshot()).catch(() => {
      host.announce(
        "入力途中の得点を保存できませんでした。正式に保存済みの結果は保持されています。",
      );
    });
    renderDraftState(changed ? currentDraft : undefined);
    host.refreshCompletion();
    return currentDraft;
  };
  discardDraft = async (): Promise<void> => {
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const focusField = lastEditedField.startsWith("penalty") &&
        (baselineDraft.regularHome !== baselineDraft.regularAway || savedDraft === undefined)
      ? "regularHome"
      : lastEditedField;
    const selection = selections.get(focusField);
    const row = regularFields.closest<HTMLElement>("[data-match-id]");
    row?.setAttribute("aria-busy", "true");
    stateControl.setBusy(true);
    for (const input of inputs) input.disabled = true;
    try {
      const queue = commitQueue(host.drafts);
      const operation = queue.tail.then(async () => {
        const nextDraftState = host.drafts.snapshotWithout([matchId]);
        await host.persistDrafts(nextDraftState);
        host.drafts.delete(matchId);
      });
      queue.tail = operation.catch(() => undefined);
      queue.commitTail = operation.catch(() => undefined);
      await operation;
      for (const [field, input] of Object.entries(inputByField) as Array<
        [ScoreField, HTMLInputElement]
      >) input.value = baselineDraft[field];
      updatePenaltyVisibility();
      renderDraftState(undefined);
      host.announce(match.result === undefined
        ? "入力途中の得点をクリアしました。"
        : "入力途中の変更を取り消し、保存済みの結果へ戻しました。");
      host.refreshCompletion();
      const focusInput = inputByField[focusField];
      focusInput.disabled = !ready;
      focusInput.focus({ preventScroll: true });
      if (selection?.start !== null && selection?.start !== undefined &&
          selection.end !== null && selection.end !== undefined) {
        const end = focusInput.value.length;
        focusInput.setSelectionRange(
          Math.min(selection.start, end),
          Math.min(selection.end, end),
        );
      }
      window.scrollTo(scrollX, scrollY);
    } catch {
      host.announce(
        "入力途中の変更を破棄できませんでした。入力内容は保持されています。もう一度お試しください。",
      );
      renderDraftState(host.drafts.get(matchId));
    } finally {
      row?.removeAttribute("aria-busy");
      stateControl.setBusy(false);
      for (const input of inputs) input.disabled = !ready;
    }
  };
  updatePenaltyVisibility();
  renderDraftState(draft);
  for (const input of inputs) input.addEventListener("input", recordDraft);

  const commitDraft = (event: Event): void => {
    if (!ready) return;
    const changedInput = event.currentTarget as HTMLInputElement;
    const capturedFocus = captureTournamentScoreFocus();
    const focusSnapshot = capturedFocus.matchId === undefined || capturedFocus.scoreField === undefined
      ? {
          matchId,
          scoreField: changedInput.dataset.scoreField,
          selectionStart: changedInput.selectionStart,
          selectionEnd: changedInput.selectionEnd,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        }
      : capturedFocus;
    const currentDraft = recordDraft();
    if (match.result !== undefined && host.drafts.get(matchId) === undefined) return;
    const evaluation = evaluateTournamentResultDraft(currentDraft);
    if (evaluation.status !== "ready") return;
    const queue = commitQueue(host.drafts);
    const request = ++queue.latestRequest;
    host.setSaveStatus("保存しています…");
    for (const input of inputs) input.disabled = true;
    const operation = queue.commitTail.then(async () => {
      const queuedDraft = host.drafts.get(matchId);
      if (!sameDraft(queuedDraft, currentDraft)) return;
      const queuedEvaluation = evaluateTournamentResultDraft(queuedDraft);
      if (queuedEvaluation.status !== "ready") return;
      const next: JsonObject = {
        match_id: matchId,
        home_team_id: match.homeTeamId!,
        away_team_id: match.awayTeamId!,
        regular_score_home: queuedEvaluation.regularHome,
        regular_score_away: queuedEvaluation.regularAway,
        ...(queuedEvaluation.penaltyRequired
          ? {
              penalty_score_home: queuedEvaluation.penaltyHome,
              penalty_score_away: queuedEvaluation.penaltyAway,
            }
          : {}),
      };
      const changed = applyTournamentResultChange(
        plan,
        host.currentResults(),
        matchId,
        next,
      );
      const removedDraftIds = [
        matchId,
        ...(changed.winnerChanged ? tournamentMatchDescendants(plan, matchId) : []),
      ];
      const nextDraftState = host.drafts.snapshotWithout(removedDraftIds);
      await host.commitResults(changed.results, nextDraftState);
      host.drafts.deleteMany(removedDraftIds);
      host.announce(changed.removedDescendantCount > 0
        ? `結果を保存し、勝者変更の影響を受ける後続${String(changed.removedDescendantCount)}試合を取り消しました。`
        : "2日目の試合結果をこの端末へ保存しました。");
    });
    queue.commitTail = operation.then(() => undefined, () => {
      queue.failed = true;
    });
    trackResultOperation(queue, operation);
    void operation.then(() => {
      if (request !== queue.latestRequest) return;
      if (queue.failed) {
        host.setSaveStatus("保存できませんでした");
        host.announce(
          "試合結果を保存できませんでした。入力途中の変更と以前の結果は保持されています。",
        );
      } else {
        host.setSaveStatus("この端末に保存済み");
      }
      host.refreshCompletion();
      const liveFocus = captureTournamentScoreFocus();
      host.rerender(
        liveFocus.matchId === undefined || liveFocus.scoreField === undefined
          ? focusSnapshot
          : liveFocus,
      );
      tournamentResultCommitQueues.delete(host.drafts);
    }).catch(() => {
      queue.failed = true;
      if (request !== queue.latestRequest) return;
      host.setSaveStatus("保存できませんでした");
      host.announce(
        "2日目の試合結果を保存できませんでした。入力途中の変更と以前の結果は保持されています。",
      );
      for (const input of inputs) input.disabled = false;
      renderDraftState(host.drafts.get(matchId));
      host.refreshCompletion();
      const liveFocus = captureTournamentScoreFocus();
      host.rerender(
        liveFocus.matchId === undefined || liveFocus.scoreField === undefined
          ? focusSnapshot
          : liveFocus,
      );
      tournamentResultCommitQueues.delete(host.drafts);
    });
  };
  for (const input of inputs) input.addEventListener("change", commitDraft);

  return { regularFields, penaltyFields, stateControl, errorArea, inputs };
}

export function renderTournamentResultsInput(
  options: RenderTournamentResultsInputOptions,
): HTMLElement {
  const { content, plan, results, schedule, teamNames, layout, host } = options;
  const progress = resolveTournamentProgress(plan, results);
  const scheduleByMatchId = new Map(schedule.map((item) => [item.matchId, item]));
  const scheduleOrder = new Map(schedule.map((item, index) => [item.matchId, index]));
  const ordered = [...progress.orderedMatches].sort(
    (left, right) =>
      (scheduleOrder.get(left.matchId) ?? Number.MAX_SAFE_INTEGER) -
      (scheduleOrder.get(right.matchId) ?? Number.MAX_SAFE_INTEGER),
  );
  const section = document.createElement("section");
  section.id = "tournament-results-input";
  section.dataset.layout = layout.id;
  appendTextElement(section, "h3", "2日目結果入力");
  appendTextElement(
    section,
    "p",
    `入力済み ${String(ordered.filter((match) => match.result !== undefined).length)} / ${String(ordered.length)}試合。前の試合を確定すると、後続試合のチームを入力できます。`,
    "muted",
  );
  const rows = ordered.map((match): TournamentResultsRenderRow => {
    const details = scheduleByMatchId.get(match.matchId);
    const ready = match.homeTeamId !== undefined && match.awayTeamId !== undefined;
    const homeName = ready
      ? teamNames.get(match.homeTeamId!) ?? match.homeTeamId!
      : "前提試合待ち";
    const awayName = ready
      ? teamNames.get(match.awayTeamId!) ?? match.awayTeamId!
      : "前提試合待ち";
    return {
      match,
      matchId: match.matchId,
      displayNumber: details?.displayNumber ?? match.matchId,
      timeLabel: details?.timeLabel ?? "未配置",
      courtName: details?.courtName ?? "未配置",
      ready,
      homeName,
      awayName,
      editor: buildEditor(
        match,
        ready,
        details?.displayNumber ?? match.matchId,
        homeName,
        awayName,
        options,
      ),
    };
  });
  layout.render(section, rows);
  content.append(section);
  return section;
}
