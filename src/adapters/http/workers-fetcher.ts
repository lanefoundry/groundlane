import type { HttpFetcher, HttpFetchRequest, RawDocument } from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import { withinDeadline } from "../../core/limits.js";
import { resolveRedirect } from "../../core/url-policy.js";

export interface WorkersFetcherOptions {
  userAgent?: string;
}

export class WorkersFetcher implements HttpFetcher {
  private readonly userAgent: string;

  constructor(options: WorkersFetcherOptions = {}) {
    this.userAgent = options.userAgent ?? "Groundlane/0.1";
  }

  async fetch(request: HttpFetchRequest, parent?: AbortSignal): Promise<RawDocument> {
    let current = request.url;

    for (let redirects = 0; ; redirects += 1) {
      if (redirects > request.maxRedirects) {
        throw new GroundlaneError("UPSTREAM_ERROR", "redirect", "Upstream exceeded the redirect limit");
      }

      const response = await withinDeadline(
        (signal) =>
          globalThis.fetch(current, {
            method: "GET",
            headers: {
              accept: "text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.1",
              ...Object.fromEntries(
                Object.entries(request.headers ?? {}).filter(
                  ([key]) => !["host", "user-agent"].includes(key.toLowerCase()),
                ),
              ),
              "user-agent": this.userAgent,
            },
            signal,
            redirect: "manual",
          }),
        request.deadline,
        parent,
        "connect",
      );

      const location = response.headers.get("location");
      if ([301, 302, 303, 307, 308].includes(response.status) && location) {
        current = resolveRedirect(new URL(current), location);
        continue;
      }

      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > request.maxBytes) {
        throw new GroundlaneError("OUTPUT_LIMIT", "response", "Upstream response exceeds the byte limit");
      }

      const buf = await withinDeadline(
        async (signal) => {
          const reader = response.body?.getReader();
          if (!reader) return new Uint8Array(0);
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            for (;;) {
              if (signal.aborted) throw signal.reason;
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > request.maxBytes) {
                await reader.cancel();
                throw new GroundlaneError("OUTPUT_LIMIT", "response", "Upstream response exceeds the byte limit");
              }
              chunks.push(value);
            }
          } finally {
            reader.releaseLock();
          }
          const body = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return body;
        },
        request.deadline,
        parent,
        "response",
      );

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      return {
        requestedUrl: request.url,
        finalUrl: current,
        status: response.status,
        headers,
        contentType: response.headers.get("content-type") ?? "application/octet-stream",
        body: buf,
        engine: "http",
        backend: "workers-fetch",
      };
    }
  }
}
