import type { ProviderBalanceChecker, ProviderBalanceResult } from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import { balanceProviderJson, type BalanceFetchLike } from "./common.js";

const LINKUP_BALANCE_URL = "https://api.linkup.so/v1/credits/balance";

export interface LinkupBalanceOptions {
  apiKey?: string;
  fetch?: BalanceFetchLike;
}

export class LinkupBalanceChecker implements ProviderBalanceChecker {
  readonly id = "linkup" as const;
  private readonly fetcher: BalanceFetchLike;

  constructor(private readonly options: LinkupBalanceOptions = {}) {
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
        warnings: ["LINKUP_API_KEY is not configured"],
      };
    }
    const raw = await balanceProviderJson(
      this.fetcher,
      LINKUP_BALANCE_URL,
      { method: "GET", headers: { authorization: `Bearer ${apiKey}` } },
      signal,
    );
    const balance =
      raw && typeof raw === "object" ? (raw as { balance?: unknown }).balance : undefined;
    if (typeof balance !== "number" || !Number.isFinite(balance)) {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "provider_balance",
        "Linkup returned a malformed balance response",
        true,
      );
    }
    return {
      provider: this.id,
      configured: true,
      status: "available",
      source: "api",
      balance,
      unit: "credits",
      warnings: [],
    };
  }
}
