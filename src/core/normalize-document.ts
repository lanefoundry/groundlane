import { load } from "cheerio";
import TurndownService from "turndown";
import type { ExtractMode, FetchFormat, NormalizedDocument, RawDocument } from "./contracts.js";
import { GroundlaneError, hint } from "./errors.js";
import { truncateUnicode } from "./limits.js";
import { extractReadableDocument } from "./readable-document.js";

const decoder = new TextDecoder("utf-8", { fatal: false });

// Article extraction is flagged when it keeps under this share of the page's visible text,
// and only for pages with enough text for the ratio to be meaningful.
const ARTICLE_LOSS_MIN_PAGE_CHARS = 400;
const ARTICLE_LOSS_MAX_KEPT_RATIO = 0.5;
const ARTICLE_LOSS_WARNING = "content extraction removed most of the page; use extract=full or format=html to keep navigation, cards and link lists";

function visibleTextLength(text: string): number {
  return text.replace(/\s+/gu, " ").trim().length;
}

function loginRedirectWarning(raw: RawDocument): string | undefined {
  const trimmed = (value: string): string => value.replace(/\/+$/, "");
  if (trimmed(raw.finalUrl) === trimmed(raw.requestedUrl)) return undefined;
  let path: string;
  try { path = new URL(raw.finalUrl).pathname; } catch { return undefined; }
  if (!/^\/(login|signin|sign-in|signup|sign-up|register)(\/|$)/i.test(path.replace(/\/+$/, ""))) return undefined;
  return "navigation ended at a login page; the target content likely requires authentication";
}

export function normalizeDocument(raw: RawDocument, format: FetchFormat, maxChars: number, selector?: string, extract: ExtractMode = "article"): NormalizedDocument {
  const source = decoder.decode(raw.body);
  const isHtml = raw.contentType.includes("html") || /^\s*</.test(source);
  let title: string | undefined;
  let description: string | undefined;
  let author: string | undefined;
  let publishedAt: string | undefined;
  let content: string;
  const extraWarnings: string[] = [];
  if (isHtml) {
    const $ = load(source);
    $("script,style,noscript,template").remove();
    title = $("title").first().text().trim() || undefined;
    let selectedHtml: string;
    let selectedText: string;
    if (selector) {
      let selected;
      try { selected = $(selector).first(); }
      catch { throw new GroundlaneError("INVALID_INPUT", "selector", "The CSS selector is invalid", false, undefined, hint("selector.invalid", "Check the CSS selector syntax. cheerio supports a jQuery-like subset; exotic pseudo-classes or invalid nesting will throw.")); }
      if (selected.length === 0) throw new GroundlaneError("INVALID_INPUT", "selector", "The CSS selector did not match", false, undefined, hint("selector.no_match", "The selector parsed but matched no elements. Inspect the page in a browser, or relax the selector (e.g. h1 instead of h1.specific-class) and rely on web_extract to filter further."));
      selectedHtml = selected.html() ?? "";
      selectedText = selected.text();
    } else if ((format === "text" || format === "markdown") && extract === "article") {
      const readable = extractReadableDocument(source, raw.finalUrl);
      title = readable.title;
      description = readable.description;
      author = readable.author;
      publishedAt = readable.publishedAt;
      selectedHtml = readable.html;
      selectedText = readable.text;
      const pageChars = visibleTextLength($("body").text());
      if (pageChars >= ARTICLE_LOSS_MIN_PAGE_CHARS && visibleTextLength(readable.text) < pageChars * ARTICLE_LOSS_MAX_KEPT_RATIO) extraWarnings.push(ARTICLE_LOSS_WARNING);
    } else if (format === "text" || format === "markdown") {
      const body = $("body").first();
      selectedHtml = body.length > 0 ? body.html() ?? "" : $.html();
      selectedText = body.length > 0 ? body.text() : $.root().text();
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
  const warnings: string[] = [...extraWarnings];
  if (bounded.truncated) warnings.push("output truncated");
  if (content.trim().length === 0) warnings.push("document contained no extractable text");
  const loginWarning = loginRedirectWarning(raw);
  if (loginWarning !== undefined) warnings.push(loginWarning);
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(author ? { author } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    content: bounded.value,
    format,
    truncated: bounded.truncated,
    bytes: raw.body.byteLength,
    warnings,
  };
}
