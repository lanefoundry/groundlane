import {
  createManagedPrincipal,
  parseBearerToken,
  timingSafeTokenEqual,
  type AuthenticatedPrincipal,
  type TimingSafeSubtleCrypto,
} from "./auth.js";

export const MANAGED_TOKEN_PREFIX = "glmt_";
export const DEFAULT_OVERLAP_SECONDS = 3600;
export const MIN_OVERLAP_SECONDS = 0;
export const MAX_OVERLAP_SECONDS = 86400;
export const MIN_SECRET_BYTES = 32;
export const MAX_CREDENTIAL_ID_LENGTH = 64;
export const MAX_LABEL_LENGTH = 64;
export const MAX_SCOPES = 16;
export const MAX_SCOPE_LENGTH = 64;
export const MAX_LIST_LIMIT = 100;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_AUDIT_RECORDS = 500;
export const MAX_IDEMPOTENCY_KEYS = 200;
export const ID_COLLISION_RETRY_MAX = 5;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

export type ManagedStoredStatus = "active" | "rotating" | "revoked" | "disabled";
export type ManagedEffectiveStatus =
  | "active"
  | "rotating"
  | "expired"
  | "rotation_expired"
  | "revoked"
  | "disabled";

export interface ManagedCredentialRecord {
  readonly id: string;
  /** Hex SHA-256 of the raw secret. Never the raw secret itself. */
  readonly verifier: string;
  readonly principalId: "owner";
  readonly scopes: readonly string[];
  readonly label: string;
  readonly status: ManagedStoredStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
  readonly validUntil?: number;
  readonly rotatedTo?: string;
  readonly rotatedFrom?: string;
  readonly revokedAt?: number;
}

export interface ManagedCredentialMetadata {
  readonly id: string;
  readonly principalId: "owner";
  readonly scopes: readonly string[];
  readonly label: string;
  readonly status: ManagedStoredStatus;
  readonly effectiveStatus: ManagedEffectiveStatus;
  readonly usable: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
  readonly validUntil?: number;
  readonly rotatedTo?: string;
  readonly rotatedFrom?: string;
  readonly revokedAt?: number;
}

export interface ManagedClock {
  now(): number;
}

export function systemUtcClock(): ManagedClock {
  return { now: () => Date.now() };
}

/** Deterministic fake clock for boundary tests (server UTC ms). */
export class FakeClock implements ManagedClock {
  private t: number;
  constructor(startMs: number) {
    this.t = startMs;
  }
  now(): number {
    return this.t;
  }
  set(ms: number): void {
    this.t = ms;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export type RandomBytes = (byteLength: number) => Uint8Array;

export function defaultRandomBytes(byteLength: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(byteLength));
}

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function encodeBase64Url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1] as number;
    const c = bytes[i + 2] as number;
    const n = (a << 16) | (b << 8) | c;
    out += BASE64URL_ALPHABET[(n >>> 18) & 63];
    out += BASE64URL_ALPHABET[(n >>> 12) & 63];
    out += BASE64URL_ALPHABET[(n >>> 6) & 63];
    out += BASE64URL_ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const a = bytes[i] as number;
    const n = a << 16;
    out += BASE64URL_ALPHABET[(n >>> 18) & 63];
    out += BASE64URL_ALPHABET[(n >>> 12) & 63];
  } else if (rest === 2) {
    const a = bytes[i] as number;
    const b = bytes[i + 1] as number;
    const n = (a << 16) | (b << 8);
    out += BASE64URL_ALPHABET[(n >>> 18) & 63];
    out += BASE64URL_ALPHABET[(n >>> 12) & 63];
    out += BASE64URL_ALPHABET[(n >>> 6) & 63];
  }
  return out;
}

function bytesToHex(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let out = "";
  for (const b of view) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

export async function computeVerifier(
  rawSecret: string,
  subtle: TimingSafeSubtleCrypto,
): Promise<string> {
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(rawSecret));
  return bytesToHex(digest);
}

export async function fingerprintForAudit(
  value: string,
  subtle: TimingSafeSubtleCrypto,
): Promise<string> {
  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`groundlane-admin-fingerprint:${value}`),
  );
  return `sha256:${bytesToHex(digest).slice(0, 16)}`;
}

const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/u;

export function isValidCredentialId(id: string): boolean {
  return CREDENTIAL_ID_PATTERN.test(id);
}

export function generateCredentialId(random: RandomBytes): string {
  const bytes = random(12);
  return `cred_${encodeBase64Url(bytes).slice(0, 16)}`;
}

