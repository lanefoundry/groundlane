import type { FetchPipelineRequest } from "./fetch-pipeline.js";
import type { HttpFetcher, RawDocument } from "./contracts.js";
import { GroundlaneError } from "./errors.js";

export interface SourceAwareResolution {
  raw: RawDocument;
  reason: string;
}

export interface SourceResolver {
  resolve(request: FetchPipelineRequest, signal?: AbortSignal): Promise<SourceAwareResolution | undefined>;
  resolveProactively?(request: FetchPipelineRequest, signal?: AbortSignal): Promise<SourceAwareResolution | undefined>;
  resolveManifests?(request: FetchPipelineRequest, signal?: AbortSignal): Promise<SourceAwareResolution | undefined>;
}

interface SourceCandidate {
  url: string;
  backend: string;
}

export interface MarkdownLink {
  title: string;
  url: string;
  section?: string;
  notes?: string;
}

export interface OpenApiSlice {
  content: string;
  backend: "source:openapi-path" | "source:openapi-operation";
}

const maxLlmsLinks = 500;
const encoder = new TextEncoder();

function withoutTrailingSlash(pathname: string): string {
  return pathname.replace(/\/+$/u, "");
}

function normalizeComparablePath(url: string): string {
  const parsed = new URL(url);
  let pathname = parsed.pathname.replace(/\/index\.md$/iu, "");
  pathname = pathname.replace(/\.html?\.md$/iu, "");
  pathname = pathname.replace(/\.md$/iu, "");
  pathname = withoutTrailingSlash(pathname);
  return pathname === "" ? "/" : pathname;
}

function sameOrigin(first: string, second: string): boolean {
  return new URL(first).origin === new URL(second).origin;
}

