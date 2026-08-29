import type { SearchProviderId } from "./contracts.js";

export interface ProviderCapability {
  provider: SearchProviderId;
  vendorFeatures: readonly string[];
  groundlaneTools: readonly string[];
  filterSupport: string;
  balanceSupport: "api" | "dashboard" | "not_implemented";
  notes: readonly string[];
}

const CAPABILITIES: Readonly<Record<string, ProviderCapability>> = {
  linkup: {
    provider: "linkup",
    vendorFeatures: ["Search", "Fetch", "Research", "Tasks", "Extract"],
    groundlaneTools: ["web_search", "web_answer", "web_content", "provider_balance"],
    filterSupport: "include domains, exclude domains, date range",
    balanceSupport: "api",
    notes: ["web_answer uses Linkup /v1/search with outputType=sourcedAnswer.", "web_content uses Linkup /v1/fetch.", "Balance uses Linkup /v1/credits/balance."],
  },
  keenable: {
    provider: "keenable",
    vendorFeatures: ["Independent-index Search", "Fetch", "MCP", "CLI", "REST"],
    groundlaneTools: ["web_search", "web_content"],
    filterSupport: "one include domain, date range; no exclude domains",
    balanceSupport: "not_implemented",
    notes: ["Groundlane can use the keyless public endpoints when no key is configured."],
  },
  you: {
    provider: "you",
    vendorFeatures: ["Web Search", "Contents", "Answer", "Research", "Finance Research", "MCP"],
    groundlaneTools: ["web_search", "web_answer", "web_content", "provider_balance"],
    filterSupport: "include domains or exclude domains, date range; not both include and exclude together",
    balanceSupport: "api",
    notes: ["web_answer uses You.com /v1/answer and requires a configured API key.", "web_content uses You.com /v1/contents and requires a configured API key.", "Balance uses You.com account balance API for keyed accounts."],
  },
  parallel: {
    provider: "parallel",
    vendorFeatures: ["Search", "Extract", "Cited responses", "Task-style primitives"],
    groundlaneTools: ["web_search"],
    filterSupport: "include domains, exclude domains; no date range",
    balanceSupport: "not_implemented",
    notes: ["Parallel's cited Responses API is not wired into Groundlane web_answer yet."],
  },
  browserbase: {
    provider: "browserbase",
    vendorFeatures: ["Search", "Fetch", "Browser sessions", "Stagehand", "Runtime"],
    groundlaneTools: ["web_search"],
    filterSupport: "unfiltered queries only",
    balanceSupport: "not_implemented",
    notes: ["Browserbase platform browser features are not exposed through Groundlane today."],
  },
  brave: {
    provider: "brave",
    vendorFeatures: ["Independent Web Search API", "News", "Images", "Local", "Goggles"],
    groundlaneTools: ["web_search", "web_news"],
    filterSupport: "date range; include/exclude domains mapped to site: query operators",
    balanceSupport: "not_implemented",
    notes: ["Groundlane only exposes normalized web search today."],
  },
  serpapi: {
    provider: "serpapi",
    vendorFeatures: ["Google organic SERP", "Vertical SERP engines"],
    groundlaneTools: ["web_search", "web_news"],
    filterSupport: "include/exclude domains mapped to Google query operators, date range",
    balanceSupport: "not_implemented",
    notes: ["Groundlane only normalizes organic web results today."],
  },
  tavily: {
    provider: "tavily",
    vendorFeatures: ["Search", "Extract", "Crawl", "Map"],
    groundlaneTools: ["web_search", "web_content", "web_map"],
    filterSupport: "include domains, exclude domains, time range",
    balanceSupport: "not_implemented",
    notes: ["web_content uses Tavily /extract. Latest search production smoke was rejected by upstream."],
  },
  exa: {
    provider: "exa",
    vendorFeatures: ["Neural Search", "Contents", "Answer"],
    groundlaneTools: ["web_search", "web_content"],
    filterSupport: "include domains only",
    balanceSupport: "not_implemented",
    notes: ["web_content uses Exa /contents. Latest search production smoke was rejected by upstream."],
  },
  firecrawl: {
    provider: "firecrawl",
    vendorFeatures: ["Search", "Scrape", "Crawl", "Map", "Extract"],
    groundlaneTools: ["web_search", "web_content", "web_map"],
    filterSupport: "include or exclude domains; not both together",
    balanceSupport: "not_implemented",
    notes: ["web_content uses Firecrawl /scrape. Latest search production smoke was rejected by upstream."],
  },
  serper: {
    provider: "serper",
    vendorFeatures: ["Google Search", "Images", "News", "Maps", "Places", "Videos", "Shopping"],
    groundlaneTools: ["web_search", "web_news"],
    filterSupport: "unfiltered queries only",
    balanceSupport: "dashboard",
    notes: ["Groundlane keeps Serper opt-in because the free pool is finite."],
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
