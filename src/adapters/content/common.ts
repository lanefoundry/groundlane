import type { ContentProviderId, ContentProviderResult } from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import { truncateUnicode } from "../../core/limits.js";
import { resolvePublicUrl } from "../../core/url-policy.js";

export type ContentFetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type ContentUrlValidator = (url: string, signal?: AbortSignal) => Promise<void>;

const MAX_CONTENT_PROVIDER_RESPONSE_BYTES = 5_000_000;

async function readContentBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_CONTENT_PROVIDER_RESPONSE_BYTES
  ) {
    throw new GroundlaneError(
      "OUTPUT_LIMIT",
      "web_content",
      "Content provider response exceeded the byte limit",
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
    if (total > MAX_CONTENT_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel();
      throw new GroundlaneError(
        "OUTPUT_LIMIT",
        "web_content",
        "Content provider response exceeded the byte limit",
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

export async function contentProviderJson(
  fetcher: ContentFetchLike,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal });
  } catch (error) {
    if (signal.aborted) {
      throw new GroundlaneError("CANCELLED", "web_content", "Content request was cancelled");
    }
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "web_content",
      "Content provider request failed",
      true,
      { cause: error },
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "web_content",
      "Content provider rejected the configured credential",
    );
  }
  if (response.status === 429) {
    throw new GroundlaneError(
      "RATE_LIMITED",
      "web_content",
      "Content provider rate limit reached",
      true,
    );
  }
  if (response.status >= 500) {
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "web_content",
      "Content provider is unavailable",
      true,
    );
  }
  if (!response.ok) {
    throw new GroundlaneError("UPSTREAM_ERROR", "web_content", "Content provider rejected the request");
  }
  try {
    return JSON.parse(await readContentBody(response)) as unknown;
  } catch (error) {
    if (error instanceof GroundlaneError) throw error;
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "web_content",
      "Content provider returned malformed JSON",
      true,
    );
  }
}

export function defaultContentUrlValidator(url: string, signal?: AbortSignal): Promise<void> {
  return resolvePublicUrl(url, { signal }).then(() => undefined);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export async function normalizedContentResult(
  provider: ContentProviderId,
  requestUrl: string,
  finalUrl: string | undefined,
  title: string | undefined,
  content: string,
  format: "markdown" | "text",
  maxContentChars: number,
  started: number,
  validateUrl: ContentUrlValidator,
  warnings: readonly string[] = [],
  signal?: AbortSignal,
): Promise<ContentProviderResult> {
  const resolvedFinalUrl = finalUrl ?? requestUrl;
  await validateUrl(resolvedFinalUrl, signal);
  const truncated = truncateUnicode(content, maxContentChars);
  return {
    provider,
    url: requestUrl,
    finalUrl: resolvedFinalUrl,
    ...(title === undefined ? {} : { title }),
    content: truncated.value,
    format,
    truncated: truncated.truncated,
    durationMs: Math.round(performance.now() - started),
    warnings,
  };
}
