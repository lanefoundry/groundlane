import type {
  ProviderBalanceChecker,
  ProviderBalanceResult,
  SearchProviderId,
} from "./contracts.js";

export interface ProviderBalanceRegistryOptions {
  checkers: readonly ProviderBalanceChecker[];
  supportedProviders: readonly SearchProviderId[];
  configuredProviders?: readonly SearchProviderId[];
}

export class ProviderBalanceRegistry {
  private readonly checkers: ReadonlyMap<SearchProviderId, ProviderBalanceChecker>;
  private readonly configuredProviders: ReadonlySet<SearchProviderId>;

  constructor(private readonly options: ProviderBalanceRegistryOptions) {
    this.checkers = new Map(options.checkers.map((checker) => [checker.id, checker]));
    this.configuredProviders = new Set(options.configuredProviders ?? []);
  }

  providers(): SearchProviderId[] {
    return [...this.options.supportedProviders];
  }

  async getBalance(
    provider: SearchProviderId,
    signal: AbortSignal,
  ): Promise<ProviderBalanceResult> {
    const checker = this.checkers.get(provider);
    if (checker === undefined) {
      return {
        provider,
        configured: this.configuredProviders.has(provider),
        status: "unsupported",
        source: "not_implemented",
        warnings: ["Provider does not expose a Groundlane balance checker"],
      };
    }
    return checker.getBalance(signal);
  }

  async getBalances(
    providers: readonly SearchProviderId[],
    signal: AbortSignal,
  ): Promise<ProviderBalanceResult[]> {
    const results: ProviderBalanceResult[] = [];
    for (const provider of providers) {
      results.push(await this.getBalance(provider, signal));
    }
    return results;
  }
}
