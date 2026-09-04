// ---------------------------------------------------------------------------
// Corpus lifecycle, scoped-search, idempotency, and durable-artifact runtime
// (PRD 665, 667, 723, 724, 725, 726).
//
// This module implements the runtime behind `src/core/corpus-contract.ts`
// using a backend adapter port with an in-memory fake backend. It is pure
// TypeScript with no MCP registry, worker, or Cloudflare bindings so the
// same contracts stay portable and fake-testable.
//
// Design rules enforced here:
// - Public corpus identity is an opaque Groundlane ID (`gl-corpus-...`);
//   backend-internal index/job IDs never leave the adapter boundary.
// - Enrollment creates a corpus-owned source lifecycle record; retention
//   expiry is min(caller request, hard caps); re-enroll never extends expiry.
// - Delete immediately revokes access and invalidates cache bindings.
//   Incomplete deletion is reported with isComplete=false, never complete.
// - The corpus manifest is the truth source; the derived index is
//   rebuildable and verified stable after rebuild.
// - Scoped corpus search is a separate tool family (`corpus_search`) from
//   public web search (`web_search`) with distinct sourceKind/provenance.
// - Retries under one idempotency key reuse the previous result and never
//   duplicate provider task creation, paid upstream calls, or artifact
//   writes. Upstream cancel is only `confirmed` with provider acknowledgment.
// - Durable state holds small records only; large content lives behind a
//   storage backend port (Cloudflare deployment maps it to R2).
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

import { GroundlaneError, hint } from "./errors.js";
import {
  MAX_INLINE_BYTES,
  mapBackendFailureToState,
  resolveCancelAcknowledgment,
  resolveEnrollmentExpiry,
  revokeEnrollment,
  validateArtifactWriteNotDuplicated,
  validateCorpusIdentity,
  validateDeletionStatus,
  validateDurableArtifactRef,
  validateDurableState,
  validateEnrollmentExpiry,
  validatePaidCallNotDuplicated,
  validateProviderTaskNotDuplicated,
  validateReEnroll,
  validateRetryIdempotency,
  validateSearchResultLabeling,
  verifyManifestStableAfterRebuild,
  type CancelAcknowledgmentStatus,
  type CorpusEnrollment,
  type CorpusManifest,
  type CorpusSourceManifestEntry,
  type CorpusSourceRecord,
  type CorpusState,
  type DeletionStatus,
  type DurableArtifactRef,
  type RetentionPolicy,
  type RetryIdempotencyGuard,
  type SearchResultProvenance,
  type SearchSourceKind,
} from "./corpus-contract.js";

// -- Shared bounds and families ----------------------------------------------

export const CORPUS_ID_PREFIX = "gl-corpus-";
export const PUBLIC_WEB_TOOL_FAMILY = "web_search";
export const SCOPED_CORPUS_TOOL_FAMILY = "corpus_search";

export type SearchToolFamily =
  | typeof PUBLIC_WEB_TOOL_FAMILY
  | typeof SCOPED_CORPUS_TOOL_FAMILY;

export const MAX_DISPLAY_NAME_CHARS = 120;
export const MAX_SOURCE_ID_CHARS = 160;
export const MAX_ACL_ENTRIES = 32;
export const MAX_ACL_ENTRY_CHARS = 64;
export const MAX_CONTENT_HASH_CHARS = 128;
export const MAX_SEARCH_QUERY_CHARS = 500;
export const MAX_SEARCH_RESULTS = 50;
export const DEFAULT_SEARCH_RESULTS = 10;

function invalidInput(message: string, hintCode: string, hintText: string): GroundlaneError {
  return new GroundlaneError("INVALID_INPUT", "corpus-runtime", message, false, undefined, hint(hintCode, hintText));
}

function assertBoundedText(value: string, field: string, maxChars: number): void {
  if (!value || !value.trim()) {
    throw invalidInput(
      `${field} must be a non-empty string`,
      "corpus.invalid_input",
      `Provide a non-empty ${field}.`,
    );
  }
  if (value.length > maxChars) {
    throw invalidInput(
      `${field} exceeds maximum length of ${String(maxChars)} characters`,
      "corpus.output_limit",
      `Shorten ${field} to at most ${maxChars} characters.`,
    );
  }
}

function assertValidAcl(acl: readonly string[]): void {
  if (acl.length === 0) {
    throw invalidInput(
      "Source ACL must contain at least one entry",
      "corpus.invalid_input",
      "Provide at least one ACL entry for the enrolled source.",
    );
  }
  if (acl.length > MAX_ACL_ENTRIES) {
    throw invalidInput(
      `Source ACL exceeds maximum of ${String(MAX_ACL_ENTRIES)} entries`,
      "corpus.output_limit",
      `Reduce the source ACL to at most ${MAX_ACL_ENTRIES} entries.`,
    );
  }
  for (const entry of acl) {
    assertBoundedText(entry, "ACL entry", MAX_ACL_ENTRY_CHARS);
  }
}

// -- Caller and retention inputs ----------------------------------------------

export interface CallerPrincipal {
  readonly principalId: string;
  readonly roles: readonly string[];
}

export interface CorpusRetentionCaps {
  readonly operatorCapExpiresAt: string | null;
  readonly projectCapExpiresAt: string | null;
  readonly corpusCapExpiresAt: string | null;
  readonly sourceCapExpiresAt: string | null;
  readonly minimumBoundMs: number;
}

export const DEFAULT_RETENTION_MINIMUM_BOUND_MS = 3600_000;

