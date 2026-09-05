import { z } from "zod";

import {
  DEFAULT_SEARCH_DAILY_BUDGETS_VALUE,
  DEFAULT_SEARCH_PROVIDER_BUDGETS_VALUE,
  DEFAULT_SEARCH_PROVIDER_ORDER_VALUE,
  SEARCH_PROVIDER_IDS,
  type KnownSearchProviderId,
} from "./core/search-provider-catalog.js";

const positiveInt = (minimum: number, maximum: number) =>
  z.coerce.number().int().min(minimum).max(maximum);

const optionalSecret = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const optionalPath = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).max(4_096).optional(),
);

const environmentSchema = z.object({
  PORT: positiveInt(1, 65_535).default(8080),
  GROUNDLANE_AUTH_TOKEN: z.string().min(32),
  SEARCH_PROVIDER_ORDER: z.string().default(DEFAULT_SEARCH_PROVIDER_ORDER_VALUE),
  SEARCH_MONTHLY_REQUEST_BUDGETS: z
    .string()
    .default(DEFAULT_SEARCH_PROVIDER_BUDGETS_VALUE),
  SEARCH_DAILY_REQUEST_BUDGETS: z
    .string()
    .default(DEFAULT_SEARCH_DAILY_BUDGETS_VALUE),
  TAVILY_API_KEY: optionalSecret,
  EXA_API_KEY: optionalSecret,
  BRAVE_API_KEY: optionalSecret,
  FIRECRAWL_API_KEY: optionalSecret,
  SERPAPI_API_KEY: optionalSecret,
  SEARCHAPI_API_KEY: optionalSecret,
  BROWSERBASE_API_KEY: optionalSecret,
  PARALLEL_API_KEY: optionalSecret,
  LINKUP_API_KEY: optionalSecret,
  KEENABLE_API_KEY: optionalSecret,
  TINYFISH_API_KEY: optionalSecret,
  SERPER_API_KEY: optionalSecret,
  YOU_API_KEY: optionalSecret,
  READER_BACKEND: z.enum(["disabled", "jina"]).default("disabled"),
  BROWSER_BACKEND: z.enum(["disabled", "local", "browserless"]).default("disabled"),
  BROWSERLESS_TOKEN: optionalSecret,
  BROWSERLESS_REGION: z.enum(["sfo", "lon", "ams"]).default("sfo"),
  JINA_READER_RPM: positiveInt(1, 1_000).default(20),
  BROWSERLESS_MONTHLY_UNITS: positiveInt(0, 100_000).default(1_000),
  REQUEST_TIMEOUT_MS: positiveInt(1_000, 120_000).default(30_000),
  MAX_RESPONSE_BYTES: positiveInt(1_024, 20_000_000).default(2_000_000),
  MAX_OUTPUT_CHARS: positiveInt(1_000, 500_000).default(100_000),
  MAX_CONCURRENCY: positiveInt(1, 100).default(4),
  MAX_QUEUE: positiveInt(0, 1_000).default(16),
  DOCUMENT_CACHE_STATE_PATH: optionalPath,
  DOCUMENT_CACHE_DEFAULT_TTL_SECONDS: positiveInt(60, 2_592_000).default(86_400),
  DOCUMENT_CACHE_MAX_TTL_SECONDS: positiveInt(60, 2_592_000).default(2_592_000),
});

export type SearchProviderId = KnownSearchProviderId;

export interface GroundlaneConfig {
  port: number;
  authToken: string;
  searchProviderOrder: SearchProviderId[];
  searchMonthlyRequestBudgets: Partial<Record<SearchProviderId, number>>;
  searchDailyRequestBudgets: Partial<Record<SearchProviderId, number>>;
  providerKeys: Partial<Record<SearchProviderId, string>>;
  readerBackend: "disabled" | "jina";
  browserBackend: "disabled" | "local" | "browserless";
  browserlessToken?: string;
  browserlessRegion: "sfo" | "lon" | "ams";
  jinaReaderRpm: number;
  browserlessMonthlyUnits: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  maxOutputChars: number;
  maxConcurrency: number;
  maxQueue: number;
  documentCacheStatePath?: string;
  documentCacheDefaultTtlSeconds: number;
  documentCacheMaxTtlSeconds: number;
}

const providerIds = new Set<SearchProviderId>(SEARCH_PROVIDER_IDS);

function parseBudgetString(
  value: string,
  label: string,
): Partial<Record<SearchProviderId, number>> {
  const budgets: Partial<Record<SearchProviderId, number>> = {};
  for (const entry of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    const [id, rawBudget, ...extra] = entry.split(":");
    const budget = Number(rawBudget);
    if (
      extra.length > 0 ||
      id === undefined ||
      !providerIds.has(id as SearchProviderId) ||
      rawBudget === undefined ||
      !/^\d+$/u.test(rawBudget) ||
      !Number.isSafeInteger(budget)
    ) {
      throw new Error(`Invalid ${label} entry: ${entry}`);
    }
    if (id in budgets) {
      throw new Error(`Duplicate ${label} provider: ${id}`);
    }
    budgets[id as SearchProviderId] = budget;
  }
  return budgets;
}