export function generateRawSecret(random: RandomBytes): string {
  return encodeBase64Url(random(MIN_SECRET_BYTES));
}

export function formatManagedToken(id: string, rawSecret: string): string {
  return `${MANAGED_TOKEN_PREFIX}${id}_${rawSecret}`;
}

export function isManagedTokenFormat(token: string): boolean {
  return token.startsWith(MANAGED_TOKEN_PREFIX);
}

export function parseManagedToken(
  rawToken: string,
): { id: string; secret: string } | null {
  if (!rawToken.startsWith(MANAGED_TOKEN_PREFIX)) return null;
  const rest = rawToken.slice(MANAGED_TOKEN_PREFIX.length);
  const sep = rest.lastIndexOf("_");
  if (sep <= 0 || sep + 1 >= rest.length) return null;
  const id = rest.slice(0, sep);
  const secret = rest.slice(sep + 1);
  if (!isValidCredentialId(id)) return null;
  if (secret.length < 43 || secret.length > 128) return null;
  if (!/^[A-Za-z0-9_-]+$/u.test(secret)) return null;
  return { id, secret };
}

export function parseManagedTokenFromHeader(
  authorization: string | null,
): { id: string; secret: string } | null {
  const token = parseBearerToken(authorization);
  if (token === undefined) return null;
  return parseManagedToken(token);
}

export function parseOverlapSeconds(input: unknown): number {
  if (typeof input !== "number" || !Number.isInteger(input)) {
    throw new ManagedTokenError("validation", "overlapSeconds must be an integer 0..86400");
  }
  if (input < MIN_OVERLAP_SECONDS || input > MAX_OVERLAP_SECONDS) {
    throw new ManagedTokenError("validation", "overlapSeconds must be an integer 0..86400");
  }
  return input;
}

export function normalizeOverlapSeconds(input: unknown): number {
  if (input === undefined) return DEFAULT_OVERLAP_SECONDS;
  return parseOverlapSeconds(input);
}

export function validateScopes(scopes: unknown): readonly string[] {
  if (scopes === undefined) return ["mcp"];
  if (!Array.isArray(scopes)) {
    throw new ManagedTokenError("validation", "scopes must be an array");
  }
  if (scopes.length > MAX_SCOPES) {
    throw new ManagedTokenError("validation", "too many scopes");
  }
  const out: string[] = [];
  for (const entry of scopes) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > MAX_SCOPE_LENGTH) {
      throw new ManagedTokenError("validation", "invalid scope entry");
    }
    if (!/^[A-Za-z0-9:_-]+$/u.test(entry)) {
      throw new ManagedTokenError("validation", "invalid scope entry");
    }
    out.push(entry);
  }
  return out;
}

export function validateLabel(label: unknown): string {
  if (label === undefined) return "";
  if (typeof label !== "string" || label.length > MAX_LABEL_LENGTH) {
    throw new ManagedTokenError("validation", "invalid label");
  }
  return label;
}

export function validateIdempotencyKey(key: unknown): string | undefined {
  if (key === undefined) return undefined;
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(key)
  ) {
    throw new ManagedTokenError("validation", "invalid idempotency key");
  }
  return key;
}

export class ManagedTokenError extends Error {
  readonly code:
    | "validation"
    | "not_found"
    | "conflict"
    | "duplicate_id"
    | "storage_unavailable";
  constructor(
    code: "validation" | "not_found" | "conflict" | "duplicate_id" | "storage_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "ManagedTokenError";
    this.code = code;
  }
}

export function getEffectiveStatus(
  record: Pick<ManagedCredentialRecord, "status" | "expiresAt" | "validUntil">,
  now: number,
): { effectiveStatus: ManagedEffectiveStatus; usable: boolean } {
  if (record.status === "revoked") return { effectiveStatus: "revoked", usable: false };
  if (record.status === "disabled") return { effectiveStatus: "disabled", usable: false };
  if (record.status === "active") {
    if (now < record.expiresAt) return { effectiveStatus: "active", usable: true };
    return { effectiveStatus: "expired", usable: false };
  }
  // rotating
  const validUntil = record.validUntil;
  if (validUntil === undefined) return { effectiveStatus: "rotation_expired", usable: false };
  const floor = Math.min(validUntil, record.expiresAt);
  if (now < floor) return { effectiveStatus: "rotating", usable: true };
  if (now < record.expiresAt) return { effectiveStatus: "rotation_expired", usable: false };
  return { effectiveStatus: "expired", usable: false };
}

