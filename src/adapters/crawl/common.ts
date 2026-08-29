import type { CrawlPage, CrawlProviderId, CrawlProviderResult } from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import { resolvePublicUrl } from "../../core/url-policy.js";

export type CrawlFetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type CrawlUrlValidator = (url: string) => Promise<void>;

const MAX_CRAWL_PROVIDER_RESPONSE_BYTES = 4_000_000;
const MAX_CRAWL_PROVIDER_CANDIDATES = 2_000;

async function readCrawlBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_CRAWL_PROVIDER_RESPONSE_BYTES
  ) {
    throw new GroundlaneError(
      "OUTPUT_LIMIT",
      "web_crawl",
      "Crawl provider response exceeded the byte limit",
      true,
    );
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CRAWL_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel();
      throw new GroundlaneError(
        "OUTPUT_LIMIT",
        "web_crawl",
        "Crawl provider response exceeded the byte limit",
        true,
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function crawlProviderJson(
  fetcher: CrawlFetchLike,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal });
  } catch (error) {
    if (signal.aborted) {
      throw new GroundlaneError("CANCELLED", "web_crawl", "Crawl request was cancelled");
    }
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "web_crawl",
      "Crawl provider request failed",
      true,
      { cause: error },
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "web_crawl",
      "Crawl provider rejected the configured credential",
    );
  }
  if (response.status === 402) {
    throw new GroundlaneError("RATE_LIMITED", "web_crawl", "Crawl provider quota is unavailable");
  }
  if (response.status === 429) {
    throw new GroundlaneError("RATE_LIMITED", "web_crawl", "Crawl provider rate limit reached", true);
  }
  if (response.status >= 500) {
    throw new GroundlaneError("UPSTREAM_ERROR", "web_crawl", "Crawl provider is unavailable", true);
  }
  if (!response.ok) {
    throw new GroundlaneError("UPSTREAM_ERROR", "web_crawl", "Crawl provider rejected the request");
  }
  try {
    return JSON.parse(await readCrawlBody(response)) as unknown;
  } catch (error) {
    if (error instanceof GroundlaneError) throw error;
    throw new GroundlaneError("UPSTREAM_ERROR", "web_crawl", "Crawl provider returned malformed JSON", true);
  }
}

export function defaultCrawlUrlValidator(url: string): Promise<void> {
  return resolvePublicUrl(url).then(() => undefined);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizeCrawlStatus(value: unknown): CrawlProviderResult["status"] {
  if (value === "completed" || value === "done" || value === "success" || value === "finished") {
    return "completed";
  }
  if (value === "running" || value === "scraping" || value === "crawling" || value === "pending") {
    return "running";
  }
  if (value === "failed" || value === "error" || value === "cancelled") return "failed";
  return "unknown";
}

export function pageFromContent(
  provider: CrawlProviderId,
  url: string,
  content: string | undefined,
  maxContentChars: number,
  fields: { title?: string; description?: string } = {},
): CrawlPage {
  const originalChars = content === undefined ? 0 : Array.from(content).length;
  const truncated = originalChars > maxContentChars;
  return {
    url,
    ...(fields.title === undefined ? {} : { title: fields.title }),
    ...(fields.description === undefined ? {} : { description: fields.description }),
    ...(content === undefined
      ? {}
      : { content: truncated ? Array.from(content).slice(0, maxContentChars).join("") : content }),
    contentChars: Math.min(originalChars, maxContentChars),
    truncated,
    provider,
  };
}

export async function normalizeCrawlPages(
  provider: CrawlProviderId,
  candidates: readonly CrawlPage[],
  maxPages: number,
  validateUrl: CrawlUrlValidator,
): Promise<CrawlPage[]> {
  const valid: CrawlPage[] = [];
  for (const candidate of candidates.slice(0, MAX_CRAWL_PROVIDER_CANDIDATES)) {
    try {
      await validateUrl(candidate.url);
      valid.push({ ...candidate, provider });
    } catch {
      // Provider-returned URLs are untrusted and unsafe candidates are dropped.
    }
    if (valid.length >= maxPages) break;
  }
  return valid;
}

export function crawlResult(
  provider: CrawlProviderId,
  url: string,
  status: CrawlProviderResult["status"],
  pages: readonly CrawlPage[],
  started: number,
  fields: {
    jobId?: string;
    total?: number;
    completed?: number;
    creditsUsed?: number;
    warnings?: readonly string[];
  } = {},
): CrawlProviderResult {
  return {
    provider,
    url,
    status,
    ...(fields.jobId === undefined ? {} : { jobId: fields.jobId }),
    ...(fields.total === undefined ? {} : { total: fields.total }),
    ...(fields.completed === undefined ? {} : { completed: fields.completed }),
    ...(fields.creditsUsed === undefined ? {} : { creditsUsed: fields.creditsUsed }),
    pages,
    durationMs: Math.round(performance.now() - started),
    warnings: fields.warnings ?? [],
  };
}

