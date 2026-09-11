import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  MAX_DOCUMENT_BYTES,
  resolveDocumentParserProfile,
  parseBoundedDocument,
} from "../adapters/document/bounded-document-parser.js";
import {
  buildCanonicalEnvelopeFromAdapter,
  projectCanonicalDocument,
} from "../core/canonical-document.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_MIME_DEPTH = 4;
const MAX_ATTACHMENTS = 50;

const emailExtractInputSchema = z.object({
  dataBase64: z
    .string()
    .min(1)
    .max(Math.ceil(MAX_INPUT_BYTES * 4 / 3) + 16)
    .describe("Base64-encoded EML file content (max 10 MB decoded)."),
  filename: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .default("message.eml")
    .describe("Original filename."),
  parseAttachments: z
    .boolean()
    .default(true)
    .describe("Whether to parse attachment contents. Default: true."),
  projection: z
    .enum(["markdown", "text", "structured", "all"])
    .default("markdown")
    .describe("Output projection for parsed attachments. Default: markdown."),
});

const attachmentSchema = z.object({
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  parsed: z.boolean(),
  content: z.string().nullable(),
  error: z.string().nullable(),
});

const emailDataSchema = z.object({
  headers: z.record(z.string(), z.string()),
  bodyText: z.string(),
  attachments: z.array(attachmentSchema),
  attachmentCount: z.number().int().nonnegative(),
  parsedAttachments: z.number().int().nonnegative(),
  engine: z.string(),
  inputBytes: z.number().int().nonnegative(),
});

export interface DocumentEmailExtractModuleOptions {
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxOutputChars: number;
}

export function createDocumentEmailExtractModule(
  options: DocumentEmailExtractModuleOptions,
): McpModule {
  return {
    name: "document_email_extract",
    register(server: McpServer) {
      server.registerTool(
        "document_email_extract",
        {
          description:
            "Parse an EML email file with recursive attachment extraction. Returns email headers (subject, from, to, date), body text, and each attachment parsed through the same deterministic engine as document_parse. Nested EML attachments are recursively extracted. No LLM or external API required.",
          inputSchema: emailExtractInputSchema,
          outputSchema: resultEnvelopeSchema(emailDataSchema),
        },
        async (input, context) => {
          let bytes: Uint8Array;
          try {
            const binary = atob(input.dataBase64);
            bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
          } catch {
            return toolError(new Error("Invalid base64 input"), { tool: "document_email_extract" });
          }

          if (bytes.byteLength > MAX_INPUT_BYTES) {
            return toolError(
              new Error(`Input exceeds the 10 MB limit (${bytes.byteLength} bytes)`),
              { tool: "document_email_extract" },
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
                    const source = new TextDecoder().decode(bytes);
                    const { headers } = splitHeaders(source);
                    const headerMap: Record<string, string> = {};
                    for (const key of ["subject", "from", "to", "cc", "date", "message-id", "content-type"]) {
                      const val = headers.get(key);
                      if (val) headerMap[key] = val.slice(0, 2000);
                    }

                    const extracted = extractParts(source, 0, { count: 0 });
                    const bodyText = (extracted.text.length > 0 ? extracted.text : extracted.html).join("\n\n");

                    const attachmentResults: Array<{
                      filename: string;
                      mimeType: string;
                      sizeBytes: number;
                      parsed: boolean;
                      content: string | null;
                      error: string | null;
                    }> = [];

                    let parsedCount = 0;
                    let outputChars = bodyText.length;

                    if (input.parseAttachments) {
                      for (const att of extracted.attachments) {
                        signal.throwIfAborted();

                        const profile = resolveDocumentParserProfile(att.mimeType, att.filename);
                        if (profile === "unsupported" || att.bytes.byteLength > MAX_DOCUMENT_BYTES) {
                          attachmentResults.push({
                            filename: att.filename,
                            mimeType: att.mimeType,
                            sizeBytes: att.bytes.byteLength,
                            parsed: false,
                            content: null,
                            error: profile === "unsupported" ? "Unsupported format" : "Attachment too large",
                          });
                          continue;
                        }

                        try {
                          const parsed = await parseBoundedDocument({
                            bytes: att.bytes,
                            declaredMime: att.mimeType,
                            filename: att.filename,
                            signal,
                          });

                          const envelope = buildCanonicalEnvelopeFromAdapter({
                            documentId: `email-attachment-${att.filename}`,
                            sourceIdentity: { contentHash: "email" },
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
                            attachmentResults.push({
                              filename: att.filename,
                              mimeType: parsed.mediaType,
                              sizeBytes: att.bytes.byteLength,
                              parsed: false,
                              content: null,
                              error: "Output limit reached",
                            });
                            continue;
                          }

                          outputChars += content.length;
                          parsedCount += 1;
                          attachmentResults.push({
                            filename: att.filename,
                            mimeType: parsed.mediaType,
                            sizeBytes: att.bytes.byteLength,
                            parsed: true,
                            content,
                            error: null,
                          });
                        } catch (error) {
                          attachmentResults.push({
                            filename: att.filename,
                            mimeType: att.mimeType,
                            sizeBytes: att.bytes.byteLength,
                            parsed: false,
                            content: null,
                            error: error instanceof Error ? error.message : "Parse failed",
                          });
                        }
                      }
                    } else {
                      for (const att of extracted.attachments) {
                        attachmentResults.push({
                          filename: att.filename,
                          mimeType: att.mimeType,
                          sizeBytes: att.bytes.byteLength,
                          parsed: false,
                          content: null,
                          error: null,
                        });
                      }
                    }

                    return {
                      headers: headerMap,
                      bodyText: bodyText.slice(0, options.maxOutputChars),
                      attachments: attachmentResults,
                      attachmentCount: extracted.attachments.length,
                      parsedAttachments: parsedCount,
                      engine: "groundlane-email-extract-v1",
                      inputBytes: bytes.byteLength,
                    };
                  },
                  deadline,
                  context.mcpReq.signal,
                  "document-email-extract",
                ),
            );

            return structuredToolResult({ ok: true, data: result });
          } catch (error) {
            return toolError(error, { tool: "document_email_extract" });
          }
        },
      );
    },
  };
}

