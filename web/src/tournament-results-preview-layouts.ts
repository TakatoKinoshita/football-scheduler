import {
  productionCurrentTournamentResultsLayout,
  type TournamentResultsLayoutId,
  type TournamentResultsLayoutStrategy,
  type TournamentResultsRenderRow,
} from "./tournament-results-input";
import {
  renderIntegratedResultInputTable,
  renderResultInputCards,
} from "./result-input-layout";

export const TOURNAMENT_RESULTS_CARD_BREAKPOINT_DEFAULT = 899;

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

function appendDisplayNumber(parent: HTMLElement, row: TournamentResultsRenderRow): void {
  const badge = appendTextElement(
    parent,
    "span",
    row.displayNumber,
    "match-display-number",
  );
  badge.dataset.matchId = row.matchId;
  badge.dataset.displayNumber = row.displayNumber;
  badge.setAttribute("aria-label", `試合番号 ${row.displayNumber}`);
}

function appendHeadingCell(
  row: HTMLTableRowElement,
  field: string,
  label: string,
): void {
  const cell = appendTextElement(row, "th", label);
  cell.scope = "col";
  cell.dataset.field = field;
}

function prepareScoreFields(row: TournamentResultsRenderRow): void {
  const prepareLine = (
    fields: HTMLElement,
    field: "regular-score" | "penalty-score",
    label: string,
  ): void => {
    const inputs = [...fields.querySelectorAll<HTMLInputElement>("input")];
    if (inputs.length !== 2) return;
    fields.classList.add("results-preview-score-line");
    fields.dataset.field = field;
    const kind = document.createElement("span");
    kind.className = "results-preview-score-kind";
    kind.textContent = label;
    const pair = document.createElement("span");
    pair.className = "results-preview-score-pair";
    const separator = document.createElement("span");
    separator.className = "results-preview-score-separator";
    separator.textContent = "−";
    separator.setAttribute("aria-hidden", "true");
    pair.append(inputs[0]!, separator, inputs[1]!);
    fields.replaceChildren(kind, pair);
  };
  prepareLine(row.editor.regularFields, "regular-score", "通常");
  prepareLine(row.editor.penaltyFields, "penalty-score", "PK");
}

function prepareCandidateStateLabel(row: TournamentResultsRenderRow): void {
  const stateLabel = row.editor.stateControl.element.querySelector<HTMLElement>(
    ".tournament-result-state-label",
  );
  if (stateLabel?.dataset.state === "saved") {
    stateLabel.textContent = "保存済";
    stateLabel.setAttribute("aria-label", "保存済み");
  } else if (stateLabel?.dataset.state === "waiting") {
    stateLabel.textContent = "待機中";
    stateLabel.setAttribute("aria-label", "前提試合待ち");
  }
}

function appendScoreEditor(
  parent: HTMLElement,
  row: TournamentResultsRenderRow,
): void {
  if (!row.ready) {
    const waiting = appendTextElement(
      parent,
      "span",
      "—",
      "results-preview-waiting-placeholder",
    );
    waiting.dataset.field = "waiting-message";
    waiting.setAttribute(
      "aria-label",
      "得点は前提試合の結果が確定した後に入力できます",
    );
    return;
  }
  prepareScoreFields(row);
  const fields = document.createElement("div");
  fields.className = "results-preview-score-editor";
  fields.append(row.editor.regularFields, row.editor.penaltyFields);
  parent.append(fields);
}

function appendEditorFeedback(
  parent: HTMLElement,
  row: TournamentResultsRenderRow,
): void {
  parent.append(row.editor.errorArea);
}

function appendTableShell(
  section: HTMLElement,
  className: string,
  label: string,
  headings: readonly (readonly [field: string, label: string])[],
): { table: HTMLTableElement; body: HTMLTableSectionElement } {
  const wrapper = document.createElement("div");
  wrapper.className = "table-wrap results-preview-table-wrap";
  const table = document.createElement("table");
  table.className = `results-preview-table ${className}`;
  table.setAttribute("aria-label", label);
  const head = document.createElement("thead");
  const heading = document.createElement("tr");
  for (const [field, headingLabel] of headings) {
    appendHeadingCell(heading, field, headingLabel);
  }
  head.append(heading);
  const body = document.createElement("tbody");
  table.append(head, body);
  wrapper.append(table);
  section.append(wrapper);
  return { table, body };
}

