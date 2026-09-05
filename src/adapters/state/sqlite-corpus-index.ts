import { DatabaseSync } from "node:sqlite";

const MAX_CORPUS_ID_CHARS = 160;
const MAX_SOURCE_ID_CHARS = 160;
const MAX_CONTENT_HASH_CHARS = 160;
export const MAX_CORPUS_INDEX_TEXT_CHARS = 1_000_000;

export interface CorpusIndexDocument {
  readonly sourceId: string;
  readonly contentHash: string;
  readonly text: string;
}

export interface CorpusIndexHit {
  readonly sourceId: string;
  readonly contentHash: string;
  readonly snippet: string;
  readonly score: number;
}

export interface CorpusDerivedIndexPort {
  replaceFromManifest(corpusId: string, documents: readonly CorpusIndexDocument[]): Promise<void>;
  upsert(corpusId: string, document: CorpusIndexDocument): Promise<void>;
  remove(corpusId: string, sourceId: string): Promise<void>;
  search(corpusId: string, query: string, limit: number): Promise<readonly CorpusIndexHit[]>;
  delete(corpusId: string): Promise<void>;
}

function assertText(value: string, label: string, max: number): void {
  if (!value || value.length > max) throw new Error(`${label} is invalid`);
}

function validateCorpusId(value: string): void {
  assertText(value, "corpus ID", MAX_CORPUS_ID_CHARS);
  if (!/^[A-Za-z0-9._-]+$/u.test(value)) throw new Error("corpus ID is invalid");
}

function validateDocument(document: CorpusIndexDocument): void {
  assertText(document.sourceId, "corpus source ID", MAX_SOURCE_ID_CHARS);
  assertText(document.contentHash, "corpus content hash", MAX_CONTENT_HASH_CHARS);
  assertText(document.text, "corpus source text", MAX_CORPUS_INDEX_TEXT_CHARS);
}

function queryTerms(query: string): readonly string[] {
  const normalized = query.normalize("NFC").trim().toLocaleLowerCase("en-US");
  if (!normalized || normalized.length > 500) throw new Error("corpus search query is invalid");
  return [...new Set(normalized.split(/\s+/u).filter(Boolean))].slice(0, 16);
}

function snippetFor(text: string, terms: readonly string[]): string {
  const lower = text.toLocaleLowerCase("en-US");
  let position = 0;
  for (const term of terms) {
    const candidate = lower.indexOf(term);
    if (candidate >= 0) {
      position = candidate;
      break;
    }
  }
  const start = Math.max(0, position - 80);
  return text.slice(start, start + 320);
}

/** SQLite is a derived search structure only; the durable manifest remains authorization truth. */
export class SqliteCorpusDerivedIndex implements CorpusDerivedIndexPort {
  private readonly database: DatabaseSync;

  constructor(path: string, private readonly namespace: string) {
    assertText(namespace, "corpus index namespace", 120);
    if (!/^[A-Za-z0-9._:-]+$/u.test(namespace)) throw new Error("corpus index namespace is invalid");
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    this.database.exec(`CREATE TABLE IF NOT EXISTS corpus_index_documents (
      namespace TEXT NOT NULL,
      corpus_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      normalized_text TEXT NOT NULL,
      PRIMARY KEY (namespace, corpus_id, source_id)
    ) STRICT;`);
  }

  close(): void {
    this.database.close();
  }

  replaceFromManifest(corpusId: string, documents: readonly CorpusIndexDocument[]): Promise<void> {
    validateCorpusId(corpusId);
    if (documents.length > 500) throw new Error("corpus index document count exceeds the supported bound");
    for (const document of documents) validateDocument(document);
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database.prepare(
        "DELETE FROM corpus_index_documents WHERE namespace = ? AND corpus_id = ?",
      ).run(this.namespace, corpusId);
      const insert = this.database.prepare(
        "INSERT INTO corpus_index_documents (namespace, corpus_id, source_id, content_hash, normalized_text) VALUES (?, ?, ?, ?, ?)",
      );
      for (const document of documents) {
        insert.run(this.namespace, corpusId, document.sourceId, document.contentHash, document.text);
      }
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
    return Promise.resolve();
  }

  upsert(corpusId: string, document: CorpusIndexDocument): Promise<void> {
    validateCorpusId(corpusId);
    validateDocument(document);
    this.database.prepare(`INSERT INTO corpus_index_documents
      (namespace, corpus_id, source_id, content_hash, normalized_text)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(namespace, corpus_id, source_id) DO UPDATE SET
        content_hash = excluded.content_hash,
        normalized_text = excluded.normalized_text`).run(
      this.namespace,
      corpusId,
      document.sourceId,
      document.contentHash,
      document.text,
    );
    return Promise.resolve();
  }

  remove(corpusId: string, sourceId: string): Promise<void> {
    validateCorpusId(corpusId);
    assertText(sourceId, "corpus source ID", MAX_SOURCE_ID_CHARS);
    this.database.prepare(
      "DELETE FROM corpus_index_documents WHERE namespace = ? AND corpus_id = ? AND source_id = ?",
    ).run(this.namespace, corpusId, sourceId);
    return Promise.resolve();
  }

  search(corpusId: string, query: string, limit: number): Promise<readonly CorpusIndexHit[]> {
    validateCorpusId(corpusId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("corpus search limit is invalid");
    const terms = queryTerms(query);
    const rows = this.database.prepare(
      "SELECT source_id, content_hash, normalized_text FROM corpus_index_documents WHERE namespace = ? AND corpus_id = ? ORDER BY source_id LIMIT 501",
    ).all(this.namespace, corpusId) as Array<{
      source_id?: unknown;
      content_hash?: unknown;
      normalized_text?: unknown;
    }>;
    const hits: CorpusIndexHit[] = [];
    for (const row of rows) {
      if (
        typeof row.source_id !== "string" || typeof row.content_hash !== "string" ||
        typeof row.normalized_text !== "string"
      ) throw new Error("SQLite corpus index row is malformed");
      const lower = row.normalized_text.toLocaleLowerCase("en-US");
      const matches = terms.reduce((count, term) => count + (lower.includes(term) ? 1 : 0), 0);
      if (matches === 0) continue;
      hits.push({
        sourceId: row.source_id,
        contentHash: row.content_hash,
        snippet: snippetFor(row.normalized_text, terms),
        score: matches / terms.length,
      });
    }
    hits.sort((left, right) => right.score - left.score || left.sourceId.localeCompare(right.sourceId));
    return Promise.resolve(hits.slice(0, limit));
  }

  delete(corpusId: string): Promise<void> {
    validateCorpusId(corpusId);
    this.database.prepare(
      "DELETE FROM corpus_index_documents WHERE namespace = ? AND corpus_id = ?",
    ).run(this.namespace, corpusId);
    return Promise.resolve();
  }
}
