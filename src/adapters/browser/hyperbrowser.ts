import { load } from "cheerio";

import type {
  BrowserBackend,
  BrowserFetchRequest,
  RawDocument,
} from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import { withinDeadline } from "../../core/limits.js";
import {
  resolvePublicUrl,
  type DnsLookup,
} from "../../core/url-policy.js";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const ORIGIN = "https://api.hyperbrowser.ai";
const POLL_INTERVAL_MS = 1_000;

export interface HyperbrowserOptions {
  apiKey: string;
  fetch?: FetchLike;
  lookup?: DnsLookup;
}

function selectRenderedHtml(html: string, selector: string): string {
  const $ = load(html);
  let selected;
  try {
    selected = $(selector).first();
  } catch {
    throw new GroundlaneError(
      "INVALID_INPUT",
      "browser-selector",
      "The selector is invalid",
    );
  }
  if (selected.length === 0) {
    throw new GroundlaneError(
      "INVALID_INPUT",
      "browser-selector",
      "The selector did not match",
    );
  }
  return selected.toString();
}

export class HyperbrowserBackend implements BrowserBackend {
  private readonly fetcher: FetchLike;

  constructor(private readonly options: HyperbrowserOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  ready(): Promise<boolean> {
    return Promise.resolve(this.options.apiKey.length > 0);
  }

  async fetch(request: BrowserFetchRequest, parent?: AbortSignal): Promise<RawDocument> {
    const policy = {
      ...(this.options.lookup === undefined ? {} : { lookup: this.options.lookup }),
    };
    const target = await withinDeadline(
      () => resolvePublicUrl(request.url, policy),
      request.deadline,
      parent,
      "browser-url",
    );

    // Step 1: Start scrape job
    const startResponse = await withinDeadline(
      (signal) =>
        this.fetcher(`${ORIGIN}/api/scrape`, {
          method: "POST",
          redirect: "error",
          headers: {
            "x-api-key": this.options.apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({ url: target.url.href }),
          signal,
        }),
      request.deadline,
      parent,
      "browser-request",
    ).catch((error: unknown) => {
      if (error instanceof GroundlaneError) throw error;
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "browser-request",
        "Hyperbrowser request failed",
        true,
      );
    });

    if (startResponse.status === 429) {
      throw new GroundlaneError(
        "RATE_LIMITED",
        "browser-request",
        "Hyperbrowser rate limit reached",
        true,
      );
    }
    if (!startResponse.ok) {
      void startResponse.body?.cancel().catch(() => undefined);
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "browser-request",
        "Hyperbrowser rejected the request",
      );
    }

    let startBody: unknown;
    try {
      startBody = await startResponse.json();
    } catch {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "browser-request",
        "Hyperbrowser returned malformed JSON",
      );
    }

    const jobId = (startBody as Record<string, unknown>).jobId;
    if (typeof jobId !== "string" || jobId.length === 0) {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "browser-request",
        "Hyperbrowser did not return a job ID",
      );
    }

    // Step 2: Poll until completed or failed
    await withinDeadline(
      async (signal) => {
        while (true) {
          signal.throwIfAborted();
          await new Promise((resolve) => { setTimeout(resolve, POLL_INTERVAL_MS); });
          signal.throwIfAborted();

          let pollResponse: Response;
          try {
            pollResponse = await this.fetcher(`${ORIGIN}/api/scrape/${jobId}/status`, {
              headers: { "x-api-key": this.options.apiKey },
              signal,
            });
          } catch {
            signal.throwIfAborted();
            throw new GroundlaneError(
              "UPSTREAM_ERROR",
              "browser-poll",
              "Hyperbrowser status check failed",
              true,
            );
          }

          if (pollResponse.status === 429) {
            throw new GroundlaneError(
              "RATE_LIMITED",
              "browser-poll",
              "Hyperbrowser rate limit reached",
              true,
            );
          }
          if (!pollResponse.ok) {
            void pollResponse.body?.cancel().catch(() => undefined);
            throw new GroundlaneError(
              "UPSTREAM_ERROR",
              "browser-poll",
              "Hyperbrowser status check failed",
              true,
            );
          }

          let pollBody: unknown;
          try {
            pollBody = await pollResponse.json();
          } catch {
            throw new GroundlaneError(
              "UPSTREAM_ERROR",
              "browser-poll",
              "Hyperbrowser returned malformed status",
            );
          }

          const status = (pollBody as Record<string, unknown>).status;
          if (status === "completed") break;
          if (status === "failed") {
            throw new GroundlaneError(
              "UPSTREAM_ERROR",
              "browser-request",
              "Hyperbrowser scrape failed",
            );
          }
        }
      },
      request.deadline,
      parent,
      "browser-poll",
    );

    // Step 3: Fetch result
    const resultResponse = await withinDeadline(
      (signal) =>
        this.fetcher(`${ORIGIN}/api/scrape/${jobId}`, {
          headers: { "x-api-key": this.options.apiKey },
          signal,
        }),
      request.deadline,
      parent,
      "browser-result",
    ).catch((error: unknown) => {
      if (error instanceof GroundlaneError) throw error;
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "browser-result",
        "Hyperbrowser result fetch failed",
        true,
      );
    });

    if (!resultResponse.ok) {
      void resultResponse.body?.cancel().catch(() => undefined);
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "browser-result",
        "Hyperbrowser result fetch failed",
      );
    }

    let resultBody: unknown;
    try {
      resultBody = await resultResponse.json();
    } catch {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "browser-result",
        "Hyperbrowser returned malformed result",
      );
    }

    const data = (resultBody as Record<string, unknown>).data as Record<string, unknown> | undefined;
    const html = typeof data?.html === "string" ? data.html : "";

    if (html.length === 0) {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "browser-result",
        "Hyperbrowser returned empty content",
      );
    }

    const selectedHtml =
      request.selector === undefined
        ? html
        : selectRenderedHtml(html, request.selector);

    const body = new TextEncoder().encode(selectedHtml);
    if (body.byteLength > request.maxBytes) {
      throw new GroundlaneError(
        "OUTPUT_LIMIT",
        "browser-response",
        "Rendered document exceeds the byte limit",
      );
    }

    return {
      requestedUrl: request.url,
      finalUrl: target.url.href,
      status: 200,
      headers: {},
      contentType: "text/html; charset=utf-8",
      body,
      engine: "browser",
      backend: "hyperbrowser",
    };
  }
}
