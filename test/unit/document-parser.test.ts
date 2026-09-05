import assert from "node:assert/strict";
import test from "node:test";

import { zipSync } from "fflate";

import {
  MAX_DOCUMENT_TABLE_CELLS,
  parseBoundedDocument,
} from "../../src/adapters/document/bounded-document-parser.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

function zip(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, bytes(value)])));
}

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

void test("stable text, CSV, JSON, XML, HTML, RTF and EML profiles produce canonical blocks", async () => {
  const cases = [
    { filename: "a.txt", mime: "text/plain", data: "hello text", expected: "hello text" },
    { filename: "a.md", mime: "text/markdown", data: "# hello markdown", expected: "hello markdown" },
    { filename: "a.csv", mime: "text/csv", data: "name,value\na,1", expected: "a" },
    { filename: "a.json", mime: "application/json", data: '{"hello":"json"}', expected: "json" },
    { filename: "a.xml", mime: "application/xml", data: "<root><p>hello xml</p></root>", expected: "hello xml" },
    { filename: "a.html", mime: "text/html", data: "<title>T</title><main>hello html</main>", expected: "hello html" },
    { filename: "a.rtf", mime: "application/rtf", data: "{\\rtf1\\ansi hello rtf\\par next}", expected: "hello rtf" },
    { filename: "a.eml", mime: "message/rfc822", data: "Subject: Hello\r\nFrom: a@example.com\r\n\r\nhello email", expected: "hello email" },
    { filename: "multipart.eml", mime: "message/rfc822", data: "Subject: Multipart\r\nContent-Type: multipart/alternative; boundary=groundlane\r\n\r\n--groundlane\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nhello=20multipart\r\n--groundlane\r\nContent-Type: text/html\r\n\r\n<b>HTML fallback</b>\r\n--groundlane--\r\n", expected: "hello multipart" },
  ];
  for (const item of cases) {
    const parsed = await parseBoundedDocument({ bytes: bytes(item.data), declaredMime: item.mime, filename: item.filename });
    assert.match(JSON.stringify(parsed), new RegExp(item.expected));
    assert.equal(parsed.capabilities.text, "available");
  }
});

