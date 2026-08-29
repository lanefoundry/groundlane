import type { ResearchCitation } from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import { resolvePublicUrl } from "../../core/url-policy.js";

export type ResearchFetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type ResearchUrlValidator = (url: string) => Promise<void>;

const MAX_RESEARCH_RESPONSE_BYTES = 4_000_000;
const MAX_RESEARCH_CANDIDATES = 100;

async function readResearchBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESEARCH_RESPONSE_BYTES) {
    throw new GroundlaneError(
      "OUTPUT_LIMIT",
      "web_research",
      "Research provider response exceeded the byte limit",
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
    if (total > MAX_RESEARCH_RESPONSE_BYTES) {
      await reader.cancel();
      throw new GroundlaneError(
        "OUTPUT_LIMIT",
        "web_research",
        "Research provider response exceeded the byte limit",
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

export async function researchProviderJson(
  fetcher: ResearchFetchLike,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal });
  } catch (error) {
    if (signal.aborted) {
      throw new GroundlaneError("CANCELLED", "web_research", "Research request was cancelled");
    }
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "web_research",
      "Research provider request failed",
      true,
      { cause: error },
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "web_research",
      "Research provider rejected the configured credential",
    );
  }
  if (response.status === 429) {
    throw new GroundlaneError(
      "RATE_LIMITED",
      "web_research",
      "Research provider rate limit reached",
      true,
    );
  }
  if (response.status >= 500) {
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "web_research",
      "Research provider is unavailable",
      true,
    );
  }
  if (!response.ok) {
    throw new GroundlaneError("UPSTREAM_ERROR", "web_research", "Research provider rejected the request");
  }
  try {
    return JSON.parse(await readResearchBody(response)) as unknown;
  } catch (error) {
    if (error instanceof GroundlaneError) throw error;
    throw new GroundlaneError(
      "UPSTREAM_ERROR",
      "web_research",
      "Research provider returned malformed JSON",
      true,
    );
  }
}

export function defaultResearchUrlValidator(url: string): Promise<void> {
  return resolvePublicUrl(url).then(() => undefined);
}

export async function validateResearchCitations(
  citations: readonly ResearchCitation[],
  validator: ResearchUrlValidator,
): Promise<ResearchCitation[]> {
  const valid: ResearchCitation[] = [];
  for (const citation of citations.slice(0, MAX_RESEARCH_CANDIDATES)) {
    try {
      await validator(citation.url);
      valid.push(citation);
    } catch {
      // Provider-returned URLs are untrusted and unsafe entries are dropped.
    }
  }
  return valid;
}
