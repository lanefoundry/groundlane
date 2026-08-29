import type { SearchProviderId } from "./contracts.js";
import { GroundlaneError } from "./errors.js";

export type SearchBudgetPeriod = "monthly" | "daily" | "minute";

export interface SearchBudgetSnapshot {
  period: SearchBudgetPeriod;
  provider: SearchProviderId;
  limited: boolean;
  limit?: number;
  used: number;
  remaining?: number;
  exhausted: boolean;
  resetAt?: string;
}

export interface SearchBudgetTracker {
  tryConsume(provider: SearchProviderId): boolean;
  remaining(provider: SearchProviderId): number | undefined;
  snapshots?(providers: readonly SearchProviderId[]): readonly SearchBudgetSnapshot[];
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

  snapshots(providers: readonly SearchProviderId[]): readonly SearchBudgetSnapshot[] {
    this.resetIfNeeded();
    return providers.map((provider) => {
      const limit = this.budgets[provider];
      const used = this.attempts.get(provider) ?? 0;
      if (limit === undefined) {
        return {
          period: "monthly",
          provider,
          limited: false,
          used,
          exhausted: false,
          resetAt: this.nextResetAt(),
        };
      }
      return {
        period: "monthly",
        provider,
        limited: true,
        limit,
        used,
        remaining: Math.max(0, limit - used),
        exhausted: used >= limit,
        resetAt: this.nextResetAt(),
      };
    });
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

  private nextResetAt(): string {
    const date = this.now();
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();
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

  snapshots(providers: readonly SearchProviderId[]): readonly SearchBudgetSnapshot[] {
    this.resetIfNeeded();
    return providers.map((provider) => {
      const limit = this.budgets[provider];
      const used = this.attempts.get(provider) ?? 0;
      if (limit === undefined) {
        return {
          period: "daily",
          provider,
          limited: false,
          used,
          exhausted: false,
          resetAt: this.nextResetAt(),
        };
      }
      return {
        period: "daily",
        provider,
        limited: true,
        limit,
        used,
        remaining: Math.max(0, limit - used),
        exhausted: used >= limit,
        resetAt: this.nextResetAt(),
      };
    });
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

  private nextResetAt(): string {
    const date = this.now();
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)).toISOString();
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

  snapshots(providers: readonly SearchProviderId[]): readonly SearchBudgetSnapshot[] {
    return providers.map((provider) => {
      const limit = this.limits[provider];
      if (limit === undefined) {
        return {
          period: "minute",
          provider,
          limited: false,
          used: 0,
          exhausted: false,
        };
      }
      this.prune(provider);
      const used = this.timestamps.get(provider)?.length ?? 0;
      return {
        period: "minute",
        provider,
        limited: true,
        limit,
        used,
        remaining: Math.max(0, limit - used),
        exhausted: used >= limit,
      };
    });
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

  snapshots(providers: readonly SearchProviderId[]): readonly SearchBudgetSnapshot[] {
    return this.trackers.flatMap((tracker) => tracker.snapshots?.(providers) ?? []);
  }
}
