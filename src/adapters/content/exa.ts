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

const EXA_CONTENTS_URL = "https://api.exa.ai/contents";

interface ExaContentOptions {
  apiKey: string;
  fetch?: ContentFetchLike;
  validateUrl?: ContentUrlValidator;
}

export class ExaContentProvider implements ContentProvider {
  readonly id = "exa" as const;
  private readonly fetcher: ContentFetchLike;
  private readonly validateUrl: ContentUrlValidator;

  constructor(private readonly options: ExaContentOptions) {
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
      EXA_CONTENTS_URL,
      {
        method: "POST",
        headers: {
          "x-api-key": this.options.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          urls: [request.url],
          text: { maxCharacters: request.maxContentChars },
          maxAgeHours: request.live === true ? 0 : undefined,
        }),
      },
      signal,
    );
    const values =
      raw && typeof raw === "object" && Array.isArray((raw as { results?: unknown }).results)
        ? (raw as { results: unknown[] }).results
        : undefined;
    if (values === undefined || !values[0] || typeof values[0] !== "object") {
      throw new GroundlaneError("UPSTREAM_ERROR", "web_content", "Exa returned a malformed contents response", true);
    }
    const value = values[0] as Record<string, unknown>;
    const content = optionalString(value.text) ?? optionalString(value.markdown);
    if (content === undefined) {
      throw new GroundlaneError("UPSTREAM_ERROR", "web_content", "Exa returned no text content", true);
    }
    return normalizedContentResult(
      this.id,
      request.url,
      optionalString(value.url) ?? request.url,
      optionalString(value.title),
      content,
      "text",
      request.maxContentChars,
      started,
      this.validateUrl,
      [],
      signal,
    );
  }
}
