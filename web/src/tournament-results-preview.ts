import {
  TournamentResultDraftController,
  tournamentPlanFingerprint,
} from "./tournament-result-drafts";
import {
  captureTournamentScoreFocus,
  renderTournamentResultsInput,
  restoreTournamentScoreFocus,
  type ScoreFocusSnapshot,
  type TournamentResultsInputHost,
  type TournamentResultsLayoutId,
} from "./tournament-results-input";
import {
  TOURNAMENT_RESULTS_PREVIEW_FIXTURE_MARKER,
  tournamentResultsPreviewScenario,
  tournamentResultsPreviewScenarios,
  type TournamentResultsPreviewScenario,
} from "./tournament-results-preview-fixtures";
import {
  TOURNAMENT_RESULTS_CARD_BREAKPOINT_DEFAULT,
  tournamentResultsPreviewLayout,
  tournamentResultsPreviewLayoutLabels,
  tournamentResultsPreviewLayouts,
} from "./tournament-results-preview-layouts";
import type { JsonObject } from "./types";
import "./style.css";
import "./tournament-results-preview.css";
import "./tournament-results-preview-shell.css";

const SUPPORTED_WIDTHS = [375, 768, 899, 900, 1002, 1280] as const;

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`プレビュー要素「${selector}」が見つかりません。`);
  return element;
}

