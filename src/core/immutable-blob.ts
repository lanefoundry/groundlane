export const MAX_IMMUTABLE_BLOB_BYTES = 32 * 1024 * 1024;

export interface ImmutableBlobStat {
  readonly blobKey: string;
  readonly ownerId: string;
  readonly digest: string;
  readonly byteSize: number;
}

export type ImmutableBlobPutResult =
  | { readonly status: "created"; readonly stat: ImmutableBlobStat }
  | { readonly status: "exists"; readonly stat: ImmutableBlobStat }
  | { readonly status: "conflict"; readonly stat: ImmutableBlobStat | null };

export interface ImmutableBlobPort {
  putIfAbsent(input: { blobKey: string; ownerId: string; digest: string; bytes: Uint8Array }): Promise<ImmutableBlobPutResult>;
  stat(blobKey: string): Promise<ImmutableBlobStat | null>;
  get(input: { blobKey: string; ownerId: string; digest: string; maxBytes: number }): Promise<Uint8Array | null>;
  deleteIfOwner(blobKey: string, ownerId: string): Promise<"deleted" | "missing" | "owner_mismatch">;
}

export function validateInternalBlobKey(blobKey: string): void {
  if (!/^blobs\/[a-f0-9]{64}$/u.test(blobKey)) throw new Error("internal blob key is invalid");
}

export function validateBlobIdentity(ownerId: string, digest: string): void {
  if (!ownerId || ownerId.length > 160) throw new Error("blob owner is invalid");
  if (!/^sha256-[a-f0-9]{64}$/u.test(digest)) throw new Error("blob digest is invalid");
}
