import type { SearchProviderId, SearchRequest } from "./contracts.js";
import { GroundlaneError, hint } from "./errors.js";

/**
 * The five domain-filter modes a provider can support:
 *
 *   none               - no domain filtering at all
 *   include-only       - include domains only, no exclude
 *   exclude-only       - exclude domains only, no include
 *   include-or-exclude - include OR exclude, but not both simultaneously
 *   combined           - both include and exclude together
 */
export type DomainFilterMode =
  | "none"
  | "include-only"
  | "exclude-only"
  | "include-or-exclude"
  | "combined";

export interface DomainFilterSpec {
  mode: DomainFilterMode;
  maxIncludeDomains?: number;
  maxExcludeDomains?: number;
  timeRange: boolean;
}

/**
 * Static filter capability catalog per search provider, derived from the
 * provider-capabilities.ts prose and the individual adapter supports() logic.
 */
const DOMAIN_FILTER_SPECS: Readonly<Record<string, DomainFilterSpec>> = {
  linkup:      { mode: "combined",            timeRange: true },
  keenable:    { mode: "include-only",        maxIncludeDomains: 1, timeRange: true },
  tinyfish:    { mode: "combined",            timeRange: true },
  you:         { mode: "include-or-exclude",  timeRange: true },
  parallel:    { mode: "combined",            timeRange: false },
  browserbase: { mode: "none",                timeRange: false },
  brave:       { mode: "combined",            timeRange: true },
  serpapi:     { mode: "combined",            timeRange: true },
  searchapi:   { mode: "combined",            timeRange: false },
  tavily:      { mode: "combined",            timeRange: true },
  exa:         { mode: "include-only",        timeRange: false },
  firecrawl:   { mode: "include-or-exclude",  timeRange: false },
  serper:      { mode: "none",                timeRange: false },
};

export function domainFilterSpec(provider: SearchProviderId): DomainFilterSpec {
  return DOMAIN_FILTER_SPECS[provider] ?? { mode: "none", timeRange: false };
}

/**
 * Classify a request's domain-filter requirements into one of the five modes.
 */
export function requestFilterMode(
  request: Pick<SearchRequest, "domains" | "excludeDomains">,
): DomainFilterMode {
  const hasInclude = (request.domains?.length ?? 0) > 0;
  const hasExclude = (request.excludeDomains?.length ?? 0) > 0;
  if (hasInclude && hasExclude) return "combined";
  if (hasInclude) return "include-only";
  if (hasExclude) return "exclude-only";
  return "none";
}

/**
 * Whether a provider's filter mode can satisfy the request's filter mode.
 */
function modeSupports(
  providerMode: DomainFilterMode,
  requestMode: DomainFilterMode,
): boolean {
  if (requestMode === "none") return true;
  if (providerMode === "combined") return true;
  if (providerMode === "include-or-exclude") {
    return requestMode === "include-only" || requestMode === "exclude-only";
  }
  return providerMode === requestMode;
}

export interface DomainFilterValidationOptions {
  /** Deployment-level maximum total domain count (include + exclude). Takes precedence over provider limits. */
  deploymentMaxDomains?: number;
}

/**
 * Validate a search request's domain filters against a specific provider.
 * Throws GroundlaneError(INVALID_INPUT) when the combination is unsupported.
 */
