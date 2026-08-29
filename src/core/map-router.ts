import type {
  MapLink,
  MapProvider,
  MapProviderId,
  MapProviderResult,
  MapRequest,
  MapResult,
} from "./contracts.js";
import { GroundlaneError, toGroundlaneError } from "./errors.js";
import { resolvePublicUrl } from "./url-policy.js";

export const MAP_PROVIDER_IDS = ["firecrawl", "tavily"] as const satisfies readonly MapProviderId[];

interface MapOutcome {
  provider: MapProvider;
  result?: MapProviderResult;
  warning?: string;
}

export class MapRouter {
  private readonly providers: ReadonlyMap<MapProviderId, MapProvider>;

  constructor(
    providers: readonly MapProvider[],
    private readonly order: readonly MapProviderId[] = MAP_PROVIDER_IDS,
  ) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
  }

  async map(request: MapRequest, signal: AbortSignal): Promise<MapResult> {
    await this.validateRequest(request);
    const startedAt = Date.now();
    const selected = this.resolveProviders(request);
    if (selected.length === 0) {
      throw new GroundlaneError(
        "PROVIDER_UNAVAILABLE",
        "web_map",
        "No configured map provider supports this request",
        true,
      );
    }
    const strategy =
      request.provider !== undefined && request.provider !== "auto"
        ? "fallback"
        : (request.strategy ?? "parallel");
    return strategy === "fallback"
      ? this.mapWithFallback(request, selected, startedAt, signal)
      : this.mapInParallel(request, selected, startedAt, signal);
  }

  private async validateRequest(request: MapRequest): Promise<void> {
    if (
      !request.url.trim() ||
      !Number.isInteger(request.maxLinks) ||
      request.maxLinks < 1 ||
      request.maxLinks > 1_000 ||
      (request.search !== undefined && request.search.trim().length === 0) ||
      (request.search !== undefined && request.search.length > 500) ||
      (request.maxDepth !== undefined &&
        (!Number.isInteger(request.maxDepth) || request.maxDepth < 1 || request.maxDepth > 5)) ||
      (request.maxBreadth !== undefined &&
        (!Number.isInteger(request.maxBreadth) || request.maxBreadth < 1 || request.maxBreadth > 500)) ||
      (request.providers !== undefined && request.providers.length === 0) ||
      (request.provider !== undefined &&
        request.provider !== "auto" &&
        request.providers !== undefined)
    ) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "web_map",
        "Map URL, limits, search, or provider selection is invalid",
      );
    }
    await resolvePublicUrl(request.url);
  }

  private resolveProviders(request: MapRequest): MapProvider[] {
    const requested =
      request.provider !== undefined && request.provider !== "auto"
        ? [request.provider]
        : (request.providers ?? this.order);
    const resolved: MapProvider[] = [];
    for (const id of [...new Set(requested)]) {
      const provider = this.providers.get(id);
      if (provider !== undefined && provider.supports(request)) resolved.push(provider);
    }
    return resolved;
  }

  private async mapWithFallback(
    request: MapRequest,
    providers: readonly MapProvider[],
    startedAt: number,
    signal: AbortSignal,
  ): Promise<MapResult> {
    const warnings: string[] = [];
    const attempted: MapProviderId[] = [];
    for (const provider of providers) {
      attempted.push(provider.id);
      try {
        const result = await provider.map(request, signal);
        return this.toResult(request, "fallback", providers, attempted, [result], startedAt, warnings);
      } catch (error) {
        const safe = toGroundlaneError(error, "web_map");
        if (providers.length === 1 || !safe.retryable) throw safe;
        warnings.push(`${provider.id} unavailable`);
      }
    }
    throw new GroundlaneError(
      "PROVIDER_UNAVAILABLE",
      "web_map",
      "All selected map providers were unavailable",
      true,
    );
  }

  private async mapInParallel(
    request: MapRequest,
    providers: readonly MapProvider[],
    startedAt: number,
    signal: AbortSignal,
  ): Promise<MapResult> {
    const outcomes = await Promise.all(
      providers.map(async (provider): Promise<MapOutcome> => {
        try {
          return { provider, result: await provider.map(request, signal) };
        } catch (error) {
          toGroundlaneError(error, "web_map");
          return { provider, warning: `${provider.id} unavailable` };
        }
      }),
    );
    if (signal.aborted) {
      if (signal.reason instanceof GroundlaneError) throw signal.reason;
      throw new GroundlaneError("CANCELLED", "web_map", "The request was cancelled");
    }
    const results = outcomes
      .map((outcome) => outcome.result)
      .filter((result): result is MapProviderResult => result !== undefined);
    if (results.length === 0) {
      throw new GroundlaneError(
        "PROVIDER_UNAVAILABLE",
        "web_map",
        "All selected map providers were unavailable",
        true,
      );
    }
    return this.toResult(
      request,
      "parallel",
      providers,
      providers.map((provider) => provider.id),
      results,
      startedAt,
      outcomes.flatMap((outcome) => outcome.warning === undefined ? [] : [outcome.warning]),
    );
  }

  private toResult(
    request: MapRequest,
    strategy: "fallback" | "parallel",
    selected: readonly MapProvider[],
    attempted: readonly MapProviderId[],
    providerResults: readonly MapProviderResult[],
    startedAt: number,
    warnings: readonly string[],
  ): MapResult {
    return {
      url: request.url,
      strategy,
      providersSelected: selected.map((provider) => provider.id),
      providersAttempted: attempted,
      providersSucceeded: providerResults.map((result) => result.provider),
      links: dedupeLinks(providerResults.flatMap((result) => result.links)).slice(0, request.maxLinks),
      providerResults,
      durationMs: Date.now() - startedAt,
      warnings: [
        ...warnings,
        ...providerResults.flatMap((result) => result.warnings),
      ],
    };
  }
}

function dedupeLinks(links: readonly MapLink[]): MapLink[] {
  const seen = new Set<string>();
  const deduped: MapLink[] = [];
  for (const link of links) {
    const key = link.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(link);
  }
  return deduped;
}
