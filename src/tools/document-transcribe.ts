import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { WorkersAiWhisperProvider } from "../adapters/document/workers-ai-whisper.js";
import { isSupportedAudioMime } from "../adapters/document/workers-ai-whisper.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

const MAX_INPUT_BYTES = 25 * 1024 * 1024;

const documentTranscribeInputSchema = z.object({
  dataBase64: z
    .string()
    .min(1)
    .max(Math.ceil(MAX_INPUT_BYTES * 4 / 3) + 16)
    .describe("Base64-encoded audio content (max 25 MB decoded)."),
  mimeType: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("MIME type: audio/mpeg, audio/wav, audio/webm, audio/ogg, audio/flac, audio/mp4, or audio/m4a."),
  filename: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .describe("Original filename with extension."),
});

const segmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
});

const transcribeDataSchema = z.object({
  text: z.string(),
  segments: z.array(segmentSchema),
  engine: z.string(),
  durationSeconds: z.number().nullable(),
  inputBytes: z.number().int().nonnegative(),
});

export interface DocumentTranscribeModuleOptions {
  provider?: WorkersAiWhisperProvider | undefined;
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxOutputChars: number;
}

export function createDocumentTranscribeModule(
  options: DocumentTranscribeModuleOptions,
): McpModule {
  return {
    name: "document_transcribe",
    register(server: McpServer) {
      server.registerTool(
        "document_transcribe",
        {
          description:
            "Transcribe audio to text using Cloudflare Workers AI (Whisper). Accepts base64-encoded MP3, WAV, WebM, OGG, FLAC, or M4A (max 25 MB). Returns transcribed text with word-level timestamps. Requires Cloudflare account credentials (CF_BROWSER_ACCOUNT_ID and CF_BROWSER_API_TOKEN).",
          inputSchema: documentTranscribeInputSchema,
          outputSchema: resultEnvelopeSchema(transcribeDataSchema),
        },
        async (input, context) => {
          if (options.provider === undefined) {
            return toolError(
              new Error("document_transcribe is not configured: set CF_BROWSER_ACCOUNT_ID and CF_BROWSER_API_TOKEN"),
              { tool: "document_transcribe" },
            );
          }

          const baseMime = input.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
          if (!isSupportedAudioMime(baseMime)) {
            return toolError(
              new Error(`Unsupported MIME type for transcription: ${baseMime}. Supported: MP3, WAV, WebM, OGG, FLAC, M4A.`),
              { tool: "document_transcribe" },
            );
          }

          let bytes: Uint8Array;
          try {
            const binary = atob(input.dataBase64);
            bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
          } catch {
            return toolError(new Error("Invalid base64 input"), { tool: "document_transcribe" });
          }

          if (bytes.byteLength > MAX_INPUT_BYTES) {
            return toolError(
              new Error(`Input exceeds the 25 MB limit (${bytes.byteLength} bytes)`),
              { tool: "document_transcribe" },
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
                  (signal) => options.provider!.transcribe(bytes, signal),
                  deadline,
                  context.mcpReq.signal,
                  "document-transcribe",
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
                segments: result.segments,
                engine: result.engine,
                durationSeconds: result.durationSeconds,
                inputBytes: bytes.byteLength,
              },
            });
          } catch (error) {
            return toolError(error, { tool: "document_transcribe" });
          }
        },
      );
    },
  };
}