function compactTableLayout(
  section: HTMLElement,
  rows: readonly TournamentResultsRenderRow[],
): void {
  section.dataset.resultsPreviewLayout = "compact-table";
  const { body } = appendTableShell(
    section,
    "results-preview-table--compact",
    "2日目の試合結果入力・圧縮表",
    [
      ["match", "試合"],
      ["time", "時間"],
      ["court", "コート"],
      ["teams", "対戦"],
      ["result", "結果"],
      ["state", "保存状態"],
    ],
  );
  for (const item of rows) {
    prepareCandidateStateLabel(item);
    const row = document.createElement("tr");
    row.dataset.matchId = item.matchId;
    row.className = "tournament-result-entry results-preview-entry";
    const match = document.createElement("td");
    match.dataset.field = "match";
    appendDisplayNumber(match, item);
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
    appendEditorFeedback(result, item);
    row.append(result);
    const state = document.createElement("td");
    state.dataset.field = "state";
    state.className = "results-preview-state-cell";
    state.append(item.editor.stateControl.element);
    row.append(state);
    body.append(row);
  }
}

function integratedStatusTableLayout(
  section: HTMLElement,
  rows: readonly TournamentResultsRenderRow[],
): void {
  section.dataset.resultsPreviewLayout = "integrated-status-table";
  const { body } = appendTableShell(
    section,
    "results-preview-table--integrated",
    "2日目の試合結果入力・状態統合表",
    [
      ["match", "試合"],
      ["time", "時間"],
      ["court", "コート"],
      ["teams", "対戦"],
      ["result", "結果"],
    ],
  );
  for (const item of rows) {
    prepareCandidateStateLabel(item);
    const row = document.createElement("tr");
    row.dataset.matchId = item.matchId;
    row.className = "tournament-result-entry results-preview-entry";
    const match = document.createElement("td");
    match.dataset.field = "match";
    appendDisplayNumber(match, item);
    match.append(item.editor.stateControl.element);
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
    appendEditorFeedback(result, item);
    row.append(result);
    body.append(row);
  }
}

