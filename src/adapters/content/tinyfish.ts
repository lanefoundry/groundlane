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

const TINYFISH_FETCH_URL = "https://api.fetch.tinyfish.ai";

interface TinyFishContentOptions {
  apiKey: string;
  fetch?: ContentFetchLike;
  validateUrl?: ContentUrlValidator;
}

export class TinyFishContentProvider implements ContentProvider {
  readonly id = "tinyfish" as const;
  private readonly fetcher: ContentFetchLike;
  private readonly validateUrl: ContentUrlValidator;

  constructor(private readonly options: TinyFishContentOptions) {
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
      TINYFISH_FETCH_URL,
      {
        method: "POST",
        headers: {
          "x-api-key": this.options.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          urls: [request.url],
          format: "markdown",
          links: false,
          image_links: false,
          ...(request.live === true ? { ttl: 0 } : {}),
        }),
      },
      signal,
    );
    const values =
      raw && typeof raw === "object" && Array.isArray((raw as { results?: unknown }).results)
        ? (raw as { results: unknown[] }).results
        : undefined;
    if (values === undefined) {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "web_content",
        "TinyFish returned a malformed fetch response",
        true,
      );
    }
    const first = values.find((value) => value && typeof value === "object") as
      | Record<string, unknown>
      | undefined;
    if (first === undefined || typeof first.text !== "string") {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "web_content",
        "TinyFish could not fetch the requested URL",
        true,
      );
    }
    return normalizedContentResult(
      this.id,
      request.url,
      optionalString(first.final_url) ?? optionalString(first.url),
      optionalString(first.title),
      first.text,
      "markdown",
      request.maxContentChars,
      started,
      this.validateUrl,
    );
  }
}
