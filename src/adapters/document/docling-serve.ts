import { GroundlaneError } from "../../core/errors.js";
import type {
  DocumentBlock,
  MetadataRecord,
} from "../../core/canonical-document.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_FILE_SIZE = 50 * 1024 * 1024;

export interface DoclingServeOptions {
  readonly baseUrl: string;
  readonly pipeline?: "standard" | "vlm";
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

export interface DoclingParseResult {
  readonly blocks: readonly DocumentBlock[];
  readonly metadata: readonly MetadataRecord[];
  readonly engine: string;
  readonly model: string;
}

interface DoclingResponseItem {
  readonly type: string;
  readonly text?: string;
  readonly prov?: readonly { readonly page_no?: number }[];
  readonly label?: string;
}

interface DoclingApiResponse {
  readonly document?: {
    readonly main_text?: readonly DoclingResponseItem[];
    readonly tables?: readonly { readonly data?: readonly { readonly text?: string }[][] }[];
    readonly name?: string;
    readonly description?: string;
  };
  readonly status?: string;
  readonly errors?: readonly string[];
}

function failure(
  code: "UPSTREAM_ERROR" | "INVALID_INPUT" | "RATE_LIMITED" | "PROVIDER_UNAVAILABLE",
  message: string,
): GroundlaneError {
  return new GroundlaneError(code, "document-vlm", message, code === "RATE_LIMITED");
}

function normalizeDoclingBlocks(response: DoclingApiResponse): { blocks: DocumentBlock[]; metadata: MetadataRecord[] } {
  const blocks: DocumentBlock[] = [];
  const metadata: MetadataRecord[] = [];
  let blockIndex = 0;

  if (response.document?.name) {
    metadata.push({ key: "title", value: response.document.name });
  }
  if (response.document?.description) {
    metadata.push({ key: "description", value: response.document.description });
  }

  const items = response.document?.main_text ?? [];
  for (const item of items) {
    if (item.text && item.text.trim().length > 0) {
      blockIndex += 1;
      blocks.push({
        type: "text",
        blockId: `vlm-${String(blockIndex)}`,
        content: item.text.trim(),
      });
    }
  }

  const tables = response.document?.tables ?? [];
  for (const table of tables) {
    if (!table.data || table.data.length === 0) continue;
    blockIndex += 1;
    const cells: { row: number; col: number; content: string }[] = [];
    for (let r = 0; r < table.data.length; r += 1) {
      const row = table.data[r]!;
      for (let c = 0; c < row.length; c += 1) {
        cells.push({ row: r, col: c, content: row[c]?.text ?? "" });
      }
    }
    blocks.push({
      type: "table",
      blockId: `vlm-table-${String(blockIndex)}`,
      cells,
    });
  }

  return { blocks, metadata };
}

export class DoclingServeProvider {
  readonly providerId = "docling-serve";
  private readonly baseUrl: string;
  private readonly pipeline: "standard" | "vlm";
  private readonly maxBytes: number;
  private readonly timeoutMs: number;

  constructor(options: DoclingServeOptions) {
    const url = options.baseUrl.replace(/\/+$/u, "");
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      throw failure("INVALID_INPUT", "Docling-serve base URL must use http or https");
    }
    this.baseUrl = url;
    this.pipeline = options.pipeline ?? "vlm";
    this.maxBytes = options.maxBytes ?? MAX_FILE_SIZE;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async parse(
    source: Uint8Array,
    mimeType: string,
    filename: string,
    signal: AbortSignal,
  ): Promise<DoclingParseResult> {
    if (source.byteLength < 1) {
      throw failure("INVALID_INPUT", "Empty source");
    }
    if (source.byteLength > this.maxBytes) {
      throw failure("INVALID_INPUT", `Source exceeds the ${String(this.maxBytes)} byte limit`);
    }

    const form = new FormData();
    form.set("file", new Blob([source.buffer as ArrayBuffer], { type: mimeType }), filename);

    const endpoint = `${this.baseUrl}/v1/convert`;
    const params = new URLSearchParams({ pipeline: this.pipeline });

    let response: Response;
    try {
      response = await fetch(`${endpoint}?${params.toString()}`, {
        method: "POST",
        body: form,
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
      });
    } catch {
      signal.throwIfAborted();
      throw failure("UPSTREAM_ERROR", "Docling-serve request failed");
    }

    if (response.status === 429) {
      throw failure("RATE_LIMITED", "Docling-serve rate limit exceeded");
    }
    if (response.status === 503) {
      throw failure("PROVIDER_UNAVAILABLE", "Docling-serve is unavailable");
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw failure("UPSTREAM_ERROR", `Docling-serve returned HTTP ${String(response.status)}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw failure("UPSTREAM_ERROR", "Docling-serve returned malformed JSON");
    }

    const apiResponse = body as DoclingApiResponse;
    if (apiResponse.status === "failure" || (apiResponse.errors && apiResponse.errors.length > 0)) {
      const msg = apiResponse.errors?.join("; ") ?? "Docling processing failed";
      throw failure("UPSTREAM_ERROR", msg);
    }

    const { blocks, metadata } = normalizeDoclingBlocks(apiResponse);
    const model = this.pipeline === "vlm" ? "granite-docling-258m" : "deterministic";

    return {
      blocks,
      metadata,
      engine: `docling-serve-${this.pipeline}`,
      model,
    };
  }
}
