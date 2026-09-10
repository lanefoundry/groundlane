import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { CloudConvertProvider } from "../adapters/document/cloudconvert.js";
import { resolveConversion } from "../adapters/document/cloudconvert.js";
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
    .describe("MIME type: application/msword, application/vnd.ms-excel, or application/vnd.ms-powerpoint."),
  filename: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .describe("Original filename with extension (.doc, .xls, or .ppt)."),
});

const convertDataSchema = z.object({
  dataBase64: z.string(),
  outputMimeType: z.string(),
  outputFilename: z.string(),
  engine: z.string(),
  inputBytes: z.number().int().nonnegative(),
  outputBytes: z.number().int().nonnegative(),
});

export interface DocumentConvertModuleOptions {
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
            "Convert legacy Office files (.doc, .xls, .ppt) to modern formats (.docx, .xlsx, .pptx) using CloudConvert. Returns the converted file as base64. The converted output can then be fed to document_parse for text extraction. Free tier: 25 conversions/day. Requires CLOUDCONVERT_API_KEY.",
          inputSchema: documentConvertInputSchema,
          outputSchema: resultEnvelopeSchema(convertDataSchema),
        },
        async (input, context) => {
          if (options.provider === undefined) {
            return toolError(
              new Error("document_convert is not configured: set CLOUDCONVERT_API_KEY"),
              { tool: "document_convert" },
            );
          }

          const baseMime = input.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
          const conversion = resolveConversion(baseMime, input.filename);
          if (conversion === undefined) {
            return toolError(
              new Error("Unsupported format for conversion. Supported: .doc → .docx, .xls → .xlsx, .ppt → .pptx."),
              { tool: "document_convert" },
            );
          }

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
                dataBase64: outputBase64,
                outputMimeType: result.outputMimeType,
                outputFilename: result.outputFilename,
                engine: result.engine,
                inputBytes: bytes.byteLength,
                outputBytes: result.bytes.byteLength,
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