void test("stable DOCX, XLSX, PPTX, ODF and EPUB profiles preserve basic structure", async () => {
  const cases = [
    {
      filename: "a.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      data: zip({ "word/document.xml": '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p>Cell</w:p></w:tc></w:tr></w:tbl></w:body></w:document>' }),
      expected: "Hello DOCX",
    },
    {
      filename: "a.xlsx",
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      data: zip({ "xl/sharedStrings.xml": "<sst><si><t>Hello XLSX</t></si></sst>", "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row><c t="s"><v>0</v></c></row></sheetData></worksheet>' }),
      expected: "Hello XLSX",
    },
    {
      filename: "a.pptx",
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      data: zip({ "ppt/slides/slide1.xml": '<p:sld xmlns:p="p" xmlns:a="a"><a:t>Hello PPTX</a:t></p:sld>' }),
      expected: "Hello PPTX",
    },
    {
      filename: "a.odt",
      mime: "application/vnd.oasis.opendocument.text",
      data: zip({ "content.xml": '<office:document xmlns:office="office" xmlns:text="text"><text:p>Hello ODT</text:p></office:document>' }),
      expected: "Hello ODT",
    },
    {
      filename: "a.ods",
      mime: "application/vnd.oasis.opendocument.spreadsheet",
      data: zip({ "content.xml": '<office:document xmlns:office="office" xmlns:table="table" xmlns:text="text"><table:table><table:table-row><table:table-cell><text:p>Hello ODS</text:p></table:table-cell></table:table-row></table:table></office:document>' }),
      expected: "Hello ODS",
    },
    {
      filename: "a.odp",
      mime: "application/vnd.oasis.opendocument.presentation",
      data: zip({ "content.xml": '<office:document xmlns:office="office" xmlns:text="text"><text:p>Hello ODP</text:p></office:document>' }),
      expected: "Hello ODP",
    },
    {
      filename: "a.epub",
      mime: "application/epub+zip",
      data: zip({
        "META-INF/container.xml": '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
        "OPS/book.opf": '<package xmlns:dc="dc"><metadata><dc:title>Book</dc:title></metadata><manifest><item id="c1" href="c1.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>',
        "OPS/c1.xhtml": "<html><body><p>Hello EPUB</p></body></html>",
      }),
      expected: "Hello EPUB",
    },
  ];
  for (const item of cases) {
    const parsed = await parseBoundedDocument({ bytes: item.data, declaredMime: item.mime, filename: item.filename });
    assert.match(JSON.stringify(parsed), new RegExp(item.expected));
  }
});

void test("stable text PDF profile extracts page text and page span", async () => {
  const parsed = await parseBoundedDocument({ bytes: simplePdf("Hello PDF"), declaredMime: "application/pdf", filename: "a.pdf" });
  assert.match(JSON.stringify(parsed.blocks), /Hello PDF/u);
  assert.match(JSON.stringify(parsed.blocks), /page-bbox/u);
  assert.match(JSON.stringify(parsed.blocks), /"width":612/u);
});

void test("archive profiles reject active content and expansion bombs before parsing", async () => {
  await assert.rejects(
    parseBoundedDocument({ bytes: zip({ "word/document.xml": "<w:document/>", "word/vbaProject.bin": "active" }), declaredMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: "a.docx" }),
    /Active or embedded/u,
  );
  await assert.rejects(
    parseBoundedDocument({ bytes: zip({ "word/document.xml": "<w:document/>", "word/_rels/document.xml.rels": '<Relationships><Relationship TargetMode="External" Target="https://example.com"/></Relationships>' }), declaredMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: "a.docx" }),
    /External package relationships/u,
  );
  await assert.rejects(
    parseBoundedDocument({ bytes: zip({ "word/document.xml": "x".repeat(2_000_000) }), declaredMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: "a.docx" }),
    /expansion exceeds/u,
  );
});

void test("malformed and encrypted-profile inputs fail closed", async () => {
  await assert.rejects(parseBoundedDocument({ bytes: bytes("{"), declaredMime: "application/json", filename: "a.json" }), /Malformed JSON/u);
  await assert.rejects(parseBoundedDocument({ bytes: bytes("<root><broken></root>"), declaredMime: "application/xml", filename: "a.xml" }), /Malformed XML/u);
  await assert.rejects(parseBoundedDocument({ bytes: bytes("not rtf"), declaredMime: "application/rtf", filename: "a.rtf" }), /Malformed RTF/u);
  await assert.rejects(parseBoundedDocument({ bytes: bytes("not zip"), declaredMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: "a.docx" }), /Malformed ZIP/u);
  await assert.rejects(parseBoundedDocument({ bytes: zip({ "META-INF/encryption.xml": "<x/>", "META-INF/container.xml": "<x/>" }), declaredMime: "application/epub+zip", filename: "a.epub" }), /Encrypted or DRM/u);
  await assert.rejects(parseBoundedDocument({ bytes: new Uint8Array([...simplePdf("locked"), ...bytes(" /Encrypt 9 0 R")]), declaredMime: "application/pdf", filename: "locked.pdf" }), /Encrypted PDF/u);
  const nested = (depth: number): string => depth === 0
    ? "Content-Type: text/plain\r\n\r\nhello"
    : `Content-Type: multipart/mixed; boundary=b${String(depth)}\r\n\r\n--b${String(depth)}\r\n${nested(depth - 1)}\r\n--b${String(depth)}--\r\n`;
  await assert.rejects(parseBoundedDocument({ bytes: bytes(nested(6)), declaredMime: "message/rfc822", filename: "a.eml" }), /MIME nesting/u);
});

void test("active PDF, HTML, EPUB, and ODF content fails closed", async () => {
  const activePdf = new Uint8Array([...simplePdf("Hello"), ...bytes(" /OpenAction 1 0 R")]);
  await assert.rejects(parseBoundedDocument({ bytes: activePdf, declaredMime: "application/pdf", filename: "a.pdf" }), /Active PDF/u);
  await assert.rejects(parseBoundedDocument({ bytes: bytes("<html><script>alert(1)</script></html>"), declaredMime: "text/html", filename: "a.html" }), /Active markup/u);
  await assert.rejects(parseBoundedDocument({
    bytes: zip({
      "META-INF/container.xml": '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
      "OPS/book.opf": '<package><manifest><item id="c1" href="c1.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>',
      "OPS/c1.xhtml": "<html><body><script>alert(1)</script></body></html>",
    }),
    declaredMime: "application/epub+zip",
    filename: "a.epub",
  }), /Active markup/u);
  await assert.rejects(parseBoundedDocument({
    bytes: zip({ "content.xml": '<office:document xmlns:office="office"><office:script/></office:document>' }),
    declaredMime: "application/vnd.oasis.opendocument.text",
    filename: "a.odt",
  }), /Active or external package/u);
});

void test("CSV quoting is deterministic and table cells are bounded", async () => {
  const source = 'name,note\r\n"A, Inc.","line 1\nline 2"\r\n"quote","a ""word"""';
  const parsed = await parseBoundedDocument({
    bytes: bytes(source),
    declaredMime: "text/csv",
    filename: "quoted.csv",
  });
  const block = parsed.blocks[0];
  assert.equal(block?.type, "table");
  if (block?.type !== "table") assert.fail("expected table block");
  assert.equal(block.blockId, "table-1");
  assert.deepEqual(block.cells, [
    { row: 0, col: 0, content: "name" }, { row: 0, col: 1, content: "note" },
    { row: 1, col: 0, content: "A, Inc." }, { row: 1, col: 1, content: "line 1\nline 2" },
    { row: 2, col: 0, content: "quote" }, { row: 2, col: 1, content: 'a "word"' },
  ]);
  assert.deepEqual(block.spans?.map((span) => ({ ...span, contentHash: "<hash>" })), [
    { kind: "char-offset", start: 0, end: source.length, contentHash: "<hash>" },
  ]);
  assert.match(block.spans?.[0]?.contentHash ?? "", /^sha256-[a-f0-9]{64}$/u);
  const excessive = `${"x,".repeat(MAX_DOCUMENT_TABLE_CELLS)}x`;
  await assert.rejects(
    parseBoundedDocument({ bytes: bytes(excessive), declaredMime: "text/csv", filename: "large.csv" }),
    /too many (?:cells|columns)/u,
  );
});

void test("archive paths and EPUB manifest paths cannot escape the package", async () => {
  await assert.rejects(parseBoundedDocument({
    bytes: zip({ "../word/document.xml": "<w:document/>", "word/document.xml": "<w:document/>" }),
    declaredMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    filename: "unsafe.docx",
  }), /unsafe entry path/u);
  await assert.rejects(parseBoundedDocument({
    bytes: zip({
      "META-INF/container.xml": '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
      "OPS/book.opf": '<package><manifest><item id="c1" href="../../outside.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>',
      "outside.xhtml": "<html><body>outside</body></html>",
    }),
    declaredMime: "application/epub+zip",
    filename: "unsafe.epub",
  }), /unsafe path/u);
});

void test("maxPages bounds PDF pages, spreadsheet sheets, presentation slides, and EPUB spine entries", async () => {
  await assert.rejects(parseBoundedDocument({
    bytes: zip({
      "xl/worksheets/sheet1.xml": "<worksheet><sheetData/></worksheet>",
      "xl/worksheets/sheet2.xml": "<worksheet><sheetData/></worksheet>",
    }),
    declaredMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    filename: "two.xlsx",
    maxPages: 1,
  }), /sheet count/u);
  await assert.rejects(parseBoundedDocument({
    bytes: zip({
      "ppt/slides/slide1.xml": '<p:sld xmlns:p="p" xmlns:a="a"><a:t>one</a:t></p:sld>',
      "ppt/slides/slide2.xml": '<p:sld xmlns:p="p" xmlns:a="a"><a:t>two</a:t></p:sld>',
    }),
    declaredMime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    filename: "two.pptx",
    maxPages: 1,
  }), /slide count/u);
  await assert.rejects(parseBoundedDocument({
    bytes: zip({
      "META-INF/container.xml": '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
      "OPS/book.opf": '<package><manifest><item id="c1" href="c1.xhtml"/><item id="c2" href="c2.xhtml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
      "OPS/c1.xhtml": "<html><body>one</body></html>",
      "OPS/c2.xhtml": "<html><body>two</body></html>",
    }),
    declaredMime: "application/epub+zip",
    filename: "two.epub",
    maxPages: 1,
  }), /spine count/u);
});
