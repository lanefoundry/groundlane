import assert from "node:assert/strict";
import test from "node:test";
import { zipSync } from "fflate";
import { parseBoundedDocument } from "../../src/adapters/document/bounded-document-parser.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

void test("OOXML numeric entities cannot disguise external relationships", async () => {
  const files = {
    "word/document.xml": '<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>safe text</w:t></w:r></w:p></w:body></w:document>',
    "word/_rels/document.xml.rels": '<Relationships><Relationship TargetMode="&#69;xternal" Target="https://example.com/private"/></Relationships>',
  };
  await assert.rejects(parseBoundedDocument({
    bytes: zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, bytes(value)]))),
    filename: "encoded-external.docx", declaredMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  }), /External package relationships/u);
});

void test("PDF hexadecimal name escapes cannot disguise active JavaScript", async () => {
  const source = "%PDF-1.4\n1 0 obj\n<< /S /J#53 /J#61vaScript (alert) >>\nendobj\n%%EOF";
  await assert.rejects(parseBoundedDocument({
    bytes: bytes(source),
    filename: "escaped-active.pdf",
    declaredMime: "application/pdf",
  }), /Active PDF content/u);
});

void test("EML multipart boundaries retain their case-sensitive identity", async () => {
  const source = "Content-Type: multipart/alternative; boundary=MixedCaseBoundary\r\n\r\n" +
    "--MixedCaseBoundary\r\nContent-Type: text/plain\r\n\r\nExpected body\r\n--MixedCaseBoundary--\r\n";
  const parsed = await parseBoundedDocument({ bytes: bytes(source), filename: "case.eml", declaredMime: "message/rfc822" });
  assert.match(JSON.stringify(parsed.blocks), /Expected body/u);
});

void test("EML quoted-printable UTF-8 is decoded as bytes before Unicode text", async () => {
  const source = "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n" +
    "=E5=8F=B0=\r\n=E7=81=A3=20=F0=9F=8C=8F";
  const parsed = await parseBoundedDocument({ bytes: bytes(source), filename: "unicode.eml", declaredMime: "message/rfc822" });
  assert.match(JSON.stringify(parsed.blocks), /台灣 🌏/u);
});
