import type { FetchPipelineRequest } from "./fetch-pipeline.js";
import type { HttpFetcher, RawDocument } from "./contracts.js";
import { GroundlaneError } from "./errors.js";

export interface SourceAwareResolution {
  raw: RawDocument;
  reason: string;
}

export interface SourceResolver {
  resolve(request: FetchPipelineRequest, signal?: AbortSignal): Promise<SourceAwareResolution | undefined>;
}

interface SourceCandidate {
  url: string;
  backend: string;
}

function withoutTrailingSlash(pathname: string): string {
  return pathname.replace(/\/+$/u, "");
}

export function markdownSourceCandidates(url: string): SourceCandidate[] {
  const parsed = new URL(url);
  if (/\/(?:index\.)?md$/iu.test(parsed.pathname) || /\.md$/iu.test(parsed.pathname)) return [];

  parsed.hash = "";
  const candidates: SourceCandidate[] = [{ url: parsed.href, backend: "source:accept-markdown" }];
  if (parsed.pathname.endsWith("/")) {
    const candidate = new URL(parsed.href);
    candidate.pathname = `${parsed.pathname}index.md`;
    candidates.push({ url: candidate.href, backend: "source:index.md" });
  } else {
    const candidate = new URL(parsed.href);
    candidate.pathname = `${withoutTrailingSlash(parsed.pathname)}/index.md`;
    candidates.push({ url: candidate.href, backend: "source:index.md" });
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.url)) return false;
    seen.add(candidate.url);
    return true;
  });
}

export function canUseSourceAwareDocs(request: FetchPipelineRequest): boolean {
  return (
    request.render !== "always" &&
    request.selector === undefined &&
    request.waitFor === undefined &&
    (request.format === "markdown" || request.format === "text")
  );
}

export class SourceAwareDocsResolver implements SourceResolver {
  constructor(private readonly http: HttpFetcher) {}

  async resolve(request: FetchPipelineRequest, signal?: AbortSignal): Promise<SourceAwareResolution | undefined> {
    if (!canUseSourceAwareDocs(request)) return undefined;

    for (const candidate of markdownSourceCandidates(request.url)) {
      try {
        const raw = await this.http.fetch(
          {
            url: candidate.url,
            maxBytes: request.maxBytes,
            maxRedirects: request.maxRedirects,
            deadline: request.deadline,
            headers: { accept: "text/markdown,text/plain;q=0.9,*/*;q=0.1" },
          },
          signal,
        );
        if (raw.status >= 400) continue;
        return {
          raw: {
            ...raw,
            requestedUrl: request.url,
            backend: candidate.backend,
          },
          reason: "source_aware_markdown",
        };
      } catch (error) {
        if (error instanceof GroundlaneError && error.code === "URL_BLOCKED") throw error;
      }
    }

    return undefined;
  }
}
