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

const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";

interface TavilyContentOptions {
  apiKey: string;
  fetch?: ContentFetchLike;
  validateUrl?: ContentUrlValidator;
}

export class TavilyContentProvider implements ContentProvider {
  readonly id = "tavily" as const;
  private readonly fetcher: ContentFetchLike;
  private readonly validateUrl: ContentUrlValidator;

  constructor(private readonly options: TavilyContentOptions) {
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
      TAVILY_EXTRACT_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          urls: [request.url],
          extract_depth: "basic",
          format: "markdown",
          include_images: false,
          include_favicon: false,
        }),
      },
      signal,
    );
    const values =
      raw && typeof raw === "object" && Array.isArray((raw as { results?: unknown }).results)
        ? (raw as { results: unknown[] }).results
        : undefined;
    if (values === undefined || !values[0] || typeof values[0] !== "object") {
      throw new GroundlaneError("UPSTREAM_ERROR", "web_content", "Tavily returned a malformed extract response", true);
    }
    const value = values[0] as Record<string, unknown>;
    const content = optionalString(value.raw_content);
    if (content === undefined) {
      throw new GroundlaneError("UPSTREAM_ERROR", "web_content", "Tavily returned no raw content", true);
    }
    return normalizedContentResult(
      this.id,
      request.url,
      optionalString(value.url) ?? request.url,
      undefined,
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
