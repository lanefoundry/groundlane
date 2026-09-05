import { createHash } from "node:crypto";
import { z } from "zod";
import { buildCanonicalEnvelopeFromAdapter } from "../../core/canonical-document.js";
import type { HttpFetcher } from "../../core/contracts.js";
import type { DocumentAsyncProviderPort, DocumentAsyncProviderStatus } from "../../core/document-async-runtime.js";
import { sniffMimeFromBytes } from "../../core/document-source.js";
import { GroundlaneError } from "../../core/errors.js";
import { Deadline, withinDeadline } from "../../core/limits.js";
import { SafeHttpFetcher } from "../http/undici-fetcher.js";

const ORIGIN = "https://platform.reducto.ai";
const sourceExtensions: Readonly<Record<string, string>> = {
  "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/tiff": "tiff", "image/webp": "webp",
};
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const receiptSchema = z.tuple([idSchema, z.string().regex(/^sha256-[a-f0-9]{64}$/u)]);
const bboxSchema = z.object({
  left: z.number().finite().nonnegative(), top: z.number().finite().nonnegative(),
  width: z.number().finite().positive(), height: z.number().finite().positive(),
  page: z.number().int().positive(), original_page: z.number().int().positive().optional(),
});
const blockSchema = z.object({
  type: z.enum(["Header", "Footer", "Title", "Section Header", "Page Number", "List Item", "Figure", "Table", "Key Value", "Text", "Comment", "Signature"]),
  content: z.string(), bbox: bboxSchema,
});
const fullSchema = z.object({ type: z.literal("full"), chunks: z.array(z.object({
  content: z.string(), embed: z.string(), enriched: z.string().nullable(), blocks: z.array(blockSchema).max(10_000),
})).max(10_000) });
const urlSchema = z.object({ type: z.literal("url"), url: z.string().url(), result_id: z.string().min(1) });
const parseSchema = z.object({
  response_type: z.literal("parse").optional(), job_id: idSchema, duration: z.number().finite().nonnegative(),
  usage: z.object({ num_pages: z.number().int().nonnegative(), credits: z.number().finite().nonnegative().nullable().optional() }),
  result: z.union([fullSchema, urlSchema]),
});
const jobSchema = z.object({
  status: z.enum(["Pending", "Idle", "InProgress", "Completing", "Completed", "Failed"]), result: z.unknown().optional(),
});

export interface ReductoAsyncOptions {
  readonly apiKey: string;
  readonly maxInputBytes?: number;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Production defaults to DNS-pinned, redirect-validating SafeHttpFetcher. */
  readonly resultFetcher?: HttpFetcher;
}
function failure(code: "UPSTREAM_ERROR" | "INVALID_INPUT" | "RATE_LIMITED" | "OUTPUT_LIMIT", message: string): GroundlaneError {
  return new GroundlaneError(code, "document-reducto", message, code === "RATE_LIMITED");
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw failure("UPSTREAM_ERROR", "Reducto returned a malformed response");
  return result.data;
}
async function readJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw failure("OUTPUT_LIMIT", "Reducto response exceeded the byte limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw failure("UPSTREAM_ERROR", "Reducto returned an empty response");
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) { cancel(); throw failure("OUTPUT_LIMIT", "Reducto response exceeded the byte limit"); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof GroundlaneError) throw error;
    throw failure("UPSTREAM_ERROR", "Reducto returned a malformed response");
  } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}

/** Opt-in provider-owned jobs; the durable runtime owns submission deduplication.
 * Reducto does not document an idempotency header. Never blindly retry create.
 */
export class ReductoAsyncDocumentProvider implements DocumentAsyncProviderPort {
  readonly providerId = "reducto";
  private readonly fetcher: (url: string, init: RequestInit) => Promise<Response>;
  private readonly resultFetcher: HttpFetcher;
  private readonly maxInputBytes: number;
  private readonly maxResponseBytes: number;
  private readonly timeoutMs: number;
  constructor(private readonly options: ReductoAsyncOptions) {
    if (!options.apiKey.trim() || /[\r\n]/u.test(options.apiKey)) throw failure("INVALID_INPUT", "Reducto requires a valid API credential");
    this.maxInputBytes = options.maxInputBytes ?? 10_000_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2_000_000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    for (const n of [this.maxInputBytes, this.maxResponseBytes, this.timeoutMs]) {
      if (!Number.isSafeInteger(n) || n < 1) throw failure("INVALID_INPUT", "Reducto limits must be positive integers");
    }
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.resultFetcher = options.resultFetcher ?? new SafeHttpFetcher();
  }

