import writeXlsxFile, {
  type CellObject,
  type Sheet,
} from "write-excel-file/universal";

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

export function xlsxSheets(workbook: WorkbookFile): Sheet<Blob>[] {
  const names = uniqueSheetNames(workbook.sheets.map((sheet) => sheet.name));
  return workbook.sheets.map((sheet, index) => ({
    sheet: names[index]!,
    data: sheet.rows.map((row) => row.map(writeCell)),
    columns: sheet.columns.map((column) => ({ width: column.width })),
    showGridLines: false,
  }));
}

export async function createWorkbookBlob(workbook: WorkbookFile): Promise<Blob> {
  if (workbook.sheets.length === 0) throw new Error("Excel workbookにsheetがありません。");
  const blob = await writeXlsxFile(xlsxSheets(workbook), {
    fontFamily: "Yu Gothic",
    fontSize: 10,
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
