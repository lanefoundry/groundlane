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

const YOU_CONTENTS_URL = "https://ydc-index.io/v1/contents";

interface YouContentOptions {
  apiKey?: string;
  fetch?: ContentFetchLike;
  validateUrl?: ContentUrlValidator;
}

export class YouContentProvider implements ContentProvider {
  readonly id = "you" as const;
  private readonly fetcher: ContentFetchLike;
  private readonly validateUrl: ContentUrlValidator;

  constructor(private readonly options: YouContentOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultContentUrlValidator;
  }

  supports(): boolean {
    const apiKey = this.options.apiKey?.trim();
    return apiKey !== undefined && apiKey.length > 0;
  }

  async fetchContent(request: ContentRequest, signal: AbortSignal): Promise<ContentProviderResult> {
    const apiKey = this.options.apiKey?.trim();
    if (apiKey === undefined || apiKey.length === 0) {
      throw new GroundlaneError(
        "PROVIDER_UNAVAILABLE",
        "web_content",
        "You.com Contents requires a configured API key",
        true,
      );
    }
    const started = performance.now();
    const raw = await contentProviderJson(
      this.fetcher,
      YOU_CONTENTS_URL,
      {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          urls: [request.url],
          formats: ["markdown", "metadata"],
          ...(request.live === true ? { max_age: 0 } : {}),
        }),
      },
      signal,
    );
    if (!Array.isArray(raw) || !raw[0] || typeof raw[0] !== "object") {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "web_content",
        "You.com returned a malformed contents response",
        true,
      );
    }
    const value = raw[0] as Record<string, unknown>;
    const markdown = optionalString(value.markdown);
    if (markdown === undefined) {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "web_content",
        "You.com returned no markdown content",
        true,
      );
    }
    return normalizedContentResult(
      this.id,
      request.url,
      optionalString(value.url) ?? request.url,
      optionalString(value.title),
      markdown,
      "markdown",
      request.maxContentChars,
      started,
      this.validateUrl,
      [],
      signal,
    );
  }
}