export interface CreateCorpusInput {
  readonly displayName: string;
  readonly ownerId: string;
  readonly tenantId: string;
  readonly callerExpiresAt: string | null;
  readonly caps?: CorpusRetentionCaps;
}

export interface EnrollSourceInput {
  readonly sourceId: string;
  readonly contentHash: string;
  readonly acl: readonly string[];
  readonly retentionPolicy: string;
  readonly deletionPolicy: string;
  readonly lifecycleProvenance: string;
  readonly citationProvenance: string;
  readonly backendProvenance: string;
  readonly callerExpiresAt: string | null;
  readonly cacheBindings?: readonly string[];
}

export interface UpdateSourceInput {
  readonly contentHash?: string;
  readonly acl?: readonly string[];
  readonly deletionPolicy?: string;
  readonly citationProvenance?: string;
}

// -- Public views (never carry backend-internal IDs) ---------------------------

export interface CorpusView {
  readonly corpusId: string;
  readonly displayName: string;
  readonly state: CorpusState;
  readonly sourceCount: number;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
}

export interface CorpusStatusView extends CorpusView {
  readonly enrolledCount: number;
  readonly manifest: CorpusManifest;
  readonly deletion: DeletionStatus;
  readonly warnings: readonly string[];
}

export interface ScopedCorpusSearchResult {
  readonly sourceId: string;
  readonly contentHash: string;
  readonly snippet: string;
  readonly score: number;
  readonly provenance: SearchResultProvenance;
}

export interface ScopedCorpusSearchResponse {
  readonly toolFamily: typeof SCOPED_CORPUS_TOOL_FAMILY;
  readonly corpusId: string;
  readonly query: string;
  readonly results: readonly ScopedCorpusSearchResult[];
  readonly warnings: readonly string[];
}

export interface PublicWebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly provenance: SearchResultProvenance;
}

export interface PublicWebSearchResponse {
  readonly toolFamily: typeof PUBLIC_WEB_TOOL_FAMILY;
  readonly query: string;
  readonly results: readonly PublicWebSearchResult[];
}

/**
 * PRD 724/745: tool family is derived from source kind so scoped corpus
 * results can never be routed or labeled as public web search.
 */
export function resolveSearchToolFamily(sourceKind: SearchSourceKind): SearchToolFamily {
  return sourceKind === "corpus" ? SCOPED_CORPUS_TOOL_FAMILY : PUBLIC_WEB_TOOL_FAMILY;
}

/**
 * Deterministic fake public-web result used only to prove the family and
 * provenance boundary against scoped corpus search in tests.
 */
export function fakePublicWebSearch(
  query: string,
  provider: string,
  backend: string,
  now: Date,
): PublicWebSearchResponse {
  assertBoundedText(query, "Search query", MAX_SEARCH_QUERY_CHARS);
  assertBoundedText(provider, "Provider", MAX_ACL_ENTRY_CHARS);
  assertBoundedText(backend, "Backend", MAX_ACL_ENTRY_CHARS);
  const provenance: SearchResultProvenance = {
    sourceKind: "public_web",
    provider,
    backend,
    corpusBoundary: null,
    freshnessTimestamp: now.toISOString(),
  };
  validateSearchResultLabeling(provenance);
  return {
    toolFamily: PUBLIC_WEB_TOOL_FAMILY,
    query,
    results: [
      {
        title: `Fake public result for ${query}`,
        url: "https://example.com/fake-public-result",
        snippet: "Deterministic fake public-web snippet for family boundary tests.",
        provenance,
      },
    ],
  };
}

// -- Backend adapter port ------------------------------------------------------

export interface BackendSearchHit {
  readonly sourceId: string;
  readonly contentHash: string;
  readonly snippet: string;
  readonly score: number;
}

/**
 * Backend-neutral corpus index port. Indexing/query/ranking live behind this
 * port; corpus identity, ACL, retention/deletion, and citation provenance
 * stay in the Groundlane manifest and never defer to backend IDs.
 */
export interface CorpusBackendPort {
  readonly backendName: string;
  createIndex(corpusId: string): string;
  enrollDocument(corpusId: string, sourceId: string, contentHash: string): void;
  removeDocument(corpusId: string, sourceId: string): void;
  searchDocuments(corpusId: string, query: string, maxResults: number): readonly BackendSearchHit[];
  deleteIndex(corpusId: string): void;
  backendHealthy(): boolean;
  indexHealthy(corpusId: string): boolean;
}

interface InMemoryIndex {
  key: string;
  docs: Map<string, string>;
  healthy: boolean;
}

/**
 * Deterministic in-memory fake backend. Internal index keys deliberately use
 * a backend-flavored `idx-mem-` shape to prove they never leak into public
 * corpus identity.
 */
export class InMemoryCorpusBackend implements CorpusBackendPort {
  readonly backendName = "mem-fake-v1";
  private seq = 0;
  private failDelete = false;
  private backendUp = true;
  private readonly indexes = new Map<string, InMemoryIndex>();

  setFailDelete(fail: boolean): void {
    this.failDelete = fail;
  }

  setBackendHealthy(healthy: boolean): void {
    this.backendUp = healthy;
  }

  setIndexHealthy(corpusId: string, healthy: boolean): void {
    const index = this.indexes.get(corpusId);
    if (index === undefined) {
      throw invalidInput(
        `Unknown corpus "${corpusId}"`,
        "corpus.invalid_input",
        "Create the corpus before changing backend health.",
      );
    }
    index.healthy = healthy;
  }

  internalIndexKeyCount(): number {
    return this.indexes.size;
  }

