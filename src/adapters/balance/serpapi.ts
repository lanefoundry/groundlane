import type { ProviderBalanceChecker, ProviderBalanceResult } from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import { balanceProviderJson, type BalanceFetchLike } from "./common.js";

const SERPAPI_ACCOUNT_URL = "https://serpapi.com/account.json";

export interface SerpApiBalanceOptions {
  apiKey?: string;
  fetch?: BalanceFetchLike;
}

interface SerpApiAccountResponse {
  total_searches_left?: unknown;
  plan_searches_left?: unknown;
  extra_credits?: unknown;
}

function firstFiniteNumber(values: readonly unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

export class SerpApiBalanceChecker implements ProviderBalanceChecker {
  readonly id = "serpapi" as const;
  private readonly fetcher: BalanceFetchLike;

  constructor(private readonly options: SerpApiBalanceOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  configured(): boolean {
    return (this.options.apiKey?.trim().length ?? 0) > 0;
  }

  async getBalance(signal: AbortSignal): Promise<ProviderBalanceResult> {
    const apiKey = this.options.apiKey?.trim();
    if (apiKey === undefined || apiKey.length === 0) {
      return {
        provider: this.id,
        configured: false,
        status: "not_configured",
        source: "not_configured",
        warnings: ["SERPAPI_API_KEY is not configured"],
      };
    }
    const url = new URL(SERPAPI_ACCOUNT_URL);
    url.searchParams.set("api_key", apiKey);
    const raw = await balanceProviderJson(
      this.fetcher,
      url.toString(),
      { method: "GET" },
      signal,
    );
    const response = raw as SerpApiAccountResponse;
    const balance =
      raw && typeof raw === "object"
        ? firstFiniteNumber([
            response.total_searches_left,
            response.plan_searches_left,
            response.extra_credits,
          ])
        : undefined;
    if (balance === undefined) {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "provider_balance",
        "SerpApi returned a malformed account response",
        true,
      );
    }
    return {
      provider: this.id,
      configured: true,
      status: "available",
      source: "api",
      balance,
      unit: "requests",
      warnings: [],
    };
  }
}
