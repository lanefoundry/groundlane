import type {
  RawDocument,
  ReaderBackend,
  ReaderFetchRequest,
} from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import { withinDeadline } from "../../core/limits.js";
import {
  resolvePublicUrl,
  type DnsLookup,
} from "../../core/url-policy.js";
import { resolveFinalHttpUrl } from "../http/undici-fetcher.js";
import { readBoundedResponse } from "../shared/bounded-response.js";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
type RedirectResolver = (
  request: ReaderFetchRequest,
  parent?: AbortSignal,
) => Promise<string>;

export interface JinaReaderOptions {
  fetch?: FetchLike;
  lookup?: DnsLookup;
  resolveRedirects?: RedirectResolver;
}

export class JinaReaderBackend implements ReaderBackend {
  private readonly fetcher: FetchLike;

  constructor(private readonly options: JinaReaderOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  ready(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async fetch(request: ReaderFetchRequest, parent?: AbortSignal): Promise<RawDocument> {
    const target = await withinDeadline(
      () =>
        resolvePublicUrl(request.url, {
          ...(this.options.lookup === undefined ? {} : { lookup: this.options.lookup }),
        }),
      request.deadline,
      parent,
      "reader-url",
    );
    const providerUrl =
      this.options.resolveRedirects === undefined
        ? await resolveFinalHttpUrl(
            { url: target.url.href, maxRedirects: 5, deadline: request.deadline },
            { ...(this.options.lookup === undefined ? {} : { lookup: this.options.lookup }) },
            parent,
          )
        : await this.options.resolveRedirects(request, parent);
    const response = await withinDeadline(
      (signal) =>
        this.fetcher(`https://r.jina.ai/${providerUrl}`, {
          method: "GET",
          redirect: "error",
          headers: {
            accept: "text/plain",
            "user-agent": "Groundlane/0.1",
            "x-no-cache": "true",
          },
          signal,
        }),
      request.deadline,
      parent,
      "reader-request",
    ).catch((error: unknown) => {
      if (error instanceof GroundlaneError) throw error;
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "reader-request",
        "Jina Reader request failed",
        true,
      );
    });

    if (response.status === 429) {
      throw new GroundlaneError(
        "RATE_LIMITED",
        "reader-request",
        "Jina Reader rate limit reached",
        true,
      );
    }
    if (response.status >= 500) {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "reader-request",
        "Jina Reader is unavailable",
        true,
      );
    }
    if (!response.ok) {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "reader-request",
        "Jina Reader rejected the request",
      );
    }

    const body = await withinDeadline(
      (signal) => readBoundedResponse(response, request.maxBytes, signal, "reader-response"),
      request.deadline,
      parent,
      "reader-response",
    );
    return {
      requestedUrl: request.url,
      finalUrl: providerUrl,
      status: 200,
      headers: {},
      contentType: "text/markdown; charset=utf-8",
      body,
      engine: "reader",
      backend: "jina",
    };
  }
}
