import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { unzipSync } from "fflate";

import {
  MAX_DOCUMENT_BYTES,
  resolveDocumentParserProfile,
  parseBoundedDocument,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_UNCOMPRESSED_BYTES,
} from "../adapters/document/bounded-document-parser.js";
import {
  buildCanonicalEnvelopeFromAdapter,
  projectCanonicalDocument,
} from "../core/canonical-document.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

const MAX_INPUT_BYTES = 32 * 1024 * 1024;

const archiveExtractInputSchema = z.object({
  dataBase64: z
    .string()
    .min(1)
    .max(Math.ceil(MAX_INPUT_BYTES * 4 / 3) + 16)
    .describe("Base64-encoded ZIP archive (max 32 MB decoded)."),
  filename: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .default("archive.zip")
    .describe("Original filename."),
  maxFiles: z
    .number()
    .int()
    .min(1)
    .max(MAX_ARCHIVE_ENTRIES)
    .default(100)
    .describe("Maximum files to extract and parse. Default: 100."),
  projection: z
    .enum(["markdown", "text", "structured", "all"])
    .default("markdown")
    .describe("Output projection for parsed files. Default: markdown."),
});

const fileResultSchema = z.object({
  path: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  parsed: z.boolean(),
  content: z.string().nullable(),
  error: z.string().nullable(),
});

const archiveDataSchema = z.object({
  files: z.array(fileResultSchema),
  totalFiles: z.number().int().nonnegative(),
  parsedFiles: z.number().int().nonnegative(),
  skippedFiles: z.number().int().nonnegative(),
  engine: z.string(),
  inputBytes: z.number().int().nonnegative(),
});

export interface DocumentArchiveExtractModuleOptions {
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxOutputChars: number;
}

export function createDocumentArchiveExtractModule(
  options: DocumentArchiveExtractModuleOptions,
): McpModule {
  return {
    name: "document_archive_extract",
    register(server: McpServer) {
      server.registerTool(
        "document_archive_extract",
        {
          description:
            "Extract and parse files from a ZIP archive. Each supported file inside the archive is parsed through the same deterministic engine as document_parse (PDF, DOCX, XLSX, PPTX, ODF, CSV, TXT, Markdown, JSON, XML, HTML, RTF, EPUB, EML). Unsupported or binary files are listed but not parsed. No LLM or external API required.",
          inputSchema: archiveExtractInputSchema,
          outputSchema: resultEnvelopeSchema(archiveDataSchema),
        },
        async (input, context) => {
          let bytes: Uint8Array;
          try {
            const binary = atob(input.dataBase64);
            bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
          } catch {
            return toolError(new Error("Invalid base64 input"), { tool: "document_archive_extract" });
          }

          if (bytes.byteLength > MAX_INPUT_BYTES) {
            return toolError(
              new Error(`Input exceeds the 32 MB limit (${bytes.byteLength} bytes)`),
              { tool: "document_archive_extract" },
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
                    let files: Record<string, Uint8Array>;
                    try {
                      files = unzipSync(bytes);
                    } catch {
                      throw new Error("Malformed or unreadable ZIP archive");
                    }

                    const entries = Object.entries(files);
                    const totalUncompressed = entries.reduce((sum, [, v]) => sum + v.byteLength, 0);
                    if (entries.length > MAX_ARCHIVE_ENTRIES) {
                      throw new Error(`Archive contains ${entries.length} entries, exceeding the ${MAX_ARCHIVE_ENTRIES} limit`);
                    }
                    if (totalUncompressed > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
                      throw new Error("Archive expansion exceeds the safe limit");
                    }

                    const safeEntries = entries.filter(([name]) => {
                      if (name.endsWith("/")) return false;
                      const segments = name.split("/");
                      return !name.includes("\\") && !name.includes("\0") && !name.startsWith("/") &&
                        !segments.some((s) => s === "" || s === "." || s === "..");
                    });

                    const results: Array<{
                      path: string;
                      mimeType: string;
                      sizeBytes: number;
                      parsed: boolean;
                      content: string | null;
                      error: string | null;
                    }> = [];

                    let parsedCount = 0;
                    let outputChars = 0;

                    for (const [name, fileBytes] of safeEntries.slice(0, input.maxFiles)) {
                      signal.throwIfAborted();

                      const extension = name.toLowerCase().split(".").pop() ?? "";
                      const mimeType = extensionToMime(extension);
                      const profile = resolveDocumentParserProfile(mimeType, name);

                      if (profile === "unsupported" || fileBytes.byteLength > MAX_DOCUMENT_BYTES) {
                        results.push({
                          path: name,
                          mimeType,
                          sizeBytes: fileBytes.byteLength,
                          parsed: false,
                          content: null,
                          error: profile === "unsupported" ? "Unsupported format" : "File too large",
                        });
                        continue;
                      }

                      try {
                        const parsed = await parseBoundedDocument({
                          bytes: fileBytes,
                          declaredMime: mimeType,
                          filename: name.split("/").pop() ?? name,
                          signal,
                        });

                        const envelope = buildCanonicalEnvelopeFromAdapter({
                          documentId: `archive-${name}`,
                          sourceIdentity: { contentHash: "archive" },
                          blocks: parsed.blocks,
                          readingOrder: parsed.blocks.map((b) => b.blockId),
                          status: "success",
                          capabilityStates: parsed.capabilities,
                          provenance: { engine: "groundlane-bounded-document-v3", model: "unknown", version: "unknown", cost: null, confidence: null },
                          warnings: parsed.warnings,
                          metadata: parsed.metadata,
                        });

                        const projected = projectCanonicalDocument(envelope, input.projection);
                        const content = typeof projected === "string" ? projected : JSON.stringify(projected);

                        if (outputChars + content.length > options.maxOutputChars) {
                          results.push({
                            path: name,
                            mimeType: parsed.mediaType,
                            sizeBytes: fileBytes.byteLength,
                            parsed: false,
                            content: null,
                            error: "Output limit reached",
                          });
                          continue;
                        }

                        outputChars += content.length;
                        parsedCount += 1;
                        results.push({
                          path: name,
                          mimeType: parsed.mediaType,
                          sizeBytes: fileBytes.byteLength,
                          parsed: true,
                          content,
                          error: null,
                        });
                      } catch (error) {
                        results.push({
                          path: name,
                          mimeType,
                          sizeBytes: fileBytes.byteLength,
                          parsed: false,
                          content: null,
                          error: error instanceof Error ? error.message : "Parse failed",
                        });
                      }
                    }

                    return {
                      files: results,
                      totalFiles: safeEntries.length,
                      parsedFiles: parsedCount,
                      skippedFiles: safeEntries.length - results.length,
                      engine: "groundlane-archive-extract-v1",
                      inputBytes: bytes.byteLength,
                    };
                  },
                  deadline,
                  context.mcpReq.signal,
                  "document-archive-extract",
                ),
            );

            return structuredToolResult({ ok: true, data: result });
          } catch (error) {
            return toolError(error, { tool: "document_archive_extract" });
          }
        },
      );
    },
  };
}

function extensionToMime(ext: string): string {
  const map: Record<string, string> = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    odt: "application/vnd.oasis.opendocument.text",
    ods: "application/vnd.oasis.opendocument.spreadsheet",
    odp: "application/vnd.oasis.opendocument.presentation",
    csv: "text/csv",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",
    xml: "application/xml",
    html: "text/html",
    htm: "text/html",
    rtf: "application/rtf",
    epub: "application/epub+zip",
    eml: "message/rfc822",
  };
  return map[ext] ?? "application/octet-stream";
}
