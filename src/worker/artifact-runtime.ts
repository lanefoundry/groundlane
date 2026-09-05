import { ZodError } from "zod";

import {
  DurableUploadArtifactService,
  type DurableArtifactRevocationPort,
  type DurableUploadCaller,
} from "../core/durable-upload-flow.js";
import { documentCacheBindingIdentity } from "../core/document-cache-contract.js";
import type { DurableRecordStorePort } from "../core/durable-store.js";
import { GroundlaneError, toGroundlaneError } from "../core/errors.js";
import type { ImmutableBlobPort } from "../core/immutable-blob.js";
import { classifyDocumentBytes } from "../core/document-source.js";
import { structuredToolError, structuredToolResult } from "../mcp/results.js";
import {
  documentUploadCompleteInputSchema,
  documentUploadCreateInputSchema,
  documentArtifactDeleteInputSchema,
} from "../tools/document-upload.js";
import { documentParseInputSchema } from "../tools/document-parse.js";
import {
  encodeArtifactParseBridgeMetadata,
  INTERNAL_ARTIFACT_METADATA_HEADER,
  INTERNAL_ARTIFACT_PARSE_PATH,
} from "../mcp/artifact-bridge.js";
import type { AuthenticatedPrincipal } from "./auth.js";
import { D1DurableRecordStore } from "./d1-durable-store.js";
import type { D1DatabaseLike } from "./d1-managed-store.js";
import { R2ImmutableBlobStore, type R2BucketLike } from "./r2-immutable-blob.js";
import { R2PresignedPutHandoff, type R2PutHandoff } from "./r2-presigned-put.js";
import { R2StagingBlobStore } from "./r2-staging-blob.js";
import { D1R2DocumentCacheRuntime } from "./d1-r2-document-cache.js";
import { createEdgeDocumentOutputRuntime } from "./document-output-runtime.js";
import type { DurableDocumentOutputRuntime } from "../core/durable-document-output.js";
import {
  createArtifactRetentionPolicy,
  type ArtifactRetentionPolicyOverrides,
} from "../core/artifact-retention-policy.js";

const ARTIFACT_TOOLS = new Set([
  "document_upload_create",
  "document_upload_complete",
  "document_artifact_delete",
]);

export interface EdgeArtifactsEnv {
  readonly MANAGED_TOKEN_D1?: D1DatabaseLike;
  readonly GROUNDLANE_ARTIFACTS?: R2BucketLike;
  readonly GROUNDLANE_INTERNAL_SIGNING_SECRET?: string;
  readonly R2_ACCOUNT_ID?: string;
  readonly R2_BUCKET_NAME?: string;
  readonly R2_ACCESS_KEY_ID?: string;
  readonly R2_SECRET_ACCESS_KEY?: string;
  readonly DOCUMENT_UPLOAD_MAX_TTL_SECONDS?: string;
  readonly DOCUMENT_ARTIFACT_MAX_TTL_SECONDS?: string;
  readonly DOCUMENT_CACHE_EDGE_ENABLED?: string;
  readonly DOCUMENT_OUTPUT_EDGE_ENABLED?: string;
}

function optionalInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  if (!/^\d+$/u.test(value)) throw new Error(`${label} must be an integer number of seconds`);
  return Number(value);
}

function retentionFromEnv(env: EdgeArtifactsEnv) {
  const uploadMaxTtlSeconds = optionalInteger(
    env.DOCUMENT_UPLOAD_MAX_TTL_SECONDS,
    "DOCUMENT_UPLOAD_MAX_TTL_SECONDS",
  );
  const artifactMaxTtlSeconds = optionalInteger(
    env.DOCUMENT_ARTIFACT_MAX_TTL_SECONDS,
    "DOCUMENT_ARTIFACT_MAX_TTL_SECONDS",
  );
  const overrides: ArtifactRetentionPolicyOverrides = {
    ...(uploadMaxTtlSeconds === undefined ? {} : { uploadMaxTtlSeconds }),
    ...(artifactMaxTtlSeconds === undefined ? {} : { artifactMaxTtlSeconds }),
  };
  return createArtifactRetentionPolicy(overrides);
}

