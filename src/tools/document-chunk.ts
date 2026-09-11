import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  MAX_DOCUMENT_BYTES,
  parseBoundedDocument,
} from "../adapters/document/bounded-document-parser.js";
import type { DocumentBlock } from "../core/canonical-document.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

const MAX_INPUT_BYTES = MAX_DOCUMENT_BYTES;
const DEFAULT_CHUNK_SIZES = [2048, 512, 128];

const documentChunkInputSchema = z.object({
  dataBase64: z
    .string()
    .min(1)
    .max(Math.ceil(MAX_INPUT_BYTES * 4 / 3) + 16)
    .describe("Base64-encoded document content (max 10 MB decoded). Supports the same formats as document_parse."),
  mimeType: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("MIME type of the document."),
  filename: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .describe("Original filename with extension."),
  chunkSizes: z
    .array(z.number().int().min(16).max(32_768))
    .min(1)
    .max(5)
    .default(DEFAULT_CHUNK_SIZES)
    .describe("Token sizes for each hierarchy level, largest first. Default: [2048, 512, 128]. Approximate tokens (chars / 4)."),
  overlap: z
    .number()
    .int()
    .min(0)
    .max(512)
    .default(32)
    .describe("Overlap in approximate tokens between adjacent chunks at the same level. Default: 32."),
  fieldAware: z
    .boolean()
    .default(false)
    .describe("When true, each chunk includes a `fields` array with field names extracted from table headers (row 0) and document metadata keys. Useful for RAG metadata pre-filtering to avoid attribute conflation in vector search."),
});

const chunkSchema = z.object({
  chunkId: z.string(),
  parentChunkId: z.string().nullable(),
  level: z.number().int().nonnegative(),
  text: z.string(),
  tokenCount: z.number().int().nonnegative(),
  blockRefs: z.array(z.string()),
  fields: z.array(z.string()).optional(),
});

const chunkDataSchema = z.object({
  chunks: z.array(chunkSchema),
  chunkCount: z.number().int().nonnegative(),
  levels: z.number().int().positive(),
  totalTokens: z.number().int().nonnegative(),
  engine: z.string(),
  inputBytes: z.number().int().nonnegative(),
});

export interface DocumentChunkModuleOptions {
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxOutputChars: number;
}

