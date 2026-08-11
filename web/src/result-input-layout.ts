export type ResultInputPresentation = "table" | "cards";

export interface ResultInputEditorView {
  regularFields: HTMLElement;
  penaltyFields: HTMLElement;
  stateLabel: HTMLElement;
  errorArea: HTMLElement;
  cancelDraft: HTMLButtonElement;
  inputs: readonly HTMLInputElement[];
}

export interface ResultInputRenderRow {
  matchId: string;
  displayNumber: string;
  timeLabel: string;
  courtName: string;
  ready: boolean;
  homeName: string;
  awayName: string;
  editor: ResultInputEditorView;
}

export const RESULT_INPUT_CARD_BREAKPOINT_REM = 56.25;

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

function appendDisplayNumber(parent: HTMLElement, row: ResultInputRenderRow): void {
  const badge = appendTextElement(parent, "span", row.displayNumber, "match-display-number");
  badge.dataset.matchId = row.matchId;
  badge.dataset.displayNumber = row.displayNumber;
  badge.setAttribute("aria-label", `試合番号 ${row.displayNumber}`);
}

function prepareStateLabel(row: ResultInputRenderRow): void {
  if (row.editor.stateLabel.dataset.state === "saved") {
    row.editor.stateLabel.textContent = "保存済";
    row.editor.stateLabel.setAttribute("aria-label", "保存済み");
  } else if (row.editor.stateLabel.dataset.state === "waiting") {
    row.editor.stateLabel.textContent = "待機中";
    row.editor.stateLabel.setAttribute("aria-label", "前提試合待ち");
  }
}

function prepareScoreLine(
  fields: HTMLElement,
  field: "regular-score" | "penalty-score",
  label: string,
): void {
  if (fields.dataset.prepared === "true") return;
  const inputs = [...fields.querySelectorAll<HTMLInputElement>("input")];
  if (inputs.length !== 2) return;
  fields.classList.add("result-input-score-line");
  fields.dataset.field = field;
  fields.dataset.prepared = "true";
  const kind = document.createElement("span");
  kind.className = "result-input-score-kind";
  kind.textContent = label;
  const pair = document.createElement("span");
  pair.className = "result-input-score-pair";
  const separator = document.createElement("span");
  separator.className = "result-input-score-separator";
  separator.textContent = "−";
  separator.setAttribute("aria-hidden", "true");
  pair.append(inputs[0]!, separator, inputs[1]!);
  fields.replaceChildren(kind, pair);
}

function appendScoreEditor(parent: HTMLElement, row: ResultInputRenderRow): void {
  if (!row.ready) {
    const placeholder = appendTextElement(parent, "span", "—", "result-input-waiting-placeholder");
    placeholder.dataset.field = "waiting-message";
    placeholder.setAttribute("aria-label", "得点は前提試合の結果が確定した後に入力できます");
    return;
  }
  prepareScoreLine(row.editor.regularFields, "regular-score", "通常");
  prepareScoreLine(row.editor.penaltyFields, "penalty-score", "PK");
  const editor = document.createElement("div");
  editor.className = "result-input-score-editor";
  editor.append(row.editor.regularFields);
  if (row.editor.penaltyFields.childElementCount > 0) editor.append(row.editor.penaltyFields);
  parent.append(editor);
}

function appendFeedback(parent: HTMLElement, row: ResultInputRenderRow): void {
  parent.append(row.editor.errorArea, row.editor.cancelDraft);
}

