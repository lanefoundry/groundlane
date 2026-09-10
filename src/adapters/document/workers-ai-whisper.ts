import { GroundlaneError } from "../../core/errors.js";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB

export interface WorkersAiWhisperOptions {
  readonly accountId: string;
  readonly apiToken: string;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

export interface TranscriptionResult {
  readonly text: string;
  readonly segments: readonly TranscriptionSegment[];
  readonly engine: string;
  readonly durationSeconds: number | null;
}

export interface TranscriptionSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function failure(
  code: "UPSTREAM_ERROR" | "INVALID_INPUT" | "RATE_LIMITED" | "OUTPUT_LIMIT",
  message: string,
): GroundlaneError {
  return new GroundlaneError(code, "document-transcribe", message, code === "RATE_LIMITED");
}

const SUPPORTED_AUDIO_MIMES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/ogg",
  "audio/flac",
  "audio/x-flac",
  "audio/m4a",
  "audio/x-m4a",
]);

export function isSupportedAudioMime(mime: string): boolean {
  return SUPPORTED_AUDIO_MIMES.has(mime.split(";")[0]?.trim().toLowerCase() ?? "");
}

export class WorkersAiWhisperProvider {
  readonly providerId = "workers-ai-whisper";
  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;

  constructor(options: WorkersAiWhisperOptions) {
    if (!options.accountId.trim()) throw failure("INVALID_INPUT", "Workers AI requires an account ID");
    if (!options.apiToken.trim()) throw failure("INVALID_INPUT", "Workers AI requires an API token");
    this.accountId = options.accountId;
    this.apiToken = options.apiToken;
    this.maxBytes = options.maxBytes ?? MAX_AUDIO_BYTES;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async transcribe(
    source: Uint8Array,
    signal: AbortSignal,
  ): Promise<TranscriptionResult> {
    if (source.byteLength < 1) throw failure("INVALID_INPUT", "Empty audio source");
    if (source.byteLength > this.maxBytes) {
      throw failure("INVALID_INPUT", `Audio exceeds the ${this.maxBytes} byte limit`);
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/@cf/openai/whisper`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiToken}`,
          "content-type": "application/octet-stream",
        },
        body: source.buffer as ArrayBuffer,
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
      });
    } catch {
      signal.throwIfAborted();
      throw failure("UPSTREAM_ERROR", "Workers AI Whisper request failed");
    }

    if (response.status === 429) throw failure("RATE_LIMITED", "Workers AI rate limit exceeded");
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw failure("UPSTREAM_ERROR", `Workers AI returned HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw failure("UPSTREAM_ERROR", "Workers AI returned malformed JSON");
    }

    const result = body as Record<string, unknown>;
    if (typeof result !== "object" || result === null || !("result" in result)) {
      throw failure("UPSTREAM_ERROR", "Workers AI returned an unexpected response shape");
    }

    const inner = result.result as Record<string, unknown>;
    const text = typeof inner.text === "string" ? inner.text : "";
    const rawSegments = Array.isArray(inner.words) ? inner.words : [];

    const segments: TranscriptionSegment[] = rawSegments
      .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
      .map((s) => ({
        start: typeof s.start === "number" ? s.start : 0,
        end: typeof s.end === "number" ? s.end : 0,
        text: typeof s.word === "string" ? s.word : "",
      }));

    const durationSeconds = segments.length > 0
      ? Math.max(...segments.map((s) => s.end))
      : null;

    return { text, segments, engine: "workers-ai-whisper", durationSeconds };
  }
}
