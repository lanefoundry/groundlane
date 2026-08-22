export const SEARCH_PROVIDER_IDS = [
  "tavily",
  "exa",
  "parallel",
  "browserbase",
  "brave",
  "firecrawl",
  "serpapi",
  "linkup",
  "serper",
  "you",
] as const;

export type KnownSearchProviderId = (typeof SEARCH_PROVIDER_IDS)[number];

// One-time REST allowances remain opt-in; renewable providers can be skipped when no key exists.
export const DEFAULT_SEARCH_PROVIDER_ORDER = [
  "tavily",
  "exa",
  "linkup",
  "parallel",
  "browserbase",
  "brave",
  "firecrawl",
  "serpapi",
] as const satisfies readonly KnownSearchProviderId[];

export const DEFAULT_SEARCH_PROVIDER_ORDER_VALUE = DEFAULT_SEARCH_PROVIDER_ORDER.join(",");
export const DEFAULT_SEARCH_PROVIDER_BUDGETS_VALUE =
  "tavily:1000,exa:1000,linkup:100,parallel:1000,browserbase:1000,brave:1000,firecrawl:500,serpapi:250,serper:0,you:0";
