import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { OcrSpaceProvider } from "../adapters/document/ocr-space.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

const MAX_INPUT_BYTES = 1_024_000;

const SUPPORTED_MIMES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/tiff",
  "image/bmp",
  "image/webp",
]);

const documentOcrInputSchema = z.object({
  dataBase64: z
    .string()
    .min(1)
    .max(Math.ceil(MAX_INPUT_BYTES * 4 / 3) + 16)
    .describe("Base64-encoded file content (max 1 MB decoded)."),
  mimeType: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("MIME type: application/pdf, image/png, image/jpeg, image/gif, image/tiff, image/bmp, or image/webp."),
  filename: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .describe("Original filename with extension."),
  language: z
    .string()
    .trim()
    .min(2)
    .max(10)
    .default("eng")
    .describe("OCR language code (e.g. eng, chi_tra, jpn). Default: eng."),
});

const ocrPageSchema = z.object({
  pageNumber: z.number().int().positive(),
  text: z.string(),
  exitCode: z.number().int(),
});

const ocrDataSchema = z.object({
  text: z.string(),
  pages: z.array(ocrPageSchema),
  engine: z.string(),
  inputBytes: z.number().int().nonnegative(),
  mimeType: z.string(),
});

export interface DocumentOcrModuleOptions {
  provider?: OcrSpaceProvider | undefined;
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxOutputChars: number;
}

export function createDocumentOcrModule(
  options: DocumentOcrModuleOptions,
): McpModule {
  return {
    name: "document_ocr",
    register(server: McpServer) {
      server.registerTool(
        "document_ocr",
        {
          description:
            "Extract text from scanned PDFs and images using OCR. Accepts base64-encoded PDF, PNG, JPEG, GIF, TIFF, BMP, or WebP (max 1 MB). Returns extracted text with per-page breakdown. This tool calls an external OCR API; use document_parse for text-based documents that do not require OCR.",
          inputSchema: documentOcrInputSchema,
          outputSchema: resultEnvelopeSchema(ocrDataSchema),
        },
        async (input, context) => {
          if (options.provider === undefined) {
            return toolError(
              new Error("document_ocr is not configured: set OCR_SPACE_API_KEY"),
              { tool: "document_ocr" },
            );
          }

          const baseMime = input.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
          if (!SUPPORTED_MIMES.has(baseMime)) {
            return toolError(
              new Error(`Unsupported MIME type for OCR: ${baseMime}. Supported: PDF, PNG, JPEG, GIF, TIFF, BMP, WebP.`),
              { tool: "document_ocr" },
            );
          }

          let bytes: Uint8Array;
          try {
            const binary = atob(input.dataBase64);
            bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
          } catch {
            return toolError(new Error("Invalid base64 input"), {
              tool: "document_ocr",
            });
          }

          if (bytes.byteLength > MAX_INPUT_BYTES) {
            return toolError(
              new Error(`Input exceeds the 1 MB limit (${bytes.byteLength} bytes)`),
              { tool: "document_ocr" },
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
                  (signal) =>
                    options.provider!.ocr(bytes, baseMime, input.filename, signal),
                  deadline,
                  context.mcpReq.signal,
                  "document-ocr",
                ),
            );

            let text = result.text;
            if (text.length > options.maxOutputChars) {
              text = text.slice(0, options.maxOutputChars);
            }

            return structuredToolResult({
              ok: true,
              data: {
                text,
                pages: result.pages,
                engine: result.engine,
                inputBytes: bytes.byteLength,
                mimeType: baseMime,
              },
            });
          } catch (error) {
            return toolError(error, { tool: "document_ocr" });
          }
        },
      );
    },
  };
}