function appendCardMetadata(
  article: HTMLElement,
  row: TournamentResultsRenderRow,
): void {
  const metadata = document.createElement("dl");
  metadata.className = "results-preview-card-meta";
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

function cardsLayout(
  section: HTMLElement,
  rows: readonly TournamentResultsRenderRow[],
): void {
  section.dataset.resultsPreviewLayout = "responsive-cards";
  section.dataset.responsivePresentation = "cards";
  const list = document.createElement("ol");
  list.className = "results-preview-card-list";
  list.setAttribute("aria-label", "2日目の試合結果入力");
  for (const item of rows) {
    prepareCandidateStateLabel(item);
    const listItem = document.createElement("li");
    const article = document.createElement("article");
    article.className =
      "tournament-result-entry results-preview-card results-preview-entry";
    article.dataset.matchId = item.matchId;
    const header = document.createElement("header");
    const heading = document.createElement("h4");
    heading.dataset.field = "match";
    appendDisplayNumber(heading, item);
    header.append(heading, item.editor.stateControl.element);
    article.append(header);
    appendCardMetadata(article, item);
    const teams = appendTextElement(
      article,
      "p",
      item.ready ? `${item.homeName} 対 ${item.awayName}` : "前提試合の結果待ち",
      "results-preview-card-teams",
    );
    teams.dataset.field = "teams";
    if (item.ready) {
      const fieldset = document.createElement("fieldset");
      fieldset.dataset.field = "result";
      fieldset.className = "results-preview-card-result";
      appendTextElement(fieldset, "legend", "試合結果");
      appendScoreEditor(fieldset, item);
      appendEditorFeedback(fieldset, item);
      article.append(fieldset);
    } else {
      const waiting = appendTextElement(
        article,
        "p",
        "得点は対戦チームの確定後に入力できます。",
        "results-preview-waiting",
      );
      waiting.dataset.field = "waiting-message";
    }
    listItem.append(article);
    list.append(listItem);
  }
  section.append(list);
}

function applySharedLayoutPreviewAliases(section: HTMLElement): void {
  section.querySelector(".result-input-table-wrap")?.classList.add("results-preview-table-wrap");
  section.querySelector(".result-input-table")?.classList.add(
    "results-preview-table",
    "results-preview-table--integrated",
  );
  for (const entry of section.querySelectorAll<HTMLElement>(".result-input-entry")) {
    entry.classList.add("tournament-result-entry", "results-preview-entry");
  }
  for (const card of section.querySelectorAll<HTMLElement>(".result-input-card")) {
    card.classList.add("results-preview-card");
  }
  section.querySelector(".result-input-card-list")?.classList.add("results-preview-card-list");
  for (const element of section.querySelectorAll<HTMLElement>("[class*='result-input-']")) {
    for (const className of [...element.classList]) {
      if (className.startsWith("result-input-")) {
        element.classList.add(className.replace("result-input-", "results-preview-"));
      }
    }
  }
}

function sharedIntegratedLayout(
  section: HTMLElement,
  rows: readonly TournamentResultsRenderRow[],
): void {
  renderIntegratedResultInputTable(section, rows, "2日目の試合結果入力・状態統合表");
  applySharedLayoutPreviewAliases(section);
}

function sharedCardsLayout(
  section: HTMLElement,
  rows: readonly TournamentResultsRenderRow[],
): void {
  renderResultInputCards(section, rows, "2日目の試合結果入力");
  applySharedLayoutPreviewAliases(section);
}

export const compactTableTournamentResultsLayout: TournamentResultsLayoutStrategy = {
  id: "compact-table",
  invalidStateLabel: "要確認",
  renderWaitingInputs: false,
  render: compactTableLayout,
};

export const integratedStatusTableTournamentResultsLayout: TournamentResultsLayoutStrategy = {
  id: "integrated-status-table",
  invalidStateLabel: "要確認",
  renderWaitingInputs: false,
  render: integratedStatusTableLayout,
};

const responsiveCardsTournamentResultsLayout: TournamentResultsLayoutStrategy = {
  id: "responsive-cards",
  invalidStateLabel: "要確認",
  renderWaitingInputs: false,
  render: cardsLayout,
};

const responsiveCardsQuietTableTournamentResultsLayout: TournamentResultsLayoutStrategy = {
  id: "responsive-cards-quiet-table",
  invalidStateLabel: "要確認",
  renderWaitingInputs: false,
  render: cardsLayout,
};

export const tournamentResultsPreviewLayouts = {
  "production-current": productionCurrentTournamentResultsLayout,
  "compact-table": compactTableTournamentResultsLayout,
  "integrated-status-table": integratedStatusTableTournamentResultsLayout,
  "responsive-cards": responsiveCardsTournamentResultsLayout,
  "responsive-cards-quiet-table": responsiveCardsQuietTableTournamentResultsLayout,
} as const satisfies Readonly<Record<TournamentResultsLayoutId, TournamentResultsLayoutStrategy>>;

export const tournamentResultsPreviewLayoutLabels = {
  "production-current": "現行：7列表",
  "compact-table": "A：圧縮表",
  "integrated-status-table": "B：状態統合表",
  "responsive-cards": "推奨：レスポンシブ",
  "responsive-cards-quiet-table": "推奨の変種：テーブルの状態バッジなし",
} as const satisfies Readonly<Record<TournamentResultsLayoutId, string>>;

export function tournamentResultsPreviewLayout(
  id: string,
  width: number,
  cardBreakpoint = TOURNAMENT_RESULTS_CARD_BREAKPOINT_DEFAULT,
): TournamentResultsLayoutStrategy | undefined {
  if (!Object.prototype.hasOwnProperty.call(tournamentResultsPreviewLayouts, id)) {
    return undefined;
  }
  const layout = tournamentResultsPreviewLayouts[id as TournamentResultsLayoutId];
  if (
    layout.id !== "responsive-cards" &&
    layout.id !== "responsive-cards-quiet-table"
  ) return layout;
  const useCards = Number.isFinite(width) && width <= cardBreakpoint;
  const layoutId = layout.id;
  return {
    ...layout,
    render: useCards
      ? (section, rows) => {
          sharedCardsLayout(section, rows);
          section.dataset.responsivePresentation = "cards";
          section.dataset.resultsPreviewLayout = layoutId;
        }
      : (section, rows) => {
          if (layoutId === "responsive-cards-quiet-table") {
            sharedIntegratedLayout(section, rows);
            section.dataset.resultsPreviewLayout = "responsive-cards-quiet-table";
            for (const state of section.querySelectorAll<HTMLElement>(
              ".tournament-result-state-label",
            )) state.classList.add("results-preview-state-label--visually-hidden");
          } else {
            sharedIntegratedLayout(section, rows);
            section.dataset.resultsPreviewLayout = layoutId;
          }
          section.dataset.responsivePresentation = "table";
        },
  };
}
