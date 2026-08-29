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

const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";

interface FirecrawlContentOptions {
  apiKey: string;
  fetch?: ContentFetchLike;
  validateUrl?: ContentUrlValidator;
}

export class FirecrawlContentProvider implements ContentProvider {
  readonly id = "firecrawl" as const;
  private readonly fetcher: ContentFetchLike;
  private readonly validateUrl: ContentUrlValidator;

  constructor(private readonly options: FirecrawlContentOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultContentUrlValidator;
  }

  supports(): boolean {
    return this.options.apiKey.trim().length > 0;
  }

  async fetchContent(request: ContentRequest, signal: AbortSignal): Promise<ContentProviderResult> {
    const started = performance.now();
    const raw = await contentProviderJson(
      this.fetcher,
      FIRECRAWL_SCRAPE_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: request.url,
          formats: ["markdown"],
          onlyMainContent: true,
        }),
      },
      signal,
    );
    const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>).data : undefined;
    if (!data || typeof data !== "object") {
      throw new GroundlaneError("UPSTREAM_ERROR", "web_content", "Firecrawl returned a malformed scrape response", true);
    }
    const value = data as Record<string, unknown>;
    const content = optionalString(value.markdown);
    if (content === undefined) {
      throw new GroundlaneError("UPSTREAM_ERROR", "web_content", "Firecrawl returned no markdown content", true);
    }
    const metadata =
      value.metadata && typeof value.metadata === "object"
        ? (value.metadata as Record<string, unknown>)
        : {};
    return normalizedContentResult(
      this.id,
      request.url,
      optionalString(metadata.url) ?? optionalString(metadata.sourceURL) ?? request.url,
      optionalString(metadata.title),
      content,
      "markdown",
      request.maxContentChars,
      started,
      this.validateUrl,
      optionalString(value.warning) === undefined ? [] : [optionalString(value.warning) as string],
    );
  }
}
