import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  getDocumentPolicyView,
  type DocumentPolicyOverrides,
  type DocumentPolicyBoundsOverrides,
  type PolicyExpiryRequest,
} from "../core/document-policy.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

const expiryRequestSchema = z.object({
  relativeTtlSeconds: z.number().int().min(0).max(31_536_000).optional(),
  absoluteExpiresAtMs: z.number().int().min(0).optional(),
});

export const documentPolicyInputSchema = z.object({
  cache: expiryRequestSchema.optional(),
  upload: expiryRequestSchema.optional(),
  artifact: expiryRequestSchema.optional(),
  corpus: expiryRequestSchema.optional(),
});

const policySectionSchema = z.object({
  defaultTtlSeconds: z.number().int(),
  minTtlSeconds: z.number().int(),
  maxTtlSeconds: z.number().int(),
  effectiveExpiresAtMs: z.number().int(),
  effectiveExpiresAt: z.string(),
});

const documentPolicyDataSchema = z.object({
  cache: policySectionSchema,
  upload: policySectionSchema,
  artifact: policySectionSchema,
  corpus: policySectionSchema,
  runtime: z.object({
    cacheEnabled: z.boolean(),
    cacheDefaultMode: z.literal("use"),
    uploadAvailable: z.boolean(),
    artifactSourceAvailable: z.boolean(),
    durableAsyncJobsAvailable: z.boolean(),
    durableCorporaAvailable: z.boolean(),
    stagingCleanupWindowSeconds: z.number().int().positive(),
    ownershipScope: z.literal("principal"),
  }).strict(),
});

type ExpiryInput = {
  readonly relativeTtlSeconds?: number | undefined;
  readonly absoluteExpiresAtMs?: number | undefined;
};

function toExpiryRequest(input: ExpiryInput | undefined): PolicyExpiryRequest | undefined {
  if (input === undefined) return undefined;
  const request: { relativeTtlSeconds?: number; absoluteExpiresAtMs?: number } = {};
  if (input.relativeTtlSeconds !== undefined) {
    request.relativeTtlSeconds = input.relativeTtlSeconds;
  }
  if (input.absoluteExpiresAtMs !== undefined) {
    request.absoluteExpiresAtMs = input.absoluteExpiresAtMs;
  }
  return request;
}

export interface DocumentPolicyModuleOptions {
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  overrides?: DocumentPolicyOverrides;
  bounds?: DocumentPolicyBoundsOverrides;
  runtime?: {
    readonly cacheEnabled?: boolean;
    readonly uploadAvailable?: boolean;
    readonly artifactSourceAvailable?: boolean;
    readonly durableAsyncJobsAvailable?: boolean;
    readonly durableCorporaAvailable?: boolean;
  };
}

/**
 * Read-only document/artifact policy view (PRD 666). Announces cache,
 * upload, artifact, and corpus defaults with hard caps; every section
 * carries its effective absolute expiry. Relative and absolute expiry are
 * mutually exclusive and out-of-bounds requests fail instead of clamping.
 */
export function createDocumentPolicyModule(options: DocumentPolicyModuleOptions): McpModule {
  return {
    name: "document_policy",
    register(server: McpServer): void {
      server.registerTool(
        "document_policy",
        {
          description:
            "Read the provider-neutral document/artifact policy: cache, upload, artifact, and corpus defaults with hard caps and effective absolute expiries.",
          inputSchema: documentPolicyInputSchema,
          outputSchema: resultEnvelopeSchema(documentPolicyDataSchema),
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (input, extra) => {
          const deadline = new Deadline(options.requestTimeoutMs);
          try {
            const data = await withConcurrency(
              options.limiter,
              deadline,
              extra.signal,
              () =>
                withinDeadline(
                  () => {
                    const nowMs = Date.now();
                    if (Object.keys(input).length === 0) {
                      return Promise.resolve({
                        ...getDocumentPolicyView(nowMs, options.overrides, options.bounds),
                        runtime: runtimeView(options),
                      });
                    }
                    const overrides: {
                      cache?: PolicyExpiryRequest;
                      upload?: PolicyExpiryRequest;
                      artifact?: PolicyExpiryRequest;
                      corpus?: PolicyExpiryRequest;
                    } = { ...(options.overrides ?? {}) };
                    const cache = toExpiryRequest(input.cache);
                    if (cache !== undefined) overrides.cache = cache;
                    const upload = toExpiryRequest(input.upload);
                    if (upload !== undefined) overrides.upload = upload;
                    const artifact = toExpiryRequest(input.artifact);
                    if (artifact !== undefined) overrides.artifact = artifact;
                    const corpus = toExpiryRequest(input.corpus);
                    if (corpus !== undefined) overrides.corpus = corpus;
                    return Promise.resolve({
                      ...getDocumentPolicyView(nowMs, overrides, options.bounds),
                      runtime: runtimeView(options),
                    });
                  },
                  deadline,
                  extra.signal,
                  "document_policy",
                ),
            );
            return structuredToolResult({ ok: true, data });
          } catch (error) {
            return toolError(error, { tool: "document_policy" });
          }
        },
      );
    },
  };
}

function runtimeView(options: DocumentPolicyModuleOptions) {
  return {
    cacheEnabled: options.runtime?.cacheEnabled ?? false,
    cacheDefaultMode: "use" as const,
    uploadAvailable: options.runtime?.uploadAvailable ?? false,
    artifactSourceAvailable: options.runtime?.artifactSourceAvailable ?? false,
    durableAsyncJobsAvailable: options.runtime?.durableAsyncJobsAvailable ?? false,
    durableCorporaAvailable: options.runtime?.durableCorporaAvailable ?? false,
    stagingCleanupWindowSeconds: 3_600,
    ownershipScope: "principal" as const,
  };
}
