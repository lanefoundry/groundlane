import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { extractTablesFromPdf } from "../adapters/document/pdf-table-extractor.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

const MAX_INPUT_BYTES = 10 * 1024 * 1024;

const documentTableExtractInputSchema = z.object({
  dataBase64: z
    .string()
    .min(1)
    .max(Math.ceil(MAX_INPUT_BYTES * 4 / 3) + 16)
    .describe("Base64-encoded PDF content (max 10 MB decoded)."),
  maxPages: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe("Maximum pages to scan for tables. Default: 50."),
});

const tableSchema = z.object({
  pageNumber: z.number().int().positive(),
  rows: z.array(z.array(z.string())),
  rowCount: z.number().int().nonnegative(),
  columnCount: z.number().int().nonnegative(),
});

const tableExtractDataSchema = z.object({
  tables: z.array(tableSchema),
  tableCount: z.number().int().nonnegative(),
  engine: z.string(),
  inputBytes: z.number().int().nonnegative(),
});

export interface DocumentTableExtractModuleOptions {
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxOutputChars: number;
}

export function createDocumentTableExtractModule(
  options: DocumentTableExtractModuleOptions,
): McpModule {
  return {
    name: "document_table_extract",
    register(server: McpServer) {
      server.registerTool(
        "document_table_extract",
        {
          description:
            "Extract tables from PDF documents using spatial heuristics. Returns structured rows and columns for each detected table. Deterministic, no LLM or external API required. Works best on PDFs with regular grid-aligned tables; accuracy drops on merged cells or complex layouts. For text extraction, use document_parse instead.",
          inputSchema: documentTableExtractInputSchema,
          outputSchema: resultEnvelopeSchema(tableExtractDataSchema),
        },
        async (input, context) => {
          let bytes: Uint8Array;
          try {
            const binary = atob(input.dataBase64);
            bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
          } catch {
            return toolError(new Error("Invalid base64 input"), { tool: "document_table_extract" });
          }

          if (bytes.byteLength > MAX_INPUT_BYTES) {
            return toolError(
              new Error(`Input exceeds the 10 MB limit (${bytes.byteLength} bytes)`),
              { tool: "document_table_extract" },
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
                  (signal) => extractTablesFromPdf(bytes, signal, input.maxPages),
                  deadline,
                  context.mcpReq.signal,
                  "document-table-extract",
                ),
            );

            let tables = result.tables;
            const serialized = JSON.stringify(tables);
            if (serialized.length > options.maxOutputChars) {
              const limited: typeof tables[number][] = [];
              let size = 0;
              for (const table of tables) {
                const tableJson = JSON.stringify(table);
                if (size + tableJson.length > options.maxOutputChars) break;
                limited.push(table);
                size += tableJson.length;
              }
              tables = limited;
            }

            return structuredToolResult({
              ok: true,
              data: {
                tables,
                tableCount: result.tables.length,
                engine: result.engine,
                inputBytes: bytes.byteLength,
              },
            });
          } catch (error) {
            return toolError(error, { tool: "document_table_extract" });
          }
        },
      );
    },
  };
}
