import { GroundlaneError } from "../../core/errors.js";
import type {
  DocumentBlock,
  MetadataRecord,
} from "../../core/canonical-document.js";

const ORIGIN = "https://mineru.net/api/v4";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const POLL_INTERVAL_MS = 2_000;
const MAX_POLLS = 60;

export interface MineruCloudOptions {
  readonly apiKey: string;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

export interface MineruParseResult {
  readonly blocks: readonly DocumentBlock[];
  readonly metadata: readonly MetadataRecord[];
  readonly engine: string;
  readonly model: string;
}

function failure(
  code: "UPSTREAM_ERROR" | "INVALID_INPUT" | "RATE_LIMITED" | "PROVIDER_UNAVAILABLE",
  message: string,
): GroundlaneError {
  return new GroundlaneError(code, "document-mineru", message, code === "RATE_LIMITED");
}

function normalizeMineruBlocks(markdown: string): { blocks: DocumentBlock[]; metadata: MetadataRecord[] } {
  const blocks: DocumentBlock[] = [];
  const metadata: MetadataRecord[] = [];
  let blockIndex = 0;

  const lines = markdown.split("\n");
  let currentText = "";

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      if (currentText.trim()) {
        blockIndex += 1;
        blocks.push({ type: "text", blockId: `mineru-${String(blockIndex)}`, content: currentText.trim() });
        currentText = "";
      }
      blockIndex += 1;
      blocks.push({ type: "text", blockId: `mineru-${String(blockIndex)}`, content: line });
      if (heading[1] === "#" && metadata.every((m) => m.key !== "title")) {
        metadata.push({ key: "title", value: heading[2]!.trim() });
      }
      continue;
    }

    currentText += (currentText ? "\n" : "") + line;
  }

  if (currentText.trim()) {
    blockIndex += 1;
    blocks.push({ type: "text", blockId: `mineru-${String(blockIndex)}`, content: currentText.trim() });
  }

  return { blocks, metadata };
}

export class MineruCloudProvider {
  readonly providerId = "mineru-cloud";
  private readonly apiKey: string;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;

  constructor(options: MineruCloudOptions) {
    if (!options.apiKey.trim() || /[\r\n]/u.test(options.apiKey)) {
      throw failure("INVALID_INPUT", "MinerU Cloud requires a valid API key");
    }
    this.apiKey = options.apiKey;
    this.maxBytes = options.maxBytes ?? MAX_FILE_SIZE;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async parse(
    source: Uint8Array,
    mimeType: string,
    filename: string,
    signal: AbortSignal,
  ): Promise<MineruParseResult> {
    if (source.byteLength < 1) {
      throw failure("INVALID_INPUT", "Empty source");
    }
    if (source.byteLength > this.maxBytes) {
      throw failure("INVALID_INPUT", `Source exceeds the ${String(this.maxBytes)} byte limit`);
    }

    const dataBase64 = bufferToBase64(source);
    const ext = filename.split(".").pop()?.toLowerCase() ?? "pdf";

    let taskResponse: Response;
    try {
      taskResponse = await fetch(`${ORIGIN}/extract/task`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          file: dataBase64,
          file_name: filename,
          is_ocr: true,
          enable_formula: false,
          enable_table: true,
          language: "auto",
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
      });
    } catch {
      signal.throwIfAborted();
      throw failure("UPSTREAM_ERROR", "MinerU Cloud request failed");
    }

    if (taskResponse.status === 429) {
      throw failure("RATE_LIMITED", "MinerU Cloud rate limit exceeded");
    }
    if (taskResponse.status === 401 || taskResponse.status === 403) {
      throw failure("INVALID_INPUT", "MinerU Cloud API key is invalid or expired");
    }
    if (!taskResponse.ok) {
      void taskResponse.body?.cancel().catch(() => undefined);
      throw failure("UPSTREAM_ERROR", `MinerU Cloud returned HTTP ${String(taskResponse.status)}`);
    }

    let taskBody: unknown;
    try {
      taskBody = await taskResponse.json();
    } catch {
      throw failure("UPSTREAM_ERROR", "MinerU Cloud returned malformed JSON");
    }

    const taskId = (taskBody as { data?: { task_id?: string } })?.data?.task_id;
    if (!taskId || typeof taskId !== "string") {
      throw failure("UPSTREAM_ERROR", "MinerU Cloud did not return a task ID");
    }

    const markdown = await this.pollForResult(taskId, signal);
    const { blocks, metadata } = normalizeMineruBlocks(markdown);

    return {
      blocks,
      metadata,
      engine: "mineru-cloud",
      model: "mineru-v3",
    };
  }

  private async pollForResult(taskId: string, signal: AbortSignal): Promise<string> {
    for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
      signal.throwIfAborted();

      await new Promise((resolve) => { setTimeout(resolve, POLL_INTERVAL_MS); });
      signal.throwIfAborted();

      let statusResponse: Response;
      try {
        statusResponse = await fetch(`${ORIGIN}/extract/task/${taskId}`, {
          method: "GET",
          headers: { "Authorization": `Bearer ${this.apiKey}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        });
      } catch {
        signal.throwIfAborted();
        continue;
      }

      if (!statusResponse.ok) {
        void statusResponse.body?.cancel().catch(() => undefined);
        if (statusResponse.status === 429) {
          throw failure("RATE_LIMITED", "MinerU Cloud rate limit exceeded during polling");
        }
        continue;
      }

      let statusBody: unknown;
      try {
        statusBody = await statusResponse.json();
      } catch {
        continue;
      }

      const status = (statusBody as { data?: { state?: string } })?.data?.state;
      if (status === "done") {
        const markdown = (statusBody as { data?: { full_result?: { md_content?: string } } })?.data?.full_result?.md_content;
        if (typeof markdown === "string") return markdown;
        throw failure("UPSTREAM_ERROR", "MinerU Cloud completed but returned no content");
      }
      if (status === "failed") {
        throw failure("UPSTREAM_ERROR", "MinerU Cloud task failed");
      }
    }

    throw failure("UPSTREAM_ERROR", `MinerU Cloud task ${taskId} did not complete within the polling limit`);
  }
}

function bufferToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}
