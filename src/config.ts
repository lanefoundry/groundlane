import { z } from "zod";

import {
  DEFAULT_SEARCH_DAILY_BUDGETS_VALUE,
  DEFAULT_SEARCH_PROVIDER_BUDGETS_VALUE,
  DEFAULT_SEARCH_PROVIDER_ORDER_VALUE,
  SEARCH_PROVIDER_IDS,
  type KnownSearchProviderId,
} from "./core/search-provider-catalog.js";
import {
  ARTIFACT_DEFAULT_TTL_SECONDS,
  ARTIFACT_HARD_MAX_TTL_SECONDS,
  UPLOAD_DEFAULT_TTL_SECONDS,
  UPLOAD_HARD_MAX_TTL_SECONDS,
} from "./core/artifact-retention-policy.js";

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

const booleanFlag = z.preprocess(
  (value) => value === "true" ? true : value === "false" || value === undefined ? false : value,
  z.boolean(),
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
  SEARXNG_BASE_URL: optionalSecret,
  CRAWL4AI_BASE_URL: optionalSecret,
  READER_BACKEND: z.enum(["disabled", "jina"]).default("disabled"),
  BROWSER_BACKEND: z.enum(["disabled", "local", "browserless", "cf-rendering", "hyperbrowser"]).default("disabled"),
  HYPERBROWSER_API_KEY: optionalSecret,
  CF_BROWSER_ACCOUNT_ID: optionalSecret,
  CF_BROWSER_API_TOKEN: optionalSecret,
  CF_BROWSER_DAILY_BUDGET_MS: positiveInt(0, 3_600_000).optional(),
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
  DOCUMENT_ARTIFACT_STATE_PATH: optionalPath,
  CORPUS_STATE_PATH: optionalPath,
  CORPUS_TENANT_ID: z.string().trim().min(1).max(160).default("default"),
  CORPUS_MAX_SOURCE_BYTES: positiveInt(1_024, 32 * 1024 * 1024).default(1_000_000),
  ASYNC_TASK_STATE_PATH: optionalPath,
  ASYNC_TASK_EDGE_ENABLED: booleanFlag,
  ARTIFACT_EDGE_ENABLED: booleanFlag,
  OCR_SPACE_API_KEY: optionalSecret,
  CLOUDCONVERT_API_KEY: optionalSecret,
  DOCUMENT_CACHE_EDGE_ENABLED: booleanFlag,
  DOCUMENT_OUTPUT_EDGE_ENABLED: booleanFlag,
  GROUNDLANE_INTERNAL_SIGNING_SECRET: optionalSecret,
  DOCUMENT_UPLOAD_MAX_TTL_SECONDS: positiveInt(
    UPLOAD_DEFAULT_TTL_SECONDS,
    UPLOAD_HARD_MAX_TTL_SECONDS,
  ).default(UPLOAD_HARD_MAX_TTL_SECONDS),
  DOCUMENT_ARTIFACT_MAX_TTL_SECONDS: positiveInt(
    ARTIFACT_DEFAULT_TTL_SECONDS,
    ARTIFACT_HARD_MAX_TTL_SECONDS,
  ).default(ARTIFACT_HARD_MAX_TTL_SECONDS),
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
  browserBackend: "disabled" | "local" | "browserless" | "cf-rendering" | "hyperbrowser";
  hyperbrowserApiKey?: string;
  browserlessToken?: string;
  browserlessRegion: "sfo" | "lon" | "ams";
  cfBrowserAccountId?: string;
  cfBrowserApiToken?: string;
  cfBrowserDailyBudgetMs?: number;
  jinaReaderRpm: number;
  browserlessMonthlyUnits: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  maxOutputChars: number;
  maxConcurrency: number;
  maxQueue: number;
  documentCacheStatePath?: string;
  documentArtifactStatePath?: string;
  documentOutputEdgeEnabled: boolean;
  corpusStatePath?: string;
  corpusTenantId: string;
  corpusMaxSourceBytes: number;
  asyncTaskStatePath?: string;
  asyncTaskEdgeEnabled: boolean;
  artifactEdgeEnabled: boolean;
  documentCacheEdgeEnabled: boolean;
  internalSigningSecret?: string;
  documentUploadMaxTtlSeconds: number;
  documentArtifactMaxTtlSeconds: number;
  documentCacheDefaultTtlSeconds: number;
  documentCacheMaxTtlSeconds: number;
  ocrSpaceApiKey?: string;
  cloudConvertApiKey?: string;
  crawl4aiBaseUrl?: string;
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
  if (parsed.SEARXNG_BASE_URL !== undefined) providerKeys.searxng = parsed.SEARXNG_BASE_URL;
  if (parsed.BROWSER_BACKEND === "browserless" && parsed.BROWSERLESS_TOKEN === undefined) {
    throw new Error("BROWSERLESS_TOKEN is required when BROWSER_BACKEND=browserless");
  }
  if (parsed.BROWSER_BACKEND === "cf-rendering") {
    if (parsed.CF_BROWSER_ACCOUNT_ID === undefined) {
      throw new Error("CF_BROWSER_ACCOUNT_ID is required when BROWSER_BACKEND=cf-rendering");
    }
    if (parsed.CF_BROWSER_API_TOKEN === undefined) {
      throw new Error("CF_BROWSER_API_TOKEN is required when BROWSER_BACKEND=cf-rendering");
    }
  }
  if (parsed.BROWSER_BACKEND === "hyperbrowser" && parsed.HYPERBROWSER_API_KEY === undefined) {
    throw new Error("HYPERBROWSER_API_KEY is required when BROWSER_BACKEND=hyperbrowser");
  }
  if (parsed.DOCUMENT_CACHE_DEFAULT_TTL_SECONDS > parsed.DOCUMENT_CACHE_MAX_TTL_SECONDS) {
    throw new Error("DOCUMENT_CACHE_DEFAULT_TTL_SECONDS must not exceed DOCUMENT_CACHE_MAX_TTL_SECONDS");
  }
  if (parsed.DOCUMENT_CACHE_EDGE_ENABLED && parsed.GROUNDLANE_INTERNAL_SIGNING_SECRET === undefined) {
    throw new Error("GROUNDLANE_INTERNAL_SIGNING_SECRET is required when DOCUMENT_CACHE_EDGE_ENABLED=true");
  }
  if (parsed.DOCUMENT_OUTPUT_EDGE_ENABLED && parsed.GROUNDLANE_INTERNAL_SIGNING_SECRET === undefined) {
    throw new Error("GROUNDLANE_INTERNAL_SIGNING_SECRET is required when DOCUMENT_OUTPUT_EDGE_ENABLED=true");
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
    ...(parsed.HYPERBROWSER_API_KEY === undefined
      ? {}
      : { hyperbrowserApiKey: parsed.HYPERBROWSER_API_KEY }),
    browserlessRegion: parsed.BROWSERLESS_REGION,
    ...(parsed.CF_BROWSER_ACCOUNT_ID === undefined
      ? {}
      : { cfBrowserAccountId: parsed.CF_BROWSER_ACCOUNT_ID }),
    ...(parsed.CF_BROWSER_API_TOKEN === undefined
      ? {}
      : { cfBrowserApiToken: parsed.CF_BROWSER_API_TOKEN }),
    ...(parsed.CF_BROWSER_DAILY_BUDGET_MS === undefined
      ? {}
      : { cfBrowserDailyBudgetMs: parsed.CF_BROWSER_DAILY_BUDGET_MS }),
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
    ...(parsed.DOCUMENT_ARTIFACT_STATE_PATH === undefined
      ? {}
      : { documentArtifactStatePath: parsed.DOCUMENT_ARTIFACT_STATE_PATH }),
    documentOutputEdgeEnabled: parsed.DOCUMENT_OUTPUT_EDGE_ENABLED,
    ...(parsed.CORPUS_STATE_PATH === undefined
      ? {}
      : { corpusStatePath: parsed.CORPUS_STATE_PATH }),
    corpusTenantId: parsed.CORPUS_TENANT_ID,
    corpusMaxSourceBytes: parsed.CORPUS_MAX_SOURCE_BYTES,
    ...(parsed.ASYNC_TASK_STATE_PATH === undefined
      ? {}
      : { asyncTaskStatePath: parsed.ASYNC_TASK_STATE_PATH }),
    asyncTaskEdgeEnabled: parsed.ASYNC_TASK_EDGE_ENABLED,
    artifactEdgeEnabled: parsed.ARTIFACT_EDGE_ENABLED,
    documentCacheEdgeEnabled: parsed.DOCUMENT_CACHE_EDGE_ENABLED,
    ...(parsed.GROUNDLANE_INTERNAL_SIGNING_SECRET === undefined
      ? {}
      : { internalSigningSecret: parsed.GROUNDLANE_INTERNAL_SIGNING_SECRET }),
    documentUploadMaxTtlSeconds: parsed.DOCUMENT_UPLOAD_MAX_TTL_SECONDS,
    documentArtifactMaxTtlSeconds: parsed.DOCUMENT_ARTIFACT_MAX_TTL_SECONDS,
    documentCacheDefaultTtlSeconds: parsed.DOCUMENT_CACHE_DEFAULT_TTL_SECONDS,
    documentCacheMaxTtlSeconds: parsed.DOCUMENT_CACHE_MAX_TTL_SECONDS,
    ...(parsed.OCR_SPACE_API_KEY === undefined
      ? {}
      : { ocrSpaceApiKey: parsed.OCR_SPACE_API_KEY }),
    ...(parsed.CLOUDCONVERT_API_KEY === undefined
      ? {}
      : { cloudConvertApiKey: parsed.CLOUDCONVERT_API_KEY }),
    ...(parsed.CRAWL4AI_BASE_URL === undefined
      ? {}
      : { crawl4aiBaseUrl: parsed.CRAWL4AI_BASE_URL }),
  };
}
