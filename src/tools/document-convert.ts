import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { CloudConvertProvider } from "../adapters/document/cloudconvert.js";
import { resolveConversion } from "../adapters/document/cloudconvert.js";
import type { AnydocLocalConverter } from "../adapters/document/anydoc-local.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

const MAX_INPUT_BYTES = 10 * 1024 * 1024;

const documentConvertInputSchema = z.object({
  dataBase64: z
    .string()
    .min(1)
    .max(Math.ceil(MAX_INPUT_BYTES * 4 / 3) + 16)
    .describe("Base64-encoded file content (max 10 MB decoded)."),
  mimeType: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("MIME type of the source file."),
  filename: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .describe("Original filename with extension (.doc, .xls, .ppt, or any format anydoc supports)."),
  outputFormat: z
    .enum(["markdown", "modern-office"])
    .default("markdown")
    .describe("Output format: 'markdown' returns converted Markdown text (default, uses local anydoc WASM, zero cost); 'modern-office' returns a .docx/.xlsx/.pptx file as base64 (uses CloudConvert API)."),
});

const convertDataSchema = z.object({
  content: z.string(),
  outputFormat: z.string(),
  outputMimeType: z.string(),
  outputFilename: z.string(),
  engine: z.string(),
  inputBytes: z.number().int().nonnegative(),
});

export interface DocumentConvertModuleOptions {
  localConverter?: AnydocLocalConverter | undefined;
  provider?: CloudConvertProvider | undefined;
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxOutputChars: number;
}

export function createDocumentConvertModule(
  options: DocumentConvertModuleOptions,
): McpModule {
  return {
    name: "document_convert",
    register(server: McpServer) {
      server.registerTool(
        "document_convert",
        {
          description:
            "Convert document files to Markdown or modern Office formats. Default output is Markdown using the built-in anydoc WASM engine (zero cost, no API key). Supports .doc, .xls, .ppt, .docx, .xlsx, .pptx, .odt, .ods, .odp, .rtf, .epub, .csv, .pdf. Use outputFormat 'modern-office' to get .docx/.xlsx/.pptx output via CloudConvert (requires CLOUDCONVERT_API_KEY). Scanned PDFs that need OCR are rejected with a diagnostic — use document_ocr instead.",
          inputSchema: documentConvertInputSchema,
          outputSchema: resultEnvelopeSchema(convertDataSchema),
        },
        async (input, context) => {
          let bytes: Uint8Array;
          try {
            const binary = atob(input.dataBase64);
            bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
          } catch {
            return toolError(new Error("Invalid base64 input"), { tool: "document_convert" });
          }

          if (bytes.byteLength > MAX_INPUT_BYTES) {
            return toolError(
              new Error(`Input exceeds the 10 MB limit (${bytes.byteLength} bytes)`),
              { tool: "document_convert" },
            );
          }

          const deadline = new Deadline(Math.max(options.requestTimeoutMs, 60_000));

          // Markdown output: use local anydoc WASM (free, fast)
          if (input.outputFormat === "markdown") {
            if (options.localConverter === undefined) {
              return toolError(
                new Error("Local document converter (anydoc WASM) is not available"),
                { tool: "document_convert" },
              );
            }

            try {
              const result = await withConcurrency(
                options.limiter,
                deadline,
                context.mcpReq.signal,
                () => options.localConverter!.convert(bytes, input.filename),
              );

              let content = result.markdown;
              if (content.length > options.maxOutputChars) {
                content = content.slice(0, options.maxOutputChars);
              }

              const baseName = input.filename.replace(/\.[^.]+$/u, "");
              return structuredToolResult({
                ok: true,
                data: {
                  content,
                  outputFormat: "markdown",
                  outputMimeType: "text/markdown",
                  outputFilename: `${baseName}.md`,
                  engine: result.engine,
                  inputBytes: bytes.byteLength,
                },
              });
            } catch (error) {
              return toolError(error, { tool: "document_convert" });
            }
          }

          // Modern Office output: use CloudConvert API
          if (options.provider === undefined) {
            return toolError(
              new Error("document_convert modern-office output requires CLOUDCONVERT_API_KEY"),
              { tool: "document_convert" },
            );
          }

          const baseMime = input.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
          const conversion = resolveConversion(baseMime, input.filename);
          if (conversion === undefined) {
            return toolError(
              new Error("Unsupported format for modern-office conversion. Supported: .doc → .docx, .xls → .xlsx, .ppt → .pptx."),
              { tool: "document_convert" },
            );
          }

          try {
            const result = await withConcurrency(
              options.limiter,
              deadline,
              context.mcpReq.signal,
              () =>
                withinDeadline(
                  (signal) =>
                    options.provider!.convert(bytes, baseMime, input.filename, signal),
                  deadline,
                  context.mcpReq.signal,
                  "document-convert",
                ),
            );

            const outputBase64 = btoa(
              Array.from(result.bytes)
                .map((b) => String.fromCharCode(b))
                .join(""),
            );

            return structuredToolResult({
              ok: true,
              data: {
                content: outputBase64,
                outputFormat: "modern-office",
                outputMimeType: result.outputMimeType,
                outputFilename: result.outputFilename,
                engine: result.engine,
                inputBytes: bytes.byteLength,
              },
            });
          } catch (error) {
            return toolError(error, { tool: "document_convert" });
          }
        },
      );
    },
  };
}