export interface EdgeArtifactsDependencies {
  readonly now?: () => number;
  readonly records?: DurableRecordStorePort;
  readonly immutableBlobs?: ImmutableBlobPort;
  readonly staging?: R2StagingBlobStore;
  readonly presigner?: {
    create(input: Parameters<R2PresignedPutHandoff["create"]>[0]): Promise<R2PutHandoff>;
  };
  readonly documentCache?: Pick<D1R2DocumentCacheRuntime, "revokeAllSourceBindings">;
  readonly documentOutput?: Pick<DurableDocumentOutputRuntime, "revokeExternalSource">;
}

export function createArtifactCacheRevocationPort(
  env: EdgeArtifactsEnv,
  dependencies: EdgeArtifactsDependencies,
): DurableArtifactRevocationPort | undefined {
  const runtime = dependencies.documentCache ?? (
    env.DOCUMENT_CACHE_EDGE_ENABLED === "true" &&
      env.MANAGED_TOKEN_D1 !== undefined && env.GROUNDLANE_ARTIFACTS !== undefined
      ? new D1R2DocumentCacheRuntime({ db: env.MANAGED_TOKEN_D1, bucket: env.GROUNDLANE_ARTIFACTS })
      : undefined
  );
  const output = dependencies.documentOutput ?? (
    env.DOCUMENT_OUTPUT_EDGE_ENABLED === "true"
      ? createEdgeDocumentOutputRuntime(env, dependencies.now === undefined ? {} : { now: dependencies.now }).runtime
      : undefined
  );
  if (runtime === undefined && output === undefined) return undefined;
  return {
    async revoke(input): Promise<void> {
      await runtime?.revokeAllSourceBindings({
        ownershipScope: input.ownerId,
        sourceIdentity: documentCacheBindingIdentity({
          kind: "artifact",
          contentHash: input.contentHash,
          artifactRef: input.refId,
          filename: input.filename,
        }, input.credentialBinding),
        nowMs: input.nowMs,
      });
      if (output !== undefined) {
        const result = await output.revokeExternalSource(input.refId, {
          tenantId: "cloudflare", ownerId: input.ownerId, credentialBinding: input.credentialBinding,
        }, AbortSignal.timeout(30_000));
        if (result.cleanupPending) {
          throw new GroundlaneError("UPSTREAM_ERROR", "document-output", "Document output cleanup is pending", true);
        }
      }
    },
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function jsonRpcId(body: Record<string, unknown>): string | number | null {
  return typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
}

function jsonRpcResult(body: Record<string, unknown>, result: Record<string, unknown>, requestId: string): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: jsonRpcId(body),
    result: {
      ...result,
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "groundlane", version: "0.1.0" } },
    },
  }, { headers: { "x-request-id": requestId } });
}

function errorResult(error: unknown): Record<string, unknown> {
  const safe = error instanceof ZodError
    ? new GroundlaneError("INVALID_INPUT", "document_upload", "Upload request is invalid")
    : toGroundlaneError(error, "document_upload");
  return structuredToolError({
    ok: false,
    error: {
      code: safe.code,
      stage: safe.stage,
      message: safe.message,
      retryable: safe.retryable,
      ...(safe.hint === undefined ? {} : { hint: safe.hint }),
    },
  });
}

export async function edgeArtifactErrorResponse(
  request: Request,
  error: unknown,
  requestId: string,
): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = objectValue(await request.clone().json()) ?? {};
  } catch {
    // The edge caller only uses this after recognizing a JSON artifact call.
  }
  return jsonRpcResult(body, errorResult(error), requestId);
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function configured(env: EdgeArtifactsEnv, dependencies: EdgeArtifactsDependencies): boolean {
  const fullyInjected = dependencies.records !== undefined &&
    dependencies.immutableBlobs !== undefined &&
    dependencies.staging !== undefined &&
    dependencies.presigner !== undefined;
  return (dependencies.records !== undefined || env.MANAGED_TOKEN_D1 !== undefined) &&
    (dependencies.immutableBlobs !== undefined || env.GROUNDLANE_ARTIFACTS !== undefined) &&
    (dependencies.staging !== undefined || env.GROUNDLANE_ARTIFACTS !== undefined) &&
    (dependencies.presigner !== undefined || (
      (env.R2_ACCOUNT_ID ?? "").trim().length > 0 &&
      (env.R2_BUCKET_NAME ?? "").trim().length > 0 &&
      (env.R2_ACCESS_KEY_ID ?? "").trim().length > 0 &&
      (env.R2_SECRET_ACCESS_KEY ?? "").trim().length > 0
    )) &&
    (fullyInjected || (env.GROUNDLANE_INTERNAL_SIGNING_SECRET ?? "").trim().length > 0);
}

