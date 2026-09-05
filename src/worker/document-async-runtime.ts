import { DurableDocumentAsyncArtifacts } from "../core/document-async-artifacts.js";
import { DocumentAdmissionStagingStore } from "../core/document-admission-staging.js";
import { DocumentSourceSnapshotRepository } from "../core/document-source-snapshot.js";
import { DocumentAsyncDispatcher } from "../core/document-async-dispatcher.js";
import { DocumentAsyncRuntime, type DocumentAsyncProviderPort, type CreateDocumentAsyncInput } from "../core/document-async-runtime.js";
import { DurableDocumentJobRepository, type DurableDocumentJobCaller } from "../core/durable-document-jobs.js";
import { DurableEffectJournal } from "../core/durable-effects.js";
import { DurableUploadArtifactService } from "../core/durable-upload-flow.js";
import { withinDeadline, Deadline } from "../core/limits.js";
import { GroundlaneError } from "../core/errors.js";
import { D1DurableRecordStore } from "./d1-durable-store.js";
import { D1DocumentAdmission } from "./d1-document-admission.js";
import { createEdgeDocumentOutputRuntime, type EdgeDocumentOutputEnv } from "./document-output-runtime.js";
import { R2ImmutableBlobStore } from "./r2-immutable-blob.js";

export const DOCUMENT_ASYNC_NAMESPACE = "document-async-v1";
export const DOCUMENT_DISPATCH_NAMESPACE = "document-dispatch-v1";
export const DOCUMENT_SNAPSHOT_NAMESPACE = "document-snapshot-v1";

