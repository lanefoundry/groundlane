import type { SearchProviderId } from "./contracts.js";
import { GroundlaneError } from "./errors.js";

export interface SearchBudgetTracker {
  tryConsume(provider: SearchProviderId): boolean;
  remaining(provider: SearchProviderId): number | undefined;
}

function validateBudgets(
  budgets: Readonly<Partial<Record<string, number>>>,
  label: string,
): void {
  for (const value of Object.values(budgets)) {
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "search-budget",
        `${label} must be non-negative integers`,
      );
    }
  }
}

export class MonthlySearchBudget implements SearchBudgetTracker {
  private month: string;
  private readonly attempts = new Map<SearchProviderId, number>();

  constructor(
    private readonly budgets: Readonly<Partial<Record<SearchProviderId, number>>>,
    private readonly now: () => Date = () => new Date(),
  ) {
    validateBudgets(budgets, "Monthly search budgets");
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

export class DailySearchBudget implements SearchBudgetTracker {
  private day: string;
  private readonly attempts = new Map<SearchProviderId, number>();

  constructor(
    private readonly budgets: Readonly<Partial<Record<SearchProviderId, number>>>,
    private readonly now: () => Date = () => new Date(),
  ) {
    validateBudgets(budgets, "Daily search budgets");
    this.day = this.currentDay();
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

  private currentDay(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private resetIfNeeded(): void {
    const current = this.currentDay();
    if (current === this.day) return;
    this.day = current;
    this.attempts.clear();
  }
}

export class MinuteRateLimiter implements SearchBudgetTracker {
  private readonly timestamps = new Map<SearchProviderId, number[]>();

  constructor(
    private readonly limits: Readonly<Partial<Record<SearchProviderId, number>>>,
    private readonly now: () => number = () => Date.now(),
  ) {
    for (const value of Object.values(limits)) {
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 1) {
        throw new GroundlaneError(
          "INVALID_INPUT",
          "search-budget",
          "Per-minute rate limits must be positive integers",
        );
      }
    }
  }

  tryConsume(provider: SearchProviderId): boolean {
    const limit = this.limits[provider];
    if (limit === undefined) return true;
    this.prune(provider);
    const times = this.timestamps.get(provider) ?? [];
    if (times.length >= limit) return false;
    times.push(this.now());
    this.timestamps.set(provider, times);
    return true;
  }

  remaining(provider: SearchProviderId): number | undefined {
    const limit = this.limits[provider];
    if (limit === undefined) return undefined;
    this.prune(provider);
    const times = this.timestamps.get(provider) ?? [];
    return Math.max(0, limit - times.length);
  }

  private prune(provider: SearchProviderId): void {
    const times = this.timestamps.get(provider);
    if (times === undefined) return;
    const cutoff = this.now() - 60_000;
    const pruned = times.filter((t) => t > cutoff);
    if (pruned.length === 0) this.timestamps.delete(provider);
    else this.timestamps.set(provider, pruned);
  }
}

export class CompositeSearchBudget implements SearchBudgetTracker {
  constructor(private readonly trackers: readonly SearchBudgetTracker[]) {}

  tryConsume(provider: SearchProviderId): boolean {
    for (const tracker of this.trackers) {
      const r = tracker.remaining(provider);
      if (r !== undefined && r <= 0) return false;
    }
    for (const tracker of this.trackers) {
      tracker.tryConsume(provider);
    }
    return true;
  }

  remaining(provider: SearchProviderId): number | undefined {
    let min: number | undefined;
    for (const tracker of this.trackers) {
      const r = tracker.remaining(provider);
      if (r === undefined) continue;
      if (min === undefined || r < min) min = r;
    }
    return min;
  }
}