/** Authenticated Worker-edge upload control; all other MCP calls fall through. */
export async function maybeHandleEdgeArtifacts(
  request: Request,
  env: EdgeArtifactsEnv,
  principal: AuthenticatedPrincipal,
  credentialBinding: string,
  requestId: string,
  dependencies: EdgeArtifactsDependencies = {},
): Promise<Response | undefined> {
  if (!configured(env, dependencies)) return undefined;
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (request.method !== "POST" || mediaType !== "application/json") return undefined;
  let bodyValue: unknown;
  try {
    bodyValue = await request.clone().json();
  } catch {
    return undefined;
  }
  const body = objectValue(bodyValue);
  const params = objectValue(body?.params);
  const toolName = body?.method === "tools/call" && typeof params?.name === "string"
    ? params.name
    : undefined;
  if (body === undefined || toolName === undefined || !ARTIFACT_TOOLS.has(toolName)) return undefined;

  const bucket = env.GROUNDLANE_ARTIFACTS;
  const records = dependencies.records ?? new D1DurableRecordStore(env.MANAGED_TOKEN_D1 as D1DatabaseLike, "artifact-upload-v1");
  const immutableBlobs = dependencies.immutableBlobs ?? new R2ImmutableBlobStore(bucket as R2BucketLike);
  const staging = dependencies.staging ?? new R2StagingBlobStore(bucket as R2BucketLike);
  const presigner = dependencies.presigner ?? new R2PresignedPutHandoff({
    accountId: env.R2_ACCOUNT_ID ?? "",
    bucketName: env.R2_BUCKET_NAME ?? "",
    accessKeyId: env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? "",
  });
  const caller: DurableUploadCaller = { ownerId: principal.principalId, credentialBinding };
  const nowMs = (dependencies.now ?? Date.now)();

  try {
    const service = new DurableUploadArtifactService(
      records,
      immutableBlobs,
      retentionFromEnv(env),
      createArtifactCacheRevocationPort(env, dependencies),
    );
    const argumentsValue = objectValue(params?.arguments) ?? {};
    if (toolName === "document_artifact_delete") {
      const input = documentArtifactDeleteInputSchema.parse(argumentsValue);
      await service.deleteArtifact(input.refId, caller, nowMs);
      return jsonRpcResult(body, structuredToolResult({
        ok: true,
        data: { refId: input.refId, deleted: true as const },
      }), requestId);
    }
    if (toolName === "document_upload_create") {
      const input = documentUploadCreateInputSchema.parse(argumentsValue);
      const intent = await service.createIntent({
        idempotencyKey: input.idempotencyKey,
        declaredMime: input.declaredMime,
        declaredSize: input.declaredSize,
        filename: input.filename,
        ...(input.expectedDigest === undefined ? {} : { expectedDigest: input.expectedDigest }),
        ...(input.uploadTtlSeconds === undefined ? {} : { uploadTtlMs: input.uploadTtlSeconds * 1_000 }),
        ...(input.artifactTtlSeconds === undefined ? {} : { artifactTtlMs: input.artifactTtlSeconds * 1_000 }),
        nowMs,
      }, caller);
      const stagingKey = `staging/${await sha256(`groundlane-staging\u0000${intent.intentId}`)}`;
      const remainingSeconds = Math.max(60, Math.ceil((intent.expiresAt - nowMs) / 1_000));
      const upload = await presigner.create({
        stagingKey,
        contentType: intent.declaredMime,
        contentLength: intent.declaredSize,
        expiresInSeconds: remainingSeconds,
        metadata: {
          intentId: intent.intentId,
          ownerId: caller.ownerId,
          credentialHash: await sha256(caller.credentialBinding),
          expiresAt: intent.expiresAt,
          ...(intent.expectedDigest === null ? {} : { expectedDigest: intent.expectedDigest }),
        },
      });
      return jsonRpcResult(body, structuredToolResult({
        ok: true,
        data: {
          uploadIntentId: intent.intentId,
          upload,
          expiresAt: intent.expiresAt,
          maxBytes: intent.declaredSize,
          multipart: false,
        },
      }), requestId);
    }

    const input = documentUploadCompleteInputSchema.parse(argumentsValue);
    const intent = await service.getIntent(input.uploadIntentId, caller, nowMs);
    const stagingKey = `staging/${await sha256(`groundlane-staging\u0000${intent.intentId}`)}`;
    const bytes = await staging.get({
      stagingKey,
      intentId: intent.intentId,
      ownerId: caller.ownerId,
      credentialBinding: caller.credentialBinding,
      declaredMime: intent.declaredMime,
      declaredSize: intent.declaredSize,
      expiresAt: intent.expiresAt,
      nowMs,
    });
    if (bytes === null) {
      throw new GroundlaneError("INVALID_INPUT", "document_upload", "Uploaded staging object is unavailable");
    }
    const observed = classifyDocumentBytes(bytes, intent.declaredMime, intent.filename).sniffedMime;
    const ref = await service.finalize({
      intentId: intent.intentId,
      bytes,
      observedMime: observed,
      nowMs,
    }, caller);
    const removed = await staging.deleteIfIntent(stagingKey, intent.intentId);
    if (removed === "intent_mismatch") {
      throw new GroundlaneError("UPSTREAM_ERROR", "document_upload", "Staging cleanup failed", true);
    }
    return jsonRpcResult(body, structuredToolResult({
      ok: true,
      data: {
        refId: ref.refId,
        artifactKind: ref.artifactKind,
        contentHash: ref.contentHash,
        byteSize: ref.byteSize,
        createdAt: ref.createdAt,
        expiresAt: ref.expiresAt,
        verified: ref.verified,
      },
    }), requestId);
  } catch (error) {
    return jsonRpcResult(body, errorResult(error), requestId);
  }
}

