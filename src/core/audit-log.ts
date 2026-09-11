import { createHash } from "node:crypto";

export interface AuditEntry {
  readonly timestamp: string;
  readonly tool: string;
  readonly inputHash: string;
  readonly durationMs: number;
  readonly status: "ok" | "error";
  readonly errorCode?: string;
}

export interface AuditLogSink {
  append(entry: AuditEntry): void;
}

export class InMemoryAuditLog implements AuditLogSink {
  private readonly entries: AuditEntry[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = 10_000) {
    this.maxEntries = maxEntries;
  }

  append(entry: AuditEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  recent(limit = 100): readonly AuditEntry[] {
    return this.entries.slice(-limit);
  }

  count(): number {
    return this.entries.length;
  }

  countByTool(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const entry of this.entries) {
      counts[entry.tool] = (counts[entry.tool] ?? 0) + 1;
    }
    return counts;
  }

  countByStatus(): { ok: number; error: number } {
    let ok = 0;
    let error = 0;
    for (const entry of this.entries) {
      if (entry.status === "ok") ok += 1;
      else error += 1;
    }
    return { ok, error };
  }
}

export function hashInput(input: unknown): string {
  const json = JSON.stringify(input ?? {});
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}
