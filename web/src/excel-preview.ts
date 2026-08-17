import "./style.css";
import "./excel-preview.css";

import {
  SCHEDULE_WORKBOOK_PREVIEW_MARKER,
  scheduleWorkbookFixtures,
} from "./schedule-workbook-fixtures";
import { leagueResultsWorkbookFixtures } from "./league-results-workbook-fixtures";
import { buildLeagueResultsWorkbook } from "./league-results-workbook-model";
import { buildScheduleWorkbook } from "./schedule-workbook-model";
import type {
  WorkbookCell,
  WorkbookCellStyle,
  WorkbookFile,
  WorkbookSheet,
} from "./workbook";
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
const workbookHost = requiredElement<HTMLElement>("#excel-preview-workbook");

document.body.dataset.previewMarker = SCHEDULE_WORKBOOK_PREVIEW_MARKER;

interface PreviewFixture {
  id: string;
  description: string;
  build: () => WorkbookFile;
}

const workbookFixtures: readonly PreviewFixture[] = [
  ...scheduleWorkbookFixtures.map((fixture): PreviewFixture => ({
    id: fixture.id,
    description: fixture.description,
    build: () => buildScheduleWorkbook(fixture.document, fixture.scope),
  })),
  ...leagueResultsWorkbookFixtures.map((fixture): PreviewFixture => ({
    id: fixture.id,
    description: fixture.description,
    build: () => buildLeagueResultsWorkbook(fixture.document),
  })),
];

for (const fixture of workbookFixtures) {
  const option = document.createElement("option");
  option.value = fixture.id;
  option.textContent = fixture.description;
  fixtureSelect.append(option);
}

function requestedFixtureId(): string {
  return new URLSearchParams(window.location.search).get("fixture")
    ?? workbookFixtures[0]!.id;
}

function setQuery(fixtureId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("fixture", fixtureId);
  window.history.replaceState(null, "", url);
}

function borderWidth(style: WorkbookCellStyle["borderStyle"]): string {
  return style === "medium" ? "2px" : "1px";
}

function applyCellStyle(target: HTMLTableCellElement, cell: Exclude<WorkbookCell, null>): void {
  if (cell.fontSize !== undefined) target.style.fontSize = `${String(cell.fontSize)}pt`;
  if (cell.fontWeight !== undefined) target.style.fontWeight = cell.fontWeight;
  if (cell.textColor !== undefined) target.style.color = cell.textColor;
  if (cell.backgroundColor !== undefined) target.style.backgroundColor = cell.backgroundColor;
  if (cell.align !== undefined) target.style.textAlign = cell.align;
  if (cell.alignVertical !== undefined) target.style.verticalAlign = cell.alignVertical;
  if (cell.wrap === false) target.style.whiteSpace = "nowrap";
  if (cell.borderStyle !== undefined) {
    target.style.border = `${borderWidth(cell.borderStyle)} solid ${cell.borderColor ?? "#AAB8B2"}`;
  }
  const sides = [
    ["border-left", cell.leftBorderStyle, cell.leftBorderColor],
    ["border-right", cell.rightBorderStyle, cell.rightBorderColor],
    ["border-top", cell.topBorderStyle, cell.topBorderColor],
    ["border-bottom", cell.bottomBorderStyle, cell.bottomBorderColor],
  ] as const;
  for (const [property, sideStyle, sideColor] of sides) {
    if (sideStyle !== undefined) {
      target.style.setProperty(
        property,
        `${borderWidth(sideStyle)} solid ${sideColor ?? "#AAB8B2"}`,
      );
    }
  }
}

function renderColumnGroup(sheet: WorkbookSheet): HTMLTableElement {
  const table = document.createElement("table");
  const totalWidth = sheet.columns.reduce((sum, column) => sum + column.width, 0);
  const columnGroup = document.createElement("colgroup");
  for (const column of sheet.columns) {
    const element = document.createElement("col");
    element.style.width = `${String(column.width / totalWidth * 100)}%`;
    columnGroup.append(element);
  }
  table.append(columnGroup);
  return table;
}

function appendRows(
  host: HTMLTableSectionElement,
  rows: readonly (readonly WorkbookCell[])[],
  columnCount: number,
): void {
  for (const row of rows) {
    const tableRow = document.createElement("tr");
    const height = row.reduce(
      (maximum, cell) => Math.max(maximum, cell?.height ?? 0),
      0,
    );
    if (height > 0 || row.length === 0) {
      tableRow.style.height = `${String(height || 15)}pt`;
    }
    if (row.length === 0) {
      const blankCell = document.createElement("td");
      blankCell.colSpan = columnCount;
      blankCell.className = "excel-preview-blank-row";
      tableRow.append(blankCell);
    }
    let coveredColumns = 0;
    for (const cell of row) {
      if (coveredColumns > 0) {
        coveredColumns -= 1;
        continue;
      }
      const tableCell = document.createElement("td");
      if (cell !== null) {
        tableCell.textContent = String(cell.value);
        if (cell.columnSpan !== undefined) {
          tableCell.colSpan = cell.columnSpan;
          coveredColumns = cell.columnSpan - 1;
        }
        applyCellStyle(tableCell, cell);
      }
      tableRow.append(tableCell);
    }
    host.append(tableRow);
  }
}

function renderTable(
  sheet: WorkbookSheet,
  rows: readonly (readonly WorkbookCell[])[],
  headerRowCount = 0,
): HTMLTableElement {
  const table = renderColumnGroup(sheet);
  if (headerRowCount > 0) {
    const header = document.createElement("thead");
    appendRows(header, rows.slice(0, headerRowCount), sheet.columns.length);
    table.append(header);
  }
  const body = document.createElement("tbody");
  appendRows(body, rows.slice(headerRowCount), sheet.columns.length);
  table.append(body);
  return table;
}

function renderSheet(sheet: WorkbookSheet): HTMLElement {
  const section = document.createElement("section");
  section.className = "excel-preview-sheet";
  section.dataset.columnCount = String(sheet.columns.length);

  const screenTitle = document.createElement("h2");
  screenTitle.textContent = sheet.name;
  screenTitle.className = "excel-preview-sheet-title";
  section.append(screenTitle);

  const repeatedRows = sheet.print?.repeatRows;
  if (repeatedRows !== undefined && repeatedRows[0] === repeatedRows[1]) {
    const headerIndex = repeatedRows[0] - 1;
    if (headerIndex > 0) section.append(renderTable(sheet, sheet.rows.slice(0, headerIndex)));
    section.append(renderTable(sheet, sheet.rows.slice(headerIndex), 1));
  } else {
    section.append(renderTable(sheet, sheet.rows));
  }
  return section;
}

function renderWorkbook(workbook: WorkbookFile): void {
  workbookHost.replaceChildren(...workbook.sheets.map(renderSheet));
}

function prepare(fixtureId: string): void {
  document.body.dataset.previewReady = "false";
  document.body.dataset.previewStatus = "loading";
  errorHost.textContent = "";
  const fixture = workbookFixtures.find((candidate) => candidate.id === fixtureId);
  if (fixture === undefined) {
    errorHost.textContent = `指定されたExcel fixture「${fixtureId}」は存在しません。`;
    downloadButton.disabled = true;
    document.body.dataset.previewStatus = "error";
    document.body.dataset.previewReady = "true";
    return;
  }
  try {
    const workbook = fixture.build();
    fixtureSelect.value = fixture.id;
    description.textContent = fixture.description;
    fileName.textContent = workbook.fileName;
    document.title = `${fixture.description} | Excelプレビュー`;
    renderWorkbook(workbook);
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
    workbookHost.replaceChildren();
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
