import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  MAX_DOCUMENT_BYTES,
  parseBoundedDocument,
  resolveDocumentParserProfile,
} from "../adapters/document/bounded-document-parser.js";
import { GroundlaneError } from "../core/errors.js";
import type { AnydocLocalConverter } from "../adapters/document/anydoc-local.js";
import { resolveConversion } from "../adapters/document/cloudconvert.js";
import type { CloudConvertProvider } from "../adapters/document/cloudconvert.js";
import type { OcrSpaceProvider } from "../adapters/document/ocr-space.js";
import { isSupportedAudioMime } from "../adapters/document/workers-ai-whisper.js";
import type { WorkersAiWhisperProvider } from "../adapters/document/workers-ai-whisper.js";
import {
  buildCanonicalEnvelopeFromAdapter,
  projectCanonicalDocument,
} from "../core/canonical-document.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

const MAX_INPUT_BYTES = 25 * 1024 * 1024;

const OCR_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/tiff",
  "image/bmp",
  "image/webp",
]);

const LEGACY_OFFICE_MIMES = new Set([
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
]);

const LEGACY_OFFICE_EXTENSIONS = new Set(["doc", "xls", "ppt"]);

type RoutedTo =
  | "document_parse"
  | "document_ocr"
  | "document_convert"
  | "document_archive_extract"
  | "document_email_extract"
  | "document_transcribe";

const documentSmartParseInputSchema = z.object({
  dataBase64: z
    .string()
    .min(1)
    .max(Math.ceil(MAX_INPUT_BYTES * 4 / 3) + 16)
    .describe("Base64-encoded file content (max 25 MB decoded for audio, 10 MB for others)."),
  mimeType: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("MIME type of the file."),
  filename: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .describe("Original filename with extension."),
  projection: z
    .enum(["markdown", "text", "structured", "all"])
    .default("markdown")
    .describe("Output projection for parsed content. Default: markdown."),
});

const scanDetectionSchema = z.object({
  scannedPages: z.array(z.number().int().positive()),
  textPages: z.array(z.number().int().positive()),
  totalPages: z.number().int().nonnegative(),
  verdict: z.enum(["text", "scanned", "mixed"]),
}).optional();

const confidenceSchema = z.object({
  score: z.number().min(0).max(1),
  suggestedEffort: z.enum(["fast", "standard", "deep"]),
  reason: z.string(),
}).optional();

const smartParseDataSchema = z.object({
  routedTo: z.string(),
  routeReason: z.string(),
  content: z.string(),
  engine: z.string(),
  inputBytes: z.number().int().nonnegative(),
  mimeType: z.string(),
  scanDetection: scanDetectionSchema,
  confidence: confidenceSchema,
  hint: z.string().optional(),
});

export interface DocumentSmartParseModuleOptions {
  ocrProvider?: OcrSpaceProvider | undefined;
  transcribeProvider?: WorkersAiWhisperProvider | undefined;
  localConverter?: AnydocLocalConverter | undefined;
  convertProvider?: CloudConvertProvider | undefined;
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxOutputChars: number;
}

export function createDocumentSmartParseModule(
  options: DocumentSmartParseModuleOptions,
): McpModule {
  return {
    name: "document_smart_parse",
    register(server: McpServer) {
      server.registerTool(
        "document_smart_parse",
        {
          description:
            "Auto-detect file type and route to the correct parser. Accepts any supported file as base64: text documents go to document_parse, scanned PDFs and images to document_ocr, audio to document_transcribe, legacy Office (.doc/.xls/.ppt) to document_convert then document_parse, ZIP archives to document_archive_extract, and EML emails to document_email_extract. The routedTo field in the response shows which tool was selected. Use this instead of choosing a specific document tool when you are unsure which parser to use.",
          inputSchema: documentSmartParseInputSchema,
          outputSchema: resultEnvelopeSchema(smartParseDataSchema),
        },
        async (input, context) => {
          let bytes: Uint8Array;
          try {
            const binary = atob(input.dataBase64);
            bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
          } catch {
            return toolError(new Error("Invalid base64 input"), { tool: "document_smart_parse" });
          }

          const baseMime = input.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
          const extension = input.filename.toLowerCase().split(".").pop() ?? "";
          const deadline = new Deadline(options.requestTimeoutMs);

          try {
            const result = await withConcurrency(
              options.limiter,
              deadline,
              context.mcpReq.signal,
              () =>
                withinDeadline(
                  async (signal) => {
                    const route = await detectRoute(bytes, baseMime, extension, signal, options);
                    const result = await executeRoute(route, bytes, baseMime, input.filename, input.projection, signal, options);
                    if (route.scanDetection !== undefined) result.scanDetection = route.scanDetection;
                    if (route.hint !== undefined) result.hint = route.hint;

                    const confidence = computeConfidence(result, bytes.byteLength, route, options);
                    if (confidence !== undefined) result.confidence = confidence;

                    return result;
                  },
                  deadline,
                  context.mcpReq.signal,
                  "document-smart-parse",
                ),
            );

            if (result.content.length > options.maxOutputChars) {
              result.content = result.content.slice(0, options.maxOutputChars);
            }

            return structuredToolResult({
              ok: true,
              data: {
                routedTo: result.routedTo,
                routeReason: result.routeReason,
                content: result.content,
                engine: result.engine,
                inputBytes: bytes.byteLength,
                mimeType: baseMime,
                ...(result.scanDetection !== undefined ? { scanDetection: result.scanDetection } : {}),
                ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
                ...(result.hint !== undefined ? { hint: result.hint } : {}),
              },
            });
          } catch (error) {
            return toolError(error, { tool: "document_smart_parse" });
          }
        },
      );
    },
  };
}

