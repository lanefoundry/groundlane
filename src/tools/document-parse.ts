import { createHash } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  DOCUMENT_ENGINE_VERSION,
  MAX_DOCUMENT_BYTES,
  parseBoundedDocument,
  type ParsedDocumentContent,
} from "../adapters/document/bounded-document-parser.js";
import {
  buildCanonicalEnvelopeFromAdapter,
  projectCanonicalDocument,
  type SourceIdentity,
} from "../core/canonical-document.js";
import { GroundlaneError, hint } from "../core/errors.js";
import {
  DEFAULT_CACHE_TTL_SECONDS,
  type CacheConfig,
  type CacheMode,
  type ParsedPayloadCacheKey,
} from "../core/document-cache-contract.js";
import { DurableDocumentCacheRepository } from "../core/durable-document-cache.js";
import { classifyDocumentBytes } from "../core/document-source.js";
import type { FetchPipeline } from "../core/fetch-pipeline.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

const inlineSourceSchema = z.object({
  kind: z.literal("inline"),
  dataBase64: z.string().min(1).max(Math.ceil(MAX_DOCUMENT_BYTES * 4 / 3) + 16),
  mimeType: z.string().trim().min(1).max(200),
  filename: z.string().trim().min(1).max(255),
}).strict();

const urlSourceSchema = z.object({
  kind: z.literal("url"),
  url: z.string().trim().url().max(2_048),
  filename: z.string().trim().min(1).max(255).optional(),
}).strict();

const artifactSourceSchema = z.object({
  kind: z.literal("artifact"),
  refId: z.string().trim().min(1).max(160),
  artifactKind: z.literal("source"),
}).strict();

const inputSchema = z.object({
  source: z.discriminatedUnion("kind", [inlineSourceSchema, urlSourceSchema, artifactSourceSchema]),
  output: z.enum(["markdown", "structured", "text", "all"]).default("markdown"),
  maxBytes: z.number().int().min(1_024).max(MAX_DOCUMENT_BYTES).optional(),
  maxPages: z.number().int().min(1).max(500).default(100),
  maxOutputChars: z.number().int().min(1_000).max(500_000).optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  cacheMode: z.enum(["use", "refresh", "bypass"]).default("use"),
  cacheTtlSeconds: z.number().int().min(60).max(2_592_000).optional(),
}).strict();

const sourceSpanSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page-bbox"), page: z.number().int().nonnegative(), x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive(), contentHash: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("char-offset"), start: z.number().int().nonnegative(), end: z.number().int().positive(), contentHash: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("sheet-cell"), sheet: z.string().min(1), startCell: z.string().min(1), endCell: z.string().min(1), contentHash: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("slide-shape"), slide: z.number().int().nonnegative(), shapeId: z.string().min(1), contentHash: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("media-time"), startMs: z.number().nonnegative(), endMs: z.number().positive(), contentHash: z.string().min(1) }).strict(),
]);

const documentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), blockId: z.string().min(1), content: z.string(), spans: z.array(sourceSpanSchema).optional() }).strict(),
  z.object({
    type: z.literal("table"),
    blockId: z.string().min(1),
    cells: z.array(z.object({ row: z.number().int().nonnegative(), col: z.number().int().nonnegative(), content: z.string(), rowSpan: z.number().int().positive().optional(), colSpan: z.number().int().positive().optional() }).strict()),
    spans: z.array(sourceSpanSchema).optional(),
  }).strict(),
  z.object({ type: z.literal("asset"), blockId: z.string().min(1), assetRef: z.string().min(1), mimeType: z.string().min(1), altText: z.string().optional(), spans: z.array(sourceSpanSchema).optional() }).strict(),
  z.object({ type: z.literal("formula"), blockId: z.string().min(1), expression: z.string(), format: z.enum(["latex", "mathml", "plain"]), spans: z.array(sourceSpanSchema).optional() }).strict(),
]);

const canonicalEnvelopeSchema = z.object({
  schemaVersion: z.string().min(1),
  documentId: z.string().min(1),
  canonicalContentId: z.string().min(1),
  sourceIdentity: z.object({ contentHash: z.string().min(1), url: z.string().optional(), filename: z.string().optional(), artifactRef: z.string().optional() }).strict(),
  blocks: z.array(documentBlockSchema),
  readingOrder: z.array(z.string().min(1)),
  status: z.enum(["success", "partial", "unsupported", "failed"]),
  capabilityStates: z.record(z.string(), z.enum(["available", "unsupported", "not_run", "failed"])),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
  provenance: z.object({ engine: z.string().min(1), model: z.string(), version: z.string().min(1), cost: z.number().nonnegative(), confidence: z.number().min(0).max(1) }).strict(),
  metadata: z.array(z.object({ key: z.string().min(1), value: z.string() }).strict()).optional(),
  citations: z.array(z.object({ citationId: z.string().min(1), label: z.string(), target: z.string(), blockId: z.string().optional() }).strict()).optional(),
}).strict();

