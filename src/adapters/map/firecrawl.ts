import type { MapLink, MapProvider, MapProviderResult, MapRequest } from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import {
  defaultMapUrlValidator,
  mapProviderJson,
  mapResult,
  normalizeMapLinks,
  optionalString,
  type MapFetchLike,
  type MapUrlValidator,
} from "./common.js";

const FIRECRAWL_MAP_URL = "https://api.firecrawl.dev/v2/map";

interface FirecrawlMapOptions {
  apiKey: string;
  fetch?: MapFetchLike;
  validateUrl?: MapUrlValidator;
}

export class FirecrawlMapProvider implements MapProvider {
  readonly id = "firecrawl" as const;
  private readonly fetcher: MapFetchLike;
  private readonly validateUrl: MapUrlValidator;

  constructor(private readonly options: FirecrawlMapOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultMapUrlValidator;
  }

  supports(): boolean {
    return this.options.apiKey.trim().length > 0;
  }

  async map(request: MapRequest, signal: AbortSignal): Promise<MapProviderResult> {
    const started = performance.now();
    const raw = await mapProviderJson(
      this.fetcher,
      FIRECRAWL_MAP_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: request.url,
          ...(request.search === undefined ? {} : { search: request.search }),
          includeSubdomains: request.includeSubdomains ?? true,
          ignoreQueryParameters: true,
          ignoreCache: request.ignoreCache ?? false,
          limit: request.maxLinks,
        }),
      },
      signal,
    );
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { links?: unknown }).links)) {
      throw new GroundlaneError("UPSTREAM_ERROR", "web_map", "Firecrawl returned a malformed map response", true);
    }
    const links = (raw as { links: unknown[] }).links.flatMap((value): MapLink[] => {
      if (typeof value === "string") return [{ url: value, provider: this.id }];
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      const url = optionalString(item.url);
      if (url === undefined) return [];
      const link: MapLink = { url, provider: this.id };
      const title = optionalString(item.title);
      const description = optionalString(item.description);
      if (title !== undefined) link.title = title;
      if (description !== undefined) link.description = description;
      return [link];
    });
    return mapResult(
      this.id,
      request.url,
      await normalizeMapLinks(this.id, links, this.validateUrl, signal),
      started,
    );
  }
}
