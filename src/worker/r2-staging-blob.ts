import type {
  R2BucketLike,
  R2ObjectBodyLike,
  R2ObjectLike,
} from "./r2-immutable-blob.js";

export const MAX_R2_STAGING_BLOB_BYTES = 10 * 1024 * 1024;

const STAGING_KEY_PATTERN = /^staging\/[A-Za-z0-9_-]{32,128}$/u;
const DIGEST_PATTERN = /^sha256-[a-f0-9]{64}$/u;
const MAX_INTENT_ID_CHARS = 160;
const MAX_OWNER_ID_CHARS = 160;
const MAX_CREDENTIAL_BINDING_CHARS = 256;
const MAX_MIME_CHARS = 128;

export interface R2StagingBlobBinding {
  readonly stagingKey: string;
  readonly intentId: string;
  readonly ownerId: string;
  readonly credentialBinding: string;
  readonly declaredMime: string;
  readonly declaredSize: number;
  readonly expiresAt: number;
}

export interface R2StagingBlobStat {
  readonly stagingKey: string;
  readonly intentId: string;
  readonly ownerId: string;
  readonly credentialBindingHash: string;
  readonly declaredMime: string;
  readonly declaredSize: number;
  readonly expiresAt: number;
  readonly digest: string | null;
}

export type R2StagingBlobPutResult =
  | { readonly status: "created"; readonly stat: R2StagingBlobStat }
  | { readonly status: "exists"; readonly stat: R2StagingBlobStat }
  | { readonly status: "conflict"; readonly stat: R2StagingBlobStat | null };

export interface R2StagingListObject extends R2ObjectLike {
  readonly key: string;
}

export interface R2StagingListResult {
  readonly objects: readonly R2StagingListObject[];
  readonly truncated: boolean;
  readonly cursor?: string | undefined;
}

type R2StagingBucketLike = Pick<R2BucketLike, "head" | "get" | "put" | "delete"> & {
  list?(options: {
    prefix?: string;
    cursor?: string;
    limit?: number;
    include?: ("httpMetadata" | "customMetadata")[];
  }): Promise<R2StagingListResult>;
};

export interface R2StagingCleanupPage {
  readonly scanned: number;
  readonly deleted: number;
  readonly failures: readonly string[];
  readonly nextCursor: string | null;
}

function assertBoundedText(
  value: string,
  maximum: number,
  field: string,
): void {
  if (value.length === 0 || value.length > maximum || value.trim() !== value) {
    throw new Error(`R2 staging blob ${field} is invalid`);
  }
}

function assertBinding(input: R2StagingBlobBinding): void {
  if (!STAGING_KEY_PATTERN.test(input.stagingKey)) {
    throw new Error("R2 staging blob key is invalid");
  }
  assertBoundedText(input.intentId, MAX_INTENT_ID_CHARS, "intent ID");
  assertBoundedText(input.ownerId, MAX_OWNER_ID_CHARS, "owner");
  assertBoundedText(
    input.credentialBinding,
    MAX_CREDENTIAL_BINDING_CHARS,
    "credential binding",
  );
  assertBoundedText(input.declaredMime, MAX_MIME_CHARS, "declared MIME type");
  if (!input.declaredMime.includes("/")) {
    throw new Error("R2 staging blob declared MIME type is invalid");
  }
  if (
    !Number.isSafeInteger(input.declaredSize) ||
    input.declaredSize < 1 ||
    input.declaredSize > MAX_R2_STAGING_BLOB_BYTES
  ) {
    throw new Error("R2 staging blob declared size is outside the supported bounds");
  }
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < 1) {
    throw new Error("R2 staging blob expiry is invalid");
  }
}

function parseInteger(value: string | undefined, field: string): number {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`R2 staging blob ${field} metadata is malformed`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`R2 staging blob ${field} metadata is malformed`);
  }
  return parsed;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const copied = new Uint8Array(bytes.byteLength);
  copied.set(bytes);
  return `sha256-${bytesToHex(await crypto.subtle.digest("SHA-256", copied.buffer))}`;
}

