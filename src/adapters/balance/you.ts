import type { ProviderBalanceChecker, ProviderBalanceResult } from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import { balanceProviderJson, type BalanceFetchLike } from "./common.js";

const YOU_BALANCE_URL = "https://api.you.com/v1/billing/account_balance";

export interface YouBalanceOptions {
  apiKey?: string;
  fetch?: BalanceFetchLike;
}

export class YouBalanceChecker implements ProviderBalanceChecker {
  readonly id = "you" as const;
  private readonly fetcher: BalanceFetchLike;

  constructor(private readonly options: YouBalanceOptions = {}) {
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
        warnings: ["YOU_API_KEY is not configured; keyless MCP daily quota has no account balance API"],
      };
    }
    const raw = await balanceProviderJson(
      this.fetcher,
      YOU_BALANCE_URL,
      { method: "GET", headers: { "x-api-key": apiKey } },
      signal,
    );
    const balance =
      raw && typeof raw === "object"
        ? (raw as { data?: { attributes?: { balance?: unknown } } }).data?.attributes?.balance
        : undefined;
    if (typeof balance !== "number" || !Number.isFinite(balance)) {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "provider_balance",
        "You.com returned a malformed balance response",
        true,
      );
    }
    return {
      provider: this.id,
      configured: true,
      status: "available",
      source: "api",
      balance,
      currency: "USD",
      unit: "cents",
      warnings: [],
    };
  }
}