interface ScanDetection {
  scannedPages: number[];
  textPages: number[];
  totalPages: number;
  verdict: "text" | "scanned" | "mixed";
}

interface Confidence {
  score: number;
  suggestedEffort: "fast" | "standard" | "deep";
  reason: string;
}

interface RouteDecision {
  routedTo: RoutedTo;
  routeReason: string;
  scanDetection?: ScanDetection;
  confidence?: Confidence;
  hint?: string;
}

interface RouteResult {
  routedTo: RoutedTo;
  routeReason: string;
  content: string;
  engine: string;
  scanDetection?: ScanDetection;
  confidence?: Confidence;
  hint?: string;
}

async function detectRoute(
  bytes: Uint8Array,
  baseMime: string,
  extension: string,
  signal: AbortSignal,
  options: DocumentSmartParseModuleOptions,
): Promise<RouteDecision> {
  if (baseMime === "application/zip" || baseMime === "application/x-zip-compressed" || extension === "zip") {
    return { routedTo: "document_archive_extract", routeReason: "ZIP archive detected" };
  }

  if (baseMime === "message/rfc822" || extension === "eml") {
    return { routedTo: "document_email_extract", routeReason: "EML email detected" };
  }

  if (isSupportedAudioMime(baseMime) || ["mp3", "wav", "ogg", "flac", "m4a", "webm"].includes(extension) && baseMime.startsWith("audio/")) {
    if (options.transcribeProvider === undefined) {
      return { routedTo: "document_transcribe", routeReason: "Audio detected but document_transcribe not configured (set CF_BROWSER_ACCOUNT_ID and CF_BROWSER_API_TOKEN)" };
    }
    return { routedTo: "document_transcribe", routeReason: "Audio file detected" };
  }

  if (LEGACY_OFFICE_MIMES.has(baseMime) || LEGACY_OFFICE_EXTENSIONS.has(extension)) {
    if (options.localConverter !== undefined) {
      return { routedTo: "document_convert", routeReason: "Legacy Office format detected — using local anydoc WASM converter" };
    }
    if (resolveConversion(baseMime, `file.${extension}`) !== undefined) {
      if (options.convertProvider === undefined) {
        return { routedTo: "document_parse", routeReason: "Legacy Office detected but conversion not configured; falling back to document_parse (may fail)" };
      }
      return { routedTo: "document_convert", routeReason: "Legacy Office format (.doc/.xls/.ppt) detected" };
    }
  }

  if (OCR_IMAGE_MIMES.has(baseMime) || ["png", "jpg", "jpeg", "gif", "tif", "tiff", "bmp", "webp"].includes(extension)) {
    if (options.ocrProvider === undefined) {
      return { routedTo: "document_ocr", routeReason: "Image detected but document_ocr not configured (set OCR_SPACE_API_KEY)" };
    }
    return { routedTo: "document_ocr", routeReason: "Image file detected" };
  }

  if (baseMime === "application/pdf" || extension === "pdf") {
    const analysis = await analyzePdfPages(bytes, signal);
    const detection = buildScanDetection(analysis);

    if (detection.verdict === "text") {
      return {
        routedTo: "document_parse",
        routeReason: `PDF with extractable text on all ${String(detection.totalPages)} page${detection.totalPages === 1 ? "" : "s"}`,
        scanDetection: detection,
      };
    }

    if (detection.verdict === "scanned") {
      if (options.ocrProvider === undefined) {
        return {
          routedTo: "document_parse",
          routeReason: `Scanned PDF detected (no extractable text on any of ${String(detection.totalPages)} page${detection.totalPages === 1 ? "" : "s"}) but OCR not configured; falling back to document_parse`,
          scanDetection: detection,
        };
      }
      return {
        routedTo: "document_ocr",
        routeReason: `Scanned PDF: no extractable text on any of ${String(detection.totalPages)} page${detection.totalPages === 1 ? "" : "s"}`,
        scanDetection: detection,
      };
    }

    // Mixed: some pages have text, some are scanned
    const scannedList = detection.scannedPages.join(", ");
    const textList = detection.textPages.join(", ");
    return {
      routedTo: "document_parse",
      routeReason: `Mixed PDF: page${detection.textPages.length === 1 ? "" : "s"} ${textList} have text, page${detection.scannedPages.length === 1 ? "" : "s"} ${scannedList} appear scanned`,
      scanDetection: detection,
      hint: options.ocrProvider !== undefined
        ? `Scanned page${detection.scannedPages.length === 1 ? "" : "s"} ${scannedList} may contain additional text. Run document_ocr on those pages for full extraction.`
        : `Scanned page${detection.scannedPages.length === 1 ? "" : "s"} ${scannedList} may contain additional text. Configure OCR_SPACE_API_KEY and use document_ocr for those pages.`,
    };
  }

  return { routedTo: "document_parse", routeReason: "Standard document format" };
}

