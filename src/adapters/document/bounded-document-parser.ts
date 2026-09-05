import { createHash } from "node:crypto";
import { posix } from "node:path";

import { load } from "cheerio";
import { unzipSync } from "fflate";
import { SaxesParser } from "saxes";

import { GroundlaneError, hint } from "../../core/errors.js";
import type {
  DocumentBlock,
  MetadataRecord,
  SourceSpan,
  TableCell,
} from "../../core/canonical-document.js";

export const DOCUMENT_ENGINE_VERSION = "groundlane-bounded-document-v1";
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 1_000;
export const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
export const MAX_DOCUMENT_BLOCKS = 10_000;
export const MAX_DOCUMENT_TABLE_CELLS = 100_000;
const MAX_MIME_DEPTH = 4;
const MAX_MIME_PARTS = 100;

export interface ParsedDocumentContent {
  readonly blocks: readonly DocumentBlock[];
  readonly metadata: readonly MetadataRecord[];
  readonly warnings: readonly string[];
  readonly capabilities: Readonly<Record<string, "available" | "unsupported" | "not_run" | "failed">>;
  readonly mediaType: string;
}

function documentError(message: string, code = "document.invalid_input"): GroundlaneError {
  return new GroundlaneError(
    "INVALID_INPUT",
    "document_parse",
    message,
    false,
    undefined,
    hint(code, "Use a supported, unencrypted document within the published limits."),
  );
}

