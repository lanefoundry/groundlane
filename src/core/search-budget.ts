import type { SearchProviderId } from "./contracts.js";
import { GroundlaneError } from "./errors.js";

export interface SearchBudgetTracker {
  tryConsume(provider: SearchProviderId): boolean;
  remaining(provider: SearchProviderId): number | undefined;
}

export class MonthlySearchBudget implements SearchBudgetTracker {
  private month: string;
  private readonly attempts = new Map<SearchProviderId, number>();

  constructor(
    private readonly budgets: Readonly<Partial<Record<SearchProviderId, number>>>,
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const value of Object.values(budgets)) {
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 0) {
        throw new GroundlaneError(
          "INVALID_INPUT",
          "search-budget",
          "Monthly search budgets must be non-negative integers",
        );
      }
    }
    this.month = this.currentMonth();
  }

  tryConsume(provider: SearchProviderId): boolean {
    this.resetIfNeeded();
    const budget = this.budgets[provider];
    if (budget === undefined) return true;
    const used = this.attempts.get(provider) ?? 0;
    if (used >= budget) return false;
    this.attempts.set(provider, used + 1);
    return true;
  }

  remaining(provider: SearchProviderId): number | undefined {
    this.resetIfNeeded();
    const budget = this.budgets[provider];
    if (budget === undefined) return undefined;
    return Math.max(0, budget - (this.attempts.get(provider) ?? 0));
  }

  private currentMonth(): string {
    const date = this.now();
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  private resetIfNeeded(): void {
    const current = this.currentMonth();
    if (current === this.month) return;
    this.month = current;
    this.attempts.clear();
  }
}
