import "./style.css";
import "./excel-preview.css";

import {
  SCHEDULE_WORKBOOK_PREVIEW_MARKER,
  scheduleWorkbookFixture,
  scheduleWorkbookFixtures,
} from "./schedule-workbook-fixtures";
import { buildScheduleWorkbook } from "./schedule-workbook-model";
import { createWorkbookBlob, downloadWorkbookBlob } from "./xlsx-workbook";

function requiredElement<T extends Element>(selector: string): T {
  const target = document.querySelector<T>(selector);
  if (target === null) throw new Error("Excelプレビューの表示先を初期化できませんでした。");
  return target;
}

const fixtureSelect = requiredElement<HTMLSelectElement>("#excel-preview-fixture");
const description = requiredElement<HTMLElement>("#excel-preview-description");
const fileName = requiredElement<HTMLElement>("#excel-preview-file-name");
const errorHost = requiredElement<HTMLElement>("#excel-preview-error");
const downloadButton = requiredElement<HTMLButtonElement>("#excel-preview-download");

document.body.dataset.previewMarker = SCHEDULE_WORKBOOK_PREVIEW_MARKER;

for (const fixture of scheduleWorkbookFixtures) {
  const option = document.createElement("option");
  option.value = fixture.id;
  option.textContent = fixture.description;
  fixtureSelect.append(option);
}

function requestedFixtureId(): string {
  return new URLSearchParams(window.location.search).get("fixture")
    ?? scheduleWorkbookFixtures[0]!.id;
}

function setQuery(fixtureId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("fixture", fixtureId);
  window.history.replaceState(null, "", url);
}

function prepare(fixtureId: string): void {
  document.body.dataset.previewReady = "false";
  document.body.dataset.previewStatus = "loading";
  errorHost.textContent = "";
  const fixture = scheduleWorkbookFixture(fixtureId);
  if (fixture === undefined) {
    errorHost.textContent = `指定されたExcel fixture「${fixtureId}」は存在しません。`;
    downloadButton.disabled = true;
    document.body.dataset.previewStatus = "error";
    document.body.dataset.previewReady = "true";
    return;
  }
  try {
    const workbook = buildScheduleWorkbook(fixture.document, fixture.scope);
    fixtureSelect.value = fixture.id;
    description.textContent = fixture.description;
    fileName.textContent = workbook.fileName;
    document.title = `${fixture.description} | Excelプレビュー`;
    downloadButton.disabled = false;
    downloadButton.onclick = async () => {
      downloadButton.disabled = true;
      document.body.dataset.previewStatus = "generating";
      errorHost.textContent = "";
      try {
        const blob = await createWorkbookBlob(workbook);
        downloadWorkbookBlob(blob, workbook.fileName);
        document.body.dataset.previewStatus = "ready";
      } catch (error) {
        errorHost.textContent = `Excelを生成できませんでした。${error instanceof Error ? error.message : "fixtureを確認してください。"}`;
        document.body.dataset.previewStatus = "error";
      } finally {
        downloadButton.disabled = false;
      }
    };
    document.body.dataset.previewStatus = "ready";
  } catch (error) {
    errorHost.textContent = `Excel fixtureを安全に確認できませんでした。${error instanceof Error ? error.message : "fixtureを確認してください。"}`;
    downloadButton.disabled = true;
    document.body.dataset.previewStatus = "error";
  }
  document.body.dataset.previewReady = "true";
}

fixtureSelect.addEventListener("change", () => {
  setQuery(fixtureSelect.value);
  prepare(fixtureSelect.value);
});

prepare(requestedFixtureId());