export function toMetadata(
  record: ManagedCredentialRecord,
  now: number,
): ManagedCredentialMetadata {
  const { effectiveStatus, usable } = getEffectiveStatus(record, now);
  const base: ManagedCredentialMetadata = {
    id: record.id,
    principalId: record.principalId,
    scopes: [...record.scopes],
    label: record.label,
    status: record.status,
    effectiveStatus,
    usable,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
  };
  const withOptionals: Record<string, unknown> = { ...base };
  if (record.validUntil !== undefined) withOptionals["validUntil"] = record.validUntil;
  if (record.rotatedTo !== undefined) withOptionals["rotatedTo"] = record.rotatedTo;
  if (record.rotatedFrom !== undefined) withOptionals["rotatedFrom"] = record.rotatedFrom;
  if (record.revokedAt !== undefined) withOptionals["revokedAt"] = record.revokedAt;
  return withOptionals as unknown as ManagedCredentialMetadata;
}

/**
 * D1 port (PRD 696/706).
 *
 * Production binds a D1 table with an indexed public-ID primary key; lookup
 * MUST be a single-row query by ID followed by a constant-time verifier
 * comparison. Reads MUST use the primary/latest session so a revoke commit is
 * visible to the next request. Unconstrained read replicas MUST NOT be used
 * for authorization, and KV MUST NOT be used as managed-token truth (KV may
 * only back OAuth sessions, which have an eventual-consistency boundary and
 * therefore no strong immediate-revoke claim).
 */
export interface ManagedTokenStore {
  /** Indexed single-row read by public ID. Throws on storage failure. */
  getById(id: string): Promise<ManagedCredentialRecord | null>;
  /** Insert; throws duplicate_id on collision, storage_unavailable on outage. */
  insert(record: ManagedCredentialRecord): Promise<void>;
  /**
   * Atomic rotate transition: if the stored old record is still `active`
   * without a `rotatedTo` successor, apply `oldUpdate` and insert `next`
   * together. Returns ok:false on stable conflict (already rotated/revoked/
   * disabled/expired). Implementations MUST perform the check-and-write as a
   * single conditional write/transaction.
   */
  tryRotate(
    oldId: string,
    oldUpdate: Pick<ManagedCredentialRecord, "status" | "validUntil" | "rotatedTo" | "updatedAt">,
    next: ManagedCredentialRecord,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Revoke exactly one row; idempotent (first revokedAt wins). */
  revokeById(id: string, now: number): Promise<ManagedCredentialRecord | null>;
  /** Force expiry by clamping expiresAt to <= now. */
  expireById(id: string, now: number): Promise<ManagedCredentialRecord | null>;
  /** Bounded metadata scan for list (never returns verifier). */
  scan(): Promise<readonly ManagedCredentialRecord[]>;
}

/**
 * In-memory fake D1 for deterministic tests. Single-threaded check-and-write
 * emulates a D1 conditional-write/transaction: concurrent rotates serialize on
 * the stored row so exactly one succeeds.
 */
export class FakeManagedTokenStore implements ManagedTokenStore {
  private readonly rows = new Map<string, ManagedCredentialRecord>();
  private unavailable = false;
  getByIdCalls = 0;
  scanCalls = 0;

  setUnavailable(unavailable: boolean): void {
    this.unavailable = unavailable;
  }

  seed(record: ManagedCredentialRecord): void {
    this.rows.set(record.id, record);
  }

  private assertAvailable(): void {
    if (this.unavailable) {
      throw new ManagedTokenError("storage_unavailable", "auth store unavailable");
    }
  }

  async getById(id: string): Promise<ManagedCredentialRecord | null> {
    this.getByIdCalls += 1;
    this.assertAvailable();
    await Promise.resolve();
    return this.rows.get(id) ?? null;
  }

  async insert(record: ManagedCredentialRecord): Promise<void> {
    this.assertAvailable();
    if (this.rows.has(record.id)) {
      throw new ManagedTokenError("duplicate_id", "credential id collision");
    }
    this.rows.set(record.id, record);
    await Promise.resolve();
  }

