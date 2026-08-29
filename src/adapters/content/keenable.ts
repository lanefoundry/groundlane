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

const KEENABLE_KEYED_FETCH_URL = "https://api.keenable.ai/v1/fetch";
const KEENABLE_PUBLIC_FETCH_URL = "https://api.keenable.ai/v1/fetch/public";
const KEENABLE_PUBLIC_TITLE = "Groundlane";

interface KeenableContentOptions {
  apiKey?: string;
  fetch?: ContentFetchLike;
  validateUrl?: ContentUrlValidator;
  publicTitle?: string;
}

export class KeenableContentProvider implements ContentProvider {
  readonly id = "keenable" as const;
  private readonly fetcher: ContentFetchLike;
  private readonly validateUrl: ContentUrlValidator;
  private readonly publicTitle: string;

  constructor(private readonly options: KeenableContentOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultContentUrlValidator;
    this.publicTitle = options.publicTitle ?? KEENABLE_PUBLIC_TITLE;
  }

  supports(): boolean {
    return true;
  }

  async fetchContent(request: ContentRequest, signal: AbortSignal): Promise<ContentProviderResult> {
    const started = performance.now();
    const apiKey = this.options.apiKey?.trim();
    const keyed = apiKey !== undefined && apiKey.length > 0;
    const url = new URL(keyed ? KEENABLE_KEYED_FETCH_URL : KEENABLE_PUBLIC_FETCH_URL);
    url.searchParams.set("url", request.url);
    url.searchParams.set("max_chars", String(request.maxContentChars));
    if (request.live === true) url.searchParams.set("live", "true");
    const raw = await contentProviderJson(
      this.fetcher,
      url.toString(),
      {
        method: "GET",
        headers: keyed ? { "x-api-key": apiKey } : { "x-keenable-title": this.publicTitle },
      },
      signal,
    );
    if (!raw || typeof raw !== "object" || typeof (raw as { content?: unknown }).content !== "string") {
      throw new GroundlaneError("UPSTREAM_ERROR", "web_content", "Keenable returned a malformed fetch response", true);
    }
    const value = raw as Record<string, unknown>;
    return normalizedContentResult(
      this.id,
      request.url,
      optionalString(value.url) ?? request.url,
      optionalString(value.title),
      value.content as string,
      "markdown",
      request.maxContentChars,
      started,
      this.validateUrl,
      keyed ? [] : ["keenable public endpoint used"],
    );
  }
}
