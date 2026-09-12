import type { D1DatabaseLike } from "../../worker/d1-managed-store.js";
import type {
  CorpusDerivedIndexPort,
  CorpusIndexDocument,
  CorpusIndexHit,
} from "./sqlite-corpus-index.js";

const FIRST_PRIMARY = "first-primary";

const MAX_CORPUS_ID_CHARS = 160;
const MAX_SOURCE_ID_CHARS = 160;
const MAX_CONTENT_HASH_CHARS = 160;
const MAX_CORPUS_INDEX_TEXT_CHARS = 1_000_000;

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

export class D1CorpusDerivedIndex implements CorpusDerivedIndexPort {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly namespace: string,
  ) {
    assertText(namespace, "corpus index namespace", 120);
    if (!/^[A-Za-z0-9._:-]+$/u.test(namespace)) throw new Error("corpus index namespace is invalid");
  }

  /**
   * D1's read replicas can lag the primary by a beat after a write, so a
   * `search` issued right after `upsert`/`replaceFromManifest` can miss it.
   * Pin reads to the primary session to get read-your-writes consistency,
   * matching the pattern in `d1-durable-store.ts`.
   */
  private readDb(): D1DatabaseLike {
    return typeof this.db.withSession === "function" ? this.db.withSession(FIRST_PRIMARY) : this.db;
  }

  async replaceFromManifest(corpusId: string, documents: readonly CorpusIndexDocument[]): Promise<void> {
    validateCorpusId(corpusId);
    if (documents.length > 500) throw new Error("corpus index document count exceeds the supported bound");
    for (const document of documents) validateDocument(document);

    const statements = [
      this.db.prepare(
        "DELETE FROM corpus_index_documents WHERE namespace = ? AND corpus_id = ?",
      ).bind(this.namespace, corpusId),
      ...documents.map((doc) =>
        this.db.prepare(
          "INSERT INTO corpus_index_documents (namespace, corpus_id, source_id, content_hash, normalized_text) VALUES (?, ?, ?, ?, ?)",
        ).bind(this.namespace, corpusId, doc.sourceId, doc.contentHash, doc.text),
      ),
    ];
    await this.db.batch(statements);
  }

  async upsert(corpusId: string, document: CorpusIndexDocument): Promise<void> {
    validateCorpusId(corpusId);
    validateDocument(document);
    await this.db.prepare(
      `INSERT INTO corpus_index_documents
        (namespace, corpus_id, source_id, content_hash, normalized_text)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(namespace, corpus_id, source_id) DO UPDATE SET
          content_hash = excluded.content_hash,
          normalized_text = excluded.normalized_text`,
    ).bind(this.namespace, corpusId, document.sourceId, document.contentHash, document.text).run();
  }

  async remove(corpusId: string, sourceId: string): Promise<void> {
    validateCorpusId(corpusId);
    assertText(sourceId, "corpus source ID", MAX_SOURCE_ID_CHARS);
    await this.db.prepare(
      "DELETE FROM corpus_index_documents WHERE namespace = ? AND corpus_id = ? AND source_id = ?",
    ).bind(this.namespace, corpusId, sourceId).run();
  }

  async search(corpusId: string, query: string, limit: number): Promise<readonly CorpusIndexHit[]> {
    validateCorpusId(corpusId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("corpus search limit is invalid");
    const terms = queryTerms(query);

    const result = await this.readDb().prepare(
      "SELECT source_id, content_hash, normalized_text FROM corpus_index_documents WHERE namespace = ? AND corpus_id = ? ORDER BY source_id LIMIT 501",
    ).bind(this.namespace, corpusId).all<Record<string, unknown>>();

    const hits: CorpusIndexHit[] = [];
    for (const row of result.results) {
      if (
        typeof row.source_id !== "string" || typeof row.content_hash !== "string" ||
        typeof row.normalized_text !== "string"
      ) throw new Error("D1 corpus index row is malformed");
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
    return hits.slice(0, limit);
  }

  async delete(corpusId: string): Promise<void> {
    validateCorpusId(corpusId);
    await this.db.prepare(
      "DELETE FROM corpus_index_documents WHERE namespace = ? AND corpus_id = ?",
    ).bind(this.namespace, corpusId).run();
  }
}

export function createD1CorpusDerivedIndex(db: D1Database, namespace: string): D1CorpusDerivedIndex {
  return new D1CorpusDerivedIndex(db, namespace);
}
