import type { AnswerCitation, AnswerResultItem } from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import { resolvePublicUrl, throwIfAborted } from "../../core/url-policy.js";

export type AnswerFetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type AnswerUrlValidator = (url: string, signal?: AbortSignal) => Promise<void>;

const MAX_ANSWER_RESPONSE_BYTES = 2_000_000;
const MAX_ANSWER_CANDIDATES = 100;

async function readAnswerBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ANSWER_RESPONSE_BYTES) {
    throw new GroundlaneError(
      "OUTPUT_LIMIT",
      "web_answer",
      "Answer provider response exceeded the byte limit",
      true,
    );
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ANSWER_RESPONSE_BYTES) {
      await reader.cancel();
      throw new GroundlaneError(
        "OUTPUT_LIMIT",
        "web_answer",
        "Answer provider response exceeded the byte limit",
        true,
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function answerProviderJson(
  fetcher: AnswerFetchLike,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal });
  } catch (error) {
    if (signal.aborted) {
      throw new GroundlaneError("CANCELLED", "web_answer", "Answer request was cancelled");
    }
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "web_answer",
      "Answer provider request failed",
      true,
      { cause: error },
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "web_answer",
      "Answer provider rejected the configured credential",
    );
  }
  if (response.status === 429) {
    throw new GroundlaneError(
      "RATE_LIMITED",
      "web_answer",
      "Answer provider rate limit reached",
      true,
    );
  }
  if (response.status >= 500) {
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "web_answer",
      "Answer provider is unavailable",
      true,
    );
  }
  if (!response.ok) {
    throw new GroundlaneError("UPSTREAM_ERROR", "web_answer", "Answer provider rejected the request");
  }
  try {
    return JSON.parse(await readAnswerBody(response)) as unknown;
  } catch (error) {
    if (error instanceof GroundlaneError) throw error;
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "web_answer",
      "Answer provider returned malformed JSON",
      true,
    );
  }
}

export function defaultAnswerUrlValidator(url: string, signal?: AbortSignal): Promise<void> {
  return resolvePublicUrl(url, { signal }).then(() => undefined);
}

export async function validateAnswerCitations(
  citations: readonly AnswerCitation[],
  validator: AnswerUrlValidator,
  signal?: AbortSignal,
): Promise<AnswerCitation[]> {
  const valid: AnswerCitation[] = [];
  for (const citation of citations.slice(0, MAX_ANSWER_CANDIDATES)) {
    throwIfAborted(signal, "web_answer", "Answer request was cancelled");
    try {
      await validator(citation.url, signal);
      valid.push(citation);
    } catch {
      throwIfAborted(signal, "web_answer", "Answer request was cancelled");
      // Provider-returned URLs are untrusted and unsafe entries are dropped.
    }
  }
  return valid;
}

export async function validateAnswerItems(
  items: readonly AnswerResultItem[],
  validator: AnswerUrlValidator,
  signal?: AbortSignal,
): Promise<AnswerResultItem[]> {
  const valid: AnswerResultItem[] = [];
  for (const item of items.slice(0, MAX_ANSWER_CANDIDATES)) {
    throwIfAborted(signal, "web_answer", "Answer request was cancelled");
    try {
      await validator(item.url, signal);
      valid.push(item);
    } catch {
      throwIfAborted(signal, "web_answer", "Answer request was cancelled");
      // Provider-returned URLs are untrusted and unsafe entries are dropped.
    }
  }
  return valid;
}
