import http from "node:http";
import https from "node:https";
import type { IncomingHttpHeaders, IncomingMessage, RequestOptions } from "node:http";
import type { HttpFetcher, HttpFetchRequest, RawDocument } from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import { withinDeadline, type Deadline } from "../../core/limits.js";
import { resolvePublicUrl, resolveRedirect, type DnsLookup, type ResolvedAddress } from "../../core/url-policy.js";

export interface SafeHttpFetcherOptions { lookup?: DnsLookup; allowedPorts?: ReadonlySet<number>; userAgent?: string }
export interface RedirectResolutionRequest {
  url: string;
  maxRedirects: number;
  deadline: Deadline;
}

function headersToRecord(headers: IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(", ") : value]]));
}

async function readBounded(response: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = Number(response.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) throw new GroundlaneError("OUTPUT_LIMIT", "response", "Upstream response exceeds the byte limit");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const rawChunk of response as AsyncIterable<Uint8Array>) {
    if (signal.aborted) throw signal.reason;
    const chunk = rawChunk;
    size += chunk.byteLength;
    if (size > maxBytes) {
      response.destroy();
      throw new GroundlaneError("OUTPUT_LIMIT", "response", "Upstream response exceeds the byte limit");
    }
    chunks.push(chunk);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

function requestPinned(
  url: URL,
  address: ResolvedAddress,
  options: SafeHttpFetcherOptions,
  signal: AbortSignal,
  headers?: Readonly<Record<string, string>>,
): Promise<IncomingMessage> {
  const extraHeaders = Object.fromEntries(
    Object.entries(headers ?? {}).filter(([key]) => !["host", "user-agent"].includes(key.toLowerCase())),
  );
  return new Promise((resolve, reject) => {
    const requestOptions: RequestOptions = {
      protocol: url.protocol,
      hostname: address.address,
      family: address.family,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        accept: "text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.1",
        ...extraHeaders,
        host: url.host,
        "user-agent": options.userAgent ?? "Groundlane/0.1",
      },
      signal,
      ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
    };
    const request = (url.protocol === "https:" ? https : http).request(requestOptions, resolve);
    request.once("error", reject);
    request.end();
  });
}

export class SafeHttpFetcher implements HttpFetcher {
  constructor(private readonly options: SafeHttpFetcherOptions = {}) {}

  async fetch(request: HttpFetchRequest, parent?: AbortSignal): Promise<RawDocument> {
    const cache = new Map<string, readonly ResolvedAddress[]>();
    let current = request.url;
    for (let redirects = 0; ; redirects += 1) {
      if (redirects > request.maxRedirects) throw new GroundlaneError("UPSTREAM_ERROR", "redirect", "Upstream exceeded the redirect limit");
      const destination = await withinDeadline(
        () => resolvePublicUrl(current, { cache, ...(this.options.lookup ? { lookup: this.options.lookup } : {}), ...(this.options.allowedPorts ? { allowedPorts: this.options.allowedPorts } : {}) }),
        request.deadline,
        parent,
        "dns",
      );
      let response: IncomingMessage | undefined;
      let lastError: unknown;
      for (const address of destination.addresses) {
        try {
          response = await withinDeadline((signal) => requestPinned(destination.url, address, this.options, signal, request.headers), request.deadline, parent, "connect");
          break;
        } catch (error) {
          if (error instanceof GroundlaneError) throw error;
          lastError = error;
        }
      }
      if (!response) {
        if (lastError instanceof GroundlaneError) throw lastError;
        throw new GroundlaneError("UPSTREAM_ERROR", "connect", "Could not connect to the validated destination", true);
      }
      const status = response.statusCode ?? 502;
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        response.resume();
        current = resolveRedirect(destination.url, location);
        continue;
      }
      const body = await withinDeadline((signal) => readBounded(response, request.maxBytes, signal), request.deadline, parent, "response");
      return {
        requestedUrl: request.url,
        finalUrl: destination.url.href,
        status,
        headers: headersToRecord(response.headers),
        contentType: response.headers["content-type"] ?? "application/octet-stream",
        body,
        engine: "http",
        backend: "direct",
      };
    }
  }
}

export async function resolveFinalHttpUrl(
  request: RedirectResolutionRequest,
  options: SafeHttpFetcherOptions = {},
  parent?: AbortSignal,
): Promise<string> {
  const cache = new Map<string, readonly ResolvedAddress[]>();
  let current = request.url;
  for (let redirects = 0; ; redirects += 1) {
    if (redirects > request.maxRedirects) {
      throw new GroundlaneError("UPSTREAM_ERROR", "redirect", "Upstream exceeded the redirect limit");
    }
    const destination = await withinDeadline(
      () =>
        resolvePublicUrl(current, {
          cache,
          ...(options.lookup ? { lookup: options.lookup } : {}),
          ...(options.allowedPorts ? { allowedPorts: options.allowedPorts } : {}),
        }),
      request.deadline,
      parent,
      "dns",
    );
    let response: IncomingMessage | undefined;
    let lastError: unknown;
    for (const address of destination.addresses) {
      try {
        response = await withinDeadline(
          (signal) => requestPinned(destination.url, address, options, signal),
          request.deadline,
          parent,
          "connect",
        );
        break;
      } catch (error) {
        if (error instanceof GroundlaneError) throw error;
        lastError = error;
      }
    }
    if (!response) {
      if (lastError instanceof GroundlaneError) throw lastError;
      throw new GroundlaneError("UPSTREAM_ERROR", "connect", "Could not connect to the validated destination", true);
    }
    const status = response.statusCode ?? 502;
    const location = response.headers.location;
    response.destroy();
    if ([301, 302, 303, 307, 308].includes(status) && location) {
      current = resolveRedirect(destination.url, location);
      continue;
    }
    return destination.url.href;
  }
}

export { SafeHttpFetcher as UndiciFetcher };
