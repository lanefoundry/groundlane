import type { CrawlPage, CrawlProvider, CrawlProviderResult, CrawlRequest } from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import {
  crawlProviderJson,
  crawlResult,
  defaultCrawlUrlValidator,
  normalizeCrawlPages,
  optionalNumber,
  optionalString,
  pageFromContent,
  type CrawlFetchLike,
  type CrawlUrlValidator,
} from "./common.js";

const TAVILY_CRAWL_URL = "https://api.tavily.com/crawl";

interface TavilyCrawlOptions {
  apiKey: string;
  fetch?: CrawlFetchLike;
  validateUrl?: CrawlUrlValidator;
}

export class TavilyCrawlProvider implements CrawlProvider {
  readonly id = "tavily" as const;
  private readonly fetcher: CrawlFetchLike;
  private readonly validateUrl: CrawlUrlValidator;

  constructor(private readonly options: TavilyCrawlOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultCrawlUrlValidator;
  }

  supports(): boolean {
    return this.options.apiKey.trim().length > 0;
  }

  async crawl(request: CrawlRequest, signal: AbortSignal): Promise<CrawlProviderResult> {
    const started = performance.now();
    const raw = await crawlProviderJson(
      this.fetcher,
      TAVILY_CRAWL_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: request.url,
          ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
          max_depth: request.maxDepth ?? 2,
          max_breadth: request.maxBreadth ?? 20,
          limit: request.maxPages,
          allow_external: false,
          include_usage: true,
        }),
      },
      signal,
    );
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { results?: unknown }).results)) {
      throw new GroundlaneError("UPSTREAM_ERROR", "web_crawl", "Tavily returned a malformed crawl response", true);
    }
    const pages = await normalizeCrawlPages(
      this.id,
      parseTavilyPages((raw as { results: unknown[] }).results, request.maxContentChars),
      request.maxPages,
      this.validateUrl,
      signal,
    );
    const usage =
      typeof (raw as { usage?: unknown }).usage === "object" && (raw as { usage?: unknown }).usage !== null
        ? ((raw as { usage: Record<string, unknown> }).usage)
        : undefined;
    const credits = optionalNumber(usage?.credits);
    return crawlResult(this.id, request.url, "completed", pages, started, {
      completed: pages.length,
      ...(credits === undefined ? {} : { creditsUsed: credits, warnings: [`tavily credits used: ${credits}`] }),
    });
  }
}

function parseTavilyPages(values: readonly unknown[], maxContentChars: number): CrawlPage[] {
  return values.flatMap((value): CrawlPage[] => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    const url = optionalString(item.url);
    if (url === undefined) return [];
    const title = optionalString(item.title);
    return [
      pageFromContent("tavily", url, optionalString(item.raw_content), maxContentChars, {
        ...(title === undefined ? {} : { title }),
      }),
    ];
  });
}