  createIndex(corpusId: string): string {
    this.seq += 1;
    const key = `idx-mem-${this.seq.toString(16).padStart(4, "0")}`;
    this.indexes.set(corpusId, { key, docs: new Map(), healthy: true });
    return key;
  }

  enrollDocument(corpusId: string, sourceId: string, contentHash: string): void {
    const index = this.requireIndex(corpusId);
    index.docs.set(sourceId, contentHash);
  }

  removeDocument(corpusId: string, sourceId: string): void {
    const index = this.requireIndex(corpusId);
    index.docs.delete(sourceId);
  }

  searchDocuments(corpusId: string, _query: string, maxResults: number): readonly BackendSearchHit[] {
    const index = this.requireIndex(corpusId);
    const hits: BackendSearchHit[] = [];
    for (const [sourceId, contentHash] of index.docs) {
      if (hits.length >= maxResults) break;
      hits.push({
        sourceId,
        contentHash,
        snippet: `Enrolled source ${sourceId}`,
        score: 1,
      });
    }
    return hits;
  }

  deleteIndex(corpusId: string): void {
    if (this.failDelete) {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "corpus-backend",
        "Corpus backend deletion failed; derived index removal is pending",
        true,
        undefined,
        hint("corpus.backend_delete_pending", "The backend did not finish deleting the derived index. Poll corpus status and retry delete."),
      );
    }
    this.indexes.delete(corpusId);
  }

  backendHealthy(): boolean {
    return this.backendUp;
  }

  indexHealthy(corpusId: string): boolean {
    return this.indexes.get(corpusId)?.healthy ?? false;
  }

  private requireIndex(corpusId: string): InMemoryIndex {
    const index = this.indexes.get(corpusId);
    if (index === undefined) {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "corpus-backend",
        "Corpus backend index is unavailable",
        true,
        undefined,
        hint("corpus.backend_unavailable", "The corpus backend index is unavailable. Retry after the backend recovers."),
      );
    }
    return index;
  }
}

// -- Corpus store (manifest truth source) ---------------------------------------

interface CorpusRecord {
  corpusId: string;
  displayName: string;
  ownerId: string;
  tenantId: string;
  readerRoles: readonly string[];
  state: CorpusState;
  enrollments: Map<string, StoredEnrollment>;
  backendIndexKey: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  deletion: DeletionStatus;
}

/**
 * Internal enrollment carrying the caller-declared ACL, deletion policy, and
 * lifecycle/citation provenance that the manifest (truth source) publishes.
 * Extra fields are assignment-compatible with the public CorpusEnrollment.
 */
interface StoredEnrollment extends CorpusEnrollment {
  acl: readonly string[];
  deletionPolicy: string;
  lifecycleProvenance: string;
  citationProvenance: string;
}

const BACKEND_PROVENANCE_LABEL = "mem-fake-v1";

function defaultCaps(): CorpusRetentionCaps {
  return {
    operatorCapExpiresAt: null,
    projectCapExpiresAt: null,
    corpusCapExpiresAt: null,
    sourceCapExpiresAt: null,
    minimumBoundMs: DEFAULT_RETENTION_MINIMUM_BOUND_MS,
  };
}

function toRetentionPolicy(caps: CorpusRetentionCaps): RetentionPolicy {
  return {
    operator: caps.operatorCapExpiresAt,
    project: caps.projectCapExpiresAt,
    corpus: caps.corpusCapExpiresAt,
    source: caps.sourceCapExpiresAt,
    minimumBoundMs: caps.minimumBoundMs,
  };
}

function manifestFromRecord(record: CorpusRecord): CorpusManifest {
  const sources: CorpusSourceManifestEntry[] = [];
  for (const enrollment of record.enrollments.values()) {
    if (enrollment.sourceRecord.lifecycle !== "enrolled") continue;
    sources.push({
      sourceId: enrollment.sourceId,
      contentHash: enrollment.sourceRecord.contentHash,
      acl: enrollment.acl,
      retentionPolicy: enrollment.expiresAt ?? "persistent",
      deletionPolicy: enrollment.deletionPolicy,
      lifecycleProvenance: enrollment.lifecycleProvenance,
      citationProvenance: enrollment.citationProvenance,
      backendProvenance: BACKEND_PROVENANCE_LABEL,
    });
  }
  // Deterministic order keeps manifest comparisons stable.
  sources.sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
  return {
    corpusId: record.corpusId,
    sources,
    updatedAt: record.updatedAt,
  };
}

export class CorpusStore {
  private seq = 0;
  private readonly records = new Map<string, CorpusRecord>();
  private readonly revokedCacheBindings = new Set<string>();