function numberInRange(value: string | null, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

const controls = requiredElement<HTMLFormElement>("#preview-controls");
const layoutSelect = requiredElement<HTMLSelectElement>("#preview-layout");
const scenarioSelect = requiredElement<HTMLSelectElement>("#preview-scenario");
const widthSelect = requiredElement<HTMLSelectElement>("#preview-width");
const breakpointInput = requiredElement<HTMLInputElement>("#preview-card-breakpoint");
const status = requiredElement<HTMLOutputElement>("#preview-status");
const heading = requiredElement<HTMLHeadingElement>("#preview-heading");
const description = requiredElement<HTMLParagraphElement>("#preview-description");
const saveStatus = requiredElement<HTMLParagraphElement>("#preview-save-status");
const announcement = requiredElement<HTMLParagraphElement>("#preview-announcement");
const capture = requiredElement<HTMLElement>("#preview-capture");
const output = requiredElement<HTMLDivElement>("#preview-output");

for (const layoutId of Object.keys(tournamentResultsPreviewLayouts)) {
  const option = document.createElement("option");
  option.value = layoutId;
  option.textContent = tournamentResultsPreviewLayoutLabels[
    layoutId as TournamentResultsLayoutId
  ];
  layoutSelect.append(option);
}
for (const scenario of tournamentResultsPreviewScenarios) {
  const option = document.createElement("option");
  option.value = scenario.id;
  option.textContent = scenario.label;
  scenarioSelect.append(option);
}

const parameters = new URLSearchParams(window.location.search);
const requestedLayout = parameters.get("layout") ?? "production-current";
layoutSelect.value = requestedLayout in tournamentResultsPreviewLayouts
  ? requestedLayout
  : "production-current";
const requestedScenario = parameters.get("scenario") ?? "mixed";
scenarioSelect.value = tournamentResultsPreviewScenario(requestedScenario)?.id ?? "mixed";
const requestedWidth = numberInRange(parameters.get("width"), 1002, 320, 1600);
widthSelect.value = SUPPORTED_WIDTHS.includes(requestedWidth as (typeof SUPPORTED_WIDTHS)[number])
  ? String(requestedWidth)
  : "1002";
breakpointInput.value = String(numberInRange(
  parameters.get("card-breakpoint"),
  TOURNAMENT_RESULTS_CARD_BREAKPOINT_DEFAULT,
  320,
  1600,
));

const drafts = new TournamentResultDraftController();
let activeScenario: TournamentResultsPreviewScenario;
let results: JsonObject[] = [];

function resetScenario(scenario: TournamentResultsPreviewScenario): void {
  activeScenario = scenario;
  results = structuredClone(scenario.results) as JsonObject[];
  drafts.activate(tournamentPlanFingerprint(scenario.plan), structuredClone(scenario.drafts));
  saveStatus.textContent = "プレビューのメモリ内に保存済み";
  announcement.textContent = "";
}

function selectedWidth(): number {
  return numberInRange(widthSelect.value, 1002, 320, 1600);
}

function selectedBreakpoint(): number {
  return numberInRange(
    breakpointInput.value,
    TOURNAMENT_RESULTS_CARD_BREAKPOINT_DEFAULT,
    320,
    1600,
  );
}

function updateLocation(layoutId: string, scenarioId: string, width: number, breakpoint: number): void {
  const next = new URLSearchParams({
    layout: layoutId,
    scenario: scenarioId,
    width: String(width),
    "card-breakpoint": String(breakpoint),
  });
  window.history.replaceState(null, "", `${window.location.pathname}?${next.toString()}`);
}

function renderPreview(focus?: ScoreFocusSnapshot): void {
  document.body.dataset.previewReady = "false";
  output.replaceChildren();
  const width = selectedWidth();
  const breakpoint = selectedBreakpoint();
  const layout = tournamentResultsPreviewLayout(layoutSelect.value, width, breakpoint);
  const scenario = tournamentResultsPreviewScenario(scenarioSelect.value);
  capture.style.setProperty("--preview-width", `${String(width)}px`);
  if (layout === undefined || scenario === undefined) {
    const error = document.createElement("p");
    error.className = "preview-error";
    error.textContent = "指定されたレイアウトまたは状態サンプルを読み取れませんでした。";
    output.append(error);
    status.textContent = "生成失敗";
    document.body.dataset.previewReady = "true";
    return;
  }

  const host: TournamentResultsInputHost = {
    drafts,
    persistDrafts: () => undefined,
    commitResults: async (nextResults) => {
      results = structuredClone(nextResults) as JsonObject[];
    },
    setSaveStatus: (message) => {
      saveStatus.textContent = message.replace("この端末", "プレビューのメモリ内");
    },
    announce: (message) => {
      announcement.textContent = message;
    },
    refreshCompletion: () => undefined,
    rerender: (snapshot) => renderPreview(snapshot),
  };

  try {
    renderTournamentResultsInput({
      content: output,
      plan: activeScenario.plan,
      results,
      schedule: activeScenario.schedule,
      teamNames: new Map(activeScenario.teams.map((team) => [team.id, team.name])),
      layout,
      host,
    });
    heading.textContent = `${activeScenario.label} / ${layout.id}`;
    description.textContent = `${activeScenario.description} 表示幅 ${String(width)}px、カード切替幅 ${String(breakpoint)}px。`;
    status.textContent = "生成完了";
    document.body.dataset.previewLayout = layout.id;
    document.body.dataset.previewScenario = activeScenario.id;
    document.body.dataset.previewWidth = String(width);
    document.body.dataset.previewCardBreakpoint = String(breakpoint);
    document.body.dataset.previewFixtureMarker = TOURNAMENT_RESULTS_PREVIEW_FIXTURE_MARKER;
    updateLocation(layout.id, activeScenario.id, width, breakpoint);
    if (focus !== undefined) restoreTournamentScoreFocus(focus, output);
  } catch (error) {
    output.replaceChildren();
    const message = document.createElement("p");
    message.className = "preview-error";
    message.textContent = error instanceof Error ? error.message : "プレビューを生成できませんでした。";
    output.append(message);
    status.textContent = "生成失敗";
  } finally {
    document.body.dataset.previewReady = "true";
  }
}

controls.addEventListener("change", (event) => {
  const target = event.target;
  if (target === scenarioSelect) {
    const scenario = tournamentResultsPreviewScenario(scenarioSelect.value);
    if (scenario !== undefined) resetScenario(scenario);
    renderPreview();
    return;
  }
  const focus = target === layoutSelect || target === widthSelect || target === breakpointInput
    ? captureTournamentScoreFocus()
    : undefined;
  renderPreview(focus);
});

const initialScenario = tournamentResultsPreviewScenario(scenarioSelect.value)
  ?? tournamentResultsPreviewScenarios[0];
if (initialScenario === undefined) throw new Error("結果入力プレビューのfixtureがありません。");
resetScenario(initialScenario);
renderPreview();