  async tryRotate(
    oldId: string,
    oldUpdate: Pick<ManagedCredentialRecord, "status" | "validUntil" | "rotatedTo" | "updatedAt">,
    next: ManagedCredentialRecord,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    this.assertAvailable();
    await Promise.resolve();
    const current = this.rows.get(oldId);
    if (current === undefined) return { ok: false, reason: "not_found" };
    if (current.status !== "active") return { ok: false, reason: `status:${current.status}` };
    if (current.rotatedTo !== undefined) return { ok: false, reason: "already_rotated" };
    if (this.rows.has(next.id)) return { ok: false, reason: "id_collision" };
    // No cycle: new lineage is exactly old -> new.
    if (next.rotatedFrom !== oldId || oldUpdate.rotatedTo !== next.id) {
      return { ok: false, reason: "lineage_mismatch" };
    }
    const updated: ManagedCredentialRecord = { ...current };
    const withUpdate: Record<string, unknown> = {
      ...updated,
      status: oldUpdate.status,
      validUntil: oldUpdate.validUntil,
      rotatedTo: oldUpdate.rotatedTo,
      updatedAt: oldUpdate.updatedAt,
    };
    this.rows.set(oldId, withUpdate as unknown as ManagedCredentialRecord);
    this.rows.set(next.id, next);
    return { ok: true };
  }

  async revokeById(id: string, now: number): Promise<ManagedCredentialRecord | null> {
    this.assertAvailable();
    await Promise.resolve();
    const current = this.rows.get(id);
    if (current === undefined) return null;
    if (current.status === "revoked") return current;
    const revoked: ManagedCredentialRecord = { ...current };
    const withRevoked: Record<string, unknown> = {
      ...revoked,
      status: "revoked",
      revokedAt: now,
      updatedAt: now,
    };
    const stored = withRevoked as unknown as ManagedCredentialRecord;
    this.rows.set(id, stored);
    return stored;
  }

  async expireById(id: string, now: number): Promise<ManagedCredentialRecord | null> {
    this.assertAvailable();
    await Promise.resolve();
    const current = this.rows.get(id);
    if (current === undefined) return null;
    const clamped = Math.min(current.expiresAt, now);
    const withExpiry: Record<string, unknown> = {
      ...current,
      expiresAt: clamped,
      updatedAt: now,
    };
    const stored = withExpiry as unknown as ManagedCredentialRecord;
    this.rows.set(id, stored);
    return stored;
  }

