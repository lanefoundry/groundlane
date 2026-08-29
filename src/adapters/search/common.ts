import type { SearchRequest, SearchResultItem } from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import { resolvePublicUrl, throwIfAborted } from "../../core/url-policy.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type UrlValidator = (url: string, signal?: AbortSignal) => Promise<void>;
const MAX_PROVIDER_RESPONSE_BYTES = 2_000_000;
const MAX_PROVIDER_RESULT_CANDIDATES = 100;

async function readProviderBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new GroundlaneError("OUTPUT_LIMIT", "search", "Search provider response exceeded the byte limit", true);
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel();
      throw new GroundlaneError("OUTPUT_LIMIT", "search", "Search provider response exceeded the byte limit", true);
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

export async function providerJson(fetcher: FetchLike, url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try { response = await fetcher(url, { ...init, signal }); }
  catch (error) {
    if (signal.aborted) throw new GroundlaneError("CANCELLED", "search", "Search was cancelled");
    throw new GroundlaneError("UPSTREAM_ERROR", "search", "Search provider request failed", true, { cause: error });
  }
  if (response.status === 429) throw new GroundlaneError("RATE_LIMITED", "search", "Search provider rate limit reached", true);
  if (response.status >= 500) throw new GroundlaneError("UPSTREAM_ERROR", "search", "Search provider is unavailable", true);
  if (!response.ok) throw new GroundlaneError("UPSTREAM_ERROR", "search", "Search provider rejected the request");
  try { return JSON.parse(await readProviderBody(response)) as unknown; }
  catch (error) {
    if (error instanceof GroundlaneError) throw error;
    throw new GroundlaneError("UPSTREAM_ERROR", "search", "Search provider returned malformed JSON", true);
  }
}

export function defaultUrlValidator(url: string, signal?: AbortSignal): Promise<void> {
  return resolvePublicUrl(url, { signal }).then(() => undefined);
}

export function cleanDomains(domains: readonly string[] | undefined): string[] | undefined {
  if (!domains) return undefined;
  const result = domains.map((domain) => domain.trim().toLowerCase()).filter((domain) => /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain));
  return result.length ? result : undefined;
}

export async function validateItems(items: readonly SearchResultItem[], validator: UrlValidator, signal?: AbortSignal): Promise<SearchResultItem[]> {
  const valid: SearchResultItem[] = [];
  for (const item of items.slice(0, MAX_PROVIDER_RESULT_CANDIDATES)) {
    throwIfAborted(signal, "search", "Search was cancelled");
    try {
      await validator(item.url, signal);
      valid.push(item);
    } catch {
      throwIfAborted(signal, "search", "Search was cancelled");
      /* untrusted provider URL is dropped */
    }
  }
  return valid;
}

export function assertSearchRequest(request: SearchRequest): void {
  if (!request.query.trim() || !Number.isInteger(request.maxResults) || request.maxResults < 1 || request.maxResults > 50) throw new GroundlaneError("INVALID_INPUT", "search", "Search query or result limit is invalid");
}
