export const MAX_DURABLE_METADATA_BYTES = 64 * 1024;
export const MAX_DURABLE_KEY_CHARS = 240;

export interface DurableRecord {
  readonly key: string;
  readonly value: string;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number | null;
}

export interface NewDurableRecord {
  readonly key: string;
  readonly value: string;
  readonly nowMs: number;
  readonly expiresAt?: number | null;
}

export interface DurableRecordUpdate {
  readonly value: string;
  readonly nowMs: number;
  readonly expiresAt?: number | null;
}

export type DurableCreateResult =
  | { readonly status: "created"; readonly record: DurableRecord }
  | { readonly status: "exists"; readonly record: DurableRecord };

export type DurableCasResult =
  | { readonly status: "updated"; readonly record: DurableRecord }
  | { readonly status: "conflict"; readonly record: DurableRecord }
  | { readonly status: "missing" };

export type DurableDeleteResult = "deleted" | "conflict" | "missing";

export interface DurableExpiredPage {
  readonly records: readonly DurableRecord[];
  readonly nextCursor: string | null;
}

export interface DurableRecordStorePort {
  get(key: string): Promise<DurableRecord | null>;
  createIfAbsent(record: NewDurableRecord): Promise<DurableCreateResult>;
  compareAndSwap(key: string, expectedRevision: number, update: DurableRecordUpdate): Promise<DurableCasResult>;
  deleteIfRevision(key: string, expectedRevision: number): Promise<DurableDeleteResult>;
  scanExpired(nowMs: number, cursor: string | null, limit: number): Promise<DurableExpiredPage>;
}

export function validateDurableKey(key: string): void {
  if (!key || key.length > MAX_DURABLE_KEY_CHARS || !/^[A-Za-z0-9._:-]+$/u.test(key)) {
    throw new Error("durable metadata key is invalid");
  }
}

export function validateDurableValue(value: string): void {
  if (new TextEncoder().encode(value).byteLength > MAX_DURABLE_METADATA_BYTES) {
    throw new Error("durable metadata exceeds the 64 KiB limit; store large content as an ArtifactRef");
  }
}

export function validateDurableWrite(input: NewDurableRecord | DurableRecordUpdate): void {
  validateDurableValue(input.value);
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) throw new Error("durable metadata timestamp is invalid");
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= input.nowMs)) {
    throw new Error("durable metadata expiry must be later than nowMs");
  }
}
