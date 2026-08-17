export const XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface WorkbookCellStyle {
  fontWeight?: "bold";
  textColor?: string;
  backgroundColor?: string;
  borderColor?: string;
  borderStyle?: "thin" | "medium";
  leftBorderColor?: string;
  leftBorderStyle?: "thin" | "medium";
  rightBorderColor?: string;
  rightBorderStyle?: "thin" | "medium";
  topBorderColor?: string;
  topBorderStyle?: "thin" | "medium";
  bottomBorderColor?: string;
  bottomBorderStyle?: "thin" | "medium";
  align?: "left" | "center" | "right";
  alignVertical?: "top" | "center" | "bottom";
  wrap?: boolean;
  columnSpan?: number;
}

export type WorkbookCell =
  | ({ kind: "text"; value: string } & WorkbookCellStyle)
  | ({ kind: "number"; value: number } & WorkbookCellStyle)
  | null;

export interface WorkbookSheet {
  name: string;
  columns: readonly { width: number }[];
  rows: readonly (readonly WorkbookCell[])[];
}

export interface WorkbookFile {
  fileName: string;
  sheets: readonly WorkbookSheet[];
}

export function textCell(value: string, style: WorkbookCellStyle = {}): WorkbookCell {
  return { kind: "text", value, ...style };
}

export function numberCell(value: number, style: WorkbookCellStyle = {}): WorkbookCell {
  if (!Number.isFinite(value)) throw new Error("Excelへ出力する数値が不正です。");
  return { kind: "number", value, ...style };
}

function truncate(value: string, maximumLength: number): string {
  return Array.from(value).slice(0, maximumLength).join("");
}

export function sanitizeSheetName(name: string, fallback = "Sheet"): string {
  const normalized = name
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/[\\/*?:\[\]]/gu, "_")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^'+|'+$/gu, "")
    .trim();
  return truncate(normalized || fallback, 31);
}

export function uniqueSheetNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name, index) => {
    const base = sanitizeSheetName(name, `Sheet ${String(index + 1)}`);
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate.toLocaleLowerCase("en-US"))) {
      const addition = ` (${String(suffix)})`;
      candidate = `${truncate(base, 31 - Array.from(addition).length)}${addition}`;
      suffix += 1;
    }
    used.add(candidate.toLocaleLowerCase("en-US"));
    return candidate;
  });
}

const WINDOWS_RESERVED_FILE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export function sanitizeWorkbookFileName(name: string, fallback = "schedule.xlsx"): string {
  const withoutExtension = name.replace(/\.xlsx$/iu, "");
  let base = withoutExtension
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/[<>:"/\\|?*]/gu, "_")
    .replace(/\s+/gu, " ")
    .replace(/[ .]+$/gu, "")
    .trim();
  if (!base) base = fallback.replace(/\.xlsx$/iu, "") || "schedule";
  if (WINDOWS_RESERVED_FILE_NAME.test(base)) base = `_${base}`;
  return `${truncate(base, 116)}.xlsx`;
}
