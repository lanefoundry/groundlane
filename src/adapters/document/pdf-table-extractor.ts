import { GroundlaneError } from "../../core/errors.js";

export interface ExtractedTable {
  readonly pageNumber: number;
  readonly rows: readonly (readonly string[])[];
  readonly rowCount: number;
  readonly columnCount: number;
}

export interface TableExtractionResult {
  readonly tables: readonly ExtractedTable[];
  readonly engine: string;
}

interface TextItem {
  readonly str: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const COLUMN_MERGE_THRESHOLD = 8;
const ROW_MERGE_THRESHOLD = 3;

function failure(code: "UPSTREAM_ERROR" | "INVALID_INPUT", message: string): GroundlaneError {
  return new GroundlaneError(code, "document-table-extract", message, false);
}

export async function extractTablesFromPdf(
  bytes: Uint8Array,
  signal: AbortSignal,
  maxPages?: number,
): Promise<TableExtractionResult> {
  if (bytes.byteLength < 4) throw failure("INVALID_INPUT", "Empty or too small PDF");

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let document: Awaited<ReturnType<typeof pdfjs.getDocument>>["promise"] extends Promise<infer T> ? T : never;

  try {
    document = await pdfjs.getDocument({ data: bytes, useSystemFonts: true }).promise;
  } catch {
    signal.throwIfAborted();
    throw failure("INVALID_INPUT", "Malformed or unreadable PDF");
  }

  const pageLimit = Math.min(maxPages ?? 50, document.numPages);
  const tables: ExtractedTable[] = [];

  for (let pageNum = 1; pageNum <= pageLimit; pageNum += 1) {
    signal.throwIfAborted();
    const page = await document.getPage(pageNum);
    const textContent = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });

    const items: TextItem[] = textContent.items
      .filter((item): item is typeof item & { str: string; width: number; transform: number[] } =>
        "str" in item && typeof (item as Record<string, unknown>).str === "string" && (item as Record<string, unknown>).str !== "" &&
        "width" in item && "transform" in item)
      .map((item) => {
        const tx = item.transform;
        return {
          str: (item.str as string).trim(),
          x: tx[4] ?? 0,
          y: viewport.height - (tx[5] ?? 0),
          width: item.width as number,
          height: Math.abs(tx[3] ?? 12),
        };
      })
      .filter((item) => item.str !== "");

    if (items.length < 4) continue;

    const pageTables = detectTables(items, pageNum);
    tables.push(...pageTables);
  }

  return { tables, engine: "groundlane-pdf-table-heuristic-v1" };
}

function detectTables(items: TextItem[], pageNumber: number): ExtractedTable[] {
  // Group items into rows by Y coordinate
  const rows = groupByY(items);
  if (rows.length < 2) return [];

  // Find sequences of rows with consistent column alignment
  const columnSets = rows.map((row) => row.map((item) => item.x));

  const tables: ExtractedTable[] = [];
  let tableStart = -1;

  for (let i = 0; i < rows.length; i += 1) {
    if (columnSets[i]!.length >= 2) {
      if (tableStart === -1) tableStart = i;
    } else {
      if (tableStart !== -1 && i - tableStart >= 2) {
        tables.push(buildTable(rows.slice(tableStart, i), pageNumber));
      }
      tableStart = -1;
    }
  }

  if (tableStart !== -1 && rows.length - tableStart >= 2) {
    tables.push(buildTable(rows.slice(tableStart), pageNumber));
  }

  return tables;
}

function groupByY(items: TextItem[]): TextItem[][] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: TextItem[][] = [];
  let currentRow: TextItem[] = [];
  let currentY = -Infinity;

  for (const item of sorted) {
    if (Math.abs(item.y - currentY) > ROW_MERGE_THRESHOLD) {
      if (currentRow.length > 0) rows.push(currentRow);
      currentRow = [item];
      currentY = item.y;
    } else {
      currentRow.push(item);
    }
  }
  if (currentRow.length > 0) rows.push(currentRow);

  return rows;
}

function buildTable(rows: TextItem[][], pageNumber: number): ExtractedTable {
  // Determine column boundaries from all items
  const allX = rows.flatMap((row) => row.map((item) => item.x));
  const columns = mergeCloseValues(allX, COLUMN_MERGE_THRESHOLD);
  columns.sort((a, b) => a - b);

  const tableRows: string[][] = rows.map((row) => {
    const cells = new Array<string>(columns.length).fill("");
    for (const item of row) {
      const colIndex = findClosestColumn(item.x, columns);
      cells[colIndex] = cells[colIndex]
        ? `${cells[colIndex]} ${item.str}`
        : item.str;
    }
    return cells;
  });

  return {
    pageNumber,
    rows: tableRows,
    rowCount: tableRows.length,
    columnCount: columns.length,
  };
}

function mergeCloseValues(values: number[], threshold: number): number[] {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const merged: number[] = [];

  for (const value of sorted) {
    if (merged.length === 0 || value - merged[merged.length - 1]! > threshold) {
      merged.push(value);
    }
  }

  return merged;
}

function findClosestColumn(x: number, columns: number[]): number {
  let closest = 0;
  let minDist = Math.abs(x - columns[0]!);

  for (let i = 1; i < columns.length; i += 1) {
    const dist = Math.abs(x - columns[i]!);
    if (dist < minDist) {
      minDist = dist;
      closest = i;
    }
  }

  return closest;
}
