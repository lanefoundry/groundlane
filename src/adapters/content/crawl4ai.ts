import type { ContentProvider, ContentProviderResult, ContentRequest } from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import {
  contentProviderJson,
  defaultContentUrlValidator,
  normalizedContentResult,
  optionalString,
  type ContentFetchLike,
  type ContentUrlValidator,
} from "./common.js";

interface Crawl4AIContentOptions {
  baseUrl: string;
  fetch?: ContentFetchLike;
  validateUrl?: ContentUrlValidator;
}

export class Crawl4AIContentProvider implements ContentProvider {
  readonly id = "crawl4ai" as const;
  private readonly endpoint: string;
  private readonly fetcher: ContentFetchLike;
  private readonly validateUrl: ContentUrlValidator;

  constructor(private readonly options: Crawl4AIContentOptions) {
    const base = options.baseUrl.replace(/\/+$/u, "");
    this.endpoint = `${base}/crawl`;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultContentUrlValidator;
  }

  supports(): boolean {
    return this.options.baseUrl.trim().length > 0;
  }

  async fetchContent(request: ContentRequest, signal: AbortSignal): Promise<ContentProviderResult> {
    const started = performance.now();
    const raw = await contentProviderJson(
      this.fetcher,
      this.endpoint,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          urls: [request.url],
          crawler_config: {
            type: "CrawlerRunConfig",
            params: {
              stream: false,
              cache_mode: "bypass",
            },
          },
        }),
      },
      signal,
    );

    const body = raw as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") {
      throw new GroundlaneError("UPSTREAM_ERROR", "web_content", "Crawl4AI returned a malformed response", true);
    }

    if (body.success === false) {
      throw new GroundlaneError("UPSTREAM_ERROR", "web_content", "Crawl4AI crawl failed", true);
    }

    const results = Array.isArray(body.results) ? body.results : [];
    const first = results[0] as Record<string, unknown> | undefined;
    if (!first || typeof first !== "object") {
      throw new GroundlaneError("UPSTREAM_ERROR", "web_content", "Crawl4AI returned no results", true);
    }

    if (first.success === false) {
      throw new GroundlaneError("UPSTREAM_ERROR", "web_content", "Crawl4AI crawl for the URL failed", true);
    }

    const content = optionalString(first.markdown);
    if (content === undefined) {
      throw new GroundlaneError("UPSTREAM_ERROR", "web_content", "Crawl4AI returned no markdown content", true);
    }

    const metadata = first.metadata && typeof first.metadata === "object"
      ? (first.metadata as Record<string, unknown>)
      : {};
    const finalUrl = optionalString(first.url) ?? request.url;
    const title = optionalString(metadata.title) ?? optionalString(first.title);

    return normalizedContentResult(
      this.id,
      request.url,
      finalUrl,
      title,
      content,
      "markdown",
      request.maxContentChars,
      started,
      this.validateUrl,
      [],
      signal,
    );
  }
}
