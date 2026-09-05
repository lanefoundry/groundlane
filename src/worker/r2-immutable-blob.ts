import {
  MAX_IMMUTABLE_BLOB_BYTES,
  validateBlobIdentity,
  validateInternalBlobKey,
  type ImmutableBlobPort,
  type ImmutableBlobPutResult,
  type ImmutableBlobStat,
} from "../core/immutable-blob.js";

export interface R2ObjectLike {
  readonly size: number;
  readonly customMetadata?: Record<string, string>;
}

export interface R2ObjectBodyLike extends R2ObjectLike {
  bytes(): Promise<Uint8Array>;
}

export interface R2BucketLike {
  head(key: string): Promise<R2ObjectLike | null>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(key: string, value: Uint8Array, options: { onlyIf: { etagDoesNotMatch: string }; customMetadata: Record<string, string> }): Promise<R2ObjectLike | null>;
  delete(key: string): Promise<void>;
}

function decodeStat(blobKey: string, object: R2ObjectLike | null): ImmutableBlobStat | null {
  if (object === null) return null;
  const ownerId = object.customMetadata?.ownerId;
  const digest = object.customMetadata?.digest;
  if (object.customMetadata?.schemaVersion !== "1" || ownerId === undefined || digest === undefined) {
    throw new Error("R2 immutable blob metadata is malformed");
  }
  validateBlobIdentity(ownerId, digest);
  if (!Number.isSafeInteger(object.size) || object.size < 1 || object.size > MAX_IMMUTABLE_BLOB_BYTES) {
    throw new Error("R2 immutable blob size is outside the supported bounds");
  }
  return { blobKey, ownerId, digest, byteSize: object.size };
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", digestInput.buffer);
  return `sha256-${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/** Cloudflare binding adapter. Public ArtifactRefs map to these internal keys in durable metadata. */
export class R2ImmutableBlobStore implements ImmutableBlobPort {
  constructor(private readonly bucket: R2BucketLike) {}

  async putIfAbsent(input: { blobKey: string; ownerId: string; digest: string; bytes: Uint8Array }): Promise<ImmutableBlobPutResult> {
    validateInternalBlobKey(input.blobKey);
    validateBlobIdentity(input.ownerId, input.digest);
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_IMMUTABLE_BLOB_BYTES) throw new Error("immutable blob size is outside the supported bounds");
    if (await digestBytes(input.bytes) !== input.digest) throw new Error("immutable blob digest mismatch");
    const created = await this.bucket.put(input.blobKey, input.bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      customMetadata: { schemaVersion: "1", ownerId: input.ownerId, digest: input.digest },
    });
    if (created !== null) {
      const stat = decodeStat(input.blobKey, created);
      if (stat === null) throw new Error("R2 immutable blob put returned no metadata");
      return { status: "created", stat };
    }
    const existing = await this.stat(input.blobKey);
    return existing !== null && existing.ownerId === input.ownerId && existing.digest === input.digest && existing.byteSize === input.bytes.byteLength
      ? { status: "exists", stat: existing }
      : { status: "conflict", stat: existing };
  }

  async stat(blobKey: string): Promise<ImmutableBlobStat | null> {
    validateInternalBlobKey(blobKey);
    return decodeStat(blobKey, await this.bucket.head(blobKey));
  }

  async get(input: { blobKey: string; ownerId: string; digest: string; maxBytes: number }): Promise<Uint8Array | null> {
    validateInternalBlobKey(input.blobKey);
    validateBlobIdentity(input.ownerId, input.digest);
    if (!Number.isInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > MAX_IMMUTABLE_BLOB_BYTES) throw new Error("immutable blob read limit is invalid");
    const object = await this.bucket.get(input.blobKey);
    const stat = decodeStat(input.blobKey, object);
    if (object === null || stat === null) return null;
    if (stat.ownerId !== input.ownerId || stat.digest !== input.digest) throw new Error("immutable blob owner or digest mismatch");
    if (stat.byteSize > input.maxBytes) throw new Error("immutable blob exceeds the read limit");
    const bytes = await object.bytes();
    if (bytes.byteLength !== stat.byteSize || await digestBytes(bytes) !== stat.digest) throw new Error("immutable blob integrity check failed");
    return bytes;
  }

  async deleteIfOwner(blobKey: string, ownerId: string): Promise<"deleted" | "missing" | "owner_mismatch"> {
    validateInternalBlobKey(blobKey);
    const stat = await this.stat(blobKey);
    if (stat === null) return "missing";
    if (stat.ownerId !== ownerId) return "owner_mismatch";
    await this.bucket.delete(blobKey);
    return "deleted";
  }
}

/** Compile-time guard that the generated Cloudflare binding satisfies the adapter surface. */
export function createR2ImmutableBlobStore(bucket: R2Bucket): R2ImmutableBlobStore {
  return new R2ImmutableBlobStore(bucket);
}
