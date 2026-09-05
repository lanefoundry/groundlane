import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { zipSync } from "fflate";
import { parseBoundedDocument, DOCUMENT_ENGINE_VERSION } from "../../src/adapters/document/bounded-document-parser.js";
import { buildCanonicalEnvelopeFromAdapter, projectCanonicalDocument } from "../../src/core/canonical-document.js";
import { parseCanonicalDocumentEnvelope } from "../../src/core/canonical-document-schema.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const zip = (files: Record<string, string>): Uint8Array => zipSync(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, bytes(value)])));

function pdf(): Uint8Array {
  const stream = "BT /F1 12 Tf 72 720 Td (PDF body) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let text = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = text.length;
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = text.length;
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  return bytes(`${text}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

void test("lossless canonical projections reject omitted or duplicate reading-order blocks", () => {
  const envelope = buildCanonicalEnvelopeFromAdapter({ documentId: "doc", sourceIdentity: { contentHash: "hash" },
    blocks: [{ type: "text", blockId: "first", content: "one" }, { type: "text", blockId: "second", content: "two" }],
    readingOrder: ["first", "second"], status: "success", capabilityStates: { text: "available" },
    provenance: { engine: "fixture", model: "none", version: "1", cost: null, confidence: null },
  });
  for (const readingOrder of [["first"], ["first", "first", "second"]]) {
    assert.throws(() => parseCanonicalDocumentEnvelope({ ...envelope, readingOrder }), /Reading order/u);
    assert.throws(() => projectCanonicalDocument({ ...envelope, readingOrder }, "structured"), /Reading order/u);
  }
});

const fixtures = [
  { filename: "document.pdf", mime: "application/pdf", data: pdf() },
  { filename: "text.txt", mime: "text/plain", data: bytes("台灣 body") },
  { filename: "table.csv", mime: "text/csv", data: bytes("name,value\n台灣,42") },
  { filename: "data.json", mime: "application/json", data: bytes('{"name":"台灣"}') },
  { filename: "data.xml", mime: "application/xml", data: bytes("<root><p>台灣</p></root>") },
  { filename: "page.html", mime: "text/html", data: bytes("<html><body><h1>Title</h1><p>台灣</p></body></html>") },
  { filename: "text.rtf", mime: "application/rtf", data: bytes("{\\rtf1\\ansi Hello\\par World}") },
  { filename: "mail.eml", mime: "message/rfc822", data: bytes("Subject: Subject\r\nContent-Type: text/plain\r\n\r\n台灣") },
  { filename: "word.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data: zip({
    "word/document.xml": '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>台灣</w:t></w:r></w:p></w:body></w:document>',
  }) },
  { filename: "sheet.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: zip({
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>台灣</t></is></c></row></sheetData></worksheet>',
  }) },
  { filename: "slide.pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", data: zip({
    "ppt/slides/slide1.xml": '<p:sld xmlns:p="p" xmlns:a="a"><a:t>台灣</a:t></p:sld>',
  }) },
  { filename: "document.odt", mime: "application/vnd.oasis.opendocument.text", data: zip({
    "content.xml": '<office:document xmlns:office="office" xmlns:text="text"><text:p>台灣</text:p></office:document>',
  }) },
  { filename: "sheet.ods", mime: "application/vnd.oasis.opendocument.spreadsheet", data: zip({
    "content.xml": '<office:document xmlns:office="office" xmlns:table="table" xmlns:text="text"><table:table><table:table-row><table:table-cell><text:p>台灣</text:p></table:table-cell></table:table-row></table:table></office:document>',
  }) },
  { filename: "slides.odp", mime: "application/vnd.oasis.opendocument.presentation", data: zip({
    "content.xml": '<office:document xmlns:office="office" xmlns:text="text"><text:p>台灣</text:p></office:document>',
  }) },
  { filename: "book.epub", mime: "application/epub+zip", data: zip({
    "META-INF/container.xml": '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
    "OPS/book.opf": '<package><manifest><item id="chapter" href="chapter.xhtml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
    "OPS/chapter.xhtml": "<html><body><p>台灣</p></body></html>",
  }) },
];

for (const fixture of fixtures) {
  void test(`canonical wire and projection roundtrip: ${fixture.filename}`, async () => {
    const parsed = await parseBoundedDocument({ bytes: fixture.data, declaredMime: fixture.mime, filename: fixture.filename });
    const envelope = buildCanonicalEnvelopeFromAdapter({ documentId: fixture.filename,
      sourceIdentity: { contentHash: `sha256-${createHash("sha256").update(fixture.data).digest("hex")}`, filename: fixture.filename },
      blocks: parsed.blocks, readingOrder: parsed.blocks.map((block) => block.blockId),
      status: "partial", capabilityStates: parsed.capabilities, warnings: parsed.warnings, metadata: parsed.metadata,
      provenance: { engine: "groundlane", model: "deterministic", version: DOCUMENT_ENGINE_VERSION, cost: 0, confidence: null },
    });
    assert.ok(envelope.blocks.length > 0);
    const decoded = parseCanonicalDocumentEnvelope(JSON.parse(JSON.stringify(envelope)) as unknown);
    assert.deepEqual(decoded, envelope);
    for (const kind of ["markdown", "text", "structured", "all"] as const) {
      const projection = projectCanonicalDocument(decoded, kind);
      assert.deepEqual(projection, projectCanonicalDocument(envelope, kind));
      assert.equal(projection.canonicalContentId, envelope.canonicalContentId);
      assert.equal(projection.sourceDocumentId, envelope.documentId);
      if (kind === "structured") {
        assert.equal(projection.lossy, false);
        assert.deepEqual(JSON.parse(projection.content), { readingOrder: envelope.readingOrder, blocks: envelope.blocks });
      }
    }
  });
}
