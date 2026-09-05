import { validateDurableKey, validateDurableValue, validateDurableWrite, type NewDurableRecord } from "./durable-store.js";
import { GroundlaneError } from "./errors.js";

export interface DocumentAdmissionInput {
  readonly source: { readonly namespace: string; readonly key: string; readonly revision: number; readonly value: string };
  readonly writes: readonly { readonly namespace: string; readonly record: NewDurableRecord }[];
  readonly nowMs: number;
}
export type DocumentAdmissionResult = "committed" | "conflict" | "source_unavailable";

/** Internal atomic metadata publication; immutable bytes must already be finalized. */
export interface DocumentAdmissionPort {
  commit(input: DocumentAdmissionInput): Promise<DocumentAdmissionResult>;
}

export const DOCUMENT_ADMISSION_MARKER_NAMESPACE = "document-admission-markers-v1";

export function validateDocumentAdmission(input: DocumentAdmissionInput): void {
  try {
    validateDurableKey(input.source.namespace); validateDurableKey(input.source.key); validateDurableValue(input.source.value);
    if (!Number.isSafeInteger(input.source.revision) || input.source.revision < 1 ||
      !Number.isSafeInteger(input.nowMs) || input.nowMs < 0 || input.writes.length < 1 || input.writes.length > 8) throw new Error();
    const keys = new Set<string>([`${input.source.namespace}\0${input.source.key}`]);
    for (const write of input.writes) {
      validateDurableKey(write.namespace); validateDurableKey(write.record.key); validateDurableWrite(write.record);
      const key = `${write.namespace}\0${write.record.key}`;
      if (keys.has(key) || write.namespace === DOCUMENT_ADMISSION_MARKER_NAMESPACE || write.record.nowMs !== input.nowMs) throw new Error();
      keys.add(key);
    }
  } catch {
    throw new GroundlaneError("INVALID_INPUT", "document-admission", "Invalid bounded document admission metadata");
  }
}