  async scan(): Promise<readonly ManagedCredentialRecord[]> {
    this.scanCalls += 1;
    this.assertAvailable();
    await Promise.resolve();
    return [...this.rows.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }
}

export interface CreateManagedInput {
  readonly label?: unknown;
  readonly scopes?: unknown;
  readonly expiresAt: number;
  readonly id?: string;
}

export async function createManagedCredential(
  store: ManagedTokenStore,
  subtle: TimingSafeSubtleCrypto,
  clock: ManagedClock,
  input: CreateManagedInput,
  random: RandomBytes = defaultRandomBytes,
): Promise<{ record: ManagedCredentialRecord; rawToken: string }> {
  const now = clock.now();
  if (!Number.isInteger(input.expiresAt) || input.expiresAt <= now) {
    throw new ManagedTokenError("validation", "expiresAt must be a future integer ms");
  }
  const label = validateLabel(input.label);
  const scopes = validateScopes(input.scopes);
  const candidateId = input.id;
  if (candidateId !== undefined && !isValidCredentialId(candidateId)) {
    throw new ManagedTokenError("validation", "invalid credential id");
  }
  const rawSecret = generateRawSecret(random);
  const verifier = await computeVerifier(rawSecret, subtle);
  for (let attempt = 0; attempt <= ID_COLLISION_RETRY_MAX; attempt += 1) {
    const id = candidateId ?? generateCredentialId(random);
    const record: ManagedCredentialRecord = {
      id,
      verifier,
      principalId: "owner",
      scopes,
      label,
      status: "active",
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt,
    };
    try {
      await store.insert(record);
      return { record, rawToken: formatManagedToken(id, rawSecret) };
    } catch (error) {
      if (
        error instanceof ManagedTokenError &&
        error.code === "duplicate_id" &&
        candidateId === undefined &&
        attempt < ID_COLLISION_RETRY_MAX
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new ManagedTokenError("conflict", "id allocation failed");
}

/**
 * Authenticate a presented managed token (PRD 696/698/701/706).
 * Fail-closed: storage failures propagate as storage_unavailable and MUST NOT
 * fall back to a static bearer. Revoked/disabled rows are rejected before
 * expiry evaluation. Uses server UTC `clock.now()`.
 */
export async function authenticateManagedToken(
  rawToken: string,
  store: ManagedTokenStore,
  subtle: TimingSafeSubtleCrypto,
  clock: ManagedClock,
): Promise<AuthenticatedPrincipal | null> {
  const parsed = parseManagedToken(rawToken);
  if (parsed === null) return null;
  const stored = await store.getById(parsed.id);
  if (stored === null) return null;
  if (stored.status === "revoked" || stored.status === "disabled") return null;
  const presentedVerifier = await computeVerifier(parsed.secret, subtle);
  const matches = await timingSafeTokenEqual(presentedVerifier, stored.verifier, subtle);
  if (!matches) return null;
  const now = clock.now();
  const { usable } = getEffectiveStatus(stored, now);
  if (!usable) return null;
  return createManagedPrincipal(stored.id, stored.scopes);
}

export interface RotateManagedInput {
  readonly oldId: string;
  readonly overlapSeconds?: unknown;
  readonly newId?: string;
  readonly idempotencyKey?: unknown;
}

export interface RotateManagedResult {
  readonly newRecord: ManagedCredentialRecord;
  /** Present only on first commit; replays return secretAvailable=false. */
  readonly rawToken?: string;
  readonly isReplay: boolean;
  readonly secretAvailable: boolean;
  readonly newId: string;
  readonly overlapSeconds: number;
}

export class RotateIdempotencyStore {
  private readonly entries = new Map<string, { newId: string }>();
  get(key: string): { newId: string } | undefined {
    return this.entries.get(key);
  }
  set(key: string, value: { newId: string }): void {
    if (this.entries.size >= MAX_IDEMPOTENCY_KEYS) {
      const first = this.entries.keys().next();
      if (!first.done) this.entries.delete(first.value);
    }
    this.entries.set(key, value);
  }
}

export async function rotateManagedCredential(
  store: ManagedTokenStore,
  subtle: TimingSafeSubtleCrypto,
  clock: ManagedClock,
  input: RotateManagedInput,
  idempotency: RotateIdempotencyStore,
  random: RandomBytes = defaultRandomBytes,
): Promise<RotateManagedResult> {
  const key = validateIdempotencyKey(input.idempotencyKey);
  const overlapSeconds = normalizeOverlapSeconds(input.overlapSeconds);
  if (input.newId !== undefined && !isValidCredentialId(input.newId)) {
    throw new ManagedTokenError("validation", "invalid credential id");
  }
  const scopedKey = key === undefined ? undefined : `${input.oldId}:${key}`;
  if (scopedKey !== undefined) {
    const replay = idempotency.get(scopedKey);
    if (replay !== undefined) {
      const stored = await store.getById(replay.newId);
      if (stored === null) {
        throw new ManagedTokenError("conflict", "idempotency replay missing successor");
      }
      return {
        newRecord: stored,
        isReplay: true,
        secretAvailable: false,
        newId: stored.id,
        overlapSeconds,
      };
    }
  }

  const now = clock.now();
  const old = await store.getById(input.oldId);
  if (old === null) throw new ManagedTokenError("not_found", "unknown credential");
  // Conditional-write gate (PRD 702/703): only a currently active successor
  // may rotate. Revoked/disabled/rotating/expired rows conflict; a revoked row
  // is never moved back to rotating.
  if (old.status !== "active") {
    throw new ManagedTokenError("conflict", `rotate requires active credential (status:${old.status})`);
  }
  if (old.rotatedTo !== undefined) {
    throw new ManagedTokenError("conflict", "credential already rotated");
  }
  if (!(now < old.expiresAt)) {
    throw new ManagedTokenError("conflict", "credential expired");
  }
  // One-to-one lineage without cycles: successor inherits principal/scopes and
  // the absolute expiry unchanged (no privilege or expiry extension).
  const rawSecret = generateRawSecret(random);
  const verifier = await computeVerifier(rawSecret, subtle);
  const validUntil = now + overlapSeconds * 1000;
  let lastCollision: ManagedTokenError | null = null;
  for (let attempt = 0; attempt <= ID_COLLISION_RETRY_MAX; attempt += 1) {
    const newId = input.newId ?? generateCredentialId(random);
    if (newId === old.id) {
      if (input.newId !== undefined) {
        throw new ManagedTokenError("validation", "successor id must differ");
      }
      lastCollision = new ManagedTokenError("duplicate_id", "credential id collision");
      continue;
    }
    const next: ManagedCredentialRecord = {
      id: newId,
      verifier,
      principalId: old.principalId,
      scopes: [...old.scopes],
      label: old.label,
      status: "active",
      createdAt: now,
      updatedAt: now,
      expiresAt: old.expiresAt,
      rotatedFrom: old.id,
    };
    const transition = await store.tryRotate(
      old.id,
      { status: "rotating", validUntil, rotatedTo: newId, updatedAt: now },
      next,
    );
    if (transition.ok) {
      if (scopedKey !== undefined) idempotency.set(scopedKey, { newId });
      return {
        newRecord: next,
        rawToken: formatManagedToken(newId, rawSecret),
        isReplay: false,
        secretAvailable: true,
        newId,
        overlapSeconds,
      };
    }
    if (transition.reason === "id_collision") {
      if (input.newId !== undefined) {
        throw new ManagedTokenError("conflict", "credential id collision");
      }
      lastCollision = new ManagedTokenError("duplicate_id", "credential id collision");
      continue;
    }
    throw new ManagedTokenError("conflict", `rotate conflict (${transition.reason})`);
  }
  throw lastCollision ?? new ManagedTokenError("conflict", "id allocation failed");
}

export async function revokeManagedCredential(
  store: ManagedTokenStore,
  clock: ManagedClock,
  id: string,
): Promise<ManagedCredentialRecord> {
  const stored = await store.revokeById(id, clock.now());
  if (stored === null) throw new ManagedTokenError("not_found", "unknown credential");
  return stored;
}

export async function expireManagedCredential(
  store: ManagedTokenStore,
  clock: ManagedClock,
  id: string,
): Promise<ManagedCredentialRecord> {
  const stored = await store.expireById(id, clock.now());
  if (stored === null) throw new ManagedTokenError("not_found", "unknown credential");
  return stored;
}

export async function listManagedMetadata(
  store: ManagedTokenStore,
  clock: ManagedClock,
  options: { limit?: number; cursor?: string } = {},
): Promise<{ items: ManagedCredentialMetadata[]; nextCursor?: string }> {
  const limit =
    options.limit === undefined ? DEFAULT_LIST_LIMIT : Math.floor(options.limit);
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
    throw new ManagedTokenError("validation", `limit must be 1..${MAX_LIST_LIMIT}`);
  }
  let offset = 0;
  if (options.cursor !== undefined) {
    const decoded = Number(options.cursor);
    if (!Number.isInteger(decoded) || decoded < 0) {
      throw new ManagedTokenError("validation", "invalid cursor");
    }
    offset = decoded;
  }
  const rows = await store.scan();
  const now = clock.now();
  const slice = rows.slice(offset, offset + limit);
  const items = slice.map((record) => toMetadata(record, now));
  const result: { items: ManagedCredentialMetadata[]; nextCursor?: string } = { items };
  if (offset + limit < rows.length) result.nextCursor = String(offset + limit);
  return result;
}

export type AuditKind = "create" | "rotate" | "revoke" | "expire";
export type AuditResult = "ok" | "conflict" | "not_found" | "validation_error" | "storage_unavailable";

export interface AuditRecord {
  readonly opId: string;
  readonly adminFingerprint: string;
  readonly kind: AuditKind;
  readonly oldId?: string;
  readonly newId?: string;
  readonly overlapSeconds?: number;
  readonly commitTime: number;
  readonly result: AuditResult;
}

/** Bounded metadata-only audit log (PRD 705): no raw/verifier, no hard delete. */
export class BoundedAuditLog {
  private readonly records: AuditRecord[] = [];
  constructor(private readonly max: number = MAX_AUDIT_RECORDS) {}
  append(record: AuditRecord): void {
    this.records.push(record);
    while (this.records.length > this.max) this.records.shift();
  }
  list(options: { limit?: number; cursor?: string } = {}): {
    items: AuditRecord[];
    nextCursor?: string;
  } {
    const limit = options.limit ?? DEFAULT_LIST_LIMIT;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
      throw new ManagedTokenError("validation", "invalid audit limit");
    }
    let offset = 0;
    if (options.cursor !== undefined) {
      const decoded = Number(options.cursor);
      if (!Number.isInteger(decoded) || decoded < 0) {
        throw new ManagedTokenError("validation", "invalid audit cursor");
      }
      offset = decoded;
    }
    const items = this.records.slice(offset, offset + limit);
    const result: { items: AuditRecord[]; nextCursor?: string } = { items: [...items] };
    if (offset + limit < this.records.length) result.nextCursor = String(offset + limit);
    return result;
  }
  get size(): number {
    return this.records.length;
  }
}
