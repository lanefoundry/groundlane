import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  CorpusStore,
  InMemoryCorpusBackend,
  type CallerPrincipal,
} from "../core/corpus-runtime.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

// V1 single-tenant mapping (PRD 5.1.1): every MCP caller acts as the same
// operator `owner` with reader/writer roles. Callers never supply
// principal/tenant identifiers.
const MCP_CALLER: CallerPrincipal = {
  principalId: "owner",
  roles: ["role:reader", "role:writer"],
};
const MCP_OWNER_ID = "owner";
const MCP_TENANT_ID = "default";

const corpusIdSchema = z.string().trim().min(1).max(128);

const corpusCreateInputSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  callerExpiresAt: z.string().datetime().nullable().optional(),
  timeoutMs: z.number().int().min(1_000).max(150_000).optional(),
});

const corpusEnrollInputSchema = z.object({
  corpusId: corpusIdSchema,
  sourceId: z.string().trim().min(1).max(160),
  contentHash: z.string().trim().min(1).max(128),
  acl: z.array(z.string().trim().min(1).max(64)).min(1).max(32),
  retentionPolicy: z.string().trim().min(1).max(200).default("operator-default"),
  deletionPolicy: z.string().trim().min(1).max(200).default("operator-default"),
  lifecycleProvenance: z.string().trim().min(1).max(200).default("operator-asserted"),
  citationProvenance: z.string().trim().min(1).max(200).default("operator-asserted"),
  backendProvenance: z.string().trim().min(1).max(200).default("operator-asserted"),
  callerExpiresAt: z.string().datetime().nullable().optional(),
  cacheBindings: z.array(z.string().trim().min(1).max(160)).max(32).optional(),
  timeoutMs: z.number().int().min(1_000).max(150_000).optional(),
});

const corpusUpdateInputSchema = z.object({
  corpusId: corpusIdSchema,
  sourceId: z.string().trim().min(1).max(160),
  contentHash: z.string().trim().min(1).max(128).optional(),
  acl: z.array(z.string().trim().min(1).max(64)).min(1).max(32).optional(),
  deletionPolicy: z.string().trim().min(1).max(200).optional(),
  citationProvenance: z.string().trim().min(1).max(200).optional(),
  timeoutMs: z.number().int().min(1_000).max(150_000).optional(),
});

const corpusRefInputSchema = z.object({
  corpusId: corpusIdSchema,
  timeoutMs: z.number().int().min(1_000).max(150_000).optional(),
});

const corpusRemoveInputSchema = z.object({
  corpusId: corpusIdSchema,
  sourceId: z.string().trim().min(1).max(160),
  timeoutMs: z.number().int().min(1_000).max(150_000).optional(),
});

const corpusSearchInputSchema = z.object({
  corpusId: corpusIdSchema,
  query: z.string().trim().min(1).max(500),
  maxResults: z.number().int().min(1).max(50).default(10),
  timeoutMs: z.number().int().min(1_000).max(150_000).optional(),
});

const corpusViewSchema = z.object({
  corpusId: z.string(),
  displayName: z.string(),
  state: z.string(),
  sourceCount: z.number().int(),
  updatedAt: z.string(),
  expiresAt: z.string().nullable(),
});

export interface CorpusToolsModuleOptions {
  store?: CorpusStore;
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxOutputChars: number;
}

function assertWithinOutputLimit(value: unknown, maxOutputChars: number, tool: string): void {
  if (Array.from(JSON.stringify(value)).length > maxOutputChars) {
    throw new Error(`${tool} output exceeds the configured limit; narrow the request`);
  }
}

/**
 * Operator-owned corpus lifecycle plus the scoped `corpus_search` tool
 * family (PRD 665, 724-726). Enrollment creates a corpus-owned source
 * lifecycle record; re-enroll never extends expiry; delete revokes access
 * immediately. Public corpus/source identity never uses backend job/index
 * IDs. Scoped results always carry `toolFamily: corpus_search`,
 * corpus boundary, and freshness provenance, and are never labeled as
 * public web search.
 */