const documentDataSchema = z.object({
  envelope: canonicalEnvelopeSchema,
  projection: z.object({
    projectionVersion: z.string(),
    sourceDocumentId: z.string(),
    canonicalContentId: z.string(),
    kind: z.enum(["markdown", "structured", "text", "all"]),
    content: z.string(),
    lossy: z.boolean(),
    omissions: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  mediaType: z.string(),
  bytes: z.number().int(),
  cached: z.boolean(),
  cache: z.object({
    requestedMode: z.enum(["use", "refresh", "bypass"]),
    enabled: z.boolean(),
    stored: z.boolean(),
    degraded: z.boolean().optional(),
    createdAt: z.number().int().optional(),
    expiresAt: z.number().int().optional(),
    ageSeconds: z.number().int().nonnegative().optional(),
    originalEngine: z.string().optional(),
    originalModel: z.string().optional(),
    error: z.string().optional(),
  }).strict(),
});

export interface ArtifactSourceReaderPort {
  readSource(
    refId: string,
    caller: { ownerId: string; credentialBinding: string },
  ): Promise<{
    bytes: Uint8Array;
    mimeType: string;
    filename: string;
    contentHash: string;
    expiresAt: string;
  }>;
}

export interface DocumentParseModuleOptions {
  pipeline: FetchPipeline;
  limiter: ConcurrencyLimiter;
  caller: { readonly ownerId: string; readonly credentialBinding: string };
  artifactReader?: ArtifactSourceReaderPort;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  maxOutputChars: number;
  cache?: DurableDocumentCacheRepository;
  cacheConfig?: CacheConfig;
}

function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw new GroundlaneError("INVALID_INPUT", "document_parse", "inline dataBase64 is malformed", false, undefined, hint("document.invalid_base64", "Encode the document bytes as canonical base64."));
  }
  const buffer = Buffer.from(value, "base64");
  if (buffer.byteLength === 0 || buffer.toString("base64") !== value) {
    throw new GroundlaneError("INVALID_INPUT", "document_parse", "inline dataBase64 is malformed", false, undefined, hint("document.invalid_base64", "Encode the document bytes as canonical base64."));
  }
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).slice();
}

