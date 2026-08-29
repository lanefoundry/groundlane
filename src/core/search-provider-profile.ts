import type { SearchProviderId } from "./contracts.js";

export type SearchProviderFamily =
  | "general-web"
  | "independent-index"
  | "semantic"
  | "serp"
  | "research"
  | "extraction-backed";

const PROVIDER_FAMILIES: Readonly<Partial<Record<SearchProviderId, SearchProviderFamily>>> = {
  tavily: "research",
  exa: "semantic",
  linkup: "research",
  parallel: "research",
  browserbase: "serp",
  brave: "independent-index",
  firecrawl: "extraction-backed",
  serpapi: "serp",
  keenable: "independent-index",
  serper: "serp",
  you: "general-web",
};

export function searchProviderFamily(provider: SearchProviderId): SearchProviderFamily {
  return PROVIDER_FAMILIES[provider] ?? "general-web";
}

const PROVIDER_WEIGHTS: Readonly<Partial<Record<SearchProviderId, number>>> = {
  tavily: 1.0,
  exa: 1.0,
  linkup: 0.9,
  brave: 0.9,
  parallel: 0.8,
  browserbase: 0.8,
  firecrawl: 0.8,
  serpapi: 0.7,
  serper: 0.7,
  you: 0.7,
};

export function searchProviderWeight(provider: SearchProviderId): number {
  return PROVIDER_WEIGHTS[provider] ?? 0.5;
}