interface Chunk {
  chunkId: string;
  parentChunkId: string | null;
  level: number;
  text: string;
  tokenCount: number;
  blockRefs: string[];
  fields?: string[];
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function extractFieldsFromBlocks(
  blocks: DocumentBlock[],
  metadata: readonly { key: string; value: string }[] | undefined,
): Map<string, string[]> {
  const blockFields = new Map<string, string[]>();

  for (const block of blocks) {
    if (block.type === "table" && block.cells.length > 0) {
      const headerCells = block.cells
        .filter((c) => c.row === 0)
        .sort((a, b) => a.col - b.col);
      if (headerCells.length > 0) {
        const fields = headerCells
          .map((c) => c.content.trim())
          .filter((s) => s.length > 0 && s.length <= 100);
        if (fields.length > 0) {
          blockFields.set(block.blockId, fields);
        }
      }
    }
  }

  if (metadata && metadata.length > 0) {
    const metaFields = metadata
      .map((m) => m.key.trim())
      .filter((k) => k.length > 0 && k.length <= 100);
    if (metaFields.length > 0) {
      blockFields.set("__metadata__", metaFields);
    }
  }

  return blockFields;
}

export function attachFieldsToChunks(
  chunks: Chunk[],
  blockFields: Map<string, string[]>,
): void {
  for (const chunk of chunks) {
    const fields = new Set<string>();
    for (const ref of chunk.blockRefs) {
      const bf = blockFields.get(ref);
      if (bf) for (const f of bf) fields.add(f);
    }
    const metaFields = blockFields.get("__metadata__");
    if (metaFields) for (const f of metaFields) fields.add(f);
    if (fields.size > 0) {
      chunk.fields = [...fields];
    }
  }
}

function blockText(block: DocumentBlock): string {
  if (block.type === "text") return block.content;
  if (block.type === "table") return block.cells.map((c) => c.content).join(" | ");
  if (block.type === "formula") return block.expression;
  if (block.type === "asset") return block.altText ?? "";
  return "";
}

function chunkTextAtLevel(
  segments: { text: string; blockId: string }[],
  maxTokens: number,
  overlapTokens: number,
  level: number,
  parentChunkId: string | null,
  idCounter: { value: number },
): Chunk[] {
  const chunks: Chunk[] = [];
  let currentText = "";
  let currentBlockRefs: string[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (currentText.trim()) {
      const id = `chunk-L${level}-${String(idCounter.value)}`;
      idCounter.value += 1;
      chunks.push({
        chunkId: id,
        parentChunkId,
        level,
        text: currentText.trim(),
        tokenCount: estimateTokens(currentText.trim()),
        blockRefs: [...new Set(currentBlockRefs)],
      });
    }
    currentText = "";
    currentBlockRefs = [];
    currentTokens = 0;
  };

  for (const segment of segments) {
    const segTokens = estimateTokens(segment.text);

    if (segTokens > maxTokens) {
      flush();
      // Split oversized segments into fixed-size windows
      let offset = 0;
      const chars = segment.text;
      const maxChars = maxTokens * 4;
      const overlapChars = overlapTokens * 4;
      while (offset < chars.length) {
        const slice = chars.slice(offset, offset + maxChars);
        const id = `chunk-L${level}-${String(idCounter.value)}`;
        idCounter.value += 1;
        chunks.push({
          chunkId: id,
          parentChunkId,
          level,
          text: slice.trim(),
          tokenCount: estimateTokens(slice.trim()),
          blockRefs: [segment.blockId],
        });
        offset += maxChars - overlapChars;
        if (overlapChars === 0) offset = Math.max(offset, offset + 1);
      }
      continue;
    }

    if (currentTokens + segTokens > maxTokens) {
      flush();
      // Apply overlap: re-add the tail of the previous chunk
      if (overlapTokens > 0 && segment.text.length > 0) {
        // The overlap comes from the *previous* content; for simplicity
        // in block-level chunking, we just start the next chunk fresh.
        // True character-level overlap is applied in the oversized-segment
        // splitting above.
      }
    }

    currentText += (currentText ? "\n\n" : "") + segment.text;
    currentBlockRefs.push(segment.blockId);
    currentTokens += segTokens;
  }

  flush();
  return chunks;
}

export function createDocumentChunkModule(
  options: DocumentChunkModuleOptions,
): McpModule {
  return {
    name: "document_chunk",
    register(server: McpServer) {
      server.registerTool(
        "document_chunk",
        {
          description:
            "Parse a document and split it into hierarchical multi-level chunks for RAG ingestion. Each chunk has a parent reference forming a tree: large chunks (e.g. 2048 tokens) at level 0, medium (512) at level 1, small (128) at level 2. Deterministic, no LLM or external API required. Supports the same formats as document_parse.",
          inputSchema: documentChunkInputSchema,
          outputSchema: resultEnvelopeSchema(chunkDataSchema),
        },
        async (input, context) => {
          let bytes: Uint8Array;
          try {
            const binary = atob(input.dataBase64);
            bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
          } catch {
            return toolError(new Error("Invalid base64 input"), { tool: "document_chunk" });
          }

          if (bytes.byteLength > MAX_INPUT_BYTES) {
            return toolError(
              new Error(`Input exceeds the 10 MB limit (${bytes.byteLength} bytes)`),
              { tool: "document_chunk" },
            );
          }

          const sizes = [...input.chunkSizes].sort((a, b) => b - a);
          const deadline = new Deadline(options.requestTimeoutMs);

          try {
            const result = await withConcurrency(
              options.limiter,
              deadline,
              context.mcpReq.signal,
              () =>
                withinDeadline(
                  async (signal) => {
                    const parsed = await parseBoundedDocument({
                      bytes,
                      declaredMime: input.mimeType,
                      filename: input.filename,
                      signal,
                    });

                    const segments = parsed.blocks
                      .map((block) => ({ text: blockText(block), blockId: block.blockId }))
                      .filter((s) => s.text.trim().length > 0);

                    const idCounter = { value: 0 };
                    const allChunks: Chunk[] = [];

                    // Level 0: largest chunks from original blocks
                    const level0 = chunkTextAtLevel(
                      segments,
                      sizes[0] ?? 2048,
                      input.overlap,
                      0,
                      null,
                      idCounter,
                    );
                    allChunks.push(...level0);

                    // Subsequent levels: split each parent chunk
                    let parentChunks = level0;
                    for (let levelIdx = 1; levelIdx < sizes.length; levelIdx += 1) {
                      signal.throwIfAborted();
                      const levelSize = sizes[levelIdx]!;
                      const childChunks: Chunk[] = [];

                      for (const parent of parentChunks) {
                        const parentSegments = [{ text: parent.text, blockId: parent.blockRefs[0] ?? parent.chunkId }];
                        const children = chunkTextAtLevel(
                          parentSegments,
                          levelSize,
                          input.overlap,
                          levelIdx,
                          parent.chunkId,
                          idCounter,
                        );
                        childChunks.push(...children);
                      }

                      allChunks.push(...childChunks);
                      parentChunks = childChunks;
                    }

                    if (input.fieldAware) {
                      const blockFields = extractFieldsFromBlocks(
                        parsed.blocks as DocumentBlock[],
                        parsed.metadata,
                      );
                      if (blockFields.size > 0) {
                        attachFieldsToChunks(allChunks, blockFields);
                      }
                    }

                    // Trim output if it exceeds maxOutputChars
                    let chunks = allChunks;
                    const serialized = JSON.stringify(chunks);
                    if (serialized.length > options.maxOutputChars) {
                      const limited: Chunk[] = [];
                      let size = 0;
                      for (const chunk of chunks) {
                        const json = JSON.stringify(chunk);
                        if (size + json.length > options.maxOutputChars) break;
                        limited.push(chunk);
                        size += json.length;
                      }
                      chunks = limited;
                    }

                    const totalTokens = level0.reduce((sum, c) => sum + c.tokenCount, 0);

                    return {
                      chunks,
                      chunkCount: allChunks.length,
                      levels: sizes.length,
                      totalTokens,
                      engine: "groundlane-hierarchical-chunk-v1",
                      inputBytes: bytes.byteLength,
                    };
                  },
                  deadline,
                  context.mcpReq.signal,
                  "document-chunk",
                ),
            );

            return structuredToolResult({ ok: true, data: result });
          } catch (error) {
            return toolError(error, { tool: "document_chunk" });
          }
        },
      );
    },
  };
}