/** Resolve only ArtifactRef document_parse calls into a bounded internal binary request. */
export async function maybePrepareArtifactParseRequest(
  request: Request,
  env: EdgeArtifactsEnv,
  principal: AuthenticatedPrincipal,
  credentialBinding: string,
  dependencies: EdgeArtifactsDependencies = {},
): Promise<Request | undefined> {
  if (!configured(env, dependencies) || request.method !== "POST") return undefined;
  let bodyValue: unknown;
  try {
    bodyValue = await request.clone().json();
  } catch {
    return undefined;
  }
  const body = objectValue(bodyValue);
  const params = objectValue(body?.params);
  if (body?.method !== "tools/call" || params?.name !== "document_parse") return undefined;
  const rawArguments = objectValue(params.arguments);
  if (objectValue(rawArguments?.source)?.kind !== "artifact") return undefined;
  const input = documentParseInputSchema.parse(rawArguments);
  if (input.source.kind !== "artifact") return undefined;
  const bucket = env.GROUNDLANE_ARTIFACTS;
  const records = dependencies.records ?? new D1DurableRecordStore(env.MANAGED_TOKEN_D1 as D1DatabaseLike, "artifact-upload-v1");
  const immutableBlobs = dependencies.immutableBlobs ?? new R2ImmutableBlobStore(bucket as R2BucketLike);
  const service = new DurableUploadArtifactService(records, immutableBlobs, retentionFromEnv(env));
  const nowMs = (dependencies.now ?? Date.now)();
  const maximum = Math.min(input.maxBytes ?? 10 * 1024 * 1024, 10 * 1024 * 1024);
  const artifact = await service.readArtifact(input.source.refId, {
    ownerId: principal.principalId,
    credentialBinding,
  }, nowMs, maximum);
  const { source: _source, ...inputWithoutSource } = input;
  void _source;
  const metadata = encodeArtifactParseBridgeMetadata({
    id: jsonRpcId(body),
    deadlineAt: nowMs + (input.timeoutMs ?? 30_000),
    input: inputWithoutSource,
    source: {
      refId: artifact.ref.refId,
      contentHash: artifact.ref.contentHash,
      mimeType: artifact.mimeType,
      filename: artifact.filename,
      expiresAt: artifact.ref.expiresAt,
    },
  });
  const headers = new Headers({
    "content-type": "application/octet-stream",
    [INTERNAL_ARTIFACT_METADATA_HEADER]: metadata,
  });
  return new Request(new URL(INTERNAL_ARTIFACT_PARSE_PATH, request.url), {
    method: "POST",
    headers,
    body: new Uint8Array(artifact.bytes).buffer,
    signal: request.signal,
  });
}
