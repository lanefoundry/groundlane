import assert from "node:assert/strict";
import test from "node:test";

import {
  extractTablesFromPdf,
  type ExtractedTable,
} from "../../src/adapters/document/pdf-table-extractor.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

function simplePdf(text: string): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${String(text.length + 31)} >>\nstream\nBT /F1 12 Tf 72 720 Td (${text}) Tj ET\nendstream`,
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(bytes(source).byteLength);
    source += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  });
  const xref = bytes(source).byteLength;
  source += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return bytes(source);
}

void test("table extract: rejects too-small input", async () => {
  await assert.rejects(
    () => extractTablesFromPdf(new Uint8Array([1, 2, 3]), AbortSignal.timeout(5_000)),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes("Empty") || error.message.includes("small") || error.message.includes("Malformed"));
      return true;
    },
  );
});

void test("table extract: rejects non-PDF content", async () => {
  const notPdf = bytes("This is definitely not a PDF file at all");
  await assert.rejects(
    () => extractTablesFromPdf(notPdf, AbortSignal.timeout(5_000)),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      return true;
    },
  );
});

void test("table extract: processes a simple PDF without crashing", async () => {
  const pdf = simplePdf("Hello World");
  const result = await extractTablesFromPdf(pdf, AbortSignal.timeout(10_000));
  assert.ok(result !== null && result !== undefined);
  assert.ok(Array.isArray(result.tables));
  assert.equal(result.engine, "groundlane-pdf-table-heuristic-v1");
});

void test("table extract: respects maxPages parameter", async () => {
  const pdf = simplePdf("Single page content");
  const result = await extractTablesFromPdf(pdf, AbortSignal.timeout(10_000), 1);
  assert.ok(result !== null);
  assert.ok(Array.isArray(result.tables));
});

void test("table extract: returns correct result shape", async () => {
  const pdf = simplePdf("Name Age City");
  const result = await extractTablesFromPdf(pdf, AbortSignal.timeout(10_000));
  assert.equal(typeof result.engine, "string");
  assert.ok(Array.isArray(result.tables));
  for (const table of result.tables as readonly ExtractedTable[]) {
    assert.equal(typeof table.pageNumber, "number");
    assert.ok(Array.isArray(table.rows));
    assert.equal(typeof table.rowCount, "number");
    assert.equal(typeof table.columnCount, "number");
    assert.equal(table.rowCount, table.rows.length);
    for (const row of table.rows) {
      assert.ok(Array.isArray(row));
      assert.equal(row.length, table.columnCount);
    }
  }
});

void test("table extract: respects abort signal", async () => {
  const pdf = simplePdf("Abort test");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => extractTablesFromPdf(pdf, controller.signal),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      return true;
    },
  );
});