const PAGE_SCANNED_CHAR_THRESHOLD = 5;

interface PdfPageAnalysis {
  pageNumber: number;
  charCount: number;
}

interface PdfAnalysisResult {
  pages: PdfPageAnalysis[];
  totalPages: number;
}

async function analyzePdfPages(bytes: Uint8Array, signal: AbortSignal): Promise<PdfAnalysisResult> {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const document = await pdfjs.getDocument({ data: bytes, useSystemFonts: true }).promise;
    const totalPages = document.numPages;
    const scanLimit = Math.min(totalPages, 10);
    const pages: PdfPageAnalysis[] = [];
    for (let i = 1; i <= scanLimit; i += 1) {
      signal.throwIfAborted();
      const page = await document.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .trim();
      pages.push({ pageNumber: i, charCount: text.length });
    }
    return { pages, totalPages };
  } catch {
    signal.throwIfAborted();
    return { pages: [], totalPages: 0 };
  }
}

function buildScanDetection(analysis: PdfAnalysisResult): ScanDetection {
  const scannedPages: number[] = [];
  const textPages: number[] = [];
  for (const page of analysis.pages) {
    if (page.charCount < PAGE_SCANNED_CHAR_THRESHOLD) {
      scannedPages.push(page.pageNumber);
    } else {
      textPages.push(page.pageNumber);
    }
  }
  const verdict: "text" | "scanned" | "mixed" =
    scannedPages.length === 0 ? "text" :
    textPages.length === 0 ? "scanned" : "mixed";
  return { scannedPages, textPages, totalPages: analysis.totalPages, verdict };
}

