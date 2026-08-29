import type { SearchProviderId } from "./contracts.js";

export interface ProviderCapability {
  provider: SearchProviderId;
  vendorFeatures: readonly string[];
  groundlaneTools: readonly string[];
  filterSupport: string;
  balanceSupport: "api" | "dashboard" | "not_implemented";
  notes: readonly string[];
}

const diagnosticsTools = ["provider_quota", "search_budget_status"] as const;

const CAPABILITIES: Readonly<Record<string, ProviderCapability>> = {
  linkup: {
    provider: "linkup",
    vendorFeatures: ["Search", "Fetch", "Research", "Tasks", "Extract"],
    groundlaneTools: ["web_search", "web_answer", "web_research", "web_content", "provider_balance", ...diagnosticsTools],
    filterSupport: "include domains, exclude domains, date range",
    balanceSupport: "api",
    notes: ["web_answer uses Linkup /v1/search with outputType=sourcedAnswer.", "web_research uses Linkup /v1/research and polls the async task inside the MCP deadline.", "web_content uses Linkup /v1/fetch.", "Balance uses Linkup /v1/credits/balance."],
  },
  keenable: {
    provider: "keenable",
    vendorFeatures: ["Independent-index Search", "Fetch", "MCP", "CLI", "REST"],
    groundlaneTools: ["web_search", "web_content", ...diagnosticsTools],
    filterSupport: "one include domain, date range; no exclude domains",
    balanceSupport: "not_implemented",
    notes: ["Groundlane can use the keyless public endpoints when no key is configured."],
  },
  tinyfish: {
    provider: "tinyfish",
    vendorFeatures: ["Search", "Fetch", "Agent", "Browser", "MCP", "SDKs", "CLI"],
    groundlaneTools: ["web_search", "web_content", ...diagnosticsTools],
    filterSupport: "include domains, exclude domains, date range through recency minutes",
    balanceSupport: "dashboard",
    notes: ["Search and Fetch are free at any wallet balance but require a configured API key.", "Groundlane does not expose TinyFish Agent or Browser paid surfaces."],
  },
  you: {
    provider: "you",
    vendorFeatures: ["Web Search", "Contents", "Answer", "Research", "Finance Research", "MCP"],
    groundlaneTools: ["web_search", "web_answer", "web_research", "web_content", "provider_balance", ...diagnosticsTools],
    filterSupport: "include domains or exclude domains, date range; not both include and exclude together",
    balanceSupport: "api",
    notes: ["web_answer uses You.com /v1/answer and requires a configured API key.", "web_research uses You.com /v1/research synchronously and requires a configured API key.", "web_content uses You.com /v1/contents and requires a configured API key.", "Balance uses You.com account balance API for keyed accounts."],
  },
  parallel: {
    provider: "parallel",
    vendorFeatures: ["Search", "Extract", "Cited responses", "Task-style primitives"],
    groundlaneTools: ["web_search", "web_research", ...diagnosticsTools],
    filterSupport: "web_search supports include domains and exclude domains; web_research does not support filters",
    balanceSupport: "not_implemented",
    notes: ["web_research uses Parallel's synchronous OpenAI-compatible /v1/responses endpoint with model parallel."],
  },
  browserbase: {
    provider: "browserbase",
    vendorFeatures: ["Search", "Fetch", "Browser sessions", "Stagehand", "Runtime"],
    groundlaneTools: ["web_search", ...diagnosticsTools],
    filterSupport: "unfiltered queries only",
    balanceSupport: "not_implemented",
    notes: ["Browserbase platform browser features are not exposed through Groundlane today."],
  },
  brave: {
    provider: "brave",
    vendorFeatures: ["Independent Web Search API", "News", "Images", "Local", "Goggles"],
    groundlaneTools: ["web_search", "web_news", "web_images", ...diagnosticsTools],
    filterSupport: "date range; include/exclude domains mapped to site: query operators",
    balanceSupport: "not_implemented",
    notes: ["web_images uses Brave Image Search."],
  },
  serpapi: {
    provider: "serpapi",
    vendorFeatures: ["Google organic SERP", "Vertical SERP engines"],
    groundlaneTools: ["web_search", "web_news", "web_images", "provider_balance", ...diagnosticsTools],
    filterSupport: "include/exclude domains mapped to Google query operators, date range",
    balanceSupport: "api",
    notes: ["web_images uses SerpApi Google Images.", "Balance uses SerpApi Account API and reports total searches left."],
  },
  searchapi: {
    provider: "searchapi",
    vendorFeatures: ["Google organic SERP", "Vertical SERP engines"],
    groundlaneTools: ["web_search", ...diagnosticsTools],
    filterSupport: "include/exclude domains mapped to Google query operators; no date range",
    balanceSupport: "dashboard",
    notes: ["Groundlane keeps SearchAPI.io opt-in because the free pool is a finite signup trial."],
  },
  tavily: {
    provider: "tavily",
    vendorFeatures: ["Search", "Extract", "Crawl", "Map"],
    groundlaneTools: ["web_search", "web_content", "web_map", "web_crawl", ...diagnosticsTools],
    filterSupport: "include domains, exclude domains, time range",
    balanceSupport: "not_implemented",
    notes: ["web_content uses Tavily /extract. Latest search production smoke was rejected by upstream."],
  },
  exa: {
    provider: "exa",
    vendorFeatures: ["Neural Search", "Contents", "Answer"],
    groundlaneTools: ["web_search", "web_content", ...diagnosticsTools],
    filterSupport: "include domains only",
    balanceSupport: "not_implemented",
    notes: ["web_content uses Exa /contents. Latest search production smoke was rejected by upstream."],
  },
  firecrawl: {
    provider: "firecrawl",
    vendorFeatures: ["Search", "Scrape", "Crawl", "Map", "Extract"],
    groundlaneTools: ["web_search", "web_content", "web_map", "web_crawl", "provider_balance", ...diagnosticsTools],
    filterSupport: "include or exclude domains; not both together",
    balanceSupport: "api",
    notes: ["web_content uses Firecrawl /scrape. Latest search production smoke was rejected by upstream.", "Balance uses Firecrawl /v2/team/credit-usage and reports remaining credits."],
  },
  serper: {
    provider: "serper",
    vendorFeatures: ["Google Search", "Images", "News", "Maps", "Places", "Videos", "Shopping"],
    groundlaneTools: ["web_search", "web_news", "web_images", ...diagnosticsTools],
    filterSupport: "unfiltered queries only",
    balanceSupport: "dashboard",
    notes: ["Groundlane keeps Serper opt-in because the free pool is finite.", "web_images uses Serper Images."],
  },
};

export function providerCapability(provider: SearchProviderId): ProviderCapability {
  return CAPABILITIES[provider] ?? {
    provider,
    vendorFeatures: [],
    groundlaneTools: [],
    filterSupport: "unknown",
    balanceSupport: "not_implemented",
    notes: ["Provider is not in the static Groundlane capability catalog."],
  };
}

export function providerCapabilities(providers: readonly SearchProviderId[]): ProviderCapability[] {
  return providers.map(providerCapability);
}
