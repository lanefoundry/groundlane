import type { ProviderBackend, ProviderOwnership } from "./contracts.js";
import type { DomainFilterSpec } from "./domain-filter-validation.js";
import type { ProviderCapability } from "./provider-capabilities.js";

export interface ProviderCapabilities {
  readonly search?: boolean;
  readonly answer?: boolean;
  readonly research?: boolean;
  readonly content?: boolean;
  readonly map?: boolean;
  readonly crawl?: boolean;
  readonly news?: boolean;
  readonly images?: boolean;
  readonly balance?: boolean;
}

export interface ProviderRegistration {
  readonly id: string;
  readonly protocol: "built-in" | "groundlane-provider-v1";
  readonly enabled: boolean;
  readonly backend: ProviderBackend;
  readonly ownership: ProviderOwnership;
  readonly capabilities: ProviderCapabilities;
  readonly family: string;
  readonly weight: number;
  readonly filterSpec: DomainFilterSpec;
  readonly defaultMonthlyBudget: number;
  readonly defaultDailyBudget?: number;
  readonly envKeyName?: string;
  readonly vendorFeatures: readonly string[];
  readonly groundlaneTools: readonly string[];
  readonly filterSupport: string;
  readonly balanceSupport: "api" | "dashboard" | "not_implemented";
  readonly notes: readonly string[];
}

const BUILT_IN_ID_RE = /^[a-z0-9]+$/u;
const CUSTOM_ID_RE = /^custom\.[a-z0-9][a-z0-9-]*$/u;
const VALID_PROTOCOLS = new Set<string>(["built-in", "groundlane-provider-v1"]);

export class ProviderRegistry {
  private readonly registrations = new Map<string, ProviderRegistration>();

  register(registration: ProviderRegistration): void {
    const { id, protocol } = registration;

    if (id === "") {
      throw new Error("Provider ID must not be empty");
    }
    if (!VALID_PROTOCOLS.has(protocol)) {
      throw new Error(`Unknown protocol "${protocol}" for provider "${id}"`);
    }
    if (this.registrations.has(id)) {
      throw new Error(`Duplicate provider ID "${id}"`);
    }

    if (protocol === "built-in") {
      if (!BUILT_IN_ID_RE.test(id)) {
        throw new Error(
          `Built-in provider ID "${id}" must be lowercase alphanumeric without dots`,
        );
      }
    } else {
      if (!CUSTOM_ID_RE.test(id)) {
        throw new Error(
          `Custom provider ID "${id}" must match custom.<lowercase-alphanumeric-hyphens>`,
        );
      }
    }

    this.registrations.set(id, registration);
  }

  get(id: string): ProviderRegistration | undefined {
    return this.registrations.get(id);
  }

  has(id: string): boolean {
    return this.registrations.has(id);
  }

  ids(): string[] {
    return [...this.registrations.keys()];
  }

  enabledIds(): string[] {
    return [...this.registrations.values()]
      .filter((r) => r.enabled)
      .map((r) => r.id);
  }

  isCustom(id: string): boolean {
    return id.startsWith("custom.");
  }

  providerCapabilities(): Record<string, ProviderCapability> {
    const result: Record<string, ProviderCapability> = {};
    for (const reg of this.registrations.values()) {
      result[reg.id] = {
        provider: reg.id,
        vendorFeatures: reg.vendorFeatures,
        groundlaneTools: reg.groundlaneTools,
        filterSupport: reg.filterSupport,
        balanceSupport: reg.balanceSupport,
        notes: reg.notes,
      };
    }
    return result;
  }

  filterSpec(id: string): DomainFilterSpec {
    return this.registrations.get(id)?.filterSpec ?? { mode: "none", timeRange: false };
  }

  family(id: string): string {
    return this.registrations.get(id)?.family ?? "general-web";
  }

  weight(id: string): number {
    return this.registrations.get(id)?.weight ?? 0.5;
  }
}

const diagnosticsTools = ["provider_quota", "search_budget_status"] as const;

function builtIn(
  partial: Omit<ProviderRegistration, "protocol" | "enabled" | "backend" | "ownership">,
): ProviderRegistration {
  return {
    ...partial,
    protocol: "built-in" as const,
    enabled: true,
    backend: "api" as const,
    ownership: "built-in" as const,
  };
}

