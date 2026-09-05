import type { DurableRecord, DurableRecordStorePort } from "./durable-store.js";

export type DurableEffectKind = "provider_task_create" | "paid_upstream_call" | "artifact_write";
export type DurableEffectStatus = "claimed" | "inflight" | "succeeded" | "uncertain";

export interface DurableEffect {
  readonly schemaVersion: "1";
  readonly jobId: string;
  readonly effectKind: DurableEffectKind;
  readonly operationKey: string;
  readonly status: DurableEffectStatus;
  readonly claimedAt: number;
  readonly updatedAt: number;
  readonly receipt: string | null;
}

export type EffectClaimResult =
  | { readonly status: "claimed"; readonly effect: DurableEffect; readonly revision: number }
  | { readonly status: "existing"; readonly effect: DurableEffect; readonly revision: number };

function keyFor(jobId: string, effectKind: DurableEffectKind, operationKey: string): string {
  const safe = `${jobId}:${effectKind}:${operationKey}`;
  if (!/^[A-Za-z0-9._:-]+$/u.test(safe) || safe.length > 220) throw new Error("durable effect identity is invalid");
  return `effect:${safe}`;
}

function encode(effect: DurableEffect): string {
  return JSON.stringify(effect);
}

function decode(record: DurableRecord): DurableEffect {
  let value: unknown;
  try { value = JSON.parse(record.value) as unknown; } catch { throw new Error("durable effect record is malformed"); }
  if (typeof value !== "object" || value === null) throw new Error("durable effect record is malformed");
  const item = value as Partial<DurableEffect>;
  if (
    item.schemaVersion !== "1" || typeof item.jobId !== "string" || typeof item.operationKey !== "string" ||
    !["provider_task_create", "paid_upstream_call", "artifact_write"].includes(item.effectKind ?? "") ||
    !["claimed", "inflight", "succeeded", "uncertain"].includes(item.status ?? "") ||
    typeof item.claimedAt !== "number" || typeof item.updatedAt !== "number" ||
    !(item.receipt === null || typeof item.receipt === "string")
  ) throw new Error("durable effect record is malformed");
  return item as DurableEffect;
}

export class DurableEffectJournal {
  constructor(private readonly store: DurableRecordStorePort) {}

  async claim(jobId: string, effectKind: DurableEffectKind, operationKey: string, nowMs: number): Promise<EffectClaimResult> {
    const key = keyFor(jobId, effectKind, operationKey);
    const effect: DurableEffect = { schemaVersion: "1", jobId, effectKind, operationKey, status: "claimed", claimedAt: nowMs, updatedAt: nowMs, receipt: null };
    const result = await this.store.createIfAbsent({ key, value: encode(effect), nowMs });
    return result.status === "created"
      ? { status: "claimed", effect, revision: result.record.revision }
      : { status: "existing", effect: decode(result.record), revision: result.record.revision };
  }

  async transition(identity: { jobId: string; effectKind: DurableEffectKind; operationKey: string }, expectedRevision: number, status: Exclude<DurableEffectStatus, "claimed">, nowMs: number, receipt: string | null = null): Promise<{ effect: DurableEffect; revision: number }> {
    const key = keyFor(identity.jobId, identity.effectKind, identity.operationKey);
    const current = await this.store.get(key);
    if (current === null) throw new Error("durable effect claim is missing");
    const previous = decode(current);
    if (previous.status === "succeeded" && status !== "succeeded") throw new Error("a succeeded durable effect is terminal");
    const next: DurableEffect = { ...previous, status, updatedAt: nowMs, receipt };
    const result = await this.store.compareAndSwap(key, expectedRevision, { value: encode(next), nowMs });
    if (result.status !== "updated") throw new Error("durable effect revision conflict");
    return { effect: next, revision: result.record.revision };
  }
}