function hash(bytes: Uint8Array): string {
  return `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
}

function charSpan(content: string, contentHash: string): SourceSpan[] {
  return content.length === 0
    ? []
    : [{ kind: "char-offset", start: 0, end: content.length, contentHash }];
}

function textBlock(content: string, id: string, contentHash: string, spans?: SourceSpan[]): DocumentBlock {
  return {
    type: "text",
    blockId: id,
    content,
    spans: spans ?? charSpan(content, contentHash),
  };
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function assertWellFormedXml(xml: string): void {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
    throw documentError("XML document types and entities are not supported", "document.active_content");
  }
  try {
    new SaxesParser().write(xml).close();
  } catch {
    throw documentError("Malformed XML document", "document.malformed");
  }
}

function assertNoActiveMarkup(source: string): void {
  if (/<\s*(?:script|iframe|object|embed)\b|\son[a-z]+\s*=|javascript\s*:/iu.test(source)) {
    throw documentError("Active markup content is not supported", "document.active_content");
  }
}

function assertArchiveBounds(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let entries = 0;
  let total = 0;
  let offset = 0;
  while (offset + 46 <= bytes.byteLength) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      offset += 1;
      continue;
    }
    entries += 1;
    if (entries > MAX_ARCHIVE_ENTRIES) throw documentError("Archive contains too many entries", "document.archive_limit");
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    total += uncompressed;
    if (
      uncompressed > MAX_DOCUMENT_BYTES ||
      total > MAX_ARCHIVE_UNCOMPRESSED_BYTES ||
      (compressed > 0 && uncompressed / compressed > 100)
    ) {
      throw documentError("Archive expansion exceeds the safe limit", "document.archive_limit");
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (entries === 0) throw documentError("Malformed ZIP package", "document.malformed");
}

function unzipBounded(bytes: Uint8Array): Record<string, Uint8Array> {
  assertArchiveBounds(bytes);
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw documentError("Malformed ZIP package", "document.malformed");
  }
  const names = Object.keys(files);
  const actualTotal = Object.values(files).reduce((total, value) => total + value.byteLength, 0);
  if (names.length > MAX_ARCHIVE_ENTRIES || actualTotal > MAX_ARCHIVE_UNCOMPRESSED_BYTES || Object.values(files).some((value) => value.byteLength > MAX_DOCUMENT_BYTES)) {
    throw documentError("Archive expansion exceeds the safe limit", "document.archive_limit");
  }
  if (names.some((name) => {
    const withoutTrailingSlash = name.endsWith("/") ? name.slice(0, -1) : name;
    const segments = withoutTrailingSlash.split("/");
    return !withoutTrailingSlash || name.includes("\\") || name.includes("\0") || name.startsWith("/") ||
      /^[A-Za-z]:/u.test(name) || segments.some((segment) => segment === "" || segment === "." || segment === "..");
  })) {
    throw documentError("Archive contains an unsafe entry path", "document.archive_path");
  }
  if (names.some((name) => /(^|\/)(?:vbaProject\.bin|embeddings?\/|externalLinks?\/|activeX\/|scripts?\/)|\.(?:zip|7z|rar)$/iu.test(name))) {
    throw documentError("Active or embedded external content is not supported", "document.active_content");
  }
  for (const name of names.filter((entry) => entry.endsWith(".rels"))) {
    if (/TargetMode\s*=\s*["']External["']/iu.test(decode(files[name] as Uint8Array))) {
      throw documentError("External package relationships are not supported", "document.active_content");
    }
  }
  for (const [name, value] of Object.entries(files)) {
    if (!/\.(?:xml|rels|opf|xhtml|html)$/iu.test(name)) continue;
    const source = decode(value);
    assertWellFormedXml(source);
    if (/\.(?:opf|xhtml|html)$/iu.test(name)) assertNoActiveMarkup(source);
    if (/<(?:office:script|script:script)\b|xlink:href\s*=\s*["'](?:https?:|file:)/iu.test(source)) {
      throw documentError("Active or external package content is not supported", "document.active_content");
    }
  }
  return files;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new GroundlaneError("CANCELLED", "document_parse", "The request was cancelled");
}

function xmlText(xml: string, selector: string): string[] {
  assertWellFormedXml(xml);
  const $ = load(xml, { xmlMode: true });
  return $(selector).toArray().map((node) => normalizeText($(node).text())).filter(Boolean);
}

function parseCsv(source: string, contentHash: string): DocumentBlock[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i] as string;
    if (quoted && c === '"' && source[i + 1] === '"') { field += '"'; i += 1; continue; }
    if (c === '"') { quoted = !quoted; continue; }
    if (!quoted && c === ",") {
      row.push(field);
      if (row.length > 1_000) throw documentError("CSV contains too many columns", "document.output_limit");
      field = ""; continue;
    }
    if (!quoted && (c === "\n" || c === "\r")) {
      if (c === "\r" && source[i + 1] === "\n") i += 1;
      row.push(field);
      if (row.length > 1_000) throw documentError("CSV contains too many columns", "document.output_limit");
      rows.push(row);
      if (rows.length > 10_000) throw documentError("CSV contains too many rows", "document.output_limit");
      row = []; field = ""; continue;
    }
    field += c;
  }
  if (quoted) throw documentError("Malformed CSV: unterminated quoted field", "document.malformed");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.length > 1_000) throw documentError("CSV contains too many columns", "document.output_limit");
    rows.push(row);
    if (rows.length > 10_000) throw documentError("CSV contains too many rows", "document.output_limit");
  }
  const cells: TableCell[] = [];
  rows.forEach((values, r) => values.forEach((value, c) => {
    if (cells.length >= MAX_DOCUMENT_TABLE_CELLS) throw documentError("Document table contains too many cells", "document.output_limit");
    cells.push({ row: r, col: c, content: value });
  }));
  return [{ type: "table", blockId: "table-1", cells, spans: charSpan(source, contentHash) }];
}

function parseDocx(files: Record<string, Uint8Array>, contentHash: string): DocumentBlock[] {
  const xml = files["word/document.xml"];
  if (xml === undefined) throw documentError("DOCX package is missing word/document.xml", "document.malformed");
  const source = decode(xml);
  assertWellFormedXml(source);
  const $ = load(source, { xmlMode: true });
  const blocks: DocumentBlock[] = [];
  $("w\\:body").children().each((_index, node) => {
    const element = $(node);
    if (!("name" in node)) return;
    if (node.name.endsWith(":p") || node.name === "p") {
      const content = normalizeText(element.find("w\\:t").toArray().map((item) => $(item).text()).join(""));
      if (content) blocks.push(textBlock(content, `p-${String(blocks.length + 1)}`, contentHash));
    } else if (node.name.endsWith(":tbl") || node.name === "tbl") {
      const cells: TableCell[] = [];
      element.find("w\\:tr").each((r, tr) => {
        $(tr).find("w\\:tc").each((c, tc) => {
          if (cells.length >= MAX_DOCUMENT_TABLE_CELLS) throw documentError("Document table contains too many cells", "document.output_limit");
          cells.push({ row: r, col: c, content: normalizeText($(tc).text()) });
        });
      });
      blocks.push({ type: "table", blockId: `table-${String(blocks.length + 1)}`, cells });
    }
  });
  return blocks;
}

function columnName(index: number): string {
  let value = index + 1;
  let out = "";
  while (value > 0) { value -= 1; out = String.fromCharCode(65 + (value % 26)) + out; value = Math.floor(value / 26); }
  return out;
}

function parseXlsx(files: Record<string, Uint8Array>, contentHash: string, maxPages: number): DocumentBlock[] {
  const shared = files["xl/sharedStrings.xml"] === undefined
    ? []
    : xmlText(decode(files["xl/sharedStrings.xml"]), "si");
  const sheetNames = Object.keys(files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name)).sort();
  if (sheetNames.length === 0) throw documentError("XLSX package contains no worksheets", "document.malformed");
  if (sheetNames.length > maxPages) throw documentError("Spreadsheet sheet count exceeds the configured limit", "document.page_limit");
  return sheetNames.map((name, sheetIndex): DocumentBlock => {
    const $ = load(decode(files[name] as Uint8Array), { xmlMode: true });
    const cells: TableCell[] = [];
    $("row").each((r, row) => {
      $(row).find("c").each((c, cell) => {
        if (cells.length >= MAX_DOCUMENT_TABLE_CELLS) throw documentError("Document table contains too many cells", "document.output_limit");
        const node = $(cell);
        const raw = node.find("v").first().text();
        const content = node.attr("t") === "s" ? (shared[Number(raw)] ?? "") : (node.find("is t").text() || raw);
        cells.push({ row: r, col: c, content });
      });
    });
    const lastRow = Math.max(1, ...cells.map((cell) => cell.row + 1));
    const lastCol = Math.max(1, ...cells.map((cell) => cell.col + 1));
    return {
      type: "table",
      blockId: `sheet-${String(sheetIndex + 1)}`,
      cells,
      spans: [{ kind: "sheet-cell", sheet: `Sheet${String(sheetIndex + 1)}`, startCell: "A1", endCell: `${columnName(lastCol - 1)}${String(lastRow)}`, contentHash }],
    };
  });
}

function parsePptx(files: Record<string, Uint8Array>, contentHash: string, maxPages: number): DocumentBlock[] {
  const slides = Object.keys(files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (slides.length === 0) throw documentError("PPTX package contains no slides", "document.malformed");
  if (slides.length > maxPages) throw documentError("Presentation slide count exceeds the configured limit", "document.page_limit");
  const blocks: DocumentBlock[] = [];
  slides.forEach((name, slide) => {
    const texts = xmlText(decode(files[name] as Uint8Array), "a\\:t");
    texts.forEach((content, shape) => blocks.push(textBlock(content, `slide-${String(slide + 1)}-shape-${String(shape + 1)}`, contentHash, [{ kind: "slide-shape", slide: slide + 1, shapeId: String(shape + 1), contentHash }])));
  });
  return blocks;
}

function parseOdf(files: Record<string, Uint8Array>, contentHash: string): DocumentBlock[] {
  const content = files["content.xml"];
  if (content === undefined) throw documentError("ODF package is missing content.xml", "document.malformed");
  const xml = decode(content);
  assertWellFormedXml(xml);
  const $ = load(xml, { xmlMode: true });
  const blocks: DocumentBlock[] = [];
  $("text\\:h, text\\:p").each((_i, node) => {
    const value = normalizeText($(node).text());
    if (value) blocks.push(textBlock(value, `p-${String(blocks.length + 1)}`, contentHash));
  });
  $("table\\:table").each((_i, table) => {
    const cells: TableCell[] = [];
    $(table).find("table\\:table-row").each((r, row) => {
      $(row).find("table\\:table-cell").each((c, cell) => {
        if (cells.length >= MAX_DOCUMENT_TABLE_CELLS) throw documentError("Document table contains too many cells", "document.output_limit");
        cells.push({ row: r, col: c, content: normalizeText($(cell).text()) });
      });
    });
    blocks.push({ type: "table", blockId: `table-${String(blocks.length + 1)}`, cells });
  });
  return blocks;
}

function safePackagePath(base: string, href: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(href.split(/[?#]/u, 1)[0] ?? ""); } catch { throw documentError("EPUB manifest path is malformed", "document.archive_path"); }
  if (!decoded || decoded.includes("\\") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(decoded) || decoded.startsWith("/")) {
    throw documentError("EPUB manifest contains an unsafe path", "document.archive_path");
  }
  const resolved = posix.normalize(`${base}${decoded}`);
  if (resolved === ".." || resolved.startsWith("../") || resolved.includes("/../")) {
    throw documentError("EPUB manifest contains an unsafe path", "document.archive_path");
  }
  return resolved;
}

function parseEpub(files: Record<string, Uint8Array>, contentHash: string, maxPages: number): { blocks: DocumentBlock[]; metadata: MetadataRecord[] } {
  if (files["META-INF/encryption.xml"] !== undefined) throw documentError("Encrypted or DRM-protected EPUB is not supported", "document.encrypted");
  const container = files["META-INF/container.xml"];
  if (container === undefined) throw documentError("EPUB package is missing its container", "document.malformed");
  const containerXml = load(decode(container), { xmlMode: true });
  const rootfile = containerXml("rootfile").attr("full-path");
  if (!rootfile || files[rootfile] === undefined) throw documentError("EPUB package has no readable rootfile", "document.malformed");
  const opfBytes = files[rootfile];
  if (opfBytes === undefined) throw documentError("EPUB package has no readable rootfile", "document.malformed");
  const opf = load(decode(opfBytes), { xmlMode: true });
  const base = rootfile.includes("/") ? rootfile.slice(0, rootfile.lastIndexOf("/") + 1) : "";
  const manifest = new Map<string, string>();
  opf("manifest item").each((_i, node) => {
    const id = opf(node).attr("id"); const href = opf(node).attr("href");
    if (id && href) manifest.set(id, safePackagePath(base, href));
  });
  const blocks: DocumentBlock[] = [];
  if (opf("spine itemref").length > maxPages) throw documentError("EPUB spine count exceeds the configured limit", "document.page_limit");
  opf("spine itemref").each((_i, node) => {
    const path = manifest.get(opf(node).attr("idref") ?? "");
    if (!path || files[path] === undefined) return;
    const chapterBytes = files[path];
    if (chapterBytes === undefined) return;
    const chapter = decode(chapterBytes);
    assertNoActiveMarkup(chapter);
    const $ = load(chapter);
    $("script,style,noscript").remove();
    const value = normalizeText($("body").text());
    if (value) blocks.push(textBlock(value, `chapter-${String(blocks.length + 1)}`, contentHash));
  });
  const metadata: MetadataRecord[] = [];
  const title = normalizeText(opf("metadata dc\\:title").first().text());
  if (title) metadata.push({ key: "title", value: title });
  return { blocks, metadata };
}

function parseRtf(source: string, contentHash: string): DocumentBlock[] {
  if (!source.startsWith("{\\rtf")) throw documentError("Malformed RTF document", "document.malformed");
  const content = normalizeText(source
    .replace(/\\'[0-9a-f]{2}/giu, (value) => String.fromCharCode(Number.parseInt(value.slice(2), 16)))
    .replace(/\\(?:par|line)\b/gu, "\n")
    .replace(/\\[a-z]+-?\d* ?/giu, "")
    .replace(/[{}]/gu, ""));
  return content ? [textBlock(content, "text-1", contentHash)] : [];
}

function splitHeaders(source: string): { headers: Map<string, string>; body: string } {
  const split = /\r?\n\r?\n/u.exec(source);
  const headerText = split === null ? source : source.slice(0, split.index);
  const body = split === null ? "" : source.slice(split.index + split[0].length);
  const headers = new Map<string, string>();
  for (const line of headerText.replace(/\r?\n[ \t]+/gu, " ").split(/\r?\n/u).slice(0, 200)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim().slice(0, 4_000);
    headers.set(key, headers.has(key) ? `${headers.get(key) ?? ""}, ${value}` : value);
  }
  return { headers, body };
}

function decodeQuotedPrintable(source: string): string {
  return source
    .replace(/=\r?\n/gu, "")
    .replace(/=([0-9A-F]{2})/giu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function decodeMimeBody(body: string, encoding: string): string {
  if (encoding === "base64") {
    const compact = body.replace(/\s/gu, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(compact) || compact.length % 4 !== 0) {
      throw documentError("Malformed base64 MIME body", "document.malformed");
    }
    return Buffer.from(compact, "base64").toString("utf8");
  }
  return encoding === "quoted-printable" ? decodeQuotedPrintable(body) : body;
}

function mimeBoundary(contentType: string): string | undefined {
  const match = /(?:^|;)\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/iu.exec(contentType);
  return match?.[1] ?? match?.[2];
}

function parseMimeText(source: string, depth: number, state: { parts: number }): { plain: string[]; html: string[] } {
  if (depth > MAX_MIME_DEPTH) throw documentError("MIME nesting exceeds the safe limit", "document.mime_limit");
  state.parts += 1;
  if (state.parts > MAX_MIME_PARTS) throw documentError("MIME message contains too many parts", "document.mime_limit");
  const { headers, body } = splitHeaders(source);
  const contentType = (headers.get("content-type") ?? "text/plain").toLowerCase();
  if (contentType.startsWith("multipart/")) {
    const boundary = mimeBoundary(contentType);
    if (!boundary) throw documentError("Multipart MIME message is missing its boundary", "document.malformed");
    const delimiter = `--${boundary}`;
    const chunks = body.split(delimiter).slice(1);
    if (chunks.length === 0) throw documentError("Multipart MIME message contains no parts", "document.malformed");
    const result = { plain: [] as string[], html: [] as string[] };
    for (const raw of chunks) {
      if (raw.startsWith("--")) break;
      const nested = parseMimeText(raw.replace(/^\r?\n/u, "").replace(/\r?\n$/u, ""), depth + 1, state);
      result.plain.push(...nested.plain);
      result.html.push(...nested.html);
    }
    return result;
  }
  if ((headers.get("content-disposition") ?? "").toLowerCase().startsWith("attachment")) {
    return { plain: [], html: [] };
  }
  const decoded = decodeMimeBody(body, (headers.get("content-transfer-encoding") ?? "").toLowerCase());
  if (contentType.startsWith("text/html")) {
    assertNoActiveMarkup(decoded);
    const $ = load(decoded);
    $("script,style,noscript,template").remove();
    return { plain: [], html: [normalizeText($("body").text() || $.root().text())].filter(Boolean) };
  }
  return contentType.startsWith("text/plain")
    ? { plain: [normalizeText(decoded)].filter(Boolean), html: [] }
    : { plain: [], html: [] };
}

function parseEml(source: string, contentHash: string): { blocks: DocumentBlock[]; metadata: MetadataRecord[] } {
  const { headers } = splitHeaders(source);
  const metadata: MetadataRecord[] = [];
  for (const key of ["subject", "from", "to", "date", "message-id"]) {
    const value = headers.get(key);
    if (value) metadata.push({ key, value: value.slice(0, 2_000) });
  }
  const text = parseMimeText(source, 0, { parts: 0 });
  const content = normalizeText((text.plain.length > 0 ? text.plain : text.html).join("\n\n"));
  return { blocks: content ? [textBlock(content, "body-1", contentHash)] : [], metadata };
}

export async function parseBoundedDocument(input: {
  bytes: Uint8Array;
  declaredMime: string;
  filename: string;
  signal?: AbortSignal;
  maxPages?: number;
}): Promise<ParsedDocumentContent> {
  throwIfCancelled(input.signal);
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_DOCUMENT_BYTES) throw documentError("Document size is outside the supported bounds", "document.output_limit");
  const contentHash = hash(input.bytes);
  const mime = input.declaredMime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const extension = input.filename.toLowerCase().split(".").pop() ?? "";
  let blocks: DocumentBlock[] = [];
  let metadata: MetadataRecord[] = [];
  let mediaType = mime;
  const maxPages = Math.min(input.maxPages ?? 500, 500);

  if (mime === "application/pdf" || extension === "pdf") {
    const pdfSource = Buffer.from(input.bytes).toString("latin1");
    if (/\/Encrypt\b/u.test(pdfSource)) {
      throw documentError("Encrypted PDF is not supported", "document.encrypted");
    }
    if (!pdfSource.startsWith("%PDF-") || /\/(?:JavaScript|JS|Launch|EmbeddedFiles|OpenAction|AA)\b/u.test(pdfSource)) {
      throw documentError(
        pdfSource.startsWith("%PDF-") ? "Active PDF content is not supported" : "Malformed or unreadable PDF",
        pdfSource.startsWith("%PDF-") ? "document.active_content" : "document.malformed",
      );
    }
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    try {
      const document = await pdfjs.getDocument({ data: input.bytes, useSystemFonts: true }).promise;
      if (document.numPages > maxPages) throw documentError("PDF page count exceeds the configured limit", "document.page_limit");
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        throwIfCancelled(input.signal);
        const page = await document.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        const text = await page.getTextContent();
        const content = normalizeText(text.items.map((item) => "str" in item ? item.str : "").join(" "));
        if (content) blocks.push(textBlock(content, `page-${String(pageNumber)}`, contentHash, [{ kind: "page-bbox", page: pageNumber, x: 0, y: 0, width: viewport.width, height: viewport.height, contentHash }]));
      }
      mediaType = "application/pdf";
    } catch (error) {
      throwIfCancelled(input.signal);
      if (error instanceof GroundlaneError) throw error;
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      throw documentError(message.includes("password") ? "Encrypted PDF is not supported" : "Malformed or unreadable PDF", message.includes("password") ? "document.encrypted" : "document.malformed");
    }
  } else if (["docx", "xlsx", "pptx", "odt", "ods", "odp", "epub"].includes(extension) || mime.includes("officedocument") || mime.includes("opendocument") || mime === "application/epub+zip") {
    const files = unzipBounded(input.bytes);
    if (extension === "docx" || mime.includes("wordprocessingml")) blocks = parseDocx(files, contentHash);
    else if (extension === "xlsx" || mime.includes("spreadsheetml")) blocks = parseXlsx(files, contentHash, maxPages);
    else if (extension === "pptx" || mime.includes("presentationml")) blocks = parsePptx(files, contentHash, maxPages);
    else if (extension === "epub" || mime === "application/epub+zip") ({ blocks, metadata } = parseEpub(files, contentHash, maxPages));
    else blocks = parseOdf(files, contentHash);
  } else {
    const source = decode(input.bytes);
    if (extension === "csv" || mime === "text/csv") blocks = parseCsv(source, contentHash);
    else if (extension === "rtf" || mime === "application/rtf" || mime === "text/rtf") blocks = parseRtf(source, contentHash);
    else if (extension === "eml" || mime === "message/rfc822") ({ blocks, metadata } = parseEml(source, contentHash));
    else if (extension === "html" || extension === "htm" || mime === "text/html") {
      assertNoActiveMarkup(source);
      const $ = load(source); $("style,noscript,template").remove();
      const content = normalizeText($("body").text() || $.root().text());
      if (content) blocks = [textBlock(content, "document-1", contentHash)];
      const title = normalizeText($("title").text()); if (title) metadata.push({ key: "title", value: title });
    } else if (extension === "json" || mime === "application/json") {
      let parsed: unknown; try { parsed = JSON.parse(source) as unknown; } catch { throw documentError("Malformed JSON document", "document.malformed"); }
      blocks = [textBlock(JSON.stringify(parsed, null, 2), "document-1", contentHash)];
    } else if (extension === "xml" || mime.endsWith("+xml") || mime === "application/xml" || mime === "text/xml") {
      assertWellFormedXml(source);
      const $ = load(source, { xmlMode: true }); const content = normalizeText($.root().text()); if (content) blocks = [textBlock(content, "document-1", contentHash)];
    } else if (["txt", "md", "markdown"].includes(extension) || mime.startsWith("text/")) {
      if (input.bytes.includes(0)) throw documentError("Binary content cannot be parsed as text", "document.mime_mismatch");
      const content = normalizeText(source); if (content) blocks = [textBlock(content, "document-1", contentHash)];
    } else throw documentError(`Unsupported document format: ${mime || extension || "unknown"}`, "document.unsupported");
  }

  if (blocks.length > MAX_DOCUMENT_BLOCKS) throw documentError("Document contains too many blocks", "document.output_limit");
  return {
    blocks,
    metadata,
    warnings: blocks.length === 0 ? ["document contained no extractable text"] : [],
    capabilities: { text: "available", tables: blocks.some((block) => block.type === "table") ? "available" : "not_run", assets: "unsupported", formulas: "unsupported" },
    mediaType,
  };
}