  constructor(
    private readonly backend: CorpusBackendPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  createCorpus(input: CreateCorpusInput): CorpusView {
    assertBoundedText(input.displayName, "Display name", MAX_DISPLAY_NAME_CHARS);
    assertBoundedText(input.ownerId, "Owner ID", MAX_ACL_ENTRY_CHARS);
    assertBoundedText(input.tenantId, "Tenant ID", MAX_ACL_ENTRY_CHARS);
    const caps = input.caps ?? defaultCaps();
    const expiresAt = resolveEnrollmentExpiry(
      input.callerExpiresAt,
      caps.operatorCapExpiresAt,
      caps.projectCapExpiresAt,
      caps.corpusCapExpiresAt,
      caps.sourceCapExpiresAt,
    );
    validateEnrollmentExpiry(expiresAt, caps.minimumBoundMs, this.now());

    this.seq += 1;
    const digest = createHash("sha256")
      .update(`${input.tenantId}:${input.ownerId}:${input.displayName}:${String(this.seq)}`)
      .digest("hex")
      .slice(0, 12);
    const corpusId = `${CORPUS_ID_PREFIX}${this.seq.toString(16).padStart(4, "0")}${digest}`;
    validateCorpusIdentity({ corpusId, displayName: input.displayName });

    let backendIndexKey: string;
    try {
      backendIndexKey = this.backend.createIndex(corpusId);
    } catch (error) {
      throw this.sanitizedBackendError(error);
    }

    const timestamp = this.now().toISOString();
    const record: CorpusRecord = {
      corpusId,
      displayName: input.displayName,
      ownerId: input.ownerId,
      tenantId: input.tenantId,
      readerRoles: ["role:reader", "role:writer"],
      state: "active",
      enrollments: new Map(),
      backendIndexKey,
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt,
      deletion: { derivedIndexDeleted: false, artifactDeleted: false, isComplete: false },
    };
    this.records.set(corpusId, record);
    return this.toView(record);
  }

  enrollSource(
    corpusId: string,
    input: EnrollSourceInput,
    caller: CallerPrincipal,
    caps?: CorpusRetentionCaps,
  ): CorpusEnrollment {
    const record = this.requireWritableRecord(corpusId, caller);
    assertBoundedText(input.sourceId, "Source ID", MAX_SOURCE_ID_CHARS);
    assertBoundedText(input.contentHash, "Content hash", MAX_CONTENT_HASH_CHARS);
    assertValidAcl(input.acl);
    const resolvedCaps = caps ?? defaultCaps();
    const expiresAt = resolveEnrollmentExpiry(
      input.callerExpiresAt,
      resolvedCaps.operatorCapExpiresAt,
      resolvedCaps.projectCapExpiresAt,
      resolvedCaps.corpusCapExpiresAt,
      resolvedCaps.sourceCapExpiresAt,
    );
    validateEnrollmentExpiry(expiresAt, resolvedCaps.minimumBoundMs, this.now());

    const existing = record.enrollments.get(input.sourceId);
    if (existing !== undefined && existing.sourceRecord.lifecycle === "enrolled") {
      // Re-enroll path: never extend or reset expiry.
      validateReEnroll(existing, expiresAt);
    }

    try {
      this.backend.enrollDocument(corpusId, input.sourceId, input.contentHash);
    } catch (error) {
      throw this.sanitizedBackendError(error);
    }

    const timestamp = this.now().toISOString();
    const enrolledAt = existing?.enrolledAt ?? timestamp;
    // Retention takes the earliest value: re-enroll keeps the existing expiry
    // unless the newly resolved expiry is earlier (never an extension).
    const effectiveExpiresAt = CorpusStore.earliestExpiry(existing?.expiresAt ?? null, expiresAt);
    const cacheBindings = input.cacheBindings ?? [];
    const sourceRecord: CorpusSourceRecord = {
      sourceId: input.sourceId,
      corpusId: record.corpusId,
      contentHash: input.contentHash,
      enrolledAt,
      lifecycle: "enrolled",
      cacheBindings,
    };
    const enrollment: StoredEnrollment = {
      sourceId: input.sourceId,
      corpusId: record.corpusId,
      enrolledAt,
      expiresAt: effectiveExpiresAt,
      retentionPolicy: toRetentionPolicy(resolvedCaps),
      sourceRecord,
      acl: input.acl,
      deletionPolicy: input.deletionPolicy,
      lifecycleProvenance: input.lifecycleProvenance,
      citationProvenance: input.citationProvenance,
    };
    record.enrollments.set(input.sourceId, enrollment);
    record.updatedAt = timestamp;
    if (record.state === "active" || record.state === "degraded") {
      record.state = mapBackendFailureToState(
        this.backend.backendHealthy(),
        this.backend.indexHealthy(corpusId),
      );
    }
    return enrollment;
  }

  updateSource(
    corpusId: string,
    sourceId: string,
    update: UpdateSourceInput,
    caller: CallerPrincipal,
  ): CorpusEnrollment {
    const record = this.requireWritableRecord(corpusId, caller);
    const existing = record.enrollments.get(sourceId);
    if (existing === undefined || existing.sourceRecord.lifecycle !== "enrolled") {
      throw invalidInput(
        `Source "${sourceId}" is not enrolled`,
        "corpus.invalid_input",
        "Enroll the source before updating it.",
      );
    }
    if (update.contentHash !== undefined) {
      assertBoundedText(update.contentHash, "Content hash", MAX_CONTENT_HASH_CHARS);
    }
    if (update.acl !== undefined) {
      assertValidAcl(update.acl);
    }
    // Update path cannot touch expiry by construction: no expiry field exists
    // on UpdateSourceInput, so re-enroll can never reset or extend it.
    const nextHash = update.contentHash ?? existing.sourceRecord.contentHash;
    try {
      this.backend.enrollDocument(corpusId, sourceId, nextHash);
    } catch (error) {
      throw this.sanitizedBackendError(error);
    }
    const previous = existing;
    const updated: StoredEnrollment = {
      ...previous,
      sourceRecord: {
        ...existing.sourceRecord,
        contentHash: nextHash,
      },
      ...(update.acl !== undefined ? { acl: update.acl } : {}),
      ...(update.deletionPolicy !== undefined ? { deletionPolicy: update.deletionPolicy } : {}),
      ...(update.citationProvenance !== undefined
        ? { citationProvenance: update.citationProvenance }
        : {}),
    };
    record.enrollments.set(sourceId, updated);
    record.updatedAt = this.now().toISOString();
    return updated;
  }

  rebuildDerivedIndex(corpusId: string, caller: CallerPrincipal): CorpusManifest {
    const record = this.requireWritableRecord(corpusId, caller);
    const before = manifestFromRecord(record);
    try {
      for (const enrollment of record.enrollments.values()) {
        if (enrollment.sourceRecord.lifecycle !== "enrolled") continue;
        this.backend.enrollDocument(
          corpusId,
          enrollment.sourceId,
          enrollment.sourceRecord.contentHash,
        );
      }
    } catch (error) {
      throw this.sanitizedBackendError(error);
    }
    const after = manifestFromRecord(record);
    // The manifest is the truth source: a derived-index rebuild must not
    // change identity, membership, or content hashes.
    verifyManifestStableAfterRebuild(before, after);
    record.updatedAt = this.now().toISOString();
    return after;
  }

  removeSource(
    corpusId: string,
    sourceId: string,
    caller: CallerPrincipal,
  ): { sourceId: string; lifecycle: "removed" } {
    const record = this.requireWritableRecord(corpusId, caller);
    const existing = record.enrollments.get(sourceId);
    if (existing === undefined || existing.sourceRecord.lifecycle !== "enrolled") {
      throw invalidInput(
        `Source "${sourceId}" is not enrolled`,
        "corpus.invalid_input",
        "Only an enrolled source can be removed.",
      );
    }
    for (const binding of existing.sourceRecord.cacheBindings) {
      this.revokedCacheBindings.add(binding);
    }
    try {
      this.backend.removeDocument(corpusId, sourceId);
    } catch (error) {
      throw this.sanitizedBackendError(error);
    }
    record.enrollments.set(sourceId, {
      ...existing,
      sourceRecord: {
        ...existing.sourceRecord,
        lifecycle: "removed",
        cacheBindings: [],
      },
    });
    record.updatedAt = this.now().toISOString();
    return { sourceId, lifecycle: "removed" };
  }

  corpusStatus(corpusId: string, caller: CallerPrincipal): CorpusStatusView {
    const record = this.requireReadableRecord(corpusId, caller);
    validateDeletionStatus(record.deletion);
    let state = record.state;
    if (state !== "deleting" && state !== "deleted") {
      state = mapBackendFailureToState(
        this.backend.backendHealthy(),
        this.backend.indexHealthy(corpusId),
      );
    }
    const warnings: string[] = [];
    if (state === "degraded") {
      warnings.push("Corpus backend is degraded; freshness may be stale.");
    }
    if (state === "deleting") {
      warnings.push("Corpus deletion is in progress; access is revoked.");
    }
    let enrolledCount = 0;
    for (const enrollment of record.enrollments.values()) {
      if (enrollment.sourceRecord.lifecycle === "enrolled") enrolledCount += 1;
    }
    return {
      ...this.toView(record, state),
      enrolledCount,
      manifest: manifestFromRecord(record),
      deletion: record.deletion,
      warnings,
    };
  }

  searchCorpus(
    corpusId: string,
    query: string,
    caller: CallerPrincipal,
    maxResults?: number,
  ): ScopedCorpusSearchResponse {
    const record = this.requireReadableRecord(corpusId, caller);
    if (record.state === "deleted" || record.state === "deleting") {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "corpus-runtime",
        "Corpus access was revoked; the corpus is deleted or deletion is in progress",
        false,
        undefined,
        hint("corpus.access_revoked", "This corpus was deleted. Its sources and cache bindings are no longer searchable."),
      );
    }
    assertBoundedText(query, "Search query", MAX_SEARCH_QUERY_CHARS);
    const limit = maxResults ?? DEFAULT_SEARCH_RESULTS;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) {
      throw invalidInput(
        `maxResults must be an integer between 1 and ${String(MAX_SEARCH_RESULTS)}`,
        "corpus.invalid_input",
        `Pass maxResults between 1 and ${MAX_SEARCH_RESULTS}.`,
      );
    }
    let hits: readonly BackendSearchHit[];
    try {
      hits = this.backend.searchDocuments(corpusId, query, limit);
    } catch (error) {
      throw this.sanitizedBackendError(error);
    }
    const warnings: string[] = [];
    if (!this.backend.backendHealthy() || !this.backend.indexHealthy(corpusId)) {
      warnings.push("Corpus backend is degraded; results may be stale.");
    }
    const results: ScopedCorpusSearchResult[] = [];
    for (const hit of hits) {
      const enrollment = record.enrollments.get(hit.sourceId);
      if (enrollment === undefined || enrollment.sourceRecord.lifecycle !== "enrolled") continue;
      if (!this.canSeeSource(record, caller, enrollment)) continue;
      const provenance: SearchResultProvenance = {
        sourceKind: "corpus",
        provider: "internal",
        backend: this.backend.backendName,
        corpusBoundary: record.corpusId,
        freshnessTimestamp: this.now().toISOString(),
      };
      validateSearchResultLabeling(provenance);
      results.push({
        sourceId: hit.sourceId,
        contentHash: hit.contentHash,
        snippet: hit.snippet,
        score: hit.score,
        provenance,
      });
      if (results.length >= limit) break;
    }
    if (results.length === 0 && record.enrollments.size > 0) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "corpus-runtime",
        "Corpus access denied for all enrolled sources",
        false,
        undefined,
        hint("corpus.access_denied", "The caller is not in any enrolled source ACL. Ask the corpus owner for access."),
      );
    }
    return {
      toolFamily: SCOPED_CORPUS_TOOL_FAMILY,
      corpusId: record.corpusId,
      query,
      results,
      warnings,
    };
  }

  deleteCorpus(corpusId: string, caller: CallerPrincipal): DeletionStatus {
    const record = this.requireWritableRecord(corpusId, caller, true);
    if (record.deletion.isComplete && record.state === "deleted") {
      return record.deletion;
    }
    // Immediate access revocation: every enrolled source is revoked and its
    // cache bindings can never hit again, before backend cleanup runs.
    if (record.state !== "deleting") {
      for (const [sourceId, enrollment] of record.enrollments) {
        if (enrollment.sourceRecord.lifecycle !== "enrolled") continue;
        const revoked = revokeEnrollment(enrollment);
        for (const binding of revoked.cacheBindingsInvalidated) {
          this.revokedCacheBindings.add(binding);
        }
        // revokeEnrollment returns the base contract type; reattach the
        // stored ACL/provenance so the manifest shape stays intact.
        const stored: StoredEnrollment = {
          ...enrollment,
          ...revoked.enrollment,
          sourceRecord: revoked.enrollment.sourceRecord,
        };
        record.enrollments.set(sourceId, stored);
      }
      record.state = "deleting";
    }
    let derivedIndexDeleted = false;
    try {
      this.backend.deleteIndex(corpusId);
      derivedIndexDeleted = true;
    } catch {
      // Backend cleanup is pending: report incomplete deletion, never throw
      // away the revocation above and never claim completion.
      record.deletion = {
        derivedIndexDeleted: false,
        artifactDeleted: false,
        isComplete: false,
      };
      validateDeletionStatus(record.deletion);
      record.updatedAt = this.now().toISOString();
      return record.deletion;
    }
    const artifactDeleted = true;
    record.deletion = { derivedIndexDeleted, artifactDeleted, isComplete: true };
    validateDeletionStatus(record.deletion);
    record.state = "deleted";
    record.updatedAt = this.now().toISOString();
    return record.deletion;
  }

  isCacheBindingHittable(binding: string): boolean {
    return !this.revokedCacheBindings.has(binding);
  }

  private static earliestExpiry(
    existing: string | null,
    resolved: string | null,
  ): string | null {
    if (existing === null) return resolved;
    if (resolved === null) return existing;
    return new Date(resolved).getTime() < new Date(existing).getTime() ? resolved : existing;
  }

  private toView(record: CorpusRecord, state?: CorpusState): CorpusView {
    return {
      corpusId: record.corpusId,
      displayName: record.displayName,
      state: state ?? record.state,
      sourceCount: record.enrollments.size,
      updatedAt: record.updatedAt,
      expiresAt: record.expiresAt,
    };
  }

  private requireRecord(corpusId: string): CorpusRecord {
    const record = this.records.get(corpusId);
    if (record === undefined) {
      throw invalidInput(
        "Unknown corpus",
        "corpus.invalid_input",
        "Create the corpus before operating on it.",
      );
    }
    return record;
  }

  private canWrite(record: CorpusRecord, caller: CallerPrincipal): boolean {
    if (caller.principalId === record.ownerId) return true;
    return caller.roles.includes("role:writer");
  }

  private canRead(record: CorpusRecord, caller: CallerPrincipal): boolean {
    if (caller.principalId === record.ownerId) return true;
    return caller.roles.some((role) => record.readerRoles.includes(role));
  }

  private canSeeSource(
    record: CorpusRecord,
    caller: CallerPrincipal,
    enrollment: StoredEnrollment,
  ): boolean {
    if (caller.principalId === record.ownerId) return true;
    return caller.roles.some((role) => enrollment.acl.includes(role));
  }

  private requireWritableRecord(
    corpusId: string,
    caller: CallerPrincipal,
    allowDeleting = false,
  ): CorpusRecord {
    const record = this.requireRecord(corpusId);
    if (!this.canWrite(record, caller)) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "corpus-runtime",
        "Corpus access denied for this caller",
        false,
        undefined,
        hint("corpus.access_denied", "The caller is not the corpus owner and has no writer role."),
      );
    }
    if (record.state === "deleted") {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "corpus-runtime",
        "Corpus access was revoked; the corpus is deleted",
        false,
        undefined,
        hint("corpus.access_revoked", "This corpus was deleted and cannot be modified."),
      );
    }
    if (record.state === "deleting" && !allowDeleting) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "corpus-runtime",
        "Corpus access was revoked; deletion is in progress",
        false,
        undefined,
        hint("corpus.access_revoked", "Deletion is in progress. Poll corpus status until it completes."),
      );
    }
    return record;
  }

  private requireReadableRecord(corpusId: string, caller: CallerPrincipal): CorpusRecord {
    const record = this.requireRecord(corpusId);
    if (!this.canRead(record, caller)) {
      throw new GroundlaneError(
        "INVALID_INPUT",
        "corpus-runtime",
        "Corpus access denied for this caller",
        false,
        undefined,
        hint("corpus.access_denied", "The caller is not the corpus owner and has no reader role."),
      );
    }
    return record;
  }

  private sanitizedBackendError(error: unknown): GroundlaneError {
    if (error instanceof GroundlaneError) {
      // Re-map without leaking backend internals: keep only the stable code
      // and a bounded message.
      return new GroundlaneError(
        error.code,
        "corpus-runtime",
        "Corpus backend operation failed",
        error.retryable,
        undefined,
        hint("corpus.backend_error", "The corpus backend failed. Poll corpus status; the manifest is unchanged."),
      );
    }
    return new GroundlaneError(
      "UPSTREAM_ERROR",
      "corpus-runtime",
      "Corpus backend operation failed",
      true,
      undefined,
      hint("corpus.backend_error", "The corpus backend failed. Poll corpus status; the manifest is unchanged."),
    );
  }
}