async function executeRoute(
  route: RouteDecision,
  bytes: Uint8Array,
  baseMime: string,
  filename: string,
  projection: "markdown" | "text" | "structured" | "all",
  signal: AbortSignal,
  options: DocumentSmartParseModuleOptions,
): Promise<RouteResult> {
  const { routedTo, routeReason } = route;

  if (routedTo === "document_ocr") {
    if (options.ocrProvider === undefined) {
      throw new GroundlaneError("INVALID_INPUT", "document_smart_parse", "Image/scanned PDF detected but document_ocr is not configured. Set OCR_SPACE_API_KEY to enable OCR.");
    }
    const result = await options.ocrProvider.ocr(bytes, baseMime, filename, signal);
    return { routedTo, routeReason, content: result.text, engine: result.engine };
  }

  if (routedTo === "document_transcribe") {
    if (options.transcribeProvider === undefined) {
      throw new GroundlaneError("INVALID_INPUT", "document_smart_parse", "Audio detected but document_transcribe is not configured. Set CF_BROWSER_ACCOUNT_ID and CF_BROWSER_API_TOKEN to enable transcription.");
    }
    const result = await options.transcribeProvider.transcribe(bytes, signal);
    return { routedTo, routeReason, content: result.text, engine: result.engine };
  }

  if (routedTo === "document_convert") {
    if (options.localConverter !== undefined) {
      const result = await options.localConverter.convert(bytes, filename);
      return { routedTo, routeReason, content: result.markdown, engine: result.engine };
    }
    const converted = await options.convertProvider!.convert(bytes, baseMime, filename, signal);
    const parsed = await parseBoundedDocument({
      bytes: converted.bytes,
      declaredMime: converted.outputMimeType,
      filename: converted.outputFilename,
      signal,
    });
    const content = projectParsed(parsed, projection);
    return { routedTo, routeReason, content, engine: `${converted.engine} + groundlane-bounded-document-v3` };
  }

  if (routedTo === "document_archive_extract") {
    const { unzipSync } = await import("fflate");
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes);
    } catch {
      throw new Error("Malformed or unreadable ZIP archive");
    }
    const entries = Object.entries(files).filter(([name]) => !name.endsWith("/"));
    const results: string[] = [];
    for (const [name, fileBytes] of entries.slice(0, 50)) {
      signal.throwIfAborted();
      const profile = resolveDocumentParserProfile(guessMime(name), name);
      if (profile === "unsupported" || fileBytes.byteLength > MAX_DOCUMENT_BYTES) continue;
      try {
        const parsed = await parseBoundedDocument({ bytes: fileBytes, declaredMime: guessMime(name), filename: name, signal });
        const text = projectParsed(parsed, projection);
        if (text) results.push(`--- ${name} ---\n${text}`);
      } catch { /* skip unparseable files */ }
    }
    return { routedTo, routeReason, content: results.join("\n\n"), engine: "groundlane-archive-extract-v1" };
  }

  if (routedTo === "document_email_extract") {
    const parsed = await parseBoundedDocument({ bytes, declaredMime: "message/rfc822", filename, signal });
    const content = projectParsed(parsed, projection);
    return { routedTo, routeReason, content, engine: "groundlane-bounded-document-v3" };
  }

  // Default: document_parse
  const parsed = await parseBoundedDocument({ bytes, declaredMime: baseMime, filename, signal });
  const content = projectParsed(parsed, projection);
  return { routedTo, routeReason, content, engine: "groundlane-bounded-document-v3" };
}

function projectParsed(
  parsed: Awaited<ReturnType<typeof parseBoundedDocument>>,
  projection: "markdown" | "text" | "structured" | "all",
): string {
  const envelope = buildCanonicalEnvelopeFromAdapter({
    documentId: "smart-parse",
    sourceIdentity: { contentHash: "smart" },
    blocks: parsed.blocks,
    readingOrder: parsed.blocks.map((b) => b.blockId),
    status: "success",
    capabilityStates: parsed.capabilities,
    provenance: { engine: "groundlane-bounded-document-v3", model: "unknown", version: "unknown", cost: null, confidence: null },
    warnings: parsed.warnings,
    metadata: parsed.metadata,
  });
  const projected = projectCanonicalDocument(envelope, projection);
  return typeof projected === "string" ? projected : JSON.stringify(projected);
}

function computeConfidence(
  result: RouteResult,
  inputBytes: number,
  route: RouteDecision,
  options: DocumentSmartParseModuleOptions,
): Confidence | undefined {
  const contentLen = result.content.trim().length;

  if (route.scanDetection !== undefined) {
    const { verdict, scannedPages, totalPages } = route.scanDetection;
    if (verdict === "scanned") {
      if (result.routedTo === "document_ocr") {
        return { score: 0.7, suggestedEffort: "standard", reason: `All ${String(totalPages)} pages are scanned; OCR was used` };
      }
      return {
        score: 0.1,
        suggestedEffort: options.ocrProvider !== undefined ? "standard" : "deep",
        reason: `All ${String(totalPages)} pages appear scanned but OCR ${options.ocrProvider !== undefined ? "was not used (try effort=standard)" : "is not configured"}`,
      };
    }
    if (verdict === "mixed") {
      const scannedRatio = scannedPages.length / Math.max(totalPages, 1);
      const score = Math.round((1 - scannedRatio * 0.5) * 100) / 100;
      return {
        score,
        suggestedEffort: scannedRatio > 0.3 ? "standard" : "fast",
        reason: `${String(scannedPages.length)} of ${String(totalPages)} pages appear scanned`,
      };
    }
  }

  if (inputBytes > 1000 && contentLen < 20) {
    return {
      score: 0.2,
      suggestedEffort: "standard",
      reason: `Input is ${String(inputBytes)} bytes but extracted only ${String(contentLen)} characters`,
    };
  }

  const ratio = contentLen / Math.max(inputBytes, 1);
  if (ratio > 0.01) {
    return { score: 0.95, suggestedEffort: "fast", reason: "Good text extraction ratio" };
  }

  return undefined;
}

function guessMime(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    csv: "text/csv", txt: "text/plain", md: "text/markdown",
    json: "application/json", xml: "application/xml",
    html: "text/html", htm: "text/html",
    rtf: "application/rtf", eml: "message/rfc822",
  };
  return map[ext] ?? "application/octet-stream";
}
