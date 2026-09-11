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

const sourceSchema = z.object({
  dataBase64: z
    .string()
    .min(1)
    .max(Math.ceil(MAX_INPUT_BYTES * 4 / 3) + 16),
  mimeType: z
    .string()
    .trim()
    .min(1)
    .max(200),
  filename: z
    .string()
    .trim()
    .min(1)
    .max(255),
});

const documentCompareInputSchema = z.object({
  sourceA: sourceSchema.describe("First document to compare."),
  sourceB: sourceSchema.describe("Second document to compare."),
  granularity: z
    .enum(["line", "word", "block"])
    .default("line")
    .describe("Diff granularity: 'line' splits by newlines, 'word' splits by whitespace, 'block' compares parsed blocks. Default: line."),
});

const changeSchema = z.object({
  type: z.enum(["added", "removed", "unchanged"]),
  content: z.string(),
});

const summarySchema = z.object({
  totalChanges: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  removals: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
});

const compareDataSchema = z.object({
  changes: z.array(changeSchema),
  summary: summarySchema,
  similarity: z.number().min(0).max(1),
  engine: z.string(),
});

export interface DocumentCompareModuleOptions {
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxOutputChars: number;
}

export function createDocumentCompareModule(
  options: DocumentCompareModuleOptions,
): McpModule {
  return {
    name: "document_compare",
    register(server: McpServer) {
      server.registerTool(
        "document_compare",
        {
          description:
            "Compare two documents and return a structured diff. Both documents are parsed through the same deterministic engine as document_parse, then diffed at the chosen granularity (line, word, or block). Returns changes with additions, removals, unchanged sections, and a similarity score. Deterministic, no LLM or external API required.",
          inputSchema: documentCompareInputSchema,
          outputSchema: resultEnvelopeSchema(compareDataSchema),
        },
        async (input, context) => {
          let bytesA: Uint8Array;
          let bytesB: Uint8Array;
          try {
            bytesA = Uint8Array.from(atob(input.sourceA.dataBase64), (c) => c.charCodeAt(0));
          } catch {
            return toolError(new Error("Invalid base64 in sourceA"), { tool: "document_compare" });
          }
          try {
            bytesB = Uint8Array.from(atob(input.sourceB.dataBase64), (c) => c.charCodeAt(0));
          } catch {
            return toolError(new Error("Invalid base64 in sourceB"), { tool: "document_compare" });
          }

          if (bytesA.byteLength > MAX_INPUT_BYTES) {
            return toolError(new Error(`sourceA exceeds the ${MAX_INPUT_BYTES} byte limit`), { tool: "document_compare" });
          }
          if (bytesB.byteLength > MAX_INPUT_BYTES) {
            return toolError(new Error(`sourceB exceeds the ${MAX_INPUT_BYTES} byte limit`), { tool: "document_compare" });
          }

          const deadline = new Deadline(options.requestTimeoutMs);

          try {
            const result = await withConcurrency(
              options.limiter,
              deadline,
              context.mcpReq.signal,
              () =>
                withinDeadline(
                  async (signal) => {
                    const parsedA = await parseBoundedDocument({
                      bytes: bytesA,
                      declaredMime: input.sourceA.mimeType,
                      filename: input.sourceA.filename,
                      signal,
                    });
                    signal.throwIfAborted();
                    const parsedB = await parseBoundedDocument({
                      bytes: bytesB,
                      declaredMime: input.sourceB.mimeType,
                      filename: input.sourceB.filename,
                      signal,
                    });

                    const textA = parsedA.blocks.map(blockText).filter(Boolean).join("\n");
                    const textB = parsedB.blocks.map(blockText).filter(Boolean).join("\n");

                    const unitsA = splitUnits(textA, input.granularity);
                    const unitsB = splitUnits(textB, input.granularity);

                    const changes = computeDiff(unitsA, unitsB);
                    const additions = changes.filter((c) => c.type === "added").length;
                    const removals = changes.filter((c) => c.type === "removed").length;
                    const unchanged = changes.filter((c) => c.type === "unchanged").length;

                    const similarity = jaccardSimilarity(unitsA, unitsB);

                    return {
                      changes,
                      summary: {
                        totalChanges: additions + removals,
                        additions,
                        removals,
                        unchanged,
                      },
                      similarity,
                      engine: "groundlane-document-compare-v1",
                    };
                  },
                  deadline,
                  context.mcpReq.signal,
                  "document-compare",
                ),
            );

            let changes = result.changes;
            const serialized = JSON.stringify(changes);
            if (serialized.length > options.maxOutputChars) {
              const limited: typeof changes[number][] = [];
              let size = 0;
              for (const change of changes) {
                const json = JSON.stringify(change);
                if (size + json.length > options.maxOutputChars) break;
                limited.push(change);
                size += json.length;
              }
              changes = limited;
            }

            return structuredToolResult({
              ok: true,
              data: { ...result, changes },
            });
          } catch (error) {
            return toolError(error, { tool: "document_compare" });
          }
        },
      );
    },
  };
}