// -- Durable async retry idempotency guard --------------------------------------

export interface IdempotentEffect<T> {
  readonly result: T;
  readonly providerTaskCreated: boolean;
  readonly paidCallCompleted: boolean;
  readonly artifactWriteCompleted: boolean;
}

export interface IdempotentRunResult<T> {
  readonly key: string;
  readonly reused: boolean;
  readonly result: T;
}

export interface UnfinishedAttemptFlags {
  readonly providerTaskCreated: boolean;
  readonly paidCallCompleted: boolean;
  readonly artifactWriteCompleted: boolean;
}

interface StoredAttempt {
  attemptId: string;
  guard: RetryIdempotencyGuard;
  result: unknown;
  hasResult: boolean;
}

/**
 * PRD 667/722: durable retry guard. The first completed attempt stores its
 * result; retries under the same key reuse it without re-executing the
 * effect. A retry that would re-create an already-created provider task,
 * re-run a completed paid call, or rewrite a completed artifact throws
 * instead of double-billing or duplicating writes.
 */
export class IdempotencyStore {
  private readonly records = new Map<string, StoredAttempt>();

  getGuard(key: string): RetryIdempotencyGuard | null {
    return this.records.get(key)?.guard ?? null;
  }

  recordUnfinishedAttempt(
    key: string,
    attemptId: string,
    flags: UnfinishedAttemptFlags,
  ): void {
    if (!key) {
      throw invalidInput("Idempotency key must be non-empty", "corpus.invalid_input", "Provide a non-empty idempotency key.");
    }
    if (!attemptId) {
      throw invalidInput("Attempt ID must be non-empty", "corpus.invalid_input", "Provide a non-empty attempt ID.");
    }
    const existing = this.records.get(key);
    if (existing?.hasResult === true) {
      throw invalidInput(
        "Idempotency key already has a completed result",
        "corpus.invalid_input",
        "Reuse the stored result instead of recording a new attempt.",
      );
    }
    this.records.set(key, {
      attemptId,
      guard: {
        idempotencyKey: key,
        previousAttemptId: attemptId,
        providerTaskCreated: flags.providerTaskCreated,
        paidCallCompleted: flags.paidCallCompleted,
        artifactWriteCompleted: flags.artifactWriteCompleted,
      },
      result: null,
      hasResult: false,
    });
  }