/** Native storage composition only: constructing it neither configures nor submits a provider job. */
export function createEdgeDocumentAsyncRuntime(
  env: EdgeDocumentOutputEnv,
  provider: DocumentAsyncProviderPort,
  options: { readonly now?: () => number } = {},
) {
  // Reuse output storage validation, including the required primary D1 session.
  const { runtime: outputs } = createEdgeDocumentOutputRuntime(env, options);
  const db = env.MANAGED_TOKEN_D1;
  const bucket = env.GROUNDLANE_ARTIFACTS;
  if (db === undefined || bucket === undefined) throw new Error("Document storage unavailable");
  const now = options.now ?? Date.now;
  const store = new D1DurableRecordStore(db, DOCUMENT_ASYNC_NAMESPACE);
  const effects = new DurableEffectJournal(store);
  const jobs = new DurableDocumentJobRepository(store, effects);
  const uploads = new DurableUploadArtifactService(new D1DurableRecordStore(db, "artifact-upload-v1"), new R2ImmutableBlobStore(bucket));
  const snapshotStore = new D1DurableRecordStore(db, DOCUMENT_SNAPSHOT_NAMESPACE);
  const snapshots = new DocumentSourceSnapshotRepository(new D1DurableRecordStore(db, "artifact-upload-v1"), snapshotStore,
    new R2ImmutableBlobStore(bucket), new D1DocumentAdmission(db), { sources: "artifact-upload-v1", snapshots: DOCUMENT_SNAPSHOT_NAMESPACE }, now);
  const forJob = (jobId: string) => new DocumentAsyncRuntime(store, jobs, effects,
    new DurableDocumentAsyncArtifacts({
      readArtifact: (refId, caller, _now, maxBytes) => snapshots.read(jobId, refId, caller, maxBytes, AbortSignal.timeout(120_000)),
    }, outputs, "cloudflare", now), provider, now);
  const guard = async (jobId: string, caller: DurableDocumentJobCaller, deadline: Deadline, signal?: AbortSignal) => {
    const reason = await snapshots.sourceStatus(jobId, caller);
    if (reason !== null) {
      await forJob(jobId).revokeSource(jobId, caller, reason, deadline, signal);
      return snapshots.revoke(jobId, caller);
    }
    return { cleanupPending: false };
  };
  const runtime = {
    async status(jobId: string, caller: DurableDocumentJobCaller, deadline: Deadline, signal?: AbortSignal) {
      return withinDeadline(async (operationSignal) => {
        const cleanup = await guard(jobId, caller, deadline, operationSignal);
        const status = await forJob(jobId).status(jobId, caller, deadline, operationSignal);
        return { ...status, snapshotCleanupPending: cleanup.cleanupPending,
          resultCleanupPending: status.resultCleanupPending || cleanup.cleanupPending };
      }, deadline, signal, "document-async-status");
    },
    async advance(jobId: string, caller: DurableDocumentJobCaller, signal?: AbortSignal) {
      const deadline = new Deadline(120_000);
      return withinDeadline(async (operationSignal) => {
        await guard(jobId, caller, deadline, operationSignal);
        return forJob(jobId).advance(jobId, caller, operationSignal);
      }, deadline, signal, "document-async-dispatch");
    },
    async cancel(jobId: string, caller: DurableDocumentJobCaller, upstream: boolean, deadline: Deadline, signal?: AbortSignal) {
      return withinDeadline(async (operationSignal) => {
        await guard(jobId, caller, deadline, operationSignal);
        return forJob(jobId).cancel(jobId, caller, upstream, deadline, operationSignal);
      }, deadline, signal, "document-async-cancel");
    },
    async revokeSource(jobId: string, caller: DurableDocumentJobCaller, reason: "deleted" | "expired", deadline: Deadline, signal?: AbortSignal) {
      const revoked = await forJob(jobId).revokeSource(jobId, caller, reason, deadline, signal);
      const cleanup = await snapshots.revoke(jobId, caller);
      return { ...revoked, snapshotCleanupPending: cleanup.cleanupPending };
    },
  };
  const scheduleStore = new D1DurableRecordStore(db, DOCUMENT_DISPATCH_NAMESPACE);
  const dispatcher = new DocumentAsyncDispatcher(scheduleStore, runtime, {}, now);
  return { runtime, outputs, dispatcher, snapshots,
    /** Snapshot, job, async state and dispatch outbox publish in one source-guarded transaction. */
    submit(input: CreateDocumentAsyncInput, caller: DurableDocumentJobCaller, deadline: Deadline, signal?: AbortSignal) {
      return withinDeadline(async (submitSignal) => {
        const staged = new DocumentAdmissionStagingStore(store);
        const stagedEffects = new DurableEffectJournal(staged);
        const creation = new DocumentAsyncRuntime(staged, new DurableDocumentJobRepository(staged, stagedEffects), stagedEffects,
          new DurableDocumentAsyncArtifacts(uploads, outputs, "cloudflare", now), provider, now);
        const created = await creation.create(input, caller, deadline, submitSignal);
        const snapshot = await snapshots.prepare(created.job.jobId, input.sourceRefId, caller, created.job.expiresAt, input.policy.maxInputBytes, submitSignal);
        const stagedSchedule = new DocumentAdmissionStagingStore(scheduleStore);
        if (staged.records().length > 0) {
          await new DocumentAsyncDispatcher(stagedSchedule, runtime, {}, now).enqueue(created.job.jobId, caller, { signal: submitSignal });
        }
        const committed = await snapshots.commit(snapshot, [
          ...staged.records().map((record) => ({ namespace: DOCUMENT_ASYNC_NAMESPACE, record })),
          ...stagedSchedule.records().map((record) => ({ namespace: DOCUMENT_DISPATCH_NAMESPACE, record })),
        ], submitSignal);
        if (committed !== "committed") {
          // Reuse only the exact already committed snapshot; core create above
          // has already checked the existing job's caller and fingerprint.
          const previous = await snapshotStore.get(snapshot.record.key);
          if (committed !== "conflict" || previous?.value !== snapshot.record.value || staged.records().length !== 0) {
            throw new GroundlaneError("INVALID_INPUT", "document-admission", "Document source changed or admission conflicted");
          }
        }
        return { ...await runtime.status(created.job.jobId, caller, deadline, submitSignal),
          snapshot: { refId: snapshot.snapshotRefId, artifactKind: "source" as const, expiresAt: snapshot.expiresAt } };
      }, deadline, signal, "document-async-submit");
    },
  };
}