function contentHash(bytes: Uint8Array): string {
  return `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
}

function documentId(ownerId: string, source: SourceIdentity, canonicalId: string): string {
  return `doc-${createHash("sha256").update(JSON.stringify({ ownerId, source, canonicalId, version: "1" })).digest("hex").slice(0, 32)}`;
}

function cacheSourceIdentity(source: unknown): string {
  return `source-${createHash("sha256").update(JSON.stringify(source)).digest("hex")}`;
}

function cacheKey(
  ownerId: string,
  sourceHash: string,
  mimeType: string,
  maxPages: number,
): ParsedPayloadCacheKey {
  return {
    ownershipScope: ownerId,
    contentHash: sourceHash,
    engineId: "groundlane",
    engineVersion: DOCUMENT_ENGINE_VERSION,
    modelId: "none",
    modelVersion: "none",
    normalizedOptions: JSON.stringify({ mimeType, maxPages }),
    schemaVersion: "canonical-document-v1",
    policyVersion: "document-policy-v1",
  };
}

function isParsedDocumentContent(value: unknown): value is ParsedDocumentContent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ParsedDocumentContent>;
  return Array.isArray(candidate.blocks) && Array.isArray(candidate.metadata) &&
    Array.isArray(candidate.warnings) && typeof candidate.capabilities === "object" &&
    candidate.capabilities !== null && typeof candidate.mediaType === "string";
}

function filenameFromUrl(url: string): string {
  const name = new URL(url).pathname.split("/").filter(Boolean).pop();
  if (name === undefined || name.length === 0) return "document";
  try { return decodeURIComponent(name).slice(0, 255); } catch { return name.slice(0, 255); }
}

function normalizeFetchedMime(mimeType: string, filename: string): string {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (normalized !== "" && normalized !== "application/octet-stream") return normalized;
  const extension = filename.toLowerCase().split(".").pop() ?? "";
  const byExtension: Readonly<Record<string, string>> = {
    pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet", odp: "application/vnd.oasis.opendocument.presentation",
    epub: "application/epub+zip", rtf: "application/rtf", eml: "message/rfc822", csv: "text/csv", txt: "text/plain", md: "text/markdown",
    json: "application/json", xml: "application/xml", html: "text/html", htm: "text/html",
  };
  return byExtension[extension] ?? normalized;
}

export function createDocumentParseModule(options: DocumentParseModuleOptions): McpModule {
  return {
    name: "document_parse",
    register(server: McpServer): void {
      server.registerTool(
        "document_parse",
        {
          description: "Parse a bounded inline, public-URL, or verified source artifact into Groundlane's versioned canonical document envelope and a deterministic projection. Stable deterministic profiles reject encrypted, malformed, over-limit, and known active or external package content.",
          inputSchema,
          outputSchema: resultEnvelopeSchema(documentDataSchema),
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (input, extra) => {
          const deadline = new Deadline(input.timeoutMs ?? options.requestTimeoutMs);
          try {
            const data = await withConcurrency(options.limiter, deadline, extra.signal, () =>
              withinDeadline(async (operationSignal) => {
                const maxBytes = Math.min(input.maxBytes ?? options.maxResponseBytes, options.maxResponseBytes, MAX_DOCUMENT_BYTES);
                let bytes: Uint8Array;
                let mimeType: string;
                let filename: string;
                let sourceIdentity: SourceIdentity;
                let cacheBindingIdentity: unknown;
                let requestedUrl: string | undefined;
                if (input.source.kind === "inline") {
                  bytes = decodeBase64(input.source.dataBase64);
                  mimeType = input.source.mimeType;
                  filename = input.source.filename;
                  sourceIdentity = { contentHash: contentHash(bytes), filename };
                  cacheBindingIdentity = { kind: "inline", ...sourceIdentity };
                } else if (input.source.kind === "url") {
                  const fetched = await options.pipeline.fetch({
                    url: input.source.url,
                    format: "text",
                    render: "never",
                    maxBytes,
                    maxOutputChars: Math.min(options.maxOutputChars, 10_000),
                    maxRedirects: 5,
                    deadline,
                  }, operationSignal);
                  bytes = fetched.raw.body;
                  filename = input.source.filename ?? filenameFromUrl(fetched.raw.finalUrl);
                  mimeType = normalizeFetchedMime(fetched.raw.contentType, filename);
                  sourceIdentity = { contentHash: contentHash(bytes), url: fetched.raw.finalUrl, filename };
                  requestedUrl = input.source.url;
                  cacheBindingIdentity = {
                    kind: "url",
                    requestedUrl: input.source.url,
                    finalUrl: fetched.raw.finalUrl,
                    contentHash: sourceIdentity.contentHash,
                    filename,
                  };
                } else {
                  if (options.artifactReader === undefined) {
                    throw new GroundlaneError("PROVIDER_UNAVAILABLE", "document_parse", "Artifact storage is not configured", false, undefined, hint("document.artifact_unavailable", "Use inline or public URL input, or configure the deployment artifact backend."));
                  }
                  const artifact = await options.artifactReader.readSource(input.source.refId, options.caller);
                  bytes = artifact.bytes;
                  mimeType = artifact.mimeType;
                  filename = artifact.filename;
                  if (contentHash(bytes) !== artifact.contentHash) {
                    throw new GroundlaneError("UPSTREAM_ERROR", "document_parse", "Artifact content integrity check failed");
                  }
                  sourceIdentity = { contentHash: artifact.contentHash, artifactRef: input.source.refId, filename };
                  cacheBindingIdentity = { kind: "artifact", ...sourceIdentity };
                }
                if (bytes.byteLength > maxBytes) {
                  throw new GroundlaneError("OUTPUT_LIMIT", "document_parse", "Document exceeds the configured byte limit", false, undefined, hint("document.output_limit", "Raise maxBytes within deployment policy or use a smaller document."));
                }
                classifyDocumentBytes(bytes, mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? mimeType, filename);
                const executeParse = async (): Promise<ParsedDocumentContent> =>
                  parseBoundedDocument({ bytes, declaredMime: mimeType, filename, signal: operationSignal, maxPages: input.maxPages });
                let parsed: ParsedDocumentContent;
                let cached = false;
                let cacheMetadata: {
                  requestedMode: CacheMode;
                  enabled: boolean;
                  stored: boolean;
                  degraded?: boolean;
                  createdAt?: number;
                  expiresAt?: number;
                  ageSeconds?: number;
                  originalEngine?: string;
                  originalModel?: string;
                  error?: string;
                } = {
                  requestedMode: input.cacheMode,
                  enabled: options.cache !== undefined,
                  stored: false,
                  ...(options.cache === undefined && input.cacheMode !== "bypass"
                    ? { degraded: true }
                    : {}),
                };
                if (options.cache === undefined) {
                  parsed = await executeParse();
                } else {
                  const nowMs = Date.now();
                  const cacheConfig = options.cacheConfig ?? {
                    enabled: true,
                    defaultTtlSeconds: DEFAULT_CACHE_TTL_SECONDS,
                  };
                  if (
                    input.cacheTtlSeconds !== undefined &&
                    cacheConfig.operatorMaxTtlSeconds !== undefined &&
                    input.cacheTtlSeconds > cacheConfig.operatorMaxTtlSeconds
                  ) {
                    throw new GroundlaneError(
                      "INVALID_INPUT",
                      "document_parse",
                      "cacheTtlSeconds exceeds the deployment maximum",
                      false,
                      undefined,
                      hint("document.cache_ttl_out_of_range", "Use document_policy to read the deployment cache maximum."),
                    );
                  }
                  const result = await options.cache.process(
                    cacheConfig,
                    {
                      mode: input.cacheMode,
                      key: cacheKey(options.caller.ownerId, sourceIdentity.contentHash, mimeType, input.maxPages),
                      sourceIdentity: cacheSourceIdentity(cacheBindingIdentity),
                      sourceVersion: sourceIdentity.contentHash,
                      ownershipScope: options.caller.ownerId,
                      nowMs,
                      ...(input.cacheTtlSeconds === undefined ? {} : { requestedTtlSeconds: input.cacheTtlSeconds }),
                      toolName: "document_parse",
                      networkPolicyChecked: true,
                      execute: async () => ({
                        data: await executeParse(),
                        provenance: { isOriginal: true, originalCost: 0, engine: "groundlane", model: "none" },
                      }),
                    },
                  );
                  if (!isParsedDocumentContent(result.data)) {
                    parsed = await executeParse();
                    cacheMetadata = { ...cacheMetadata, error: "Cached document payload was malformed" };
                  } else {
                    parsed = result.data;
                    cached = result.cached;
                    cacheMetadata = result.cached
                      ? {
                          ...cacheMetadata,
                          createdAt: result.hit.createdAt,
                          expiresAt: result.hit.expiresAt,
                          ageSeconds: result.hit.ageSeconds,
                          originalEngine: result.hit.billingProvenance.engine,
                          originalModel: result.hit.billingProvenance.model,
                        }
                      : {
                          ...cacheMetadata,
                          stored: result.stored,
                          ...(result.createdAt === undefined ? {} : { createdAt: result.createdAt }),
                          ...(result.expiresAt === undefined ? {} : { expiresAt: result.expiresAt }),
                          ...(result.degraded === undefined ? {} : { degraded: result.degraded }),
                          ...(result.cacheError === undefined ? {} : { error: result.cacheError }),
                        };
                  }
                }
                const provisional = buildCanonicalEnvelopeFromAdapter({
                  documentId: "document-pending-binding",
                  sourceIdentity,
                  blocks: parsed.blocks,
                  readingOrder: parsed.blocks.map((block) => block.blockId),
                  status: parsed.blocks.length === 0 ? "partial" : "success",
                  capabilityStates: parsed.capabilities,
                  provenance: { engine: "groundlane", model: "none", version: DOCUMENT_ENGINE_VERSION, cost: 0, confidence: 1 },
                  warnings: parsed.warnings,
                  metadata: [
                    ...parsed.metadata,
                    ...(requestedUrl === undefined ? [] : [{ key: "requestedUrl", value: requestedUrl }]),
                  ],
                });
                const envelope = { ...provisional, documentId: documentId(options.caller.ownerId, sourceIdentity, provisional.canonicalContentId) };
                const projection = projectCanonicalDocument(envelope, input.output);
                const outputLimit = Math.min(input.maxOutputChars ?? options.maxOutputChars, options.maxOutputChars);
                if (projection.content.length > outputLimit) {
                  throw new GroundlaneError("OUTPUT_LIMIT", "document_parse", "Document projection exceeds the configured output limit", false, undefined, hint("document.output_limit", "Request a narrower projection or use artifact output after configuring durable storage."));
                }
                return { envelope, projection, mediaType: parsed.mediaType, bytes: bytes.byteLength, cached, cache: cacheMetadata };
              }, deadline, extra.signal, "document_parse"),
            );
            return structuredToolResult({ ok: true, data });
          } catch (error) {
            return toolError(error, { tool: "document_parse" });
          }
        },
      );
    },
  };
}