export function renderIntegratedResultInputTable(
  section: HTMLElement,
  rows: readonly ResultInputRenderRow[],
  ariaLabel: string,
): void {
  section.dataset.responsivePresentation = "table";
  const wrapper = document.createElement("div");
  wrapper.className = "table-wrap result-input-table-wrap";
  const table = document.createElement("table");
  table.className = "result-input-table";
  table.setAttribute("aria-label", ariaLabel);
  const head = document.createElement("thead");
  const heading = document.createElement("tr");
  for (const [field, label] of [
    ["match", "試合"],
    ["time", "時間"],
    ["court", "コート"],
    ["teams", "対戦"],
    ["result", "結果"],
  ] as const) {
    const cell = appendTextElement(heading, "th", label);
    cell.scope = "col";
    cell.dataset.field = field;
  }
  head.append(heading);
  const body = document.createElement("tbody");
  for (const item of rows) {
    prepareStateLabel(item);
    const row = document.createElement("tr");
    row.dataset.matchId = item.matchId;
    row.className = "result-input-entry";
    const match = document.createElement("td");
    match.dataset.field = "match";
    appendDisplayNumber(match, item);
    match.append(item.editor.stateLabel);
    row.append(match);
    const time = appendTextElement(row, "td", item.timeLabel);
    time.dataset.field = "time";
    const court = appendTextElement(row, "td", item.courtName);
    court.dataset.field = "court";
    const teams = appendTextElement(
      row,
      "td",
      item.ready ? `${item.homeName} 対 ${item.awayName}` : "前提試合の結果待ち",
    );
    teams.dataset.field = "teams";
    const result = document.createElement("td");
    result.dataset.field = "result";
    appendScoreEditor(result, item);
    appendFeedback(result, item);
    row.append(result);
    body.append(row);
  }
  table.append(head, body);
  wrapper.append(table);
  section.append(wrapper);
}

function appendCardMetadata(article: HTMLElement, row: ResultInputRenderRow): void {
  const metadata = document.createElement("dl");
  metadata.className = "result-input-card-meta";
  for (const [field, label, value] of [
    ["time", "時間", row.timeLabel],
    ["court", "コート", row.courtName],
  ] as const) {
    const group = document.createElement("div");
    group.dataset.field = field;
    appendTextElement(group, "dt", label);
    appendTextElement(group, "dd", value);
    metadata.append(group);
  }
  article.append(metadata);
}

export function renderResultInputCards(
  section: HTMLElement,
  rows: readonly ResultInputRenderRow[],
  ariaLabel: string,
): void {
  section.dataset.responsivePresentation = "cards";
  const list = document.createElement("ol");
  list.className = "result-input-card-list";
  list.setAttribute("aria-label", ariaLabel);
  for (const item of rows) {
    prepareStateLabel(item);
    const listItem = document.createElement("li");
    const article = document.createElement("article");
    article.className = "result-input-entry result-input-card";
    article.dataset.matchId = item.matchId;
    const header = document.createElement("header");
    const heading = document.createElement("h4");
    heading.dataset.field = "match";
    appendDisplayNumber(heading, item);
    header.append(heading, item.editor.stateLabel);
    article.append(header);
    appendCardMetadata(article, item);
    const teams = appendTextElement(
      article,
      "p",
      item.ready ? `${item.homeName} 対 ${item.awayName}` : "前提試合の結果待ち",
      "result-input-card-teams",
    );
    teams.dataset.field = "teams";
    const fieldset = document.createElement("fieldset");
    fieldset.dataset.field = "result";
    fieldset.className = "result-input-card-result";
    appendTextElement(fieldset, "legend", "試合結果");
    appendScoreEditor(fieldset, item);
    appendFeedback(fieldset, item);
    article.append(fieldset);
    listItem.append(article);
    list.append(listItem);
  }
  section.append(list);
}

export function resultInputBreakpointPixels(root: Element = document.documentElement): number {
  const rootSize = Number.parseFloat(getComputedStyle(root).fontSize);
  return (Number.isFinite(rootSize) ? rootSize : 16) * RESULT_INPUT_CARD_BREAKPOINT_REM;
}

export function resultInputPresentationForWidth(
  width: number,
  breakpoint = resultInputBreakpointPixels(),
): ResultInputPresentation {
  return width < breakpoint ? "cards" : "table";
}

interface ObservedPresentation {
  observer: ResizeObserver;
  presentation: ResultInputPresentation;
}

const observedPresentations = new WeakMap<Element, ObservedPresentation>();

export function observeResultInputPresentation(
  root: HTMLElement,
  presentation: ResultInputPresentation,
  onChange: (presentation: ResultInputPresentation) => void,
): void {
  observedPresentations.get(root)?.observer.disconnect();
  if (typeof ResizeObserver === "undefined") return;
  const observer = new ResizeObserver((entries) => {
    const width = entries.at(-1)?.contentRect.width ?? root.getBoundingClientRect().width;
    const next = resultInputPresentationForWidth(width);
    const current = observedPresentations.get(root);
    if (current === undefined || current.presentation === next) return;
    current.presentation = next;
    onChange(next);
  });
  observedPresentations.set(root, { observer, presentation });
  observer.observe(root);
}