async function expectedStat(
  input: R2StagingBlobBinding,
  digest: string,
): Promise<R2StagingBlobStat> {
  return {
    stagingKey: input.stagingKey,
    intentId: input.intentId,
    ownerId: input.ownerId,
    credentialBindingHash: await sha256(input.credentialBinding),
    declaredMime: input.declaredMime,
    declaredSize: input.declaredSize,
    expiresAt: input.expiresAt,
    digest,
  };
}

function decodeStat(
  stagingKey: string,
  object: R2ObjectLike | null,
): R2StagingBlobStat | null {
  if (object === null) return null;
  if (!STAGING_KEY_PATTERN.test(stagingKey)) {
    throw new Error("R2 staging blob key is invalid");
  }
  const metadata = object.customMetadata;
  if (
    metadata?.["schema-version"] !== "1" ||
    metadata.kind !== "staging" ||
    metadata["intent-id"] === undefined ||
    metadata["owner-id"] === undefined ||
    metadata["credential-binding-hash"] === undefined ||
    metadata["declared-mime"] === undefined
  ) {
    throw new Error("R2 staging blob metadata is malformed");
  }
  assertBoundedText(metadata["intent-id"], MAX_INTENT_ID_CHARS, "intent ID");
  assertBoundedText(metadata["owner-id"], MAX_OWNER_ID_CHARS, "owner");
  assertBoundedText(metadata["declared-mime"], MAX_MIME_CHARS, "declared MIME type");
  if (!metadata["declared-mime"].includes("/") ||
      !(metadata.digest === undefined || DIGEST_PATTERN.test(metadata.digest))) {
    throw new Error("R2 staging blob metadata is malformed");
  }
  if (!DIGEST_PATTERN.test(metadata["credential-binding-hash"])) {
    throw new Error("R2 staging blob metadata is malformed");
  }
  const declaredSize = parseInteger(metadata["declared-size"], "declared size");
  const expiresAt = parseInteger(metadata["expires-at"], "expiry");
  if (
    declaredSize < 1 ||
    declaredSize > MAX_R2_STAGING_BLOB_BYTES ||
    object.size !== declaredSize ||
    expiresAt < 1
  ) {
    throw new Error("R2 staging blob metadata is malformed");
  }
  return {
    stagingKey,
    intentId: metadata["intent-id"],
    ownerId: metadata["owner-id"],
    credentialBindingHash: metadata["credential-binding-hash"],
    declaredMime: metadata["declared-mime"],
    declaredSize,
    expiresAt,
    digest: metadata.digest ?? null,
  };
}

function sameStat(left: R2StagingBlobStat, right: R2StagingBlobStat): boolean {
  return left.stagingKey === right.stagingKey &&
    left.intentId === right.intentId &&
    left.ownerId === right.ownerId &&
    left.credentialBindingHash === right.credentialBindingHash &&
    left.declaredMime === right.declaredMime &&
    left.declaredSize === right.declaredSize &&
    left.expiresAt === right.expiresAt &&
    left.digest === right.digest;
}

/** R2 staging storage with one conditional write and no raw credential metadata. */
export class R2StagingBlobStore {
  constructor(private readonly bucket: R2StagingBucketLike) {}