interface Attachment {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

interface ExtractedParts {
  text: string[];
  html: string[];
  attachments: Attachment[];
}

function splitHeaders(source: string): { headers: Map<string, string>; body: string } {
  const divider = source.indexOf("\r\n\r\n");
  const dividerAlt = source.indexOf("\n\n");
  const pos = divider !== -1 ? divider : dividerAlt;
  const skip = divider !== -1 ? 4 : 2;
  if (pos === -1) return { headers: new Map(), body: source };

  const headerSection = source.slice(0, pos);
  const body = source.slice(pos + skip);
  const headers = new Map<string, string>();

  const unfolded = headerSection.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
  }

  return { headers, body };
}

function extractParts(source: string, depth: number, state: { count: number }): ExtractedParts {
  if (depth > MAX_MIME_DEPTH || state.count > MAX_ATTACHMENTS) {
    return { text: [], html: [], attachments: [] };
  }

  const { headers, body } = splitHeaders(source);
  const rawContentType = headers.get("content-type") ?? "text/plain";
  const contentType = rawContentType.toLowerCase();

  if (contentType.startsWith("multipart/")) {
    const boundaryMatch = /boundary\s*=\s*"?([^\s";]+)"?/i.exec(rawContentType);
    if (!boundaryMatch) return { text: [], html: [], attachments: [] };
    const delimiter = `--${boundaryMatch[1]}`;

    const parts = body.split(delimiter).slice(1);
    const result: ExtractedParts = { text: [], html: [], attachments: [] };

    for (const raw of parts) {
      if (raw.startsWith("--")) break;
      const nested = extractParts(
        raw.replace(/^\r?\n/, "").replace(/\r?\n$/, ""),
        depth + 1,
        state,
      );
      result.text.push(...nested.text);
      result.html.push(...nested.html);
      result.attachments.push(...nested.attachments);
    }
    return result;
  }

  const disposition = (headers.get("content-disposition") ?? "").toLowerCase();
  const isAttachment = disposition.startsWith("attachment") ||
    (disposition.startsWith("inline") && !contentType.startsWith("text/"));

  if (isAttachment) {
    state.count += 1;
    const filenameMatch = /filename\s*=\s*"?([^"\r\n;]+)"?/i.exec(
      headers.get("content-disposition") ?? headers.get("content-type") ?? "",
    );
    const filename = filenameMatch?.[1]?.trim() ?? `attachment-${state.count}`;
    const encoding = (headers.get("content-transfer-encoding") ?? "").toLowerCase().trim();
    const decoded = decodeMimeBody(body, encoding);

    return {
      text: [],
      html: [],
      attachments: [{
        filename,
        mimeType: contentType.split(";")[0]?.trim() ?? "application/octet-stream",
        bytes: decoded,
      }],
    };
  }

  const encoding = (headers.get("content-transfer-encoding") ?? "").toLowerCase().trim();
  const decodedText = decodeMimeBodyText(body, encoding);

  if (contentType.startsWith("text/plain")) {
    return { text: [decodedText], html: [], attachments: [] };
  }
  if (contentType.startsWith("text/html")) {
    return { text: [], html: [decodedText], attachments: [] };
  }

  return { text: [], html: [], attachments: [] };
}

function decodeMimeBody(body: string, encoding: string): Uint8Array {
  if (encoding === "base64") {
    try {
      const cleaned = body.replace(/[\r\n\s]/g, "");
      const binary = atob(cleaned);
      return Uint8Array.from(binary, (c) => c.charCodeAt(0));
    } catch {
      return new TextEncoder().encode(body);
    }
  }

  if (encoding === "quoted-printable") {
    const decoded = body
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    return new TextEncoder().encode(decoded);
  }

  return new TextEncoder().encode(body);
}

function decodeMimeBodyText(body: string, encoding: string): string {
  if (encoding === "base64") {
    try {
      const cleaned = body.replace(/[\r\n\s]/g, "");
      return atob(cleaned);
    } catch {
      return body;
    }
  }

  if (encoding === "quoted-printable") {
    return body
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }

  return body;
}
