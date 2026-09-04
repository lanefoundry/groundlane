-- 0001_managed_tokens.sql — D1 registry for managed credentials (PRD 696-705).
--
-- Stores verifiers/digests and bounded metadata only. Raw bearer secrets are
-- NEVER persisted here: D1 holds hex(SHA-256(secret)) plus public IDs and
-- lifecycle metadata. Apply with:
--
--   pnpm exec wrangler d1 migrations apply MANAGED_TOKEN_D1
--
-- Authorization reads MUST use the primary/latest session (D1 Sessions API
-- with a primary/sequential constraint) so a revoke commit is visible to the
-- next request. Unconstrained read replicas MUST NOT back authorization, and
-- KV MUST NOT be used as managed-token truth.

CREATE TABLE IF NOT EXISTS managed_credentials (
  id TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  principal_id TEXT NOT NULL DEFAULT 'owner',
  scopes TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  valid_until INTEGER,
  rotated_to TEXT,
  rotated_from TEXT,
  revoked_at INTEGER
);

-- Planned rotation MUST be a single atomic conditional write, e.g.:
--
--   BEGIN IMMEDIATE;
--   UPDATE managed_credentials
--      SET status = 'rotating', valid_until = ?, rotated_to = ?, updated_at = ?
--    WHERE id = ? AND status = 'active' AND rotated_to IS NULL;
--   -- exactly one row changed, then:
--   INSERT INTO managed_credentials (...) VALUES (...);
--   COMMIT;
--
-- If the UPDATE changes zero rows, another request won the race: return a
-- stable conflict and create no second successor. Never resurrect a revoked
-- row back to rotating. Revoke is idempotent: first revoked_at wins.

CREATE TABLE IF NOT EXISTS managed_credential_audit (
  op_id TEXT PRIMARY KEY,
  admin_fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL,
  old_id TEXT,
  new_id TEXT,
  overlap_seconds INTEGER,
  commit_time INTEGER NOT NULL,
  result TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_managed_credential_audit_commit_time
  ON managed_credential_audit (commit_time);

-- Bounded rotation idempotency keys (PRD 704). Replay of the same key returns
-- the recorded successor ID with secretAvailable=false; it never replays the
-- raw secret and never creates a second successor.
CREATE TABLE IF NOT EXISTS managed_rotate_idempotency (
  scope_key TEXT PRIMARY KEY,
  new_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
