import type { CrawlPage, CrawlProvider, CrawlProviderResult, CrawlRequest } from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import {
  crawlProviderJson,
  crawlResult,
  defaultCrawlUrlValidator,
  normalizeCrawlPages,
  normalizeCrawlStatus,
  optionalNumber,
  optionalString,
  pageFromContent,
  type CrawlFetchLike,
  type CrawlUrlValidator,
} from "./common.js";

const FIRECRAWL_CRAWL_URL = "https://api.firecrawl.dev/v2/crawl";

interface FirecrawlCrawlOptions {
  apiKey: string;
  fetch?: CrawlFetchLike;
  validateUrl?: CrawlUrlValidator;
}

export class FirecrawlCrawlProvider implements CrawlProvider {
  readonly id = "firecrawl" as const;
  private readonly fetcher: CrawlFetchLike;
  private readonly validateUrl: CrawlUrlValidator;

  constructor(private readonly options: FirecrawlCrawlOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultCrawlUrlValidator;
  }

  supports(): boolean {
    return this.options.apiKey.trim().length > 0;
  }

  async crawl(request: CrawlRequest, signal: AbortSignal): Promise<CrawlProviderResult> {
    const started = performance.now();
    const startedRaw = await crawlProviderJson(
      this.fetcher,
      FIRECRAWL_CRAWL_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: request.url,
          ...(request.instructions === undefined ? {} : { prompt: request.instructions }),
          limit: request.maxPages,
          maxDiscoveryDepth: request.maxDepth ?? 2,
          ignoreQueryParameters: true,
          allowExternalLinks: false,
          allowSubdomains: request.includeSubdomains ?? false,
          scrapeOptions: {
            formats: ["markdown"],
            onlyMainContent: true,
            storeInCache: !(request.ignoreCache ?? false),
          },
        }),
      },
      signal,
    );
    const startedObject = asObject(startedRaw);
    if (startedObject === undefined) {
      throw new GroundlaneError("UPSTREAM_ERROR", "web_crawl", "Firecrawl returned a malformed crawl response", true);
    }
    const jobId = optionalString(startedObject.id);
    const immediateData = Array.isArray(startedObject.data) ? startedObject.data : undefined;
    if (jobId === undefined && immediateData === undefined) {
      throw new GroundlaneError("UPSTREAM_ERROR", "web_crawl", "Firecrawl returned no crawl job identifier", true);
    }
    const statusRaw = immediateData === undefined && jobId !== undefined
      ? await this.pollStatus(jobId, request, signal)
      : startedRaw;
    const statusObject = asObject(statusRaw);
    if (statusObject === undefined) {
      throw new GroundlaneError("UPSTREAM_ERROR", "web_crawl", "Firecrawl returned a malformed crawl status", true);
    }
    const pages = await normalizeCrawlPages(
      this.id,
      parseFirecrawlPages(statusObject.data, request.maxContentChars),
      request.maxPages,
      this.validateUrl,
      signal,
    );
    const status = normalizeCrawlStatus(statusObject.status);
    const warnings = status === "completed" ? [] : ["firecrawl crawl job not completed within bounded polling"];
    const total = optionalNumber(statusObject.total);
    const completed = optionalNumber(statusObject.completed);
    const creditsUsed = optionalNumber(statusObject.creditsUsed);
    return crawlResult(this.id, request.url, status, pages, started, {
      ...(jobId === undefined ? {} : { jobId }),
      ...(total === undefined ? {} : { total }),
      ...(completed === undefined ? {} : { completed }),
      ...(creditsUsed === undefined ? {} : { creditsUsed }),
      warnings,
    });
  }

  private async pollStatus(jobId: string, request: CrawlRequest, signal: AbortSignal): Promise<unknown> {
    const maxPolls = request.maxPolls ?? 1;
    let latest: unknown;
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      if (attempt > 0) await sleep(request.pollIntervalMs ?? 1_000, signal);
      latest = await crawlProviderJson(
        this.fetcher,
        `${FIRECRAWL_CRAWL_URL}/${encodeURIComponent(jobId)}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${this.options.apiKey}` },
        },
        signal,
      );
      const status = normalizeCrawlStatus(asObject(latest)?.status);
      if (status === "completed" || status === "failed") break;
    }
    return latest;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function parseFirecrawlPages(value: unknown, maxContentChars: number): CrawlPage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): CrawlPage[] => {
    const page = asObject(item);
    if (page === undefined) return [];
    const metadata = asObject(page.metadata) ?? {};
    const url = optionalString(metadata.url) ?? optionalString(metadata.sourceURL);
    if (url === undefined) return [];
    const title = optionalString(metadata.title);
    const description = optionalString(metadata.description);
    return [
      pageFromContent("firecrawl", url, optionalString(page.markdown), maxContentChars, {
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
      }),
    ];
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new GroundlaneError("CANCELLED", "web_crawl", "Crawl request was cancelled"));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new GroundlaneError("CANCELLED", "web_crawl", "Crawl request was cancelled"));
      },
      { once: true },
    );
  });
}
