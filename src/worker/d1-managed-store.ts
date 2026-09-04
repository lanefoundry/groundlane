import {
  ManagedTokenError,
  type ManagedCredentialRecord,
  type ManagedStoredStatus,
  type ManagedTokenStore,
} from "./managed-tokens.js";

// Minimal structural D1 surface. The real D1Database satisfies this
// interface; deterministic tests fake it. Reads that back authorization
// decisions go through a `first-primary` session when the binding offers
// one, so a revoke commit is visible to the next request (PRD 706).
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: readonly T[] }>;
  run(): Promise<{ success: boolean; meta: { changes: number } }>;
}

export interface D1BatchResult {
  readonly success: boolean;
  readonly meta: { readonly changes: number };
}

export interface D1DatabaseLike {
  prepare(query: string): D1StatementLike;
  batch(statements: readonly D1StatementLike[]): Promise<readonly D1BatchResult[]>;
  withSession?(constraint: string): D1DatabaseLike;
}

const FIRST_PRIMARY = "first-primary";
const SCAN_LIMIT = 500;

const MANAGED_STATUSES: readonly ManagedStoredStatus[] = [
  "active",
  "rotating",
  "revoked",
  "disabled",
];

const CREDENTIAL_COLUMNS =
  "id, verifier, principal_id, scopes, label, status, created_at, updated_at, " +
  "expires_at, valid_until, rotated_to, rotated_from, revoked_at";

function storageUnavailable(): ManagedTokenError {
  return new ManagedTokenError("storage_unavailable", "auth store unavailable");
}

function isRecordStatus(value: unknown): value is ManagedStoredStatus {
  return (
    typeof value === "string" &&
    (MANAGED_STATUSES as readonly string[]).includes(value)
  );
}

function toInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function toNullableInteger(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  return toInteger(value);
}

function toNullableText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value === "string" ? value : undefined;
}

// Fail closed on any malformed row: a corrupt registry row must never
// authenticate, and must surface as an outage rather than a valid credential.
function mapCredentialRow(row: Record<string, unknown>): ManagedCredentialRecord {
  const scopesRaw = row.scopes;
  let scopes: readonly string[] | undefined;
  if (typeof scopesRaw === "string") {
    try {
      const parsed: unknown = JSON.parse(scopesRaw);
      if (
        Array.isArray(parsed) &&
        parsed.every((entry): entry is string => typeof entry === "string")
      ) {
        scopes = parsed;
      }
    } catch {
      scopes = undefined;
    }
  }
  const createdAt = toInteger(row.created_at);
  const updatedAt = toInteger(row.updated_at);
  const expiresAt = toInteger(row.expires_at);
  if (
    typeof row.id !== "string" ||
    row.id.length === 0 ||
    typeof row.verifier !== "string" ||
    row.verifier.length === 0 ||
    row.principal_id !== "owner" ||
    scopes === undefined ||
    typeof row.label !== "string" ||
    !isRecordStatus(row.status) ||
    createdAt === undefined ||
    updatedAt === undefined ||
    expiresAt === undefined
  ) {
    throw storageUnavailable();
  }
  const record: ManagedCredentialRecord = {
    id: row.id,
    verifier: row.verifier,
    principalId: "owner",
    scopes,
    label: row.label,
    status: row.status,
    createdAt,
    updatedAt,
    expiresAt,
  };
  const withOptionals: Record<string, unknown> = { ...record };
  const validUntil = toNullableInteger(row.valid_until);
  if (validUntil !== undefined) withOptionals.validUntil = validUntil;
  const rotatedTo = toNullableText(row.rotated_to);
  if (rotatedTo !== undefined) withOptionals.rotatedTo = rotatedTo;
  const rotatedFrom = toNullableText(row.rotated_from);
  if (rotatedFrom !== undefined) withOptionals.rotatedFrom = rotatedFrom;
  const revokedAt = toNullableInteger(row.revoked_at);
  if (revokedAt !== undefined) withOptionals.revokedAt = revokedAt;
  return withOptionals as unknown as ManagedCredentialRecord;
}