export function parseSearchMonthlyRequestBudgets(
  value: string,
): Partial<Record<SearchProviderId, number>> {
  return parseBudgetString(value, "SEARCH_MONTHLY_REQUEST_BUDGETS");
}

export function parseSearchDailyRequestBudgets(
  value: string,
): Partial<Record<SearchProviderId, number>> {
  return parseBudgetString(value, "SEARCH_DAILY_REQUEST_BUDGETS");
}

export function parseConfig(
  environment: Readonly<Record<string, string | undefined>>,
): GroundlaneConfig {
  const parsed = environmentSchema.parse(environment);
  const order = parsed.SEARCH_PROVIDER_ORDER.split(",")
    .map((value) => value.trim())
    .filter((value): value is SearchProviderId => providerIds.has(value as SearchProviderId));

  if (order.length === 0) {
    throw new Error(
      "SEARCH_PROVIDER_ORDER must contain a supported provider",
    );
  }

  const providerKeys: Partial<Record<SearchProviderId, string>> = {};
  if (parsed.TAVILY_API_KEY !== undefined) providerKeys.tavily = parsed.TAVILY_API_KEY;
  if (parsed.EXA_API_KEY !== undefined) providerKeys.exa = parsed.EXA_API_KEY;
  if (parsed.BRAVE_API_KEY !== undefined) providerKeys.brave = parsed.BRAVE_API_KEY;
  if (parsed.FIRECRAWL_API_KEY !== undefined) {
    providerKeys.firecrawl = parsed.FIRECRAWL_API_KEY;
  }
  if (parsed.SERPAPI_API_KEY !== undefined) providerKeys.serpapi = parsed.SERPAPI_API_KEY;
  if (parsed.SEARCHAPI_API_KEY !== undefined) {
    providerKeys.searchapi = parsed.SEARCHAPI_API_KEY;
  }
  if (parsed.BROWSERBASE_API_KEY !== undefined) {
    providerKeys.browserbase = parsed.BROWSERBASE_API_KEY;
  }
  if (parsed.PARALLEL_API_KEY !== undefined) providerKeys.parallel = parsed.PARALLEL_API_KEY;
  if (parsed.LINKUP_API_KEY !== undefined) providerKeys.linkup = parsed.LINKUP_API_KEY;
  if (parsed.KEENABLE_API_KEY !== undefined) providerKeys.keenable = parsed.KEENABLE_API_KEY;
  if (parsed.TINYFISH_API_KEY !== undefined) providerKeys.tinyfish = parsed.TINYFISH_API_KEY;
  if (parsed.SERPER_API_KEY !== undefined) providerKeys.serper = parsed.SERPER_API_KEY;
  if (parsed.YOU_API_KEY !== undefined) providerKeys.you = parsed.YOU_API_KEY;
  if (parsed.BROWSER_BACKEND === "browserless" && parsed.BROWSERLESS_TOKEN === undefined) {
    throw new Error("BROWSERLESS_TOKEN is required when BROWSER_BACKEND=browserless");
  }
  if (parsed.DOCUMENT_CACHE_DEFAULT_TTL_SECONDS > parsed.DOCUMENT_CACHE_MAX_TTL_SECONDS) {
    throw new Error("DOCUMENT_CACHE_DEFAULT_TTL_SECONDS must not exceed DOCUMENT_CACHE_MAX_TTL_SECONDS");
  }

  return {
    port: parsed.PORT,
    authToken: parsed.GROUNDLANE_AUTH_TOKEN,
    searchProviderOrder: [...new Set(order)],
    searchMonthlyRequestBudgets: parseSearchMonthlyRequestBudgets(
      parsed.SEARCH_MONTHLY_REQUEST_BUDGETS,
    ),
    searchDailyRequestBudgets: parseSearchDailyRequestBudgets(
      parsed.SEARCH_DAILY_REQUEST_BUDGETS,
    ),
    providerKeys,
    readerBackend: parsed.READER_BACKEND,
    browserBackend: parsed.BROWSER_BACKEND,
    ...(parsed.BROWSERLESS_TOKEN === undefined
      ? {}
      : { browserlessToken: parsed.BROWSERLESS_TOKEN }),
    browserlessRegion: parsed.BROWSERLESS_REGION,
    jinaReaderRpm: parsed.JINA_READER_RPM,
    browserlessMonthlyUnits: parsed.BROWSERLESS_MONTHLY_UNITS,
    requestTimeoutMs: parsed.REQUEST_TIMEOUT_MS,
    maxResponseBytes: parsed.MAX_RESPONSE_BYTES,
    maxOutputChars: parsed.MAX_OUTPUT_CHARS,
    maxConcurrency: parsed.MAX_CONCURRENCY,
    maxQueue: parsed.MAX_QUEUE,
    ...(parsed.DOCUMENT_CACHE_STATE_PATH === undefined
      ? {}
      : { documentCacheStatePath: parsed.DOCUMENT_CACHE_STATE_PATH }),
    documentCacheDefaultTtlSeconds: parsed.DOCUMENT_CACHE_DEFAULT_TTL_SECONDS,
    documentCacheMaxTtlSeconds: parsed.DOCUMENT_CACHE_MAX_TTL_SECONDS,
  };
}
