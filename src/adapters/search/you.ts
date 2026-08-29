import type {
  SearchProvider,
  SearchRequest,
  SearchResult,
  SearchResultItem,
} from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  assertSearchRequest,
  cleanDomains,
  defaultUrlValidator,
  providerJson,
  validateItems,
  type FetchLike,
  type UrlValidator,
} from "./common.js";

const YOU_SEARCH_URL = "https://ydc-index.io/v1/search";
const YOU_FREE_MCP_URL = "https://api.you.com/mcp?profile=free";

interface YouOptions {
  apiKey?: string;
  fetch?: FetchLike;
  validateUrl?: UrlValidator;
  freeMcpSearch?: YouFreeMcpSearch;
}

type YouFreeMcpSearch = (request: SearchRequest, signal: AbortSignal) => Promise<unknown>;

function youRequestBody(request: SearchRequest): Record<string, unknown> {
  const includeDomains = cleanDomains(request.domains);
  const excludeDomains = cleanDomains(request.excludeDomains);
  return {
    query: request.query,
    count: request.maxResults,
    ...(request.timeRange === undefined ? {} : { freshness: request.timeRange }),
    ...(includeDomains === undefined ? {} : { include_domains: includeDomains }),
    ...(excludeDomains === undefined ? {} : { exclude_domains: excludeDomains }),
  };
}

async function defaultFreeMcpSearch(
  request: SearchRequest,
  signal: AbortSignal,
): Promise<unknown> {
  const client = new Client({ name: "groundlane-you-free", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(YOU_FREE_MCP_URL));
  try {
    // SDK transport works at runtime; the assertion narrows an exact optional type mismatch.
    await client.connect(transport as Transport, { signal });
    const result = await client.callTool(
      { name: "you-search", arguments: youRequestBody(request) },
      undefined,
      { signal },
    );
    if (result.isError) {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "search",
        "You.com free search rejected the request",
        true,
      );
    }
    return result.structuredContent;
  } catch (error) {
    if (error instanceof GroundlaneError) throw error;
    if (signal.aborted) throw new GroundlaneError("CANCELLED", "search", "Search was cancelled");
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "search",
      "You.com free search request failed",
      true,
      { cause: error },
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}

function normalizeYouResult(
  raw: unknown,
  request: SearchRequest,
  started: number,
  validateUrl: UrlValidator,
  warning: string | undefined,
): Promise<SearchResult> {
  const results =
    raw && typeof raw === "object" &&
    (raw as { results?: unknown }).results &&
    typeof (raw as { results?: unknown }).results === "object"
      ? ((raw as { results: Record<string, unknown> }).results)
      : undefined;
  if (results === undefined || (!Array.isArray(results.web) && !Array.isArray(results.news))) {
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "search",
      "You.com returned a malformed response",
      true,
    );
  }
  const webValues: unknown[] = Array.isArray(results.web)
    ? (results.web as unknown[])
    : [];
  const newsValues: unknown[] = Array.isArray(results.news)
    ? (results.news as unknown[])
    : [];
  const values: unknown[] = [...webValues, ...newsValues];
  const items: SearchResultItem[] = values.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    if (typeof item.title !== "string" || typeof item.url !== "string") return [];
    const snippets = Array.isArray(item.snippets)
      ? item.snippets.filter((entry): entry is string => typeof entry === "string")
      : [];
    const snippet =
      snippets.length > 0
        ? snippets.join("\n")
        : typeof item.description === "string"
          ? item.description
          : "";
    return [
      {
        title: item.title,
        url: item.url,
        snippet,
        ...(typeof item.page_age === "string" ? { publishedAt: item.page_age } : {}),
        provider: "you",
      },
    ];
  });
  return validateItems(items, validateUrl).then((results) => ({
    query: request.query,
    provider: "you",
    results,
    durationMs: Math.round(performance.now() - started),
    warnings: warning === undefined ? [] : [warning],
  }));
}

export class YouSearchProvider implements SearchProvider {
  readonly id = "you" as const;
  private readonly fetcher: FetchLike;
  private readonly validateUrl: UrlValidator;
  private readonly freeMcpSearch: YouFreeMcpSearch;

  constructor(private readonly options: YouOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? defaultUrlValidator;
    this.freeMcpSearch = options.freeMcpSearch ?? defaultFreeMcpSearch;
  }

  supports(request: SearchRequest): boolean {
    return !(request.domains?.length && request.excludeDomains?.length);
  }

  async search(request: SearchRequest, signal: AbortSignal): Promise<SearchResult> {
    assertSearchRequest(request);
    const started = performance.now();
    const apiKey = this.options.apiKey?.trim();
    if (apiKey === undefined || apiKey.length === 0) {
      const raw = await this.freeMcpSearch(request, signal);
      return normalizeYouResult(
        raw,
        request,
        started,
        this.validateUrl,
        "you.com free MCP profile used",
      );
    }
    const raw = await providerJson(
      this.fetcher,
      YOU_SEARCH_URL,
      {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(youRequestBody(request)),
      },
      signal,
    );
    return normalizeYouResult(raw, request, started, this.validateUrl, undefined);
  }
}
