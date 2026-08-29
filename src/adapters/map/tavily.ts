import type { MapLink, MapProvider, MapProviderResult, MapRequest } from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import {
  defaultMapUrlValidator,
  mapProviderJson,
  mapResult,
  normalizeMapLinks,
  type MapFetchLike,
  type MapUrlValidator,
} from "./common.js";

const TAVILY_MAP_URL = "https://api.tavily.com/map";

interface TavilyMapOptions {
  apiKey: string;
  fetch?: MapFetchLike;
  validateUrl?: MapUrlValidator;
}

export class TavilyMapProvider implements MapProvider {
  readonly id = "tavily" as const;
  private readonly fetcher: MapFetchLike;
  private readonly validateUrl: MapUrlValidator;

  constructor(private readonly options: TavilyMapOptions) {
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
      TAVILY_MAP_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: request.url,
          ...(request.search === undefined ? {} : { instructions: request.search }),
          max_depth: request.maxDepth ?? 1,
          max_breadth: request.maxBreadth ?? 20,
          limit: request.maxLinks,
          allow_external: false,
          include_usage: true,
        }),
      },
      signal,
    );
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { results?: unknown }).results)) {
      throw new GroundlaneError("UPSTREAM_ERROR", "web_map", "Tavily returned a malformed map response", true);
    }
    const links = (raw as { results: unknown[] }).results.flatMap((value): MapLink[] =>
      typeof value === "string" ? [{ url: value, provider: this.id }] : [],
    );
    const usage =
      raw && typeof raw === "object" && typeof (raw as { usage?: unknown }).usage === "object"
        ? (raw as { usage: Record<string, unknown> }).usage
        : undefined;
    const credits = typeof usage?.credits === "number" ? [`tavily credits used: ${usage.credits}`] : [];
    return mapResult(
      this.id,
      request.url,
      await normalizeMapLinks(this.id, links, this.validateUrl, signal),
      started,
      credits,
    );
  }
}
