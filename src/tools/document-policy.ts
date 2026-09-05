import {
  acceptedContent,
  inputRequired,
  inputResponse,
  type McpServer,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  getDocumentPolicyView,
  type DocumentPolicyOverrides,
  type DocumentPolicyBoundsOverrides,
  type PolicyExpiryRequest,
} from "../core/document-policy.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import { GroundlaneError } from "../core/errors.js";
import type { McpModule, McpRequestStateIssuer } from "../mcp/registry.js";
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
  interactiveTtlFor: z.enum(["cache", "upload", "artifact", "corpus"]).optional(),
});

const interactiveTtlSchema = z.object({
  relativeTtlSeconds: z.number().int().min(0).max(31_536_000),
});

type PolicySection = "cache" | "upload" | "artifact" | "corpus";

interface DocumentPolicyMrtrState extends Record<string, unknown> {
  readonly v: 1;
  readonly flow: "document_policy_ttl";
  readonly phase: "awaiting_ttl";
  readonly tool: "document_policy";
  readonly requestDigest: string;
  readonly section: PolicySection;
  readonly evaluationNowMs: number;
  readonly flowExpiresAtMs: number;
  readonly round: number;
}

const MRTR_TTL_MS = 5 * 60 * 1000;
const MRTR_MAX_ROUNDS = 3;

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
  requestState?: McpRequestStateIssuer | undefined;
  now?: (() => number) | undefined;
  runtime?: {
    readonly cacheEnabled?: boolean;
    readonly uploadAvailable?: boolean;
    readonly artifactSourceAvailable?: boolean;
    readonly durableAsyncJobsAvailable?: boolean;
    readonly durableCorporaAvailable?: boolean;
  };
}

function canonicalRequest(input: z.infer<typeof documentPolicyInputSchema>): string {
  return JSON.stringify({
    cache: input.cache ?? null,
    upload: input.upload ?? null,
    artifact: input.artifact ?? null,
    corpus: input.corpus ?? null,
    interactiveTtlFor: input.interactiveTtlFor ?? null,
  });
}

async function requestDigest(input: z.infer<typeof documentPolicyInputSchema>): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalRequest(input)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validMrtrState(
  value: unknown,
  section: PolicySection,
  digest: string,
  nowMs: number,
): value is DocumentPolicyMrtrState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Partial<DocumentPolicyMrtrState>;
  return state.v === 1 &&
    state.flow === "document_policy_ttl" &&
    state.phase === "awaiting_ttl" &&
    state.tool === "document_policy" &&
    state.section === section &&
    state.requestDigest === digest &&
    typeof state.evaluationNowMs === "number" &&
    Number.isSafeInteger(state.evaluationNowMs) &&
    typeof state.flowExpiresAtMs === "number" &&
    Number.isSafeInteger(state.flowExpiresAtMs) &&
    state.flowExpiresAtMs > nowMs &&
    typeof state.round === "number" &&
    Number.isSafeInteger(state.round) &&
    state.round >= 1 && state.round <= MRTR_MAX_ROUNDS;
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
        async (input, ctx) => {
          const deadline = new Deadline(options.requestTimeoutMs);
          try {
            const wallNowMs = (options.now ?? Date.now)();
            let evaluationNowMs = wallNowMs;
            let interactiveTtl: number | undefined;
            if (input.interactiveTtlFor !== undefined) {
              if (options.requestState === undefined) {
                throw new GroundlaneError(
                  "PROVIDER_UNAVAILABLE",
                  "document_policy",
                  "Interactive policy input is not configured",
                );
              }
              const digest = await requestDigest(input);
              const decoded = ctx.mcpReq.requestState<DocumentPolicyMrtrState>();
              if (decoded !== undefined && !validMrtrState(
                decoded,
                input.interactiveTtlFor,
                digest,
                wallNowMs,
              )) {
                throw new GroundlaneError(
                  "INVALID_INPUT",
                  "document_policy",
                  "Interactive policy request state does not match this request",
                );
              }
              const response = inputResponse(ctx.mcpReq.inputResponses, "ttl");
              if (
                response.kind === "elicit" &&
                (response.action === "decline" || response.action === "cancel")
              ) {
                throw new GroundlaneError(
                  "CANCELLED",
                  "document_policy",
                  "Interactive policy input was cancelled",
                );
              }
              const accepted = acceptedContent(
                ctx.mcpReq.inputResponses,
                "ttl",
                interactiveTtlSchema,
              );
              if (accepted === undefined) {
                const round = (decoded?.round ?? 0) + 1;
                if (round > MRTR_MAX_ROUNDS) {
                  throw new GroundlaneError(
                    "INVALID_INPUT",
                    "document_policy",
                    "Interactive policy input exceeded the round limit",
                  );
                }
                const state: DocumentPolicyMrtrState = decoded === undefined
                  ? {
                      v: 1,
                      flow: "document_policy_ttl",
                      phase: "awaiting_ttl",
                      tool: "document_policy",
                      requestDigest: digest,
                      section: input.interactiveTtlFor,
                      evaluationNowMs: wallNowMs,
                      flowExpiresAtMs: wallNowMs + MRTR_TTL_MS,
                      round,
                    }
                  : { ...decoded, round };
                return inputRequired({
                  inputRequests: {
                    ttl: inputRequired.elicit({
                      message: `Choose the relative TTL in seconds for ${input.interactiveTtlFor}.`,
                      requestedSchema: interactiveTtlSchema,
                    }),
                  },
                  requestState: await options.requestState.mint(state, ctx),
                });
              }
              if (decoded === undefined) {
                throw new GroundlaneError(
                  "INVALID_INPUT",
                  "document_policy",
                  "Interactive policy input requires verified request state",
                );
              }
              evaluationNowMs = decoded.evaluationNowMs;
              interactiveTtl = accepted.relativeTtlSeconds;
            }
            const data = await withConcurrency(
              options.limiter,
              deadline,
              ctx.mcpReq.signal,
              () =>
                withinDeadline(
                  () => {
                    const nowMs = evaluationNowMs;
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
                    if (input.interactiveTtlFor !== undefined && interactiveTtl !== undefined) {
                      overrides[input.interactiveTtlFor] = {
                        relativeTtlSeconds: interactiveTtl,
                      };
                    }
                    return Promise.resolve({
                      ...getDocumentPolicyView(nowMs, overrides, options.bounds),
                      runtime: runtimeView(options),
                    });
                  },
                  deadline,
                  ctx.mcpReq.signal,
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