export function validateDomainFilters(
  request: Pick<SearchRequest, "domains" | "excludeDomains" | "timeRange">,
  provider: SearchProviderId,
  options?: DomainFilterValidationOptions,
): void {
  const includeCount = request.domains?.length ?? 0;
  const excludeCount = request.excludeDomains?.length ?? 0;

  // Deployment cap takes precedence over provider-specific limits.
  const deploymentMax = options?.deploymentMaxDomains;
  if (deploymentMax !== undefined) {
    const totalDomains = includeCount + excludeCount;
    if (totalDomains > deploymentMax) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "domain-filter",
        `Total domain count ${totalDomains} exceeds deployment limit of ${deploymentMax}`,
        false,
        undefined,
        hint(
          "domain_filter.deployment_cap",
          `The deployment limits the total number of domain filters to ${deploymentMax}. Reduce the number of included and excluded domains.`,
        ),
      );
    }
  }

  const spec = domainFilterSpec(provider);
  const reqMode = requestFilterMode(request);

  // Filter mode compatibility.
  if (!modeSupports(spec.mode, reqMode)) {
    const advice =
      spec.mode === "none"
        ? "Remove domain filters or choose a provider that supports them."
        : spec.mode === "include-or-exclude"
          ? "Use either include or exclude domains, not both simultaneously."
          : `Use ${spec.mode} domains only.`;
    throw new GroundlaneError(
      "INVALID_INPUT",
      "domain-filter",
      `Provider ${provider} does not support ${reqMode} domain filtering`,
      false,
      undefined,
      hint(
        "domain_filter.unsupported_mode",
        `${provider} supports "${spec.mode}" domain filtering but the request requires "${reqMode}". ${advice}`,
      ),
    );
  }

  // maxDomains enforcement.
  if (spec.maxIncludeDomains !== undefined && includeCount > spec.maxIncludeDomains) {
    throw new GroundlaneError(
      "INVALID_INPUT",
      "domain-filter",
      `Provider ${provider} supports at most ${spec.maxIncludeDomains} include domain(s), got ${includeCount}`,
      false,
      undefined,
      hint(
        "domain_filter.max_include_domains",
        `${provider} limits include domains to ${spec.maxIncludeDomains}. Reduce the list or choose a provider that accepts more.`,
      ),
    );
  }
  if (spec.maxExcludeDomains !== undefined && excludeCount > spec.maxExcludeDomains) {
    throw new GroundlaneError(
      "INVALID_INPUT",
      "domain-filter",
      `Provider ${provider} supports at most ${spec.maxExcludeDomains} exclude domain(s), got ${excludeCount}`,
      false,
      undefined,
      hint(
        "domain_filter.max_exclude_domains",
        `${provider} limits exclude domains to ${spec.maxExcludeDomains}. Reduce the list or choose a provider that accepts more.`,
      ),
    );
  }

  // timeRange support.
  if (request.timeRange !== undefined && !spec.timeRange) {
    throw new GroundlaneError(
      "INVALID_INPUT",
      "domain-filter",
      `Provider ${provider} does not support time range filtering`,
      false,
      undefined,
      hint(
        "domain_filter.no_time_range",
        `${provider} does not support the timeRange parameter. Remove it or choose a provider with date-range support.`,
      ),
    );
  }
}

/**
 * Check whether a single candidate provider can handle the request filters
 * (mode + maxDomains + timeRange), ignoring deployment cap (checked separately).
 */
function providerMatchesFilters(
  request: Pick<SearchRequest, "domains" | "excludeDomains" | "timeRange">,
  provider: SearchProviderId,
): boolean {
  const spec = domainFilterSpec(provider);
  const reqMode = requestFilterMode(request);
  if (!modeSupports(spec.mode, reqMode)) return false;
  if (spec.maxIncludeDomains !== undefined && (request.domains?.length ?? 0) > spec.maxIncludeDomains) return false;
  if (spec.maxExcludeDomains !== undefined && (request.excludeDomains?.length ?? 0) > spec.maxExcludeDomains) return false;
  if (request.timeRange !== undefined && !spec.timeRange) return false;
  return true;
}

/**
 * Validate domain filters for a search request before dispatching.
 *
 * - Deployment cap is checked first and takes precedence.
 * - When an explicit provider is given, validates strictly against that provider.
 * - When auto-routing, checks that at least one candidate can handle the combination.
 *
 * Throws GroundlaneError(INVALID_INPUT) when no provider can satisfy the filters.
 */
export function validateDomainFiltersForRequest(
  request: Pick<SearchRequest, "domains" | "excludeDomains" | "timeRange">,
  explicitProvider: SearchProviderId | undefined,
  candidateProviders: readonly SearchProviderId[],
  options?: DomainFilterValidationOptions,
): void {
  const reqMode = requestFilterMode(request);
  if (reqMode === "none" && request.timeRange === undefined) return;

  // Deployment cap takes precedence over everything.
  const deploymentMax = options?.deploymentMaxDomains;
  if (deploymentMax !== undefined) {
    const totalDomains = (request.domains?.length ?? 0) + (request.excludeDomains?.length ?? 0);
    if (totalDomains > deploymentMax) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "domain-filter",
        `Total domain count ${totalDomains} exceeds deployment limit of ${deploymentMax}`,
        false,
        undefined,
        hint(
          "domain_filter.deployment_cap",
          `The deployment limits the total number of domain filters to ${deploymentMax}. Reduce the number of included and excluded domains.`,
        ),
      );
    }
  }

  // Explicit provider: strict validation against that single provider.
  if (explicitProvider !== undefined) {
    validateDomainFilters(request, explicitProvider);
    return;
  }

  // Auto-routing: check that at least one candidate can handle the combination.
  for (const provider of candidateProviders) {
    if (providerMatchesFilters(request, provider)) return;
  }

  // No candidate can handle the filter combination.
  const reasons: string[] = [];
  if (reqMode !== "none") reasons.push(`${reqMode} domain filtering`);
  if (request.timeRange !== undefined) reasons.push(`time range "${request.timeRange}"`);

  throw new GroundlaneError(
    "INVALID_INPUT",
    "domain-filter",
    `No candidate provider supports the requested filter combination: ${reasons.join(" with ")}`,
    false,
    undefined,
    hint(
      "domain_filter.no_candidate",
      "None of the configured candidate providers support this combination of domain filters and time range. Adjust the filters or add a provider that supports them.",
    ),
  );
}