export function createCorpusToolsModule(options: CorpusToolsModuleOptions): McpModule {
  const store = options.store ?? new CorpusStore(new InMemoryCorpusBackend());
  return {
    name: "corpus_tools",
    register(server: McpServer): void {
      const run = <T>(tool: string, timeoutMs: number | undefined, signal: AbortSignal, fn: () => T): Promise<T> => {
        const deadline = new Deadline(timeoutMs ?? options.requestTimeoutMs);
        return withConcurrency(options.limiter, deadline, signal, () =>
          withinDeadline(() => Promise.resolve(fn()), deadline, signal, tool),
        );
      };

      server.registerTool(
        "corpus_create",
        {
          description:
            "Create an operator-owned corpus with retention caps. Returns an opaque Groundlane corpus identity, never a backend index ID.",
          inputSchema: corpusCreateInputSchema,
          outputSchema: resultEnvelopeSchema(z.object({ corpus: corpusViewSchema })),
          annotations: { readOnlyHint: false, openWorldHint: false },
        },
        async (input, extra) => {
          try {
            const corpus = await run("corpus_create", input.timeoutMs, extra.signal, () =>
              store.createCorpus({
                displayName: input.displayName,
                ownerId: MCP_OWNER_ID,
                tenantId: MCP_TENANT_ID,
                callerExpiresAt: input.callerExpiresAt ?? null,
              }),
            );
            const data = { corpus };
            assertWithinOutputLimit(data, options.maxOutputChars, "corpus_create");
            return structuredToolResult({ ok: true, data });
          } catch (error) {
            return toolError(error, { tool: "corpus_create" });
          }
        },
      );

      server.registerTool(
        "corpus_enroll",
        {
          description:
            "Enroll a source into a corpus, creating a corpus-owned lifecycle record with ACL, retention, and provenance. Re-enroll never extends expiry.",
          inputSchema: corpusEnrollInputSchema,
          outputSchema: resultEnvelopeSchema(z.object({ enrollment: z.unknown() })),
          annotations: { readOnlyHint: false, openWorldHint: false },
        },
        async (input, extra) => {
          try {
            const enrollment = await run("corpus_enroll", input.timeoutMs, extra.signal, () =>
              store.enrollSource(
                input.corpusId,
                {
                  sourceId: input.sourceId,
                  contentHash: input.contentHash,
                  acl: [...input.acl],
                  retentionPolicy: input.retentionPolicy,
                  deletionPolicy: input.deletionPolicy,
                  lifecycleProvenance: input.lifecycleProvenance,
                  citationProvenance: input.citationProvenance,
                  backendProvenance: input.backendProvenance,
                  callerExpiresAt: input.callerExpiresAt ?? null,
                  ...(input.cacheBindings === undefined
                    ? {}
                    : { cacheBindings: [...input.cacheBindings] }),
                },
                MCP_CALLER,
              ),
            );
            const data = { enrollment };
            assertWithinOutputLimit(data, options.maxOutputChars, "corpus_enroll");
            return structuredToolResult({ ok: true, data });
          } catch (error) {
            return toolError(error, { tool: "corpus_enroll" });
          }
        },
      );

      server.registerTool(
        "corpus_update",
        {
          description:
            "Update an enrolled source's hash, ACL, deletion policy, or citation provenance. Never resets expiry.",
          inputSchema: corpusUpdateInputSchema,
          outputSchema: resultEnvelopeSchema(z.object({ enrollment: z.unknown() })),
          annotations: { readOnlyHint: false, openWorldHint: false },
        },
        async (input, extra) => {
          try {
            const enrollment = await run("corpus_update", input.timeoutMs, extra.signal, () =>
              store.updateSource(
                input.corpusId,
                input.sourceId,
                {
                  ...(input.contentHash === undefined ? {} : { contentHash: input.contentHash }),
                  ...(input.acl === undefined ? {} : { acl: [...input.acl] }),
                  ...(input.deletionPolicy === undefined
                    ? {}
                    : { deletionPolicy: input.deletionPolicy }),
                  ...(input.citationProvenance === undefined
                    ? {}
                    : { citationProvenance: input.citationProvenance }),
                },
                MCP_CALLER,
              ),
            );
            const data = { enrollment };
            assertWithinOutputLimit(data, options.maxOutputChars, "corpus_update");
            return structuredToolResult({ ok: true, data });
          } catch (error) {
            return toolError(error, { tool: "corpus_update" });
          }
        },
      );

      server.registerTool(
        "corpus_remove",
        {
          description:
            "Remove a source from a corpus. Immediately revokes access and its cache bindings.",
          inputSchema: corpusRemoveInputSchema,
          outputSchema: resultEnvelopeSchema(z.object({
            sourceId: z.string(),
            lifecycle: z.string(),
          })),
          annotations: { readOnlyHint: false, openWorldHint: false },
        },
        async (input, extra) => {
          try {
            const data = await run("corpus_remove", input.timeoutMs, extra.signal, () =>
              store.removeSource(input.corpusId, input.sourceId, MCP_CALLER),
            );
            assertWithinOutputLimit(data, options.maxOutputChars, "corpus_remove");
            return structuredToolResult({ ok: true, data });
          } catch (error) {
            return toolError(error, { tool: "corpus_remove" });
          }
        },
      );

      server.registerTool(
        "corpus_status",
        {
          description:
            "Read corpus status: manifest truth source, enrollment counts, backend health, and deletion state.",
          inputSchema: corpusRefInputSchema,
          outputSchema: resultEnvelopeSchema(z.object({
            corpus: corpusViewSchema.passthrough(),
          })),
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (input, extra) => {
          try {
            const corpus = await run("corpus_status", input.timeoutMs, extra.signal, () =>
              store.corpusStatus(input.corpusId, MCP_CALLER),
            );
            const data = { corpus };
            assertWithinOutputLimit(data, options.maxOutputChars, "corpus_status");
            return structuredToolResult({ ok: true, data });
          } catch (error) {
            return toolError(error, { tool: "corpus_status" });
          }
        },
      );

      server.registerTool(
        "corpus_search",
        {
          description:
            "Search an operator-owned corpus. Scoped results carry corpus boundary and freshness provenance and are never labeled as public web search.",
          inputSchema: corpusSearchInputSchema,
          outputSchema: resultEnvelopeSchema(z.object({
            toolFamily: z.literal("corpus_search"),
            corpusId: z.string(),
            query: z.string(),
            results: z.array(z.object({
              sourceId: z.string(),
              contentHash: z.string(),
              snippet: z.string(),
              score: z.number(),
              provenance: z.unknown(),
            })),
            warnings: z.array(z.string()),
          })),
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (input, extra) => {
          try {
            const response = await run("corpus_search", input.timeoutMs, extra.signal, () =>
              store.searchCorpus(input.corpusId, input.query, MCP_CALLER, input.maxResults),
            );
            const data = {
              toolFamily: "corpus_search" as const,
              corpusId: response.corpusId,
              query: response.query,
              results: response.results.map((hit) => ({
                sourceId: hit.sourceId,
                contentHash: hit.contentHash,
                snippet: hit.snippet,
                score: hit.score,
                provenance: hit.provenance,
              })),
              warnings: [...response.warnings],
            };
            assertWithinOutputLimit(data, options.maxOutputChars, "corpus_search");
            return structuredToolResult({ ok: true, data });
          } catch (error) {
            return toolError(error, { tool: "corpus_search" });
          }
        },
      );

      server.registerTool(
        "corpus_delete",
        {
          description:
            "Delete a corpus. Access is revoked immediately; deletion reports completion only when backend and artifact removal are done.",
          inputSchema: corpusRefInputSchema,
          outputSchema: resultEnvelopeSchema(z.object({ deletion: z.unknown() })),
          annotations: { readOnlyHint: false, openWorldHint: false },
        },
        async (input, extra) => {
          try {
            const deletion = await run("corpus_delete", input.timeoutMs, extra.signal, () =>
              store.deleteCorpus(input.corpusId, MCP_CALLER),
            );
            const data = { deletion };
            assertWithinOutputLimit(data, options.maxOutputChars, "corpus_delete");
            return structuredToolResult({ ok: true, data });
          } catch (error) {
            return toolError(error, { tool: "corpus_delete" });
          }
        },
      );
    },
  };
}
