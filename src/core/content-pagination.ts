import { createHash } from "node:crypto";
import type { ContentProviderResult, ContentResult } from "./contracts.js";
import { GroundlaneError, hint } from "./errors.js";

export interface PaginatedContent extends ContentProviderResult {
  contentOffset: number;
  totalContentChars: number;
  nextContentOffset: number | null;
  contentHash: string;
  sourceTruncated: boolean;
}

export interface PaginatedContentResult extends ContentResult {
  contents: readonly PaginatedContent[];
}

export interface ContentPageOptions {
  offset: number;
  maxContentChars: number;
  maxOutputChars: number;
  expectedContentHash?: string;
}

/** Stateless pages are fenced against a changed provider response, not stored snapshots. */
export function paginateContentResult(result: ContentResult, options: ContentPageOptions): PaginatedContentResult {
  const source = result.contents[0];
  if (result.contents.length !== 1 || source === undefined ||
      !Number.isSafeInteger(options.offset) || options.offset < 0 || options.offset > 200_000 ||
      !Number.isSafeInteger(options.maxContentChars) || options.maxContentChars < 1 || options.maxContentChars > 200_000 ||
      !Number.isSafeInteger(options.maxOutputChars) || options.maxOutputChars < 1 ||
      (options.expectedContentHash !== undefined && !/^[a-f0-9]{64}$/.test(options.expectedContentHash)) ||
      (options.offset > 0 && options.expectedContentHash === undefined)) {
    throw new GroundlaneError("INVALID_INPUT", "web_content", "Pagination requires one provider, valid limits, and a content hash for continuation");
  }
  const characters = Array.from(source.content);
  if (options.offset > characters.length) {
    throw new GroundlaneError("INVALID_INPUT", "web_content", "Content offset exceeds the retrieved source length");
  }
  const contentHash = createHash("sha256").update(JSON.stringify([
    source.provider, source.url, source.finalUrl, source.format, source.truncated, source.content,
  ])).digest("hex");
  if (options.expectedContentHash !== undefined && options.expectedContentHash !== contentHash) {
    throw new GroundlaneError("INVALID_INPUT", "web_content", "Content changed since the previous page", false, undefined,
      hint("web_content.content_changed", "Restart pagination at contentOffset=0; provider content or its final URL changed."));
  }

  const makePage = (count: number): PaginatedContentResult => {
    const end = options.offset + count;
    return { ...result, contents: [{
      ...source,
      content: characters.slice(options.offset, end).join(""),
      contentOffset: options.offset,
      totalContentChars: characters.length,
      nextContentOffset: end < characters.length ? end : null,
      contentHash,
      sourceTruncated: source.truncated,
      truncated: source.truncated || options.offset > 0 || end < characters.length,
    }] };
  };
  const fits = (page: PaginatedContentResult): boolean => Array.from(JSON.stringify(page)).length <= options.maxOutputChars;
  if (!fits(makePage(0))) {
    throw new GroundlaneError("OUTPUT_LIMIT", "web_content", "Pagination metadata exceeds the configured output limit");
  }
  let low = 0;
  let high = Math.min(options.maxContentChars, characters.length - options.offset);
  while (low < high) {
    const count = Math.ceil((low + high) / 2);
    if (fits(makePage(count))) low = count;
    else high = count - 1;
  }
  if (low === 0 && options.offset < characters.length) {
    throw new GroundlaneError("OUTPUT_LIMIT", "web_content", "Output limit cannot fit a non-empty content page");
  }
  // Prefer complete timestamped lines without allowing a long line to stall progress.
  if (options.offset + low < characters.length) {
    const lastNewline = characters.slice(options.offset, options.offset + low).lastIndexOf("\n");
    if (lastNewline >= Math.floor(low * 0.8)) low = lastNewline + 1;
  }
  const page = makePage(low);
  if (!fits(page)) throw new GroundlaneError("OUTPUT_LIMIT", "web_content", "Content page exceeds the configured output limit");
  return page;
}
