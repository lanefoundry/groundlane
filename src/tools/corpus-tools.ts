import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { parseBoundedDocument } from "../adapters/document/bounded-document-parser.js";
import type { DocumentBlock } from "../core/canonical-document.js";
import {
  CorpusStore,
  type CallerPrincipal,
} from "../core/corpus-runtime.js";
import {
  blockText,
  chunkTextAtLevel,
  extractFieldsFromBlocks,
  attachFieldsToChunks,
  type Chunk,
} from "./document-chunk.js";
import {
  DurableCorpusRuntime,
  type DurableCorpusCaller,
} from "../core/durable-corpus-runtime.js";
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

export const corpusCreateInputSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  callerExpiresAt: z.string().datetime().nullable().optional(),
  timeoutMs: z.number().int().min(1_000).max(150_000).optional(),
});

export const corpusEnrollInputSchema = z.object({
  corpusId: corpusIdSchema,
  sourceId: z.string().trim().min(1).max(160).optional(),
  content: z.string().min(1).max(1_000_000).optional(),
  contentHash: z.string().trim().min(1).max(128).optional(),
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

export const corpusUpdateInputSchema = z.object({
  corpusId: corpusIdSchema,
  sourceId: z.string().trim().min(1).max(160),
  contentHash: z.string().trim().min(1).max(128).optional(),
  content: z.string().min(1).max(1_000_000).optional(),
  acl: z.array(z.string().trim().min(1).max(64)).min(1).max(32).optional(),
  deletionPolicy: z.string().trim().min(1).max(200).optional(),
  citationProvenance: z.string().trim().min(1).max(200).optional(),
  timeoutMs: z.number().int().min(1_000).max(150_000).optional(),
});

export const corpusRefInputSchema = z.object({
  corpusId: corpusIdSchema,
  timeoutMs: z.number().int().min(1_000).max(150_000).optional(),
});

export const corpusRemoveInputSchema = z.object({
  corpusId: corpusIdSchema,
  sourceId: z.string().trim().min(1).max(160),
  timeoutMs: z.number().int().min(1_000).max(150_000).optional(),
});

export const corpusSearchInputSchema = z.object({
  corpusId: corpusIdSchema,
  query: z.string().trim().min(1).max(500),
  maxResults: z.number().int().min(1).max(50).default(10),
  timeoutMs: z.number().int().min(1_000).max(150_000).optional(),
});

export const corpusSourceInspectInputSchema = z.object({
  corpusId: corpusIdSchema,
  sourceId: z.string().trim().min(1).max(160),
  maxBlocks: z.number().int().min(1).max(200).default(50),
  timeoutMs: z.number().int().min(1_000).max(150_000).optional(),
});

export const corpusRetrievalTestInputSchema = z.object({
  corpusId: corpusIdSchema,
  query: z.string().trim().min(1).max(500),
  expectedSourceIds: z.array(z.string().trim().min(1).max(160)).min(1).max(20),
  maxResults: z.number().int().min(1).max(50).default(10),
  timeoutMs: z.number().int().min(1_000).max(150_000).optional(),
});

export const corpusChunkInspectInputSchema = z.object({
  corpusId: corpusIdSchema,
  sourceId: z.string().trim().min(1).max(160),
  chunkSizes: z.array(z.number().int().min(16).max(32_768)).min(1).max(5).default([2048, 512, 128]),
  overlap: z.number().int().min(0).max(512).default(32),
  maxChunks: z.number().int().min(1).max(200).default(20),
  fieldAware: z.boolean().default(true),
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

interface CommonCorpusToolsModuleOptions {
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxOutputChars: number;
}

export type CorpusToolsModuleOptions = CommonCorpusToolsModuleOptions & (
  | { readonly runtime: DurableCorpusRuntime; readonly caller: DurableCorpusCaller; readonly store?: never }
  | { readonly store: CorpusStore; readonly runtime?: never; readonly caller?: never }
);

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
  const durable = "runtime" in options ? options.runtime : undefined;
  const store = "store" in options ? options.store : undefined;
  const durableCaller = "caller" in options ? options.caller : undefined;
  if ((durable === undefined) === (store === undefined)) {
    throw new Error("corpus tools require exactly one durable runtime or explicit legacy store");
  }
  return {
    name: "corpus_tools",
    register(server: McpServer): void {
      const run = <T>(tool: string, timeoutMs: number | undefined, signal: AbortSignal, fn: () => T | Promise<T>): Promise<T> => {
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
        async (input, ctx) => {
          try {
            const corpus = await run("corpus_create", input.timeoutMs, ctx.mcpReq.signal, async () => {
              if (durable !== undefined && durableCaller !== undefined) {
                return await durable.createCorpus({
                  displayName: input.displayName,
                  callerExpiresAt: input.callerExpiresAt ?? null,
                }, durableCaller);
              }
              if (store === undefined) throw new Error("corpus runtime is unavailable");
              return store.createCorpus({
                displayName: input.displayName,
                ownerId: MCP_OWNER_ID,
                tenantId: MCP_TENANT_ID,
                callerExpiresAt: input.callerExpiresAt ?? null,
              });
            });
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
        async (input, ctx) => {
          try {
            const enrollment = await run("corpus_enroll", input.timeoutMs, ctx.mcpReq.signal, async () => {
              if (durable !== undefined && durableCaller !== undefined) {
                if (input.content === undefined) {
                  throw new Error("durable corpus enrollment requires normalized source content");
                }
                return await durable.enrollSource(input.corpusId, {
                  content: input.content,
                  ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
                  ...(input.contentHash === undefined ? {} : { contentHash: input.contentHash }),
                  acl: [...input.acl],
                  retentionPolicy: input.retentionPolicy,
                  deletionPolicy: input.deletionPolicy,
                  citationProvenance: input.citationProvenance,
                  callerExpiresAt: input.callerExpiresAt ?? null,
                }, durableCaller);
              }
              if (store === undefined || input.sourceId === undefined || input.contentHash === undefined) {
                throw new Error("legacy corpus enrollment requires sourceId and contentHash");
              }
              return store.enrollSource(
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
              );
            });
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
        async (input, ctx) => {
          try {
            const enrollment = await run("corpus_update", input.timeoutMs, ctx.mcpReq.signal, async () => {
              if (durable !== undefined && durableCaller !== undefined) {
                return await durable.updateSource(input.corpusId, input.sourceId, {
                  ...(input.content === undefined ? {} : { content: input.content }),
                  ...(input.contentHash === undefined ? {} : { contentHash: input.contentHash }),
                  ...(input.acl === undefined ? {} : { acl: [...input.acl] }),
                  ...(input.deletionPolicy === undefined ? {} : { deletionPolicy: input.deletionPolicy }),
                  ...(input.citationProvenance === undefined ? {} : { citationProvenance: input.citationProvenance }),
                }, durableCaller);
              }
              if (store === undefined) throw new Error("corpus runtime is unavailable");
              return store.updateSource(
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
              );
            });
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
        async (input, ctx) => {
          try {
            const data = await run("corpus_remove", input.timeoutMs, ctx.mcpReq.signal, async () => {
              if (durable !== undefined && durableCaller !== undefined) {
                return await durable.removeSource(input.corpusId, input.sourceId, durableCaller);
              }
              if (store === undefined) throw new Error("corpus runtime is unavailable");
              return store.removeSource(input.corpusId, input.sourceId, MCP_CALLER);
            });
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
        async (input, ctx) => {
          try {
            const corpus = await run("corpus_status", input.timeoutMs, ctx.mcpReq.signal, async () => {
              if (durable !== undefined && durableCaller !== undefined) {
                return await durable.corpusStatus(input.corpusId, durableCaller);
              }
              if (store === undefined) throw new Error("corpus runtime is unavailable");
              return store.corpusStatus(input.corpusId, MCP_CALLER);
            });
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
        async (input, ctx) => {
          try {
            const response = await run("corpus_search", input.timeoutMs, ctx.mcpReq.signal, async () => {
              if (durable !== undefined && durableCaller !== undefined) {
                return await durable.searchCorpus(input.corpusId, input.query, durableCaller, input.maxResults);
              }
              if (store === undefined) throw new Error("corpus runtime is unavailable");
              return store.searchCorpus(input.corpusId, input.query, MCP_CALLER, input.maxResults);
            });
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
        async (input, ctx) => {
          try {
            const deletion = await run("corpus_delete", input.timeoutMs, ctx.mcpReq.signal, async () => {
              if (durable !== undefined && durableCaller !== undefined) {
                return await durable.deleteCorpus(input.corpusId, durableCaller);
              }
              if (store === undefined) throw new Error("corpus runtime is unavailable");
              return store.deleteCorpus(input.corpusId, MCP_CALLER);
            });
            const data = { deletion };
            assertWithinOutputLimit(data, options.maxOutputChars, "corpus_delete");
            return structuredToolResult({ ok: true, data });
          } catch (error) {
            return toolError(error, { tool: "corpus_delete" });
          }
        },
      );

      server.registerTool(
        "corpus_retrieval_test",
        {
          description:
            "Test retrieval quality for a corpus query. Given a query and a list of expected source IDs, runs corpus_search and reports which expected sources were found, at what rank and score. Use this to verify that a corpus returns the right sources before building a RAG pipeline. Read-only, no LLM generation.",
          inputSchema: corpusRetrievalTestInputSchema,
          outputSchema: resultEnvelopeSchema(z.object({
            corpusId: z.string(),
            query: z.string(),
            expectedCount: z.number().int(),
            foundCount: z.number().int(),
            recall: z.number(),
            hits: z.array(z.object({
              sourceId: z.string(),
              expected: z.boolean(),
              rank: z.number().int(),
              score: z.number(),
            })),
            missed: z.array(z.string()),
          })),
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (input, ctx) => {
          try {
            const response = await run("corpus_retrieval_test", input.timeoutMs, ctx.mcpReq.signal, async () => {
              if (durable !== undefined && durableCaller !== undefined) {
                return await durable.searchCorpus(input.corpusId, input.query, durableCaller, input.maxResults);
              }
              if (store === undefined) throw new Error("corpus runtime is unavailable");
              return store.searchCorpus(input.corpusId, input.query, MCP_CALLER, input.maxResults);
            });

            const expectedSet = new Set(input.expectedSourceIds);
            const hits = response.results.map((hit, index) => ({
              sourceId: hit.sourceId,
              expected: expectedSet.has(hit.sourceId),
              rank: index + 1,
              score: hit.score,
            }));
            const foundIds = new Set(hits.filter((h) => h.expected).map((h) => h.sourceId));
            const missed = input.expectedSourceIds.filter((id) => !foundIds.has(id));

            const data = {
              corpusId: response.corpusId,
              query: response.query,
              expectedCount: input.expectedSourceIds.length,
              foundCount: foundIds.size,
              recall: input.expectedSourceIds.length === 0 ? 1 : foundIds.size / input.expectedSourceIds.length,
              hits,
              missed,
            };
            assertWithinOutputLimit(data, options.maxOutputChars, "corpus_retrieval_test");
            return structuredToolResult({ ok: true, data });
          } catch (error) {
            return toolError(error, { tool: "corpus_retrieval_test" });
          }
        },
      );

      server.registerTool(
        "corpus_source_inspect",
        {
          description:
            "Inspect a corpus source by parsing it into document blocks. Returns block types, text previews, table headers, and metadata — useful for verifying what the RAG pipeline will index before going live. Read-only, no LLM generation.",
          inputSchema: corpusSourceInspectInputSchema,
          outputSchema: resultEnvelopeSchema(z.object({
            corpusId: z.string(),
            sourceId: z.string(),
            blockCount: z.number().int(),
            blocks: z.array(z.object({
              blockId: z.string(),
              type: z.string(),
              preview: z.string(),
              tokenEstimate: z.number().int(),
              fields: z.array(z.string()).optional(),
            })),
            metadata: z.array(z.object({ key: z.string(), value: z.string() })),
          })),
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (input, ctx) => {
          try {
            const source = await run("corpus_source_inspect", input.timeoutMs, ctx.mcpReq.signal, async () => {
              if (durable !== undefined && durableCaller !== undefined) {
                return await durable.readSource(input.corpusId, input.sourceId, durableCaller);
              }
              throw new Error("corpus_source_inspect requires durable corpus storage (set CORPUS_STATE_PATH)");
            });

            const parsed = await parseBoundedDocument({
              bytes: source.bytes,
              declaredMime: source.mimeType,
              filename: source.filename,
              signal: ctx.mcpReq.signal,
            });

            const blocks = parsed.blocks.slice(0, input.maxBlocks).map((block) => {
              let preview = "";
              const fields: string[] = [];
              if (block.type === "text") {
                preview = block.content.slice(0, 200);
              } else if (block.type === "table") {
                const headers = block.cells.filter((c) => c.row === 0).sort((a, b) => a.col - b.col);
                fields.push(...headers.map((c) => c.content.trim()).filter((s) => s.length > 0));
                preview = `${String(Math.max(0, ...block.cells.map((c) => c.row)) + 1)} rows × ${String(Math.max(0, ...block.cells.map((c) => c.col)) + 1)} cols`;
              } else if (block.type === "formula") {
                preview = block.expression.slice(0, 200);
              } else if (block.type === "asset") {
                preview = block.altText ?? block.assetRef;
              }
              return {
                blockId: block.blockId,
                type: block.type,
                preview,
                tokenEstimate: Math.ceil(preview.length / 4),
                ...(fields.length > 0 ? { fields } : {}),
              };
            });

            const data = {
              corpusId: input.corpusId,
              sourceId: input.sourceId,
              blockCount: parsed.blocks.length,
              blocks,
              metadata: [...parsed.metadata],
            };
            assertWithinOutputLimit(data, options.maxOutputChars, "corpus_source_inspect");
            return structuredToolResult({ ok: true, data });
          } catch (error) {
            return toolError(error, { tool: "corpus_source_inspect" });
          }
        },
      );

      server.registerTool(
        "corpus_chunk_inspect",
        {
          description:
            "Inspect how a corpus source will be chunked for RAG ingestion. Reads the source, parses it into blocks, splits into hierarchical chunks at the requested sizes, and returns chunk previews with token counts, block refs, and field labels. Read-only, no LLM generation. Requires durable corpus storage.",
          inputSchema: corpusChunkInspectInputSchema,
          outputSchema: resultEnvelopeSchema(z.object({
            corpusId: z.string(),
            sourceId: z.string(),
            totalChunks: z.number().int(),
            levels: z.number().int(),
            chunks: z.array(z.object({
              chunkId: z.string(),
              parentChunkId: z.string().nullable(),
              level: z.number().int(),
              preview: z.string(),
              tokenCount: z.number().int(),
              blockRefs: z.array(z.string()),
              fields: z.array(z.string()).optional(),
            })),
          })),
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (input, ctx) => {
          try {
            const source = await run("corpus_chunk_inspect", input.timeoutMs, ctx.mcpReq.signal, async () => {
              if (durable !== undefined && durableCaller !== undefined) {
                return await durable.readSource(input.corpusId, input.sourceId, durableCaller);
              }
              throw new Error("corpus_chunk_inspect requires durable corpus storage (set CORPUS_STATE_PATH)");
            });

            const parsed = await parseBoundedDocument({
              bytes: source.bytes,
              declaredMime: source.mimeType,
              filename: source.filename,
              signal: ctx.mcpReq.signal,
            });

            const segments = parsed.blocks
              .map((block) => ({ text: blockText(block as DocumentBlock), blockId: block.blockId }))
              .filter((s) => s.text.trim().length > 0);

            const sizes = [...input.chunkSizes].sort((a, b) => b - a);
            const idCounter = { value: 0 };
            const allChunks: Chunk[] = [];

            const level0 = chunkTextAtLevel(segments, sizes[0] ?? 2048, input.overlap, 0, null, idCounter);
            allChunks.push(...level0);

            let parentChunks = level0;
            for (let levelIdx = 1; levelIdx < sizes.length; levelIdx += 1) {
              ctx.mcpReq.signal.throwIfAborted();
              const levelSize = sizes[levelIdx]!;
              const childChunks: Chunk[] = [];
              for (const parent of parentChunks) {
                const parentSegments = [{ text: parent.text, blockId: parent.blockRefs[0] ?? parent.chunkId }];
                childChunks.push(...chunkTextAtLevel(parentSegments, levelSize, input.overlap, levelIdx, parent.chunkId, idCounter));
              }
              allChunks.push(...childChunks);
              parentChunks = childChunks;
            }

            if (input.fieldAware) {
              const blockFields = extractFieldsFromBlocks(parsed.blocks as DocumentBlock[], parsed.metadata);
              if (blockFields.size > 0) {
                attachFieldsToChunks(allChunks, blockFields);
              }
            }

            const limited = allChunks.slice(0, input.maxChunks);
            const chunks = limited.map((c) => ({
              chunkId: c.chunkId,
              parentChunkId: c.parentChunkId,
              level: c.level,
              preview: c.text.slice(0, 200),
              tokenCount: c.tokenCount,
              blockRefs: c.blockRefs,
              ...(c.fields !== undefined && c.fields.length > 0 ? { fields: c.fields } : {}),
            }));

            const data = {
              corpusId: input.corpusId,
              sourceId: input.sourceId,
              totalChunks: allChunks.length,
              levels: sizes.length,
              chunks,
            };
            assertWithinOutputLimit(data, options.maxOutputChars, "corpus_chunk_inspect");
            return structuredToolResult({ ok: true, data });
          } catch (error) {
            return toolError(error, { tool: "corpus_chunk_inspect" });
          }
        },
      );
    },
  };
}
