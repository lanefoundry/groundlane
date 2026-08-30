import { load } from "cheerio";

import { GroundlaneError, hint } from "./errors.js";
import { truncateUnicode } from "./limits.js";
import { extractReadableDocument } from "./readable-document.js";

export type ParsePurpose = "document" | "metadata" | "links" | "media" | "tables" | "all";

export interface ParsedLink {
  url: string;
  text?: string;
  rel?: string;
  internal: boolean;
}

export interface ParsedImage {
  url: string;
  alt?: string;
  title?: string;
}

export interface ParsedTable {
  caption?: string;
  headers: string[];
  rows: string[][];
}

export interface ParsedDocument {
  purpose: ParsePurpose;
  title?: string;
  description?: string;
  author?: string;
  publishedAt?: string;
  canonicalUrl?: string;
  content?: string;
  text?: string;
  metadata?: Record<string, string | string[]>;
  links?: ParsedLink[];
  images?: ParsedImage[];
  tables?: ParsedTable[];
  truncated: boolean;
  warnings: string[];
}

export interface ParseDocumentOptions {
  purpose: ParsePurpose;
  baseUrl: string;
  maxOutputChars: number;
}

const maxLinks = 500;
const maxImages = 300;
const maxTables = 50;
const maxRowsPerTable = 200;
const maxCellsPerRow = 50;

function cleanText(value: string | null | undefined, maxLength = 1_000): string | undefined {
  const cleaned = value?.replace(/\s+/gu, " ").trim();
  if (!cleaned) return undefined;
  return truncateUnicode(cleaned, maxLength).value;
}

function httpUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function isInternalUrl(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

function addMetadata(
  metadata: Record<string, string | string[]>,
  name: string,
  value: string | undefined,
): void {
  if (value === undefined) return;
  const existing = metadata[name];
  if (existing === undefined) {
    metadata[name] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    metadata[name] = [existing, value];
  }
}

function stripTitleSuffix(title: string): string {
  const separators = [" - ", " | ", " – ", " — ", " :: "];
  for (const separator of separators) {
    const index = title.lastIndexOf(separator);
    if (index <= 0) continue;
    const candidate = title.slice(0, index).trim();
    const suffix = title.slice(index + separator.length).trim();
    if (candidate.length >= 8 && suffix.length >= 2 && suffix.length <= 80) {
      return candidate;
    }
  }
  return title;
}

function equivalentTitle(left: string, right: string): boolean {
  return left.localeCompare(right, "en-US", { sensitivity: "base" }) === 0;
}

function selectTitle(source: string): string | undefined {
  const $ = load(source);
  const explicitTitle = cleanText(
    $('meta[property="og:title"]').first().attr("content") ??
      $('meta[name="twitter:title"]').first().attr("content"),
    500,
  );
  if (explicitTitle !== undefined) return explicitTitle;

  const pageTitle = cleanText($("title").first().text(), 500);
  const headingTitle = cleanText($("article h1, main h1, h1").first().text(), 500);
  if (pageTitle === undefined) return headingTitle;
  const strippedTitle = stripTitleSuffix(pageTitle);
  if (
    headingTitle !== undefined &&
    !equivalentTitle(strippedTitle, pageTitle) &&
    equivalentTitle(strippedTitle, headingTitle)
  ) {
    return headingTitle;
  }
  return strippedTitle;
}

function parseMetadata(source: string, baseUrl: string): Pick<
  ParsedDocument,
  "title" | "description" | "author" | "publishedAt" | "canonicalUrl" | "metadata"
> {
  const $ = load(source);
  const metadata: Record<string, string | string[]> = {};
  $("meta").each((_index, element) => {
    const node = $(element);
    const name = cleanText(
      node.attr("name") ?? node.attr("property") ?? node.attr("itemprop"),
      200,
    );
    const value = cleanText(node.attr("content"), 2_000);
    if (name !== undefined) addMetadata(metadata, name, value);
  });
  const canonicalUrl = httpUrl($("link[rel='canonical']").first().attr("href"), baseUrl);
  if (canonicalUrl !== undefined) addMetadata(metadata, "canonical", canonicalUrl);
  const title = selectTitle(source);
  const description = cleanText(
    $('meta[name="description"]').first().attr("content") ??
      $('meta[property="og:description"]').first().attr("content"),
    1_000,
  );
  const author = cleanText(
    $('meta[name="author"]').first().attr("content") ??
      $('meta[property="article:author"]').first().attr("content") ??
      $("[rel='author']").first().text(),
    200,
  );
  const publishedAt = cleanText(
    $('meta[property="article:published_time"]').first().attr("content") ??
      $("time[datetime]").first().attr("datetime"),
    200,
  );
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(author === undefined ? {} : { author }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
    metadata,
  };
}

function parseLinks(source: string, baseUrl: string): ParsedLink[] {
  const $ = load(source);
  const links: ParsedLink[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_index, element) => {
    if (links.length >= maxLinks) return;
    const node = $(element);
    const url = httpUrl(node.attr("href"), baseUrl);
    if (url === undefined || seen.has(url)) return;
    seen.add(url);
    const text = cleanText(node.text(), 500);
    const rel = cleanText(node.attr("rel"), 200);
    links.push({
      url,
      ...(text === undefined ? {} : { text }),
      ...(rel === undefined ? {} : { rel }),
      internal: isInternalUrl(url, baseUrl),
    });
  });
  return links;
}

