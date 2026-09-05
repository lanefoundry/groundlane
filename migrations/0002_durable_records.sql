-- 0002_durable_records.sql — bounded, revision-fenced metadata for durable jobs,
-- upload sessions, artifacts, cache entries, corpora, and side-effect receipts.
-- Large payload bytes belong in R2 and are referenced by an opaque ArtifactRef.

CREATE TABLE IF NOT EXISTS durable_records (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (namespace, key)
);

CREATE INDEX IF NOT EXISTS idx_durable_records_expiry
  ON durable_records (namespace, expires_at, key)
  WHERE expires_at IS NOT NULL;
