import type { ImageItem, ImagesProviderId, ImagesProviderResult } from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import { resolvePublicUrl, throwIfAborted } from "../../core/url-policy.js";

export type ImagesFetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type ImagesUrlValidator = (url: string, signal?: AbortSignal) => Promise<void>;

const MAX_IMAGES_PROVIDER_RESPONSE_BYTES = 2_000_000;
const MAX_IMAGES_PROVIDER_CANDIDATES = 100;

async function readImagesBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_IMAGES_PROVIDER_RESPONSE_BYTES
  ) {
    throw new GroundlaneError(
      "OUTPUT_LIMIT",
      "web_images",
      "Images provider response exceeded the byte limit",
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
    if (total > MAX_IMAGES_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel();
      throw new GroundlaneError(
        "OUTPUT_LIMIT",
        "web_images",
        "Images provider response exceeded the byte limit",
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

export async function imagesProviderJson(
  fetcher: ImagesFetchLike,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal });
  } catch (error) {
    if (signal.aborted) throw new GroundlaneError("CANCELLED", "web_images", "Images request was cancelled");
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "web_images",
      "Images provider request failed",
      true,
      { cause: error },
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "web_images",
      "Images provider rejected the configured credential",
    );
  }
  if (response.status === 402) {
    throw new GroundlaneError("RATE_LIMITED", "web_images", "Images provider quota is unavailable");
  }
  if (response.status === 429) {
    throw new GroundlaneError("RATE_LIMITED", "web_images", "Images provider rate limit reached", true);
  }
  if (response.status >= 500) {
    throw new GroundlaneError("UPSTREAM_ERROR", "web_images", "Images provider is unavailable", true);
  }
  if (!response.ok) throw new GroundlaneError("UPSTREAM_ERROR", "web_images", "Images provider rejected the request");
  try {
    return JSON.parse(await readImagesBody(response)) as unknown;
  } catch (error) {
    if (error instanceof GroundlaneError) throw error;
    throw new GroundlaneError("UPSTREAM_ERROR", "web_images", "Images provider returned malformed JSON", true);
  }
}

export function defaultImagesUrlValidator(url: string, signal?: AbortSignal): Promise<void> {
  return resolvePublicUrl(url, { signal }).then(() => undefined);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export async function normalizeImageItems(
  provider: ImagesProviderId,
  candidates: readonly ImageItem[],
  validateUrl: ImagesUrlValidator,
  signal?: AbortSignal,
): Promise<ImageItem[]> {
  const valid: ImageItem[] = [];
  for (const candidate of candidates.slice(0, MAX_IMAGES_PROVIDER_CANDIDATES)) {
    throwIfAborted(signal, "web_images", "Images request was cancelled");
    try {
      await validateUrl(candidate.imageUrl, signal);
      await validateUrl(candidate.sourceUrl, signal);
      if (candidate.thumbnailUrl !== undefined) await validateUrl(candidate.thumbnailUrl, signal);
      valid.push({ ...candidate, provider });
    } catch {
      throwIfAborted(signal, "web_images", "Images request was cancelled");
      // Provider-returned URLs are untrusted and unsafe candidates are dropped.
    }
  }
  return valid;
}

export function imagesResult(
  provider: ImagesProviderId,
  query: string,
  results: readonly ImageItem[],
  started: number,
  warnings: readonly string[] = [],
): ImagesProviderResult {
  return {
    provider,
    query,
    results,
    durationMs: Math.round(performance.now() - started),
    warnings,
  };
}
