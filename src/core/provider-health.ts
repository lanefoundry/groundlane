import type { SearchProviderId } from "./contracts.js";

export interface ProviderHealthTracker {
  isHealthy(provider: SearchProviderId): boolean;
  recordSuccess(provider: SearchProviderId): void;
  recordFailure(provider: SearchProviderId): void;
  penalty(provider: SearchProviderId): number;
}

interface PenaltyEntry {
  score: number;
  lastUpdate: number;
}

interface CircuitState {
  consecutive: number;
  openUntil: number;
}

export interface HealthTrackerConfig {
  penaltyIncrement: number;
  decayPerMinute: number;
  circuitThreshold: number;
  circuitCooldownMs: number;
}

const DEFAULT_CONFIG: HealthTrackerConfig = {
  penaltyIncrement: 3,
  decayPerMinute: 1,
  circuitThreshold: 5,
  circuitCooldownMs: 60_000,
};

export class DynamicPenaltyHealthTracker implements ProviderHealthTracker {
  private readonly penalties = new Map<SearchProviderId, PenaltyEntry>();
  private readonly circuits = new Map<SearchProviderId, CircuitState>();
  private readonly config: HealthTrackerConfig;

  constructor(
    config?: Partial<HealthTrackerConfig>,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  isHealthy(provider: SearchProviderId): boolean {
    const state = this.circuits.get(provider);
    if (state === undefined) return true;
    if (state.consecutive < this.config.circuitThreshold) return true;
    if (this.now() >= state.openUntil) return true;
    return false;
  }

  recordSuccess(provider: SearchProviderId): void {
    this.circuits.delete(provider);
    const entry = this.penalties.get(provider);
    if (entry !== undefined) {
      const decayed = this.decayedScore(entry);
      entry.score = Math.max(0, decayed - 1);
      entry.lastUpdate = this.now();
      if (entry.score === 0) this.penalties.delete(provider);
    }
  }

  recordFailure(provider: SearchProviderId): void {
    const entry = this.penalties.get(provider) ?? {
      score: 0,
      lastUpdate: this.now(),
    };
    entry.score = this.decayedScore(entry) + this.config.penaltyIncrement;
    entry.lastUpdate = this.now();
    this.penalties.set(provider, entry);

    const state = this.circuits.get(provider) ?? {
      consecutive: 0,
      openUntil: 0,
    };
    if (state.openUntil > 0 && this.now() >= state.openUntil) {
      state.consecutive = this.config.circuitThreshold;
    } else {
      state.consecutive += 1;
    }
    if (state.consecutive >= this.config.circuitThreshold) {
      state.openUntil = this.now() + this.config.circuitCooldownMs;
    }
    this.circuits.set(provider, state);
  }

  penalty(provider: SearchProviderId): number {
    const entry = this.penalties.get(provider);
    if (entry === undefined) return 0;
    return Math.max(0, this.decayedScore(entry));
  }

  private decayedScore(entry: PenaltyEntry): number {
    const elapsedMinutes = (this.now() - entry.lastUpdate) / 60_000;
    return Math.max(
      0,
      entry.score - elapsedMinutes * this.config.decayPerMinute,
    );
  }
}
