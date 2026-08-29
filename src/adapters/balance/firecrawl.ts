import type { ProviderBalanceChecker, ProviderBalanceResult } from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import { balanceProviderJson, type BalanceFetchLike } from "./common.js";

const FIRECRAWL_CREDIT_USAGE_URL = "https://api.firecrawl.dev/v2/team/credit-usage";

export interface FirecrawlBalanceOptions {
  apiKey?: string;
  fetch?: BalanceFetchLike;
}

interface FirecrawlCreditUsageResponse {
  success?: unknown;
  data?: {
    remainingCredits?: unknown;
  };
}

export class FirecrawlBalanceChecker implements ProviderBalanceChecker {
  readonly id = "firecrawl" as const;
  private readonly fetcher: BalanceFetchLike;

  constructor(private readonly options: FirecrawlBalanceOptions = {}) {
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
        warnings: ["FIRECRAWL_API_KEY is not configured"],
      };
    }
    const raw = await balanceProviderJson(
      this.fetcher,
      FIRECRAWL_CREDIT_USAGE_URL,
      { method: "GET", headers: { authorization: `Bearer ${apiKey}` } },
      signal,
    );
    const response = raw as FirecrawlCreditUsageResponse;
    const remainingCredits =
      raw && typeof raw === "object" ? response.data?.remainingCredits : undefined;
    if (typeof remainingCredits !== "number" || !Number.isFinite(remainingCredits)) {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "provider_balance",
        "Firecrawl returned a malformed credit usage response",
        true,
      );
    }
    return {
      provider: this.id,
      configured: true,
      status: "available",
      source: "api",
      balance: remainingCredits,
      unit: "credits",
      warnings: [],
    };
  }
}