function isMarkdownDocument(raw: RawDocument): boolean {
  const source = new TextDecoder().decode(raw.body.slice(0, 256));
  const contentType = raw.contentType.toLowerCase();
  if (/^\s*<!doctype\s+html|^\s*<html[\s>]/iu.test(source)) return false;
  return (
    contentType.includes("markdown") ||
    contentType.includes("text/plain") ||
    /\.md(?:$|[?#])/iu.test(raw.finalUrl) ||
    /\/llms(?:-full)?\.txt(?:$|[?#])/iu.test(raw.finalUrl)
  );
}

export function isLikelyDocumentationUrl(url: string): boolean {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();
  const pathSegments = parsed.pathname.toLowerCase().split("/").filter(Boolean);
  if (
    hostname === "developers.cloudflare.com" ||
    hostname.endsWith(".readthedocs.io") ||
    hostname.startsWith("docs.") ||
    hostname.startsWith("developer.") ||
    hostname.startsWith("developers.")
  ) {
    return true;
  }
  return pathSegments.some((segment) =>
    ["api", "reference", "references", "docs", "documentation", "guide", "guides"].includes(segment),
  );
}

export function cleanSourceMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  let start = 0;
  if (lines[0]?.trim() === "---") {
    for (let index = 1; index < lines.length; index += 1) {
      if (lines[index]?.trim() === "---") {
        start = index + 1;
        break;
      }
    }
  }
  const cleaned: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (/^\[Skip to content\]\(/iu.test(trimmed)) continue;
    if (/^Copy Markdown$/iu.test(trimmed)) continue;
    if (/^On this page$/iu.test(trimmed)) continue;
    if (/^(Edit this page|Was this helpful\?|Feedback)$/iu.test(trimmed)) continue;
    cleaned.push(line);
  }
  const firstHeading = cleaned.findIndex((line) => /^#{1,6}\s+\S/u.test(line.trim()));
  const contentLines = firstHeading >= 0 && firstHeading <= 40 ? cleaned.slice(firstHeading) : cleaned;
  return contentLines.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

function resolvePublicLink(baseUrl: string, href: string): string | undefined {
  try {
    const resolved = new URL(href, baseUrl);
    if (!["http:", "https:"].includes(resolved.protocol)) return undefined;
    resolved.hash = "";
    return resolved.href;
  } catch {
    return undefined;
  }
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

export function llmsTxtCandidates(url: string): string[] {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const candidates: string[] = [];
  if (segments.length > 0) {
    const scoped = new URL(parsed.origin);
    scoped.pathname = `/${segments[0]}/llms.txt`;
    candidates.push(scoped.href);
  }
  const root = new URL(parsed.origin);
  root.pathname = "/llms.txt";
  candidates.push(root.href);
  return [...new Set(candidates)];
}

export function parseLlmsTxtLinks(markdown: string, baseUrl: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  let section: string | undefined;
  for (const line of markdown.split(/\r?\n/u)) {
    const heading = /^(#{2,6})\s+(.+?)\s*$/u.exec(line);
    if (heading) {
      section = heading[2]?.replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1").trim();
      continue;
    }
    const link = /^\s*-\s+\[([^\]]+)\]\(([^)]+)\)(?::\s*(.*))?\s*$/u.exec(line);
    if (!link) continue;
    const resolved = resolvePublicLink(baseUrl, link[2] ?? "");
    if (resolved === undefined) continue;
    if (!sameOrigin(baseUrl, resolved)) continue;
    links.push({
      title: (link[1] ?? "").trim(),
      url: resolved,
      ...(section ? { section } : {}),
      ...(link[3]?.trim() ? { notes: link[3].trim() } : {}),
    });
    if (links.length >= maxLlmsLinks) break;
  }
  return links;
}

export function selectLlmsMarkdownLink(markdown: string, llmsUrl: string, targetUrl: string): MarkdownLink | undefined {
  const targetPath = normalizeComparablePath(targetUrl);
  let best: { link: MarkdownLink; score: number } | undefined;
  for (const link of parseLlmsTxtLinks(markdown, llmsUrl)) {
    const linkPath = normalizeComparablePath(link.url);
    let score = 0;
    if (linkPath === targetPath) score = 1_000;
    else if (targetPath.startsWith(`${linkPath}/`)) score = 500 + linkPath.length;
    else if (linkPath.startsWith(`${targetPath}/`)) score = 250 + targetPath.length;
    if (score === 0) continue;
    if (best === undefined || score > best.score) best = { link, score };
  }
  return best?.link;
}

function slugifyHeading(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[`*_~[\]()]/gu, "")
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
}

export function sliceMarkdownByHash(markdown: string, sourceUrl: string): string {
  const hash = new URL(sourceUrl).hash.replace(/^#/u, "");
  if (hash.length === 0) return markdown;
  const target = decodeURIComponent(hash).toLowerCase();
  const lines = markdown.split(/\r?\n/u);
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*$/u.exec(lines[index] ?? "");
    if (!match) continue;
    if (slugifyHeading(match[2] ?? "") === target) {
      start = index;
      level = match[1]?.length ?? 1;
      break;
    }
  }
  if (start === -1) return markdown;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+/u.exec(lines[index] ?? "");
    if (match && (match[1]?.length ?? 1) <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function operationMatchesPath(operation: unknown, method: string): boolean {
  if (!isRecord(operation)) return false;
  const methods = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];
  return methods.includes(method.toLowerCase());
}

export function sliceOpenApiJsonByPath(openApiJson: string, path: string, method?: string): OpenApiSlice | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(openApiJson);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.paths)) return undefined;
  const pathItem = parsed.paths[path];
  if (pathItem === undefined) return undefined;
  if (method === undefined) {
    return {
      content: stableJson({ openapi: parsed.openapi, path, operations: pathItem }),
      backend: "source:openapi-path",
    };
  }
  if (!isRecord(pathItem)) return undefined;
  const operation = pathItem[method.toLowerCase()];
  if (!operationMatchesPath(operation, method)) return undefined;
  return {
    content: stableJson({ openapi: parsed.openapi, path, method: method.toLowerCase(), operation }),
    backend: "source:openapi-path",
  };
}

export function sliceOpenApiJsonByOperationId(openApiJson: string, operationId: string): OpenApiSlice | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(openApiJson);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.paths)) return undefined;
  const matches: Array<{ path: string; method: string; operation: unknown }> = [];
  for (const [path, pathItem] of Object.entries(parsed.paths)) {
    if (!isRecord(pathItem)) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!isRecord(operation) || operation.operationId !== operationId) continue;
      matches.push({ path, method, operation });
    }
  }
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  if (match === undefined) return undefined;
  return {
    content: stableJson({
      openapi: parsed.openapi,
      path: match.path,
      method: match.method,
      operation: match.operation,
    }),
    backend: "source:openapi-operation",
  };
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

  async resolveProactively(request: FetchPipelineRequest, signal?: AbortSignal): Promise<SourceAwareResolution | undefined> {
    if (!canUseSourceAwareDocs(request) || !isLikelyDocumentationUrl(request.url)) return undefined;
    return this.resolveFromCandidates(request, signal, { directCandidates: true, manifests: false });
  }

  async resolve(request: FetchPipelineRequest, signal?: AbortSignal): Promise<SourceAwareResolution | undefined> {
    if (!canUseSourceAwareDocs(request)) return undefined;
    return this.resolveFromCandidates(request, signal, { directCandidates: true, manifests: true });
  }

  async resolveManifests(request: FetchPipelineRequest, signal?: AbortSignal): Promise<SourceAwareResolution | undefined> {
    if (!canUseSourceAwareDocs(request)) return undefined;
    return this.resolveFromCandidates(request, signal, { directCandidates: false, manifests: true });
  }

  private async resolveFromCandidates(
    request: FetchPipelineRequest,
    signal: AbortSignal | undefined,
    options: { directCandidates: boolean; manifests: boolean },
  ): Promise<SourceAwareResolution | undefined> {
    if (options.directCandidates) {
      for (const candidate of markdownSourceCandidates(request.url)) {
        const resolved = await this.tryFetchMarkdownCandidate(request, candidate, signal);
        if (resolved !== undefined) return resolved;
      }
    }

    if (!options.manifests) return undefined;

    for (const llmsUrl of llmsTxtCandidates(request.url)) {
      try {
        const llmsRaw = await this.fetchMarkdown(request, llmsUrl, signal);
        if (llmsRaw.status >= 400) continue;
        const selected = selectLlmsMarkdownLink(new TextDecoder().decode(llmsRaw.body), llmsRaw.finalUrl, request.url);
        if (selected === undefined) continue;
        const resolved = await this.tryFetchMarkdownCandidate(
          request,
          { url: selected.url, backend: "source:llms.txt" },
          signal,
        );
        if (resolved !== undefined) return resolved;
      } catch (error) {
        if (error instanceof GroundlaneError && error.code === "URL_BLOCKED") throw error;
      }
    }

    return undefined;
  }

  private async tryFetchMarkdownCandidate(
    request: FetchPipelineRequest,
    candidate: SourceCandidate,
    signal?: AbortSignal,
  ): Promise<SourceAwareResolution | undefined> {
    try {
      const raw = await this.fetchMarkdown(request, candidate.url, signal);
      if (raw.status >= 400) return undefined;
      if (!isMarkdownDocument(raw)) return undefined;
      const sliced = sliceMarkdownByHash(cleanSourceMarkdown(new TextDecoder().decode(raw.body)), request.url);
      return {
        raw: {
          ...raw,
          requestedUrl: request.url,
          body: encoder.encode(sliced),
          backend: candidate.backend,
        },
        reason: "source_aware_markdown",
      };
    } catch (error) {
      if (error instanceof GroundlaneError && error.code === "URL_BLOCKED") throw error;
      return undefined;
    }
  }

  private fetchMarkdown(
    request: FetchPipelineRequest,
    url: string,
    signal?: AbortSignal,
  ): Promise<RawDocument> {
    return this.http.fetch(
      {
        url,
        maxBytes: request.maxBytes,
        maxRedirects: request.maxRedirects,
        deadline: request.deadline,
        headers: { accept: "text/markdown,text/plain;q=0.9,*/*;q=0.1" },
      },
      signal,
    );
  }
}
