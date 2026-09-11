import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  MAX_DOCUMENT_BYTES,
  parseBoundedDocument,
} from "../adapters/document/bounded-document-parser.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

const MAX_INPUT_BYTES = MAX_DOCUMENT_BYTES;
const HEADING_MAX_LENGTH = 200;

const documentTocInputSchema = z.object({
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
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(6)
    .default(6)
    .describe("Maximum heading depth to include (1–6). Default: 6."),
});

const tocEntrySchema: z.ZodType<TocEntry> = z.lazy(() =>
  z.object({
    id: z.string(),
    level: z.number().int().min(1).max(6),
    title: z.string(),
    blockRef: z.string(),
    children: z.array(tocEntrySchema),
  }),
);

interface TocEntry {
  id: string;
  level: number;
  title: string;
  blockRef: string;
  children: TocEntry[];
}

const tocDataSchema = z.object({
  entries: z.array(tocEntrySchema),
  flatCount: z.number().int().nonnegative(),
  maxDepthFound: z.number().int().nonnegative(),
  engine: z.string(),
  inputBytes: z.number().int().nonnegative(),
});

export interface DocumentTocModuleOptions {
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxOutputChars: number;
}

export function createDocumentTocModule(
  options: DocumentTocModuleOptions,
): McpModule {
  return {
    name: "document_toc",
    register(server: McpServer) {
      server.registerTool(
        "document_toc",
        {
          description:
            "Extract a structured table of contents (heading hierarchy) from a document. Returns a nested tree of headings with levels, enabling vectorless retrieval for structured documents. Deterministic, no LLM or external API required. Supports all document_parse formats. Heading detection uses Markdown heading prefixes, HTML heading tags, short leading lines, and slide/page title heuristics.",
          inputSchema: documentTocInputSchema,
          outputSchema: resultEnvelopeSchema(tocDataSchema),
        },
        async (input, context) => {
          let bytes: Uint8Array;
          try {
            const binary = atob(input.dataBase64);
            bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
          } catch {
            return toolError(new Error("Invalid base64 input"), { tool: "document_toc" });
          }

          if (bytes.byteLength > MAX_INPUT_BYTES) {
            return toolError(
              new Error(`Input exceeds the 10 MB limit (${bytes.byteLength} bytes)`),
              { tool: "document_toc" },
            );
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
                    signal.throwIfAborted();
                    const parsed = await parseBoundedDocument({
                      bytes,
                      declaredMime: input.mimeType,
                      filename: input.filename,
                      signal,
                    });

                    const flatHeadings = extractHeadings(
                      parsed.blocks.filter(
                        (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
                      ),
                      input.maxDepth,
                    );

                    const tree = buildTree(flatHeadings);
                    const maxDepthFound = flatHeadings.length > 0
                      ? Math.max(...flatHeadings.map((h) => h.level))
                      : 0;

                    return {
                      entries: tree,
                      flatCount: flatHeadings.length,
                      maxDepthFound,
                      engine: "groundlane-toc-heuristic-v1",
                      inputBytes: bytes.byteLength,
                    };
                  },
                  deadline,
                  context.mcpReq.signal,
                  "document-toc",
                ),
            );

            const serialized = JSON.stringify(result);
            if (serialized.length > options.maxOutputChars) {
              return structuredToolResult({
                ok: true,
                data: {
                  ...result,
                  entries: flattenToDepth(result.entries, Math.max(1, input.maxDepth - 1)),
                },
              });
            }

            return structuredToolResult({ ok: true, data: result });
          } catch (error) {
            return toolError(error, { tool: "document_toc" });
          }
        },
      );
    },
  };
}

interface FlatHeading {
  id: string;
  level: number;
  title: string;
  blockRef: string;
}

function extractHeadings(
  blocks: readonly { readonly blockId: string; readonly content: string }[],
  maxDepth: number,
): FlatHeading[] {
  const headings: FlatHeading[] = [];
  let counter = 0;

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]!;
    const content = block.content.trim();
    if (!content) continue;

    const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);

    for (const line of lines) {
      const heading = detectHeading(line, i, blocks.length, maxDepth);
      if (heading !== null) {
        counter += 1;
        headings.push({
          id: `toc-${String(counter)}`,
          level: heading.level,
          title: heading.title.slice(0, HEADING_MAX_LENGTH),
          blockRef: block.blockId,
        });
      }
    }
  }

  return headings;
}

function detectHeading(
  line: string,
  blockIndex: number,
  totalBlocks: number,
  maxDepth: number,
): { level: number; title: string } | null {
  // Markdown heading: # Title, ## Title, etc.
  const mdMatch = /^(#{1,6})\s+(.+)$/u.exec(line);
  if (mdMatch) {
    const level = mdMatch[1]!.length;
    if (level <= maxDepth) {
      return { level, title: mdMatch[2]!.trim() };
    }
    return null;
  }

  // HTML heading tags in text: <h1>Title</h1>, etc.
  const htmlMatch = /^<h([1-6])[^>]*>\s*(.+?)\s*<\/h\1>/iu.exec(line);
  if (htmlMatch) {
    const level = Number(htmlMatch[1]);
    if (level <= maxDepth) {
      return { level, title: htmlMatch[2]!.replace(/<[^>]*>/gu, "").trim() };
    }
    return null;
  }

  // Slide/page title heuristic: first block is often a title
  if (blockIndex === 0 && line.length <= 120 && line.length >= 2 && !line.includes("\n")) {
    return { level: 1, title: line };
  }

  // Short standalone line that looks like a section heading:
  // - uppercase or title-case
  // - not too long
  // - no trailing punctuation (not a sentence)
  if (
    line.length >= 2 &&
    line.length <= 80 &&
    !line.endsWith(".") &&
    !line.endsWith(",") &&
    !line.endsWith(";") &&
    !line.endsWith(":") &&
    !line.endsWith("?") &&
    !line.endsWith("!") &&
    (isAllCaps(line) || isTitleCase(line))
  ) {
    const level = isAllCaps(line) ? 2 : 3;
    if (level <= maxDepth) {
      return { level, title: line };
    }
  }

  return null;
}

function isAllCaps(text: string): boolean {
  const letters = text.replace(/[^a-zA-Z]/gu, "");
  return letters.length >= 2 && letters === letters.toUpperCase();
}

function isTitleCase(text: string): boolean {
  const words = text.split(/\s+/u).filter((w) => w.length > 0);
  if (words.length < 2) return false;
  const significantWords = words.filter((w) => w.length > 3);
  if (significantWords.length === 0) return false;
  return significantWords.every((w) => /^[A-Z]/u.test(w));
}

function buildTree(headings: FlatHeading[]): TocEntry[] {
  const root: TocEntry[] = [];
  const stack: TocEntry[] = [];

  for (const h of headings) {
    const entry: TocEntry = {
      id: h.id,
      level: h.level,
      title: h.title,
      blockRef: h.blockRef,
      children: [],
    };

    while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      root.push(entry);
    } else {
      stack[stack.length - 1]!.children.push(entry);
    }

    stack.push(entry);
  }

  return root;
}

function flattenToDepth(entries: TocEntry[], maxDepth: number): TocEntry[] {
  return entries.map((e) => ({
    ...e,
    children: e.level < maxDepth ? flattenToDepth(e.children, maxDepth) : [],
  }));
}