  run<T>(key: string, attemptId: string, effect: () => IdempotentEffect<T>): IdempotentRunResult<T> {
    if (!key) {
      throw invalidInput("Idempotency key must be non-empty", "corpus.invalid_input", "Provide a non-empty idempotency key.");
    }
    if (!attemptId) {
      throw invalidInput("Attempt ID must be non-empty", "corpus.invalid_input", "Provide a non-empty attempt ID.");
    }
    const existing = this.records.get(key);
    if (existing !== undefined && existing.hasResult) {
      const replay = validateRetryIdempotency(existing.guard, existing.result);
      return { key, reused: replay.reused, result: replay.result as T };
    }
    const previous = existing?.guard ?? {
      idempotencyKey: key,
      previousAttemptId: null,
      providerTaskCreated: false,
      paidCallCompleted: false,
      artifactWriteCompleted: false,
    };
    // Execute the effect exactly once per run call. Duplicate protection is
    // enforced below before anything is stored.
    const produced = effect();
    if (existing !== undefined) {
      // Retry after an unfinished attempt: re-creating billable or mutating
      // work that already happened must throw, not duplicate.
      validateProviderTaskNotDuplicated({
        idempotencyKey: key,
        previousAttemptId: existing.attemptId,
        providerTaskCreated: previous.providerTaskCreated && produced.providerTaskCreated,
        paidCallCompleted: false,
        artifactWriteCompleted: false,
      });
      validatePaidCallNotDuplicated({
        idempotencyKey: key,
        previousAttemptId: existing.attemptId,
        providerTaskCreated: false,
        paidCallCompleted: previous.paidCallCompleted && produced.paidCallCompleted,
        artifactWriteCompleted: false,
      });
      validateArtifactWriteNotDuplicated({
        idempotencyKey: key,
        previousAttemptId: existing.attemptId,
        providerTaskCreated: false,
        paidCallCompleted: false,
        artifactWriteCompleted: previous.artifactWriteCompleted && produced.artifactWriteCompleted,
      });
    }
    const guard: RetryIdempotencyGuard = {
      idempotencyKey: key,
      previousAttemptId: previous.previousAttemptId ?? existing?.attemptId ?? attemptId,
      providerTaskCreated: previous.providerTaskCreated || produced.providerTaskCreated,
      paidCallCompleted: previous.paidCallCompleted || produced.paidCallCompleted,
      artifactWriteCompleted: previous.artifactWriteCompleted || produced.artifactWriteCompleted,
    };
    this.records.set(key, { attemptId, guard, result: produced.result, hasResult: true });
    return { key, reused: false, result: produced.result };
  }
}

