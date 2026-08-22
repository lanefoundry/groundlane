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
  serper: "serp",
  you: "general-web",
};

export function searchProviderFamily(provider: SearchProviderId): SearchProviderFamily {
  return PROVIDER_FAMILIES[provider] ?? "general-web";
}
