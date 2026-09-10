import { GroundlaneError } from "../../core/errors.js";

const ORIGIN = "https://api.semanticscholar.org/graph/v1";

export interface PaperMetadata {
  readonly paperId: string;
  readonly title: string;
  readonly abstract: string | null;
  readonly year: number | null;
  readonly venue: string | null;
  readonly citationCount: number | null;
  readonly authors: readonly { readonly name: string; readonly authorId: string | null }[];
  readonly tldr: string | null;
  readonly externalIds: Readonly<Record<string, string>> | null;
  readonly url: string;
  readonly openAccessPdf: string | null;
  readonly fieldsOfStudy: readonly string[] | null;
  readonly references: readonly { readonly paperId: string; readonly title: string }[] | null;
  readonly citations: readonly { readonly paperId: string; readonly title: string }[] | null;
}

export interface PaperSearchResult {
  readonly papers: readonly PaperMetadata[];
  readonly total: number;
  readonly engine: string;
}

function failure(
  code: "UPSTREAM_ERROR" | "INVALID_INPUT" | "RATE_LIMITED",
  message: string,
): GroundlaneError {
  return new GroundlaneError(code, "paper-search", message, code === "RATE_LIMITED");
}

const PAPER_FIELDS = [
  "paperId", "title", "abstract", "year", "venue",
  "citationCount", "authors", "tldr", "externalIds",
  "url", "openAccessPdf", "fieldsOfStudy",
  "references.paperId", "references.title",
  "citations.paperId", "citations.title",
].join(",");

const SEARCH_FIELDS = [
  "paperId", "title", "abstract", "year", "venue",
  "citationCount", "authors", "tldr", "externalIds",
  "url", "openAccessPdf", "fieldsOfStudy",
].join(",");

export class SemanticScholarProvider {
  readonly providerId = "semantic-scholar";
  private readonly timeoutMs: number;

  constructor(options?: { timeoutMs?: number }) {
    this.timeoutMs = options?.timeoutMs ?? 15_000;
  }

  async search(
    query: string,
    signal: AbortSignal,
    limit: number = 10,
    offset: number = 0,
  ): Promise<PaperSearchResult> {
    if (!query.trim()) throw failure("INVALID_INPUT", "Search query is required");

    const params = new URLSearchParams({
      query: query.trim(),
      limit: String(Math.min(limit, 100)),
      offset: String(offset),
      fields: SEARCH_FIELDS,
    });

    const url = `${ORIGIN}/paper/search?${params.toString()}`;
    const body = await this.request(url, signal);
    const data = body as { total?: number; data?: unknown[] };

    return {
      papers: (data.data ?? []).map(normalizePaper),
      total: typeof data.total === "number" ? data.total : 0,
      engine: "semantic-scholar-api",
    };
  }

  async getPaper(
    paperId: string,
    signal: AbortSignal,
  ): Promise<PaperMetadata> {
    if (!paperId.trim()) throw failure("INVALID_INPUT", "Paper ID is required");

    const url = `${ORIGIN}/paper/${encodeURIComponent(paperId.trim())}?fields=${PAPER_FIELDS}`;
    const body = await this.request(url, signal);
    return normalizePaper(body);
  }

  private async request(url: string, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { "user-agent": "Groundlane/0.1.0" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
      });
    } catch {
      signal.throwIfAborted();
      throw failure("UPSTREAM_ERROR", "Semantic Scholar request failed");
    }

    if (response.status === 429) throw failure("RATE_LIMITED", "Semantic Scholar rate limit exceeded");
    if (response.status === 404) throw failure("INVALID_INPUT", "Paper not found");
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw failure("UPSTREAM_ERROR", `Semantic Scholar returned HTTP ${response.status}`);
    }

    try {
      return await response.json();
    } catch {
      throw failure("UPSTREAM_ERROR", "Semantic Scholar returned malformed JSON");
    }
  }
}

function normalizePaper(raw: unknown): PaperMetadata {
  const p = raw as Record<string, unknown>;
  return {
    paperId: str(p.paperId) ?? "",
    title: str(p.title) ?? "",
    abstract: str(p.abstract),
    year: typeof p.year === "number" ? p.year : null,
    venue: str(p.venue),
    citationCount: typeof p.citationCount === "number" ? p.citationCount : null,
    authors: Array.isArray(p.authors)
      ? p.authors.map((a: Record<string, unknown>) => ({
          name: str(a.name) ?? "",
          authorId: str(a.authorId),
        }))
      : [],
    tldr: p.tldr !== null && typeof p.tldr === "object" && p.tldr !== undefined
      ? str((p.tldr as Record<string, unknown>).text)
      : null,
    externalIds: p.externalIds !== null && typeof p.externalIds === "object"
      ? (p.externalIds as Readonly<Record<string, string>>)
      : null,
    url: str(p.url) ?? "",
    openAccessPdf: p.openAccessPdf !== null && typeof p.openAccessPdf === "object" && p.openAccessPdf !== undefined
      ? str((p.openAccessPdf as Record<string, unknown>).url)
      : null,
    fieldsOfStudy: Array.isArray(p.fieldsOfStudy) ? p.fieldsOfStudy.filter((f): f is string => typeof f === "string") : null,
    references: Array.isArray(p.references)
      ? p.references.map((r: Record<string, unknown>) => ({ paperId: str(r.paperId) ?? "", title: str(r.title) ?? "" }))
      : null,
    citations: Array.isArray(p.citations)
      ? p.citations.map((c: Record<string, unknown>) => ({ paperId: str(c.paperId) ?? "", title: str(c.title) ?? "" }))
      : null,
  };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
