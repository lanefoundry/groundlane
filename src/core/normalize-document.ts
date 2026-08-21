import { load } from "cheerio";
import TurndownService from "turndown";
import type { FetchFormat, NormalizedDocument, RawDocument } from "./contracts.js";
import { GroundlaneError } from "./errors.js";
import { truncateUnicode } from "./limits.js";
import { extractReadableDocument } from "./readable-document.js";

const decoder = new TextDecoder("utf-8", { fatal: false });

export function normalizeDocument(raw: RawDocument, format: FetchFormat, maxChars: number, selector?: string): NormalizedDocument {
  const source = decoder.decode(raw.body);
  const isHtml = raw.contentType.includes("html") || /^\s*</.test(source);
  let title: string | undefined;
  let description: string | undefined;
  let author: string | undefined;
  let publishedAt: string | undefined;
  let content: string;
  if (isHtml) {
    const $ = load(source);
    $("script,style,noscript,template").remove();
    title = $("title").first().text().trim() || undefined;
    let selectedHtml: string;
    let selectedText: string;
    if (selector) {
      let selected;
      try { selected = $(selector).first(); } catch { throw new GroundlaneError("INVALID_INPUT", "selector", "The CSS selector is invalid"); }
      if (selected.length === 0) throw new GroundlaneError("INVALID_INPUT", "selector", "The CSS selector did not match");
      selectedHtml = selected.html() ?? "";
      selectedText = selected.text();
    } else if (format === "text" || format === "markdown") {
      const readable = extractReadableDocument(source, raw.finalUrl);
      title = readable.title;
      description = readable.description;
      author = readable.author;
      publishedAt = readable.publishedAt;
      selectedHtml = readable.html;
      selectedText = readable.text;
    } else {
      selectedHtml = $.html();
      selectedText = $.root().text();
    }
    if (format === "html") content = selectedHtml;
    else if (format === "text") content = selectedText.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    else content = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" }).turndown(selectedHtml).trim();
  } else {
    content = source;
  }
  if (title !== undefined) title = truncateUnicode(title, 500).value;
  const bounded = truncateUnicode(content, maxChars);
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(author ? { author } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    content: bounded.value,
    format,
    truncated: bounded.truncated,
    bytes: raw.body.byteLength,
    warnings: bounded.truncated ? ["output truncated"] : [],
  };
}
