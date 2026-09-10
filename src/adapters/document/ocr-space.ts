import { GroundlaneError } from "../../core/errors.js";

const ORIGIN = "https://api.ocr.space/parse/image";
const MAX_FILE_SIZE = 1_024_000; // OCR.space free tier: 1 MB

export interface OcrSpaceOptions {
  readonly apiKey: string;
  readonly language?: string;
  readonly engine?: 1 | 2;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

export interface OcrResult {
  readonly text: string;
  readonly pages: readonly OcrPageResult[];
  readonly engine: string;
}

export interface OcrPageResult {
  readonly pageNumber: number;
  readonly text: string;
  readonly exitCode: number;
}

const resultSchema = {
  isValid(value: unknown): value is {
    OCRExitCode: number;
    ParsedResults: Array<{
      ParsedText: string;
      FileParseExitCode: number;
      ErrorMessage?: string;
    }>;
    ErrorMessage?: string[];
    IsErroredOnProcessing: boolean;
  } {
    return (
      typeof value === "object" &&
      value !== null &&
      "OCRExitCode" in value &&
      "ParsedResults" in value &&
      Array.isArray((value as Record<string, unknown>).ParsedResults)
    );
  },
};

function failure(
  code: "UPSTREAM_ERROR" | "INVALID_INPUT" | "RATE_LIMITED" | "OUTPUT_LIMIT",
  message: string,
): GroundlaneError {
  return new GroundlaneError(code, "document-ocr", message, code === "RATE_LIMITED");
}

export class OcrSpaceProvider {
  readonly providerId = "ocr-space";
  private readonly apiKey: string;
  private readonly language: string;
  private readonly engine: 1 | 2;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;

  constructor(options: OcrSpaceOptions) {
    if (!options.apiKey.trim() || /[\r\n]/u.test(options.apiKey)) {
      throw failure("INVALID_INPUT", "OCR.space requires a valid API key");
    }
    this.apiKey = options.apiKey;
    this.language = options.language ?? "eng";
    this.engine = options.engine ?? 2;
    this.maxBytes = options.maxBytes ?? MAX_FILE_SIZE;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async ocr(
    source: Uint8Array,
    mimeType: string,
    filename: string,
    signal: AbortSignal,
  ): Promise<OcrResult> {
    if (source.byteLength < 1) {
      throw failure("INVALID_INPUT", "Empty source");
    }
    if (source.byteLength > this.maxBytes) {
      throw failure("INVALID_INPUT", `Source exceeds the ${this.maxBytes} byte limit`);
    }

    const form = new FormData();
    form.set("file", new Blob([source.buffer as ArrayBuffer], { type: mimeType }), filename);
    form.set("language", this.language);
    form.set("OCREngine", String(this.engine));
    form.set("isTable", "true");
    form.set("scale", "true");
    form.set("filetype", extensionFromMime(mimeType, filename));

    let response: Response;
    try {
      response = await fetch(ORIGIN, {
        method: "POST",
        headers: { apikey: this.apiKey },
        body: form,
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
      });
    } catch {
      signal.throwIfAborted();
      throw failure("UPSTREAM_ERROR", "OCR.space request failed");
    }

    if (response.status === 429) {
      throw failure("RATE_LIMITED", "OCR.space rate limit exceeded");
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw failure("UPSTREAM_ERROR", `OCR.space returned HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw failure("UPSTREAM_ERROR", "OCR.space returned malformed JSON");
    }

    if (!resultSchema.isValid(body)) {
      throw failure("UPSTREAM_ERROR", "OCR.space returned an unexpected response shape");
    }

    if (body.IsErroredOnProcessing || body.OCRExitCode !== 1) {
      const msg = body.ErrorMessage?.join("; ") ?? "OCR processing failed";
      throw failure("UPSTREAM_ERROR", msg);
    }

    const pages: OcrPageResult[] = body.ParsedResults.map((r, i) => ({
      pageNumber: i + 1,
      text: r.ParsedText,
      exitCode: r.FileParseExitCode,
    }));

    return {
      text: pages.map((p) => p.text).join("\n\n"),
      pages,
      engine: `ocr-space-engine-${this.engine}`,
    };
  }
}

function extensionFromMime(mime: string, filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (["pdf", "png", "jpg", "jpeg", "gif", "tif", "tiff", "bmp", "webp"].includes(ext)) {
    return ext === "jpg" ? "jpeg" : ext;
  }
  const mimeMap: Record<string, string> = {
    "application/pdf": "pdf",
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/gif": "gif",
    "image/tiff": "tiff",
    "image/bmp": "bmp",
    "image/webp": "webp",
  };
  return mimeMap[mime.split(";")[0]?.trim().toLowerCase() ?? ""] ?? "pdf";
}