/**
 * PRD 667: upstream cancel is only `confirmed` with an explicit provider
 * acknowledgment. Without it the status stays `uncertain` — never claimed.
 */
export function resolveUpstreamCancel(
  requested: boolean,
  providerAcknowledged: boolean,
): CancelAcknowledgmentStatus {
  return resolveCancelAcknowledgment(requested, providerAcknowledged);
}

// -- Durable state and storage-neutral ArtifactRef ports -------------------------

export interface DurableStateRecord {
  readonly key: string;
  readonly inlineBytes: number;
  readonly ref: DurableArtifactRef | null;
}

export interface DurableStateStorePort {
  get(key: string): DurableStateRecord | null;
  put(record: DurableStateRecord): void;
  delete(key: string): void;
}

/**
 * PRD 723: D1/DO/Workflow/Queue-shaped state holds small records only.
 * Inline bytes above the durable limit are rejected; large content must be
 * referenced via a storage-neutral ArtifactRef instead.
 */
export class InMemoryDurableStateStore implements DurableStateStorePort {
  private readonly records = new Map<string, DurableStateRecord>();

  get(key: string): DurableStateRecord | null {
    return this.records.get(key) ?? null;
  }

  put(record: DurableStateRecord): void {
    if (!record.key) {
      throw invalidInput("Durable state key must be non-empty", "corpus.invalid_input", "Provide a non-empty durable state key.");
    }
    validateDurableState(record.inlineBytes, { maxInlineBytes: MAX_INLINE_BYTES });
    if (record.ref !== null) {
      validateDurableArtifactRef(record.ref);
    }
    this.records.set(record.key, record);
  }

