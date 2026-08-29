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

const LINKUP_FETCH_URL = "https://api.linkup.so/v1/fetch";

interface LinkupContentOptions {
  apiKey: string;
  fetch?: ContentFetchLike;
  validateUrl?: ContentUrlValidator;
}

export class LinkupContentProvider implements ContentProvider {
  readonly id = "linkup" as const;
  private readonly fetcher: ContentFetchLike;
  private readonly validateUrl: ContentUrlValidator;

  constructor(private readonly options: LinkupContentOptions) {
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
      LINKUP_FETCH_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: request.url,
          extractImages: false,
          includeRawContent: false,
          includeRawHtml: false,
          renderJs: false,
          mode: "standard",
        }),
      },
      signal,
    );
    if (!raw || typeof raw !== "object" || typeof (raw as { markdown?: unknown }).markdown !== "string") {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "web_content",
        "Linkup returned a malformed fetch response",
        true,
      );
    }
    const value = raw as Record<string, unknown>;
    return normalizedContentResult(
      this.id,
      request.url,
      request.url,
      undefined,
      value.markdown as string,
      "markdown",
      request.maxContentChars,
      started,
      this.validateUrl,
      optionalString(value.warning) === undefined ? [] : [optionalString(value.warning) as string],
    );
  }
}