function conflictReasonFor(
  row: ManagedCredentialRecord | null,
): { ok: false; reason: string } {
  if (row === null) return { ok: false, reason: "not_found" };
  if (row.status !== "active") return { ok: false, reason: `status:${row.status}` };
  if (row.rotatedTo !== undefined) return { ok: false, reason: "already_rotated" };
  return { ok: false, reason: "conflict" };
}

/**
 * D1-backed ManagedTokenStore (PRD 696/697/701-704/706).
 *
 * - Lookup is a single indexed row read by public ID on a `first-primary`
 *   session, followed by the caller's constant-time verifier comparison.
 * - Planned rotation is one atomic batch: a guarded UPDATE plus a guarded
 *   INSERT that only fires when the old row is still eligible. D1 executes
 *   batches as a single transaction, so a lost race changes zero rows and
 *   returns a stable conflict instead of an orphan successor or a dangling
 *   rotating record.
 * - Revoke is idempotent with first-revoked_at-wins.
 * - Every storage failure surfaces as storage_unavailable (fail closed);
 *   the data plane never falls back to a static bearer.
 */
export class D1ManagedTokenStore implements ManagedTokenStore {
  constructor(private readonly db: D1DatabaseLike) {}

  private readDb(): D1DatabaseLike {
    if (typeof this.db.withSession === "function") {
      return this.db.withSession(FIRST_PRIMARY);
    }
    return this.db;
  }

  private async selectById(id: string): Promise<ManagedCredentialRecord | null> {
    let row: Record<string, unknown> | null;
    try {
      row = await this.readDb()
        .prepare(`SELECT ${CREDENTIAL_COLUMNS} FROM managed_credentials WHERE id = ? LIMIT 1`)
        .bind(id)
        .first<Record<string, unknown>>();
    } catch {
      throw storageUnavailable();
    }
    if (row === null) return null;
    return mapCredentialRow(row);
  }

  async getById(id: string): Promise<ManagedCredentialRecord | null> {
    return this.selectById(id);
  }

  async insert(record: ManagedCredentialRecord): Promise<void> {
    try {
      await this.db
        .prepare(
          "INSERT INTO managed_credentials (id, verifier, principal_id, scopes, label, status, " +
            "created_at, updated_at, expires_at, valid_until, rotated_to, rotated_from, revoked_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          record.id,
          record.verifier,
          record.principalId,
          JSON.stringify([...record.scopes]),
          record.label,
          record.status,
          record.createdAt,
          record.updatedAt,
          record.expiresAt,
          record.validUntil ?? null,
          record.rotatedTo ?? null,
          record.rotatedFrom ?? null,
          record.revokedAt ?? null,
        )
        .run();
      return;
    } catch {
      // Distinguish a genuine id collision from an outage without parsing
      // vendor error text: re-read the row exactly once.
      let existing: ManagedCredentialRecord | null = null;
      try {
        existing = await this.selectById(record.id);
      } catch {
        throw storageUnavailable();
      }
      if (existing !== null) {
        throw new ManagedTokenError("duplicate_id", "credential id collision");
      }
      throw storageUnavailable();
    }
  }