  async create(source: Uint8Array, _idempotencyKey: string, parent: AbortSignal): Promise<string> {
    if (source.byteLength < 1 || source.byteLength > this.maxInputBytes) throw failure("INVALID_INPUT", "Document source exceeds the input limit");
    const deadline = new Deadline(this.timeoutMs);
    return withinDeadline(async (signal) => {
      // Own a snapshot: caller mutation during upload cannot change its receipt hash.
      const bytes = Uint8Array.from(source);
      const mime = sniffMimeFromBytes(bytes);
      const extension = mime === null ? undefined : sourceExtensions[mime];
      if (mime === null || extension === undefined) throw failure("INVALID_INPUT", "Reducto async source must be a recognized PDF or supported image");
      const contentHash = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
      const form = new FormData();
      form.set("file", new Blob([bytes], { type: mime }), `document.${extension}`);
      const upload = parse(z.object({ file_id: z.string().regex(/^reducto:\/\/[A-Za-z0-9/_-]{1,512}$/u) }),
        await this.request("/upload", { method: "POST", body: form }, signal));
      signal.throwIfAborted();
      const submitted = parse(z.object({ job_id: idSchema }), await this.request("/parse_async", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: upload.file_id,
          settings: { persist_results: false, return_images: [], return_ocr_data: false },
        }),
      }, signal));
      return JSON.stringify([submitted.job_id, contentHash]);
    }, deadline, parent, "document-reducto-create");
  }

  async poll(receipt: string, parent: AbortSignal): Promise<DocumentAsyncProviderStatus> {
    let decoded: unknown;
    try { decoded = JSON.parse(receipt); } catch { throw failure("INVALID_INPUT", "Invalid Reducto task receipt"); }
    const checked = receiptSchema.safeParse(decoded);
    if (!checked.success) throw failure("INVALID_INPUT", "Invalid Reducto task receipt");
    const [jobId, contentHash] = checked.data;
    const deadline = new Deadline(this.timeoutMs);
    return withinDeadline(async (signal) => {
      const job = parse(jobSchema, await this.request(`/job/${jobId}`, { method: "GET" }, signal));
      if (job.status === "Failed") return { status: "failed" };
      if (job.status === "Pending" || job.status === "Idle") return { status: "pending" };
      if (job.status !== "Completed") return { status: "running" };
      const parsed = parse(parseSchema, job.result);
      if (parsed.job_id !== jobId) throw failure("UPSTREAM_ERROR", "Reducto returned a mismatched task");
      let result: z.infer<typeof fullSchema>;
      if (parsed.result.type === "url") {
        const remote = await this.resultFetcher.fetch({ url: parsed.result.url, maxBytes: this.maxResponseBytes,
          maxRedirects: 3, deadline }, signal);
        if (remote.status < 200 || remote.status >= 300) throw failure("UPSTREAM_ERROR", "Reducto result download failed");
        if (remote.body.byteLength > this.maxResponseBytes) throw failure("OUTPUT_LIMIT", "Reducto result exceeded the byte limit");
        let raw: unknown;
        try { raw = JSON.parse(new TextDecoder().decode(remote.body)); } catch { throw failure("UPSTREAM_ERROR", "Reducto result is malformed JSON"); }
        // The URL hosts a chunk array, not a second FullResult wrapper.
        // Official /parse/response-format documents this distinct wire shape.
        result = parse(fullSchema, { type: "full", chunks: raw });
      } else result = parsed.result;
      const rawBlocks = result.chunks.flatMap((chunk) => chunk.blocks);
      if (rawBlocks.length > 10_000) throw failure("OUTPUT_LIMIT", "Reducto result exceeded the block limit");
      const blocks = rawBlocks.map((block, i) => ({ type: "text" as const, blockId: `block-${i}`, content: block.content,
        spans: [{ kind: "page-bbox" as const, page: block.bbox.original_page ?? block.bbox.page,
          x: block.bbox.left, y: block.bbox.top, width: block.bbox.width, height: block.bbox.height, contentHash }],
      }));
      const envelope = buildCanonicalEnvelopeFromAdapter({ documentId: `reducto-${jobId}`, sourceIdentity: { contentHash },
        blocks, readingOrder: blocks.map((block) => block.blockId), status: "partial",
        capabilityStates: { text: blocks.length ? "available" : "not_run", pageSpans: blocks.length ? "available" : "not_run",
          tables: "unsupported", assets: "unsupported", ocr: "not_run", confidence: "not_run", monetaryCost: "not_run" },
        provenance: { engine: "reducto", model: "unknown", version: "unknown", cost: null, confidence: null },
        warnings: ["Provider model/version and monetary cost/confidence are not reported; credits are retained separately without currency conversion.",
          "Table/figure content is retained as text; structured cells, image assets and OCR provenance are not preserved."],
        metadata: [{ key: "provider.usage.num_pages", value: String(parsed.usage.num_pages) },
          { key: "provider.usage.credits", value: parsed.usage.credits == null ? "unknown" : String(parsed.usage.credits) },
          { key: "provider.duration_seconds", value: String(parsed.duration) }],
      });
      if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength > this.maxResponseBytes) throw failure("OUTPUT_LIMIT", "Canonical result exceeded the byte limit");
      return { status: "completed", envelope };
    }, deadline, parent, "document-reducto-poll");
  }

  cancel(_receipt: string, signal: AbortSignal): Promise<{ acknowledged: boolean }> {
    signal.throwIfAborted();
    // DELETE /job/{id} only deletes stored artifacts; it is not a cancel API.
    return Promise.resolve({ acknowledged: false });
  }

  private async request(path: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    let response: Response;
    try { response = await this.fetcher(`${ORIGIN}${path}`, { ...init, redirect: "error", signal,
      headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: `Bearer ${this.options.apiKey}` } }); }
    catch { signal.throwIfAborted(); throw failure("UPSTREAM_ERROR", "Reducto request failed"); }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw failure(response.status === 429 ? "RATE_LIMITED" : "UPSTREAM_ERROR", "Reducto rejected the request");
    }
    return readJson(response, this.maxResponseBytes, signal);
  }
}