  async putOnce(
    input: R2StagingBlobBinding & { readonly bytes: Uint8Array },
  ): Promise<R2StagingBlobPutResult> {
    assertBinding(input);
    if (input.bytes.byteLength !== input.declaredSize) {
      throw new Error("R2 staging blob bytes do not match the declared size");
    }
    const digest = await sha256(input.bytes);
    const expected = await expectedStat(input, digest);
    const created = await this.bucket.put(input.stagingKey, input.bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      customMetadata: {
        "schema-version": "1",
        kind: "staging",
        "intent-id": input.intentId,
        "owner-id": input.ownerId,
        "credential-binding-hash": expected.credentialBindingHash,
        "declared-mime": input.declaredMime,
        "declared-size": String(input.declaredSize),
        "expires-at": String(input.expiresAt),
        digest,
      },
    });
    if (created !== null) {
      const stat = decodeStat(input.stagingKey, created);
      if (stat === null || !sameStat(stat, expected)) {
        throw new Error("R2 staging blob put returned mismatched metadata");
      }
      return { status: "created", stat };
    }
    const existing = decodeStat(input.stagingKey, await this.bucket.head(input.stagingKey));
    return existing !== null && sameStat(existing, expected)
      ? { status: "exists", stat: existing }
      : { status: "conflict", stat: existing };
  }

  async get(
    input: R2StagingBlobBinding & { readonly nowMs: number },
  ): Promise<Uint8Array | null> {
    assertBinding(input);
    if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
      throw new Error("R2 staging blob read time is invalid");
    }
    const object: R2ObjectBodyLike | null = await this.bucket.get(input.stagingKey);
    const stat = decodeStat(input.stagingKey, object);
    if (object === null || stat === null) return null;
    const expectedCredentialHash = await sha256(input.credentialBinding);
    if (
      stat.intentId !== input.intentId ||
      stat.ownerId !== input.ownerId ||
      stat.credentialBindingHash !== expectedCredentialHash ||
      stat.declaredMime !== input.declaredMime ||
      stat.declaredSize !== input.declaredSize ||
      stat.expiresAt !== input.expiresAt
    ) {
      throw new Error("R2 staging blob binding mismatch");
    }
    if (input.nowMs >= stat.expiresAt) {
      throw new Error("R2 staging blob has expired");
    }
    const bytes = await object.bytes();
    if (
      bytes.byteLength !== stat.declaredSize ||
      bytes.byteLength > MAX_R2_STAGING_BLOB_BYTES ||
      (stat.digest !== null && await sha256(bytes) !== stat.digest)
    ) {
      throw new Error("R2 staging blob integrity check failed");
    }
    return bytes;
  }

  async deleteIfIntent(
    stagingKey: string,
    intentId: string,
  ): Promise<"deleted" | "missing" | "intent_mismatch"> {
    if (!STAGING_KEY_PATTERN.test(stagingKey)) {
      throw new Error("R2 staging blob key is invalid");
    }
    assertBoundedText(intentId, MAX_INTENT_ID_CHARS, "intent ID");
    const stat = decodeStat(stagingKey, await this.bucket.head(stagingKey));
    if (stat === null) return "missing";
    if (stat.intentId !== intentId) return "intent_mismatch";
    await this.bucket.delete(stagingKey);
    return "deleted";
  }

  async cleanupExpiredPage(
    nowMs: number,
    cursor: string | null,
    limit: number,
  ): Promise<R2StagingCleanupPage> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("R2 staging cleanup time is invalid");
    if (cursor !== null && (cursor.length === 0 || cursor.length > 2_048)) {
      throw new Error("R2 staging cleanup cursor is invalid");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("R2 staging cleanup limit must be 1..100");
    }
    if (this.bucket.list === undefined) throw new Error("R2 staging cleanup listing is unavailable");
    const listed = await this.bucket.list({
      prefix: "staging/",
      ...(cursor === null ? {} : { cursor }),
      limit,
      include: ["customMetadata"],
    });
    const failures: string[] = [];
    let deleted = 0;
    for (const object of listed.objects) {
      try {
        const listedStat = decodeStat(object.key, object);
        if (listedStat === null || listedStat.expiresAt > nowMs) continue;
        const current = decodeStat(object.key, await this.bucket.head(object.key));
        if (current === null) continue;
        if (!sameStat(listedStat, current)) {
          failures.push(object.key);
          continue;
        }
        await this.bucket.delete(object.key);
        deleted += 1;
      } catch {
        failures.push(object.key);
      }
    }
    const nextCursor = listed.truncated ? (listed.cursor ?? null) : null;
    if (listed.truncated && (nextCursor === null || nextCursor === cursor)) {
      throw new Error("R2 staging cleanup returned an invalid cursor");
    }
    return { scanned: listed.objects.length, deleted, failures, nextCursor };
  }
}

export function createR2StagingBlobStore(bucket: R2Bucket): R2StagingBlobStore {
  return new R2StagingBlobStore(bucket);
}