function parseImages(source: string, baseUrl: string): ParsedImage[] {
  const $ = load(source);
  const images: ParsedImage[] = [];
  const seen = new Set<string>();
  $("img[src], source[srcset], img[srcset]").each((_index, element) => {
    if (images.length >= maxImages) return;
    const node = $(element);
    const sourceUrl = node.attr("src") ?? node.attr("srcset")?.split(",")[0]?.trim().split(/\s+/u)[0];
    const url = httpUrl(sourceUrl, baseUrl);
    if (url === undefined || seen.has(url)) return;
    seen.add(url);
    const alt = cleanText(node.attr("alt"), 500);
    const title = cleanText(node.attr("title"), 500);
    images.push({
      url,
      ...(alt === undefined ? {} : { alt }),
      ...(title === undefined ? {} : { title }),
    });
  });
  return images;
}

function parseTables(source: string): ParsedTable[] {
  const $ = load(source);
  return $("table")
    .toArray()
    .slice(0, maxTables)
    .map((table): ParsedTable => {
      const node = $(table);
      const caption = cleanText(node.find("caption").first().text(), 500);
      const headers = node
        .find("thead th, tr:first-child th")
        .toArray()
        .slice(0, maxCellsPerRow)
        .flatMap((cell) => {
          const text = cleanText($(cell).text(), 500);
          return text === undefined ? [] : [text];
        });
      const rows = node
        .find("tr")
        .toArray()
        .slice(0, maxRowsPerTable)
        .map((row) =>
          $(row)
            .find("th,td")
            .toArray()
            .slice(0, maxCellsPerRow)
            .map((cell) => cleanText($(cell).text(), 500) ?? ""),
        )
        .filter((row) => row.some((cell) => cell.length > 0));
      return {
        ...(caption === undefined ? {} : { caption }),
        headers,
        rows,
      };
    });
}

export function parseDocument(source: string, options: ParseDocumentOptions): ParsedDocument {
  if (source.trim().length === 0) {
    throw new GroundlaneError("INVALID_INPUT", "parse", "Parser input is empty", false, undefined, hint("parse.input_empty", "Provide a non-empty HTML string for html-mode parse, or pass a real URL for url-mode parse."));
  }
  const metadata = parseMetadata(source, options.baseUrl);

  const result: ParsedDocument = {
    purpose: options.purpose,
    ...(metadata.title === undefined ? {} : { title: metadata.title }),
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    ...(metadata.author === undefined ? {} : { author: metadata.author }),
    ...(metadata.publishedAt === undefined ? {} : { publishedAt: metadata.publishedAt }),
    ...(metadata.canonicalUrl === undefined ? {} : { canonicalUrl: metadata.canonicalUrl }),
    truncated: false,
    warnings: [],
  };

  if (options.purpose === "document" || options.purpose === "all") {
    const readable = extractReadableDocument(source, options.baseUrl);
    const content = truncateUnicode(readable.html, options.maxOutputChars);
    const text = truncateUnicode(readable.text.replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim(), options.maxOutputChars);
    if (result.title === undefined && readable.title !== undefined) result.title = readable.title;
    if (readable.description !== undefined) result.description = readable.description;
    if (readable.author !== undefined) result.author = readable.author;
    if (readable.publishedAt !== undefined) result.publishedAt = readable.publishedAt;
    result.content = content.value;
    result.text = text.value;
    result.truncated = result.truncated || content.truncated || text.truncated;
  }
  if (options.purpose === "metadata" || options.purpose === "all") {
    if (metadata.metadata !== undefined) result.metadata = metadata.metadata;
  }
  if (options.purpose === "links" || options.purpose === "all") {
    result.links = parseLinks(source, options.baseUrl);
  }
  if (options.purpose === "media" || options.purpose === "all") {
    result.images = parseImages(source, options.baseUrl);
  }
  if (options.purpose === "tables" || options.purpose === "all") {
    result.tables = parseTables(source);
  }

  const serializedLength = Array.from(JSON.stringify(result)).length;
  if (serializedLength > options.maxOutputChars * 2) {
    throw new GroundlaneError("OUTPUT_LIMIT", "parse", "Parsed output exceeds the configured limit", false, undefined, hint("parse.output_too_large", "Lower maxOutputChars on the parse request, or narrow the purpose (e.g. metadata-only or links-only) so the document returns a smaller projection."));
  }
  if (result.truncated) result.warnings.push("output truncated");
  return result;
}
