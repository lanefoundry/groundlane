-- 0003_corpus_index.sql — derived full-text search index for corpus documents.
-- Authoritative corpus data lives in durable_records; this table is a
-- query-optimized projection that can be rebuilt from the manifest.

CREATE TABLE IF NOT EXISTS corpus_index_documents (
  namespace TEXT NOT NULL,
  corpus_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  PRIMARY KEY (namespace, corpus_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_corpus_index_corpus
  ON corpus_index_documents (namespace, corpus_id);