  delete(key: string): void {
    this.records.delete(key);
  }
}

export interface CreateDurableArtifactInput {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly contentHash: string;
  readonly byteSize: number;
  readonly retentionPolicy: string;
  readonly deletionPolicy: "on_expiry" | "on_owner_delete" | "manual";
  readonly expiresAt: string;
}

/**
 * PRD 667/723/744: builds a storage-neutral durable ArtifactRef with
 * tenant/owner binding, content hash, and retention/deletion policy.
 * The ref never carries a storage backend, bucket, binding, or endpoint.
 */
export function createDurableArtifact(input: CreateDurableArtifactInput): DurableArtifactRef {
  const ref: DurableArtifactRef = {
    tenantId: input.tenantId,
    ownerId: input.ownerId,
    contentHash: input.contentHash,
    byteSize: input.byteSize,
    retentionPolicy: input.retentionPolicy,
    expiresAt: input.expiresAt,
    deletionPolicy: input.deletionPolicy,
  };
  const keys = Object.keys(ref);
  for (const forbidden of ["storageBackend", "bucket", "region", "endpoint", "r2Binding"]) {
    if (keys.includes(forbidden)) {
      throw invalidInput(
        `Durable ArtifactRef must not carry storage field "${forbidden}"`,
        "corpus.invalid_input",
        "Keep the ArtifactRef storage-neutral; the deployment maps it to a backend.",
      );
    }
  }
  validateDurableArtifactRef(ref);
  return ref;
}

export type DeploymentTarget = "cloudflare" | "local";
export type ArtifactStorageName = "r2" | "in-memory-fake";

/**
 * PRD 723: deployment-side mapping from a storage-neutral ArtifactRef to the
 * concrete storage backend. Cloudflare maps to R2; the mapping lives here,
 * never on the ref itself.
 */
export function resolveStorageBackendName(deployment: DeploymentTarget): ArtifactStorageName {
  if (deployment === "cloudflare") return "r2";
  if (deployment === "local") return "in-memory-fake";
  throw invalidInput(
    "Unknown deployment target",
    "corpus.invalid_input",
    'Use deployment "cloudflare" or "local".',
  );
}

export interface ArtifactStorageBackendPort {
  readonly storageName: ArtifactStorageName;
  storeBlob(tenantId: string, ownerId: string, contentHash: string, bytes: Uint8Array): void;
  loadBlob(tenantId: string, ownerId: string, contentHash: string): Uint8Array;
  deleteBlob(tenantId: string, ownerId: string, contentHash: string): void;
}

/**
 * Deterministic in-memory fake for the storage backend port. Enforces
 * tenant/owner binding (cross-tenant reads fail closed with a generic
 * message that discloses nothing about existence) and content-hash match.
 */
export class InMemoryArtifactStorageBackend implements ArtifactStorageBackendPort {
  readonly storageName: ArtifactStorageName = "in-memory-fake";
  private readonly blobs = new Map<string, Uint8Array>();

  storeBlob(tenantId: string, ownerId: string, contentHash: string, bytes: Uint8Array): void {
    assertBoundedText(tenantId, "Tenant ID", MAX_ACL_ENTRY_CHARS);
    assertBoundedText(ownerId, "Owner ID", MAX_ACL_ENTRY_CHARS);
    assertBoundedText(contentHash, "Content hash", MAX_CONTENT_HASH_CHARS);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== contentHash) {
      throw invalidInput(
        "Content hash mismatch; blob was not stored",
        "corpus.invalid_input",
        "Store the blob with the SHA-256 hex digest of its exact bytes.",
      );
    }
    this.blobs.set(InMemoryArtifactStorageBackend.blobKey(tenantId, ownerId, contentHash), bytes.slice());
  }

  loadBlob(tenantId: string, ownerId: string, contentHash: string): Uint8Array {
    const blob = this.blobs.get(
      InMemoryArtifactStorageBackend.blobKey(tenantId, ownerId, contentHash),
    );
    if (blob === undefined) {
      throw invalidInput(
        "Artifact not found or access denied",
        "corpus.invalid_input",
        "Check the tenant/owner binding and content hash, then retry.",
      );
    }
    return blob.slice();
  }

  deleteBlob(tenantId: string, ownerId: string, contentHash: string): void {
    this.blobs.delete(InMemoryArtifactStorageBackend.blobKey(tenantId, ownerId, contentHash));
  }

  private static blobKey(tenantId: string, ownerId: string, contentHash: string): string {
    return `${tenantId}:${ownerId}:${contentHash}`;
  }
}