  async tryRotate(
    oldId: string,
    oldUpdate: Pick<ManagedCredentialRecord, "status" | "validUntil" | "rotatedTo" | "updatedAt">,
    next: ManagedCredentialRecord,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (next.rotatedFrom !== oldId || oldUpdate.rotatedTo !== next.id) {
      return { ok: false, reason: "lineage_mismatch" };
    }
    if (oldUpdate.validUntil === undefined || oldUpdate.rotatedTo === undefined) {
      return { ok: false, reason: "lineage_mismatch" };
    }
    let results: readonly D1BatchResult[];
    try {
      // Order matters: the guarded INSERT runs first so its EXISTS check
      // sees the pre-update row. The guarded UPDATE follows. Same guard on
      // both statements means a batch can only ever apply both or neither;
      // a short count is always a lost race, never a partial write.
      results = await this.db.batch([
        this.db
          .prepare(
            "INSERT INTO managed_credentials (id, verifier, principal_id, scopes, label, status, " +
              "created_at, updated_at, expires_at, valid_until, rotated_to, rotated_from, revoked_at) " +
              "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS " +
              "(SELECT 1 FROM managed_credentials WHERE id = ? AND status = 'active' AND rotated_to IS NULL)",
          )
          .bind(
            next.id,
            next.verifier,
            next.principalId,
            JSON.stringify([...next.scopes]),
            next.label,
            next.status,
            next.createdAt,
            next.updatedAt,
            next.expiresAt,
            next.validUntil ?? null,
            next.rotatedTo ?? null,
            next.rotatedFrom ?? null,
            next.revokedAt ?? null,
            oldId,
          ),
        this.db
          .prepare(
            "UPDATE managed_credentials SET status = ?, valid_until = ?, rotated_to = ?, updated_at = ? " +
              "WHERE id = ? AND status = 'active' AND rotated_to IS NULL",
          )
          .bind("rotating", oldUpdate.validUntil, oldUpdate.rotatedTo, oldUpdate.updatedAt, oldId),
      ]);
    } catch {
      // The batch is atomic: on abort the old row is untouched. Re-read once
      // to separate a lost race or id collision from a real outage.
      let successor: ManagedCredentialRecord | null = null;
      try {
        successor = await this.selectById(next.id);
      } catch {
        throw storageUnavailable();
      }
      if (successor !== null) return { ok: false, reason: "id_collision" };
      let current: ManagedCredentialRecord | null = null;
      try {
        current = await this.selectById(oldId);
      } catch {
        throw storageUnavailable();
      }
      if (current === null || current.status !== "active" || current.rotatedTo !== undefined) {
        return conflictReasonFor(current);
      }
      throw storageUnavailable();
    }
    const inserted = results[0]?.meta.changes ?? 0;
    const updated = results[1]?.meta.changes ?? 0;
    if (inserted === 1 && updated === 1) return { ok: true };
    // Same guard on both statements: partial application is impossible, so a
    // short count is always a lost race. Re-read to name the conflict.
    let current: ManagedCredentialRecord | null = null;
    try {
      current = await this.selectById(oldId);
    } catch {
      throw storageUnavailable();
    }
    return conflictReasonFor(current);
  }

  async revokeById(id: string, now: number): Promise<ManagedCredentialRecord | null> {
    try {
      await this.db
        .prepare(
          "UPDATE managed_credentials SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?), " +
            "updated_at = ? WHERE id = ? AND status != 'revoked'",
        )
        .bind(now, now, id)
        .run();
    } catch {
      throw storageUnavailable();
    }
    return this.selectById(id);
  }

  async expireById(id: string, now: number): Promise<ManagedCredentialRecord | null> {
    try {
      await this.db
        .prepare(
          "UPDATE managed_credentials SET expires_at = CASE WHEN expires_at > ? THEN ? ELSE expires_at END, " +
            "updated_at = ? WHERE id = ?",
        )
        .bind(now, now, now, id)
        .run();
    } catch {
      throw storageUnavailable();
    }
    return this.selectById(id);
  }

  async scan(): Promise<readonly ManagedCredentialRecord[]> {
    let rows: readonly Record<string, unknown>[];
    try {
      const result = await this.readDb()
        .prepare(
          `SELECT ${CREDENTIAL_COLUMNS} FROM managed_credentials ORDER BY created_at ASC LIMIT ${String(SCAN_LIMIT)}`,
        )
        .all<Record<string, unknown>>();
      rows = result.results;
    } catch {
      throw storageUnavailable();
    }
    return rows.map((row) => mapCredentialRow(row));
  }
}
