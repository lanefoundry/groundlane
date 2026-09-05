import { randomUUID } from "node:crypto";

import {
  DOCUMENT_ADMISSION_MARKER_NAMESPACE, validateDocumentAdmission,
  type DocumentAdmissionInput, type DocumentAdmissionPort, type DocumentAdmissionResult,
} from "../core/document-admission.js";
import { GroundlaneError } from "../core/errors.js";
import type { D1DatabaseLike } from "./d1-managed-store.js";

const columns = "namespace,key,value,revision,created_at,updated_at,expires_at";
// CASE guards JSON extraction even if SQL predicate evaluation is reordered.
const sourcePredicate = "namespace=? AND key=? AND revision=? AND value=? AND " +
  "CASE WHEN json_valid(value) THEN " +
  "CASE WHEN json_extract(value,'$.status')='active' AND json_type(value,'$.expiresAt')='integer' " +
  "AND json_extract(value,'$.expiresAt')>? THEN 1 ELSE 0 END ELSE 0 END=1";

function unavailable(): GroundlaneError {
  return new GroundlaneError("UPSTREAM_ERROR", "document-admission", "Document admission storage is unavailable", true);
}

/**
 * All writes are gated by a unique marker created inside the same D1 batch
 * transaction. Marker admission tests source AND every destination collision
 * before any write. A constraint/SQL failure rolls back the complete batch.
 * The marker is removed in that transaction; no unbounded marker collection.
 */
export class D1DocumentAdmission implements DocumentAdmissionPort {
  constructor(private readonly db: D1DatabaseLike) {}

  async commit(input: DocumentAdmissionInput): Promise<DocumentAdmissionResult> {
    validateDocumentAdmission(input);
    if (this.db.withSession === undefined) throw unavailable();
    const marker = randomUUID();
    const sourceBindings = [input.source.namespace, input.source.key, input.source.revision, input.source.value, input.nowMs];
    try {
      const session = this.db.withSession("first-primary");
      const noCollisions = input.writes.map(() => "NOT EXISTS(SELECT 1 FROM durable_records WHERE namespace=? AND key=?)").join(" AND ");
      const admit = session.prepare(`INSERT INTO durable_records(${columns}) ` +
        `SELECT ?,?,'1',1,?,?,NULL WHERE EXISTS(SELECT 1 FROM durable_records WHERE ${sourcePredicate}) AND ${noCollisions}`)
        .bind(DOCUMENT_ADMISSION_MARKER_NAMESPACE, marker, input.nowMs, input.nowMs,
          ...sourceBindings, ...input.writes.flatMap((write) => [write.namespace, write.record.key]));
      const statements = [admit, ...input.writes.map(({ namespace, record }) => session.prepare(
        `INSERT INTO durable_records(${columns}) SELECT ?,?,?,1,?,?,? ` +
        "WHERE EXISTS(SELECT 1 FROM durable_records WHERE namespace=? AND key=?)",
      ).bind(namespace, record.key, record.value, record.nowMs, record.nowMs, record.expiresAt ?? null, DOCUMENT_ADMISSION_MARKER_NAMESPACE, marker)),
      session.prepare("DELETE FROM durable_records WHERE namespace=? AND key=?").bind(DOCUMENT_ADMISSION_MARKER_NAMESPACE, marker)];
      const results = await session.batch(statements);
      if (results.length !== statements.length || results.some((result) => !result.success)) throw unavailable();
      if (results.every((result) => result.meta.changes === 1)) return "committed";
      if (results.some((result) => result.meta.changes !== 0)) throw unavailable();
      // Re-read through the same primary-started session for safe classification.
      // An ambiguous batch failure is NOT classified as a known conflict.
      const active = await session.prepare(`SELECT key FROM durable_records WHERE ${sourcePredicate} LIMIT 1`).bind(...sourceBindings).first();
      return active === null ? "source_unavailable" : "conflict";
    } catch { throw unavailable(); }
  }
}

/** Native binding compatibility is checked without widening or unsafe casts. */
export function createD1DocumentAdmission(db: D1Database): D1DocumentAdmission {
  return new D1DocumentAdmission(db);
}
