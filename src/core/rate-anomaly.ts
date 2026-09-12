export interface RateAnomalyOptions {
  readonly windowMs: number;
  readonly maxCallsPerWindow: number;
  readonly maxCallsPerToolPerWindow: number;
}

export interface AnomalyCheckResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly callsInWindow: number;
  readonly limit: number;
}

interface CredentialWindow {
  timestamps: number[];
  byTool: Map<string, number[]>;
}

const DEFAULT_OPTIONS: RateAnomalyOptions = {
  windowMs: 60_000,
  maxCallsPerWindow: 100,
  maxCallsPerToolPerWindow: 30,
};

export class RateAnomalyDetector {
  private readonly options: RateAnomalyOptions;
  private readonly windows = new Map<string, CredentialWindow>();

  constructor(options?: Partial<RateAnomalyOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  record(credentialBinding: string, toolName: string): AnomalyCheckResult {
    const now = Date.now();
    const cutoff = now - this.options.windowMs;

    let window = this.windows.get(credentialBinding);
    if (window === undefined) {
      window = { timestamps: [], byTool: new Map() };
      this.windows.set(credentialBinding, window);
    }

    window.timestamps = window.timestamps.filter((t) => t > cutoff);
    window.timestamps.push(now);

    let toolTimestamps = window.byTool.get(toolName);
    if (toolTimestamps === undefined) {
      toolTimestamps = [];
      window.byTool.set(toolName, toolTimestamps);
    }
    const filtered = toolTimestamps.filter((t) => t > cutoff);
    filtered.push(now);
    window.byTool.set(toolName, filtered);

    if (window.timestamps.length > this.options.maxCallsPerWindow) {
      return {
        allowed: false,
        reason: `Credential made ${String(window.timestamps.length)} calls in ${String(this.options.windowMs / 1000)}s (limit: ${String(this.options.maxCallsPerWindow)})`,
        callsInWindow: window.timestamps.length,
        limit: this.options.maxCallsPerWindow,
      };
    }

    if (filtered.length > this.options.maxCallsPerToolPerWindow) {
      return {
        allowed: false,
        reason: `Credential made ${String(filtered.length)} calls to ${toolName} in ${String(this.options.windowMs / 1000)}s (limit: ${String(this.options.maxCallsPerToolPerWindow)})`,
        callsInWindow: filtered.length,
        limit: this.options.maxCallsPerToolPerWindow,
      };
    }

    return {
      allowed: true,
      callsInWindow: window.timestamps.length,
      limit: this.options.maxCallsPerWindow,
    };
  }
}
