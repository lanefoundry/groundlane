import type { MapLink, MapProviderId, MapProviderResult } from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import { resolvePublicUrl, throwIfAborted } from "../../core/url-policy.js";

export type MapFetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type MapUrlValidator = (url: string, signal?: AbortSignal) => Promise<void>;

const MAX_MAP_PROVIDER_RESPONSE_BYTES = 2_000_000;
const MAX_MAP_PROVIDER_CANDIDATES = 2_000;

async function readMapBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_MAP_PROVIDER_RESPONSE_BYTES
  ) {
    throw new GroundlaneError(
      "OUTPUT_LIMIT",
      "web_map",
      "Map provider response exceeded the byte limit",
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
    if (total > MAX_MAP_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel();
      throw new GroundlaneError(
        "OUTPUT_LIMIT",
        "web_map",
        "Map provider response exceeded the byte limit",
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

export async function mapProviderJson(
  fetcher: MapFetchLike,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal });
  } catch (error) {
    if (signal.aborted) throw new GroundlaneError("CANCELLED", "web_map", "Map request was cancelled");
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "web_map",
      "Map provider request failed",
      true,
      { cause: error },
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "web_map",
      "Map provider rejected the configured credential",
    );
  }
  if (response.status === 402) {
    throw new GroundlaneError("RATE_LIMITED", "web_map", "Map provider quota is unavailable");
  }
  if (response.status === 429) {
    throw new GroundlaneError("RATE_LIMITED", "web_map", "Map provider rate limit reached", true);
  }
  if (response.status >= 500) {
    throw new GroundlaneError("UPSTREAM_ERROR", "web_map", "Map provider is unavailable", true);
  }
  if (!response.ok) throw new GroundlaneError("UPSTREAM_ERROR", "web_map", "Map provider rejected the request");
  try {
    return JSON.parse(await readMapBody(response)) as unknown;
  } catch (error) {
    if (error instanceof GroundlaneError) throw error;
    throw new GroundlaneError("UPSTREAM_ERROR", "web_map", "Map provider returned malformed JSON", true);
  }
}

export function defaultMapUrlValidator(url: string, signal?: AbortSignal): Promise<void> {
  return resolvePublicUrl(url, { signal }).then(() => undefined);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export async function normalizeMapLinks(
  provider: MapProviderId,
  candidates: readonly MapLink[],
  validateUrl: MapUrlValidator,
  signal?: AbortSignal,
): Promise<MapLink[]> {
  const valid: MapLink[] = [];
  for (const candidate of candidates.slice(0, MAX_MAP_PROVIDER_CANDIDATES)) {
    throwIfAborted(signal, "web_map", "Map request was cancelled");
    try {
      await validateUrl(candidate.url, signal);
      valid.push(candidate);
    } catch {
      throwIfAborted(signal, "web_map", "Map request was cancelled");
      // Provider-returned URLs are untrusted and unsafe candidates are dropped.
    }
  }
  return valid.map((link) => ({ ...link, provider }));
}

export function mapResult(
  provider: MapProviderId,
  url: string,
  links: readonly MapLink[],
  started: number,
  warnings: readonly string[] = [],
): MapProviderResult {
  return {
    provider,
    url,
    links,
    durationMs: Math.round(performance.now() - started),
    warnings,
  };
}
