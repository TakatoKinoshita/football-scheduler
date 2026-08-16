import "./style.css";
import "./print-preview.css";

import {
  PRINT_PREVIEW_FIXTURE_MARKER,
  printPreviewFixture,
  printPreviewFixtures,
} from "./print-preview-fixtures";
import { buildPrintPreviewModel } from "./print-preview-model";
import { renderPrintPreview } from "./print-preview-renderer";

function requiredElement<T extends Element>(selector: string): T {
  const target = document.querySelector<T>(selector);
  if (target === null) throw new Error("印刷プレビューの表示先を初期化できませんでした。");
  return target;
}

const fixtureSelect = requiredElement<HTMLSelectElement>("#print-preview-fixture");
const description = requiredElement<HTMLElement>("#print-preview-description");
const host = requiredElement<HTMLElement>("#print-preview-host");
const errorHost = requiredElement<HTMLElement>("#print-preview-error");

document.body.dataset.previewMarker = PRINT_PREVIEW_FIXTURE_MARKER;

for (const fixture of printPreviewFixtures) {
  const option = document.createElement("option");
  option.value = fixture.id;
  option.textContent = fixture.description;
  fixtureSelect.append(option);
}

function requestedFixtureId(): string {
  return new URLSearchParams(window.location.search).get("fixture") ?? printPreviewFixtures[0]!.id;
}

function setQuery(fixtureId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("fixture", fixtureId);
  window.history.replaceState(null, "", url);
}

function render(fixtureId: string): void {
  document.body.dataset.previewReady = "false";
  document.body.dataset.previewStatus = "loading";
  host.replaceChildren();
  errorHost.replaceChildren();
  const fixture = printPreviewFixture(fixtureId);
  if (fixture === undefined) {
    const message = `指定された印刷fixture「${fixtureId}」は存在しません。出力を中止しました。`;
    errorHost.textContent = message;
    description.textContent = "固定fixtureを読み込めませんでした。";
    document.body.dataset.previewStatus = "error";
    document.body.dataset.previewReady = "true";
    return;
  }
  fixtureSelect.value = fixture.id;
  description.textContent = fixture.description;
  try {
    host.append(renderPrintPreview(buildPrintPreviewModel(fixture)));
    document.title = `${fixture.description} | 印刷プレビュー`;
    document.body.dataset.previewStatus = "ready";
  } catch (error) {
    errorHost.textContent = `印刷fixtureを安全に確認できなかったため出力しませんでした。${error instanceof Error ? error.message : "fixtureを確認してください。"}`;
    document.body.dataset.previewStatus = "error";
  }
  document.body.dataset.previewReady = "true";
}

fixtureSelect.addEventListener("change", () => {
  setQuery(fixtureSelect.value);
  render(fixtureSelect.value);
});

render(requestedFixtureId());
