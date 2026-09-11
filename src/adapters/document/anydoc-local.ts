import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GroundlaneError } from "../../core/errors.js";

let initialized = false;
let toMarkdownBytesFn: ((bytes: Uint8Array, format?: string | null) => string) | undefined;
let formatFromBytesFn: ((bytes: Uint8Array) => string | undefined) | undefined;

function failure(
  code: "UPSTREAM_ERROR" | "INVALID_INPUT",
  message: string,
): GroundlaneError {
  return new GroundlaneError(code, "document-convert-local", message, false);
}

async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  try {
    const mod = await import("@firecrawl/anydoc-wasm");
    const wasmPath = join(
      dirname(fileURLToPath(import.meta.resolve("@firecrawl/anydoc-wasm"))),
      "anydoc_wasm_bg.wasm",
    );
    const wasmBytes = readFileSync(wasmPath);
    mod.initSync({ module: wasmBytes });
    toMarkdownBytesFn = mod.toMarkdownBytes as (bytes: Uint8Array, format?: string | null) => string;
    formatFromBytesFn = mod.formatFromBytes;
    initialized = true;
  } catch (error) {
    throw failure("UPSTREAM_ERROR", `Failed to initialize anydoc WASM: ${error instanceof Error ? error.message : "unknown"}`);
  }
}

export interface AnydocLocalResult {
  readonly markdown: string;
  readonly detectedFormat: string | undefined;
  readonly engine: string;
}

const EXTENSION_TO_FORMAT: Record<string, string> = {
  doc: "doc", docx: "docx", docm: "docx",
  xls: "xls", xlsx: "xlsx", xlsm: "xlsx",
  ppt: "ppt", pptx: "pptx", ppsx: "pptx", pptm: "pptx",
  odt: "odt", ods: "ods", odp: "odp",
  rtf: "rtf", epub: "epub", csv: "csv", pdf: "pdf",
};

export class AnydocLocalConverter {
  readonly providerId = "anydoc-local";

  async convert(
    source: Uint8Array,
    filename: string,
  ): Promise<AnydocLocalResult> {
    if (source.byteLength < 1) throw failure("INVALID_INPUT", "Empty source");

    await ensureInitialized();

    const ext = filename.toLowerCase().split(".").pop() ?? "";
    const formatHint = EXTENSION_TO_FORMAT[ext] ?? null;
    const detectedFormat = formatFromBytesFn?.(source) ?? formatHint ?? undefined;

    try {
      const markdown = toMarkdownBytesFn!(source, formatHint);
      return {
        markdown,
        detectedFormat,
        engine: "anydoc-wasm",
      };
    } catch (error) {
      const err = error as Error & { code?: string };
      if (err.code === "needsOcr") {
        throw failure("INVALID_INPUT", "Document needs OCR — use document_ocr instead");
      }
      if (err.code === "encrypted") {
        throw failure("INVALID_INPUT", "Encrypted or password-protected document");
      }
      if (err.code === "unsupported") {
        throw failure("INVALID_INPUT", `Unsupported format: ${ext || "unknown"}`);
      }
      throw failure("UPSTREAM_ERROR", `anydoc conversion failed: ${err.message ?? "unknown"}`);
    }
  }
}