export function createBuiltInRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();

  registry.register(builtIn({
    id: "tavily",
    capabilities: { search: true, content: true, map: true, crawl: true },
    family: "research",
    weight: 1.0,
    filterSpec: { mode: "combined", timeRange: true },
    defaultMonthlyBudget: 800,
    envKeyName: "TAVILY_API_KEY",
    vendorFeatures: ["Search", "Extract", "Crawl", "Map"],
    groundlaneTools: ["web_search", "web_content", "web_map", "web_crawl", ...diagnosticsTools],
    filterSupport: "include domains, exclude domains, time range",
    balanceSupport: "not_implemented",
    notes: ["web_content uses Tavily /extract. Latest search production smoke was rejected by upstream."],
  }));

  registry.register(builtIn({
    id: "exa",
    capabilities: { search: true, content: true },
    family: "semantic",
    weight: 1.0,
    filterSpec: { mode: "include-only", timeRange: false },
    defaultMonthlyBudget: 1200,
    envKeyName: "EXA_API_KEY",
    vendorFeatures: ["Neural Search", "Contents", "Answer"],
    groundlaneTools: ["web_search", "web_content", ...diagnosticsTools],
    filterSupport: "include domains only",
    balanceSupport: "not_implemented",
    notes: ["web_content uses Exa /contents. Latest search production smoke was rejected by upstream."],
  }));

  registry.register(builtIn({
    id: "parallel",
    capabilities: { search: true, research: true },
    family: "research",
    weight: 0.8,
    filterSpec: { mode: "combined", timeRange: false },
    defaultMonthlyBudget: 500,
    envKeyName: "PARALLEL_API_KEY",
    vendorFeatures: ["Search", "Extract", "Cited responses", "Task-style primitives"],
    groundlaneTools: ["web_search", "web_research", ...diagnosticsTools],
    filterSupport: "web_search supports include domains and exclude domains; web_research does not support filters",
    balanceSupport: "not_implemented",
    notes: ["web_research uses Parallel's synchronous OpenAI-compatible /v1/responses endpoint with model parallel."],
  }));

  registry.register(builtIn({
    id: "browserbase",
    capabilities: { search: true },
    family: "serp",
    weight: 0.8,
    filterSpec: { mode: "none", timeRange: false },
    defaultMonthlyBudget: 1000,
    envKeyName: "BROWSERBASE_API_KEY",
    vendorFeatures: ["Search", "Fetch", "Browser sessions", "Stagehand", "Runtime"],
    groundlaneTools: ["web_search", ...diagnosticsTools],
    filterSupport: "unfiltered queries only",
    balanceSupport: "not_implemented",
    notes: ["Browserbase platform browser features are not exposed through Groundlane today."],
  }));

  registry.register(builtIn({
    id: "brave",
    capabilities: { search: true, news: true, images: true },
    family: "independent-index",
    weight: 0.9,
    filterSpec: { mode: "combined", timeRange: true },
    defaultMonthlyBudget: 1000,
    envKeyName: "BRAVE_API_KEY",
    vendorFeatures: ["Independent Web Search API", "News", "Images", "Local", "Goggles"],
    groundlaneTools: ["web_search", "web_news", "web_images", ...diagnosticsTools],
    filterSupport: "date range; include/exclude domains mapped to site: query operators",
    balanceSupport: "not_implemented",
    notes: ["web_images uses Brave Image Search."],
  }));

  registry.register(builtIn({
    id: "firecrawl",
    capabilities: { search: true, content: true, map: true, crawl: true, balance: true },
    family: "extraction-backed",
    weight: 0.8,
    filterSpec: { mode: "include-or-exclude", timeRange: false },
    defaultMonthlyBudget: 500,
    envKeyName: "FIRECRAWL_API_KEY",
    vendorFeatures: ["Search", "Scrape", "Crawl", "Map", "Extract"],
    groundlaneTools: ["web_search", "web_content", "web_map", "web_crawl", "provider_balance", ...diagnosticsTools],
    filterSupport: "include or exclude domains; not both together",
    balanceSupport: "api",
    notes: ["web_content uses Firecrawl /scrape. Latest search production smoke was rejected by upstream.", "Balance uses Firecrawl /v2/team/credit-usage and reports remaining credits."],
  }));

  registry.register(builtIn({
    id: "serpapi",
    capabilities: { search: true, news: true, images: true, balance: true },
    family: "serp",
    weight: 0.7,
    filterSpec: { mode: "combined", timeRange: true },
    defaultMonthlyBudget: 250,
    envKeyName: "SERPAPI_API_KEY",
    vendorFeatures: ["Google organic SERP", "Vertical SERP engines"],
    groundlaneTools: ["web_search", "web_news", "web_images", "provider_balance", ...diagnosticsTools],
    filterSupport: "include/exclude domains mapped to Google query operators, date range",
    balanceSupport: "api",
    notes: ["web_images uses SerpApi Google Images.", "Balance uses SerpApi Account API and reports total searches left."],
  }));

  registry.register(builtIn({
    id: "searchapi",
    capabilities: { search: true },
    family: "serp",
    weight: 0.7,
    filterSpec: { mode: "combined", timeRange: false },
    defaultMonthlyBudget: 0,
    envKeyName: "SEARCHAPI_API_KEY",
    vendorFeatures: ["Google organic SERP", "Vertical SERP engines"],
    groundlaneTools: ["web_search", ...diagnosticsTools],
    filterSupport: "include/exclude domains mapped to Google query operators; no date range",
    balanceSupport: "dashboard",
    notes: ["Groundlane keeps SearchAPI.io opt-in because the free pool is a finite signup trial."],
  }));

  registry.register(builtIn({
    id: "linkup",
    capabilities: { search: true, answer: true, research: true, content: true, balance: true },
    family: "research",
    weight: 0.9,
    filterSpec: { mode: "combined", timeRange: true },
    defaultMonthlyBudget: 100,
    envKeyName: "LINKUP_API_KEY",
    vendorFeatures: ["Search", "Fetch", "Research", "Tasks", "Extract"],
    groundlaneTools: ["web_search", "web_answer", "web_research", "web_content", "provider_balance", ...diagnosticsTools],
    filterSupport: "include domains, exclude domains, date range",
    balanceSupport: "api",
    notes: ["web_answer uses Linkup /v1/search with outputType=sourcedAnswer.", "web_research uses Linkup /v1/research and polls the async task inside the MCP deadline.", "web_content uses Linkup /v1/fetch.", "Balance uses Linkup /v1/credits/balance."],
  }));

  registry.register(builtIn({
    id: "keenable",
    capabilities: { search: true, content: true },
    family: "independent-index",
    weight: 0.5,
    filterSpec: { mode: "include-only", maxIncludeDomains: 1, timeRange: true },
    defaultMonthlyBudget: 100,
    envKeyName: "KEENABLE_API_KEY",
    vendorFeatures: ["Independent-index Search", "Fetch", "MCP", "CLI", "REST"],
    groundlaneTools: ["web_search", "web_content", ...diagnosticsTools],
    filterSupport: "one include domain, date range; no exclude domains",
    balanceSupport: "not_implemented",
    notes: ["Groundlane can use the keyless public endpoints when no key is configured."],
  }));

  registry.register(builtIn({
    id: "serper",
    capabilities: { search: true, news: true, images: true },
    family: "serp",
    weight: 0.7,
    filterSpec: { mode: "none", timeRange: false },
    defaultMonthlyBudget: 0,
    envKeyName: "SERPER_API_KEY",
    vendorFeatures: ["Google Search", "Images", "News", "Maps", "Places", "Videos", "Shopping"],
    groundlaneTools: ["web_search", "web_news", "web_images", ...diagnosticsTools],
    filterSupport: "unfiltered queries only",
    balanceSupport: "dashboard",
    notes: ["Groundlane keeps Serper opt-in because the free pool is finite.", "web_images uses Serper Images."],
  }));

  registry.register(builtIn({
    id: "you",
    capabilities: { search: true, answer: true, research: true, content: true, balance: true },
    family: "general-web",
    weight: 0.7,
    filterSpec: { mode: "include-or-exclude", timeRange: true },
    defaultMonthlyBudget: 3000,
    defaultDailyBudget: 100,
    envKeyName: "YOU_API_KEY",
    vendorFeatures: ["Web Search", "Contents", "Answer", "Research", "Finance Research", "MCP"],
    groundlaneTools: ["web_search", "web_answer", "web_research", "web_content", "provider_balance", ...diagnosticsTools],
    filterSupport: "include domains or exclude domains, date range; not both include and exclude together",
    balanceSupport: "api",
    notes: ["web_answer uses You.com /v1/answer and requires a configured API key.", "web_research uses You.com /v1/research synchronously and requires a configured API key.", "web_content uses You.com /v1/contents and requires a configured API key.", "Balance uses You.com account balance API for keyed accounts."],
  }));

  registry.register(builtIn({
    id: "tinyfish",
    capabilities: { search: true, content: true },
    family: "general-web",
    weight: 0.9,
    filterSpec: { mode: "combined", timeRange: true },
    defaultMonthlyBudget: 3000,
    envKeyName: "TINYFISH_API_KEY",
    vendorFeatures: ["Search", "Fetch", "Agent", "Browser", "MCP", "SDKs", "CLI"],
    groundlaneTools: ["web_search", "web_content", ...diagnosticsTools],
    filterSupport: "include domains, exclude domains, date range through recency minutes",
    balanceSupport: "dashboard",
    notes: ["Search and Fetch are free at any wallet balance but require a configured API key.", "Groundlane does not expose TinyFish Agent or Browser paid surfaces."],
  }));

  return registry;
}

export const builtInRegistry: ProviderRegistry = createBuiltInRegistry();
