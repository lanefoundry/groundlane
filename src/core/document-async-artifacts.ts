import { projectCanonicalDocument, type CanonicalDocumentEnvelope } from "./canonical-document.js";
import { parseCanonicalDocumentEnvelope } from "./canonical-document-schema.js";

import type { DocumentAsyncArtifactPort, DocumentAsyncSourceSnapshot } from "./document-async-runtime.js";
import type { DurableDocumentJobCaller } from "./durable-document-jobs.js";
import type { DurableDocumentOutputRuntime } from "./durable-document-output.js";
import type { DurableUploadArtifactService } from "./durable-upload-flow.js";
import { GroundlaneError } from "./errors.js";
import { MAX_IMMUTABLE_BLOB_BYTES } from "./immutable-blob.js";

/** Concrete byte storage for the async runtime, which validates the complete envelope before writing. */
export class DurableDocumentAsyncArtifacts implements DocumentAsyncArtifactPort {
  constructor(
    private readonly uploads: Pick<DurableUploadArtifactService, "readArtifact">,
    private readonly outputs: Pick<DurableDocumentOutputRuntime, "save" | "delete" | "recoverOperation">,
    private readonly tenantId: string,
    private readonly clock: () => number = Date.now,
  ) {
    if (tenantId.length === 0 || tenantId.length > 256) throw new GroundlaneError("INVALID_INPUT", "document-async-artifacts", "Invalid storage tenant");
  }

  async inspectSource(refId: string, caller: DurableDocumentJobCaller, signal: AbortSignal): Promise<DocumentAsyncSourceSnapshot> {
    signal.throwIfAborted();
    const source = await this.uploads.readArtifact(refId, caller, this.clock(), MAX_IMMUTABLE_BLOB_BYTES);
    signal.throwIfAborted();
    return { refId: source.ref.refId, contentHash: source.ref.contentHash,
      byteSize: source.ref.byteSize, expiresAt: source.ref.expiresAt };
  }

  async readSource(refId: string, caller: DurableDocumentJobCaller, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    const source = await this.uploads.readArtifact(refId, caller, this.clock(), maxBytes);
    signal.throwIfAborted();
    return source.bytes;
  }

  async writeResult(
    jobId: string, bytes: Uint8Array, caller: DurableDocumentJobCaller, expiresAt: number,
    signal: AbortSignal, snapshot: DocumentAsyncSourceSnapshot,
  ): Promise<string> {
    signal.throwIfAborted();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMMUTABLE_BLOB_BYTES) {
      throw new GroundlaneError("OUTPUT_LIMIT", "document-async-artifacts", "Document result exceeds storage bounds");
    }
    let envelope: CanonicalDocumentEnvelope;
    try { envelope = parseCanonicalDocumentEnvelope(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown); }
    catch { throw new GroundlaneError("INVALID_INPUT", "document-async-artifacts", "Document result is invalid"); }
    const source = await this.uploads.readArtifact(snapshot.refId, caller, this.clock(), MAX_IMMUTABLE_BLOB_BYTES);
    if (source.ref.contentHash !== snapshot.contentHash || source.ref.byteSize !== snapshot.byteSize ||
        source.ref.expiresAt !== snapshot.expiresAt || envelope.sourceIdentity.contentHash !== snapshot.contentHash ||
        (envelope.sourceIdentity.artifactRef !== undefined && envelope.sourceIdentity.artifactRef !== snapshot.refId)) {
      throw new GroundlaneError("INVALID_INPUT", "document-async-artifacts", "Document source snapshot changed");
    }
    signal.throwIfAborted();
    const output = await this.outputs.save({ caller: { ...caller, tenantId: this.tenantId },
      sourceBytes: source.bytes, mimeType: source.mimeType, filename: source.filename,
      sourceExpiresAt: Math.min(expiresAt, snapshot.expiresAt), externalSourceRef: snapshot.refId,
      operationKey: jobId, payload: { envelope, projection: projectCanonicalDocument(envelope, "markdown") },
    }, signal);
    // Do not drop a late acknowledgment: the durable runtime must record and
    // compensate this reference even when the attempt was cancelled meanwhile.
    return output.refId;
  }

  revokeResult(refId: string, caller: DurableDocumentJobCaller, signal: AbortSignal): Promise<{ readonly cleanupPending: boolean }> {
    return this.outputs.delete(refId, { ...caller, tenantId: this.tenantId }, signal);
  }

  recoverResult(jobId: string, caller: DurableDocumentJobCaller, signal: AbortSignal): Promise<{ readonly refId: string; readonly ready: boolean } | null> {
    return this.outputs.recoverOperation(jobId, { ...caller, tenantId: this.tenantId }, signal);
  }
}