function blockText(block: DocumentBlock): string {
  if (block.type === "text") return block.content;
  if (block.type === "table") return block.cells.map((c) => c.content).join(" | ");
  if (block.type === "formula") return block.expression;
  if (block.type === "asset") return block.altText ?? "";
  return "";
}

function splitUnits(text: string, granularity: "line" | "word" | "block"): string[] {
  if (granularity === "word") return text.split(/\s+/).filter(Boolean);
  if (granularity === "block") return text.split(/\n{2,}/).filter(Boolean);
  return text.split("\n");
}

function computeDiff(
  a: string[],
  b: string[],
): Array<{ type: "added" | "removed" | "unchanged"; content: string }> {
  const lcs = computeLcs(a, b);
  const changes: Array<{ type: "added" | "removed" | "unchanged"; content: string }> = [];

  let ai = 0;
  let bi = 0;
  let li = 0;

  while (ai < a.length || bi < b.length) {
    if (li < lcs.length && ai < a.length && bi < b.length && a[ai] === lcs[li] && b[bi] === lcs[li]) {
      changes.push({ type: "unchanged", content: a[ai]! });
      ai += 1;
      bi += 1;
      li += 1;
    } else if (li < lcs.length && ai < a.length && a[ai] !== lcs[li]) {
      changes.push({ type: "removed", content: a[ai]! });
      ai += 1;
    } else if (li < lcs.length && bi < b.length && b[bi] !== lcs[li]) {
      changes.push({ type: "added", content: b[bi]! });
      bi += 1;
    } else if (li >= lcs.length && ai < a.length) {
      changes.push({ type: "removed", content: a[ai]! });
      ai += 1;
    } else if (li >= lcs.length && bi < b.length) {
      changes.push({ type: "added", content: b[bi]! });
      bi += 1;
    }
  }

  return changes;
}

function computeLcs(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;

  // For very large inputs, use a bounded approach
  if (m * n > 10_000_000) {
    return computeLcsGreedy(a, b);
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  const result: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.push(a[i - 1]!);
      i -= 1;
      j -= 1;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      i -= 1;
    } else {
      j -= 1;
    }
  }

  return result.reverse();
}

function computeLcsGreedy(a: string[], b: string[]): string[] {
  const bIndex = new Map<string, number[]>();
  for (let j = 0; j < b.length; j += 1) {
    const key = b[j]!;
    if (!bIndex.has(key)) bIndex.set(key, []);
    bIndex.get(key)!.push(j);
  }

  const result: string[] = [];
  let lastJ = -1;
  for (const item of a) {
    const positions = bIndex.get(item);
    if (positions === undefined) continue;
    for (const pos of positions) {
      if (pos > lastJ) {
        result.push(item);
        lastJ = pos;
        break;
      }
    }
  }
  return result;
}

function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  if (union === 0) return 1;
  return Math.round((intersection / union) * 1000) / 1000;
}
