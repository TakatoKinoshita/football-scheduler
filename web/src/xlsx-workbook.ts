import writeXlsxFile, {
  type CellObject,
  type Feature,
  type Sheet,
} from "write-excel-file/universal";
import {
  appendMarkupInsideElement,
  findElement,
  findElementInsideElement,
  getClosingTagMarkup,
  getOpeningTagMarkup,
  getOrderOfSiblings,
  getSelfClosingTagMarkup,
  insertElementMarkupAccordingToOrderOfSiblings,
  replaceElement,
  sanitizeTextContent,
} from "write-excel-file/utility";

import {
  XLSX_MIME_TYPE,
  type WorkbookCell,
  type WorkbookFile,
  uniqueSheetNames,
} from "./workbook";

function writeCell(cell: WorkbookCell): CellObject | null {
  if (cell === null) return null;
  const { kind, value, ...style } = cell;
  return kind === "text"
    ? { value, type: String, ...style }
    : { value, type: Number, ...style };
}

function columnName(column: number): string {
  let value = column;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function printTitlesFormula(
  sheetName: string,
  print: NonNullable<WorkbookFile["sheets"][number]["print"]>,
): string | undefined {
  const references: string[] = [];
  const escapedSheetName = sheetName.replaceAll("'", "''");
  if (print.repeatRows !== undefined) {
    references.push(
      `'${escapedSheetName}'!$${String(print.repeatRows[0])}:$${String(print.repeatRows[1])}`,
    );
  }
  if (print.repeatColumns !== undefined) {
    references.push(
      `'${escapedSheetName}'!$${columnName(print.repeatColumns[0])}:$${columnName(print.repeatColumns[1])}`,
    );
  }
  return references.length === 0 ? undefined : references.join(",");
}

function addFitToPage(xml: string): string {
  const setupMarkup = getSelfClosingTagMarkup("pageSetUpPr", {
    fitToPage: 1,
    autoPageBreaks: 0,
  });
  const sheetPr = findElement(xml, "sheetPr");
  if (sheetPr === undefined) {
    return insertElementMarkupAccordingToOrderOfSiblings(
      xml,
      `${getOpeningTagMarkup("sheetPr")}${setupMarkup}${getClosingTagMarkup("sheetPr")}`,
      getOrderOfSiblings("xl/worksheets/sheet{id}.xml", "worksheet") ?? [],
      "worksheet",
    );
  }
  if (findElementInsideElement(xml, "pageSetUpPr", sheetPr) !== undefined) return xml;
  if (sheetPr.selfClosingTag) {
    return replaceElement(
      xml,
      sheetPr,
      `${getOpeningTagMarkup("sheetPr", sheetPr.openingTagAttributes)}${setupMarkup}${getClosingTagMarkup("sheetPr")}`,
    );
  }
  return appendMarkupInsideElement(xml, sheetPr, setupMarkup);
}

function workbookPrintFeature(workbook: WorkbookFile): Feature<Blob> {
  const names = uniqueSheetNames(workbook.sheets.map((sheet) => sheet.name));
  return {
    files: {
      transform: {
        "xl/worksheets/sheet{id}.xml": {
          transformElementAttributes: (tagName, attributes, _index, _options, properties) => {
            const print = workbook.sheets[properties.sheetIndex]?.print;
            if (tagName !== "pageSetup" || print?.fitToWidth === undefined) return attributes;
            return {
              ...attributes,
              fitToWidth: print.fitToWidth,
              fitToHeight: print.fitToHeight ?? 0,
            };
          },
          transform: (xml, _options, properties) => {
            const print = workbook.sheets[properties.sheetIndex]?.print;
            return print?.fitToWidth === undefined ? xml : addFitToPage(xml);
          },
        },
        "xl/workbook.xml": {
          transform: (xml) => {
            const entries = workbook.sheets.flatMap((sheet, index) => {
              const formula = sheet.print === undefined
                ? undefined
                : printTitlesFormula(names[index]!, sheet.print);
              return formula === undefined ? [] : [
                `${getOpeningTagMarkup("definedName", {
                  name: "_xlnm.Print_Titles",
                  localSheetId: index,
                })}${sanitizeTextContent(formula)}${getClosingTagMarkup("definedName")}`,
              ];
            });
            if (entries.length === 0) return xml;
            const definedNames = findElement(xml, "definedNames");
            if (definedNames === undefined) {
              return insertElementMarkupAccordingToOrderOfSiblings(
                xml,
                `${getOpeningTagMarkup("definedNames")}${entries.join("")}${getClosingTagMarkup("definedNames")}`,
                getOrderOfSiblings("xl/workbook.xml", "workbook") ?? [],
                "workbook",
              );
            }
            if (definedNames.selfClosingTag) {
              return replaceElement(
                xml,
                definedNames,
                `${getOpeningTagMarkup("definedNames", definedNames.openingTagAttributes)}${entries.join("")}${getClosingTagMarkup("definedNames")}`,
              );
            }
            return appendMarkupInsideElement(xml, definedNames, entries.join(""));
          },
        },
      },
    },
  };
}

export function xlsxSheets(workbook: WorkbookFile): Sheet<Blob>[] {
  const names = uniqueSheetNames(workbook.sheets.map((sheet) => sheet.name));
  return workbook.sheets.map((sheet, index) => ({
    sheet: names[index]!,
    data: sheet.rows.map((row) => row.map(writeCell)),
    columns: sheet.columns.map((column) => ({ width: column.width })),
    ...(sheet.orientation === undefined ? {} : { orientation: sheet.orientation }),
    ...(sheet.stickyRowsCount === undefined ? {} : { stickyRowsCount: sheet.stickyRowsCount }),
    ...(sheet.stickyColumnsCount === undefined
      ? {}
      : { stickyColumnsCount: sheet.stickyColumnsCount }),
    ...(sheet.zoomScale === undefined ? {} : { zoomScale: sheet.zoomScale }),
    showGridLines: false,
  }));
}

export async function createWorkbookBlob(workbook: WorkbookFile): Promise<Blob> {
  if (workbook.sheets.length === 0) throw new Error("Excel workbookにsheetがありません。");
  const blob = await writeXlsxFile(xlsxSheets(workbook), {
    fontFamily: "Yu Gothic",
    fontSize: 10,
    features: [workbookPrintFeature(workbook)],
  }).toBlob();
  if (blob.type !== XLSX_MIME_TYPE) {
    return new Blob([blob], { type: XLSX_MIME_TYPE });
  }
  return blob;
}

export function downloadWorkbookBlob(
  blob: Blob,
  fileName: string,
  targetDocument: Document = document,
  targetUrl: Pick<typeof URL, "createObjectURL" | "revokeObjectURL"> = URL,
): void {
  const href = targetUrl.createObjectURL(blob);
  const anchor = targetDocument.createElement("a");
  anchor.href = href;
  anchor.download = fileName;
  anchor.hidden = true;
  targetDocument.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => targetUrl.revokeObjectURL(href), 0);
}
