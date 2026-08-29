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
import { resolveFinalHttpUrl } from "../http/undici-fetcher.js";
import { readBoundedResponse } from "../shared/bounded-response.js";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
type RedirectResolver = (
  request: BrowserFetchRequest,
  parent?: AbortSignal,
) => Promise<string>;
export type BrowserlessRegion = "sfo" | "lon" | "ams";

export interface BrowserlessOptions {
  token: string;
  region?: BrowserlessRegion;
  fetch?: FetchLike;
  lookup?: DnsLookup;
  resolveRedirects?: RedirectResolver;
}

export function browserlessContentEndpoint(region: BrowserlessRegion): string {
  return `https://production-${region}.browserless.io/content`;
}

export function selectRenderedHtml(html: string, selector: string): string {
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

function targetStatus(response: Response): number {
  const value = Number(response.headers.get("x-response-code"));
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : 200;
}

export class BrowserlessBackend implements BrowserBackend {
  private readonly fetcher: FetchLike;
  private readonly endpoint: string;

  constructor(private readonly options: BrowserlessOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.endpoint = browserlessContentEndpoint(options.region ?? "sfo");
  }

  ready(): Promise<boolean> {
    return Promise.resolve(this.options.token.length > 0);
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
    const providerUrl =
      this.options.resolveRedirects === undefined
        ? await resolveFinalHttpUrl(
            { url: target.url.href, maxRedirects: 5, deadline: request.deadline },
            policy,
            parent,
          )
        : await this.options.resolveRedirects(request, parent);
    const response = await withinDeadline(
      (signal) =>
        this.fetcher(this.endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            accept: "text/html",
            authorization: `Bearer ${this.options.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            url: providerUrl,
            bestAttempt: false,
            gotoOptions: {
              waitUntil: "domcontentloaded",
              timeout: request.deadline.remainingMs("browser-request"),
            },
            rejectResourceTypes: ["image", "media", "font"],
            ...(request.waitFor === undefined
              ? {}
              : {
                  waitForSelector: {
                    selector: request.waitFor,
                    timeout: request.deadline.remainingMs("browser-selector"),
                  },
                }),
          }),
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
        "Browserless request failed",
        true,
      );
    });

    if (response.status === 408) {
      throw new GroundlaneError(
        "DEADLINE_EXCEEDED",
        "browser-request",
        "Browserless navigation timed out",
        true,
      );
    }
    if (response.status === 429) {
      throw new GroundlaneError(
        "RATE_LIMITED",
        "browser-request",
        "Browserless rate limit reached",
        true,
      );
    }
    if (response.status >= 500) {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "browser-request",
        "Browserless is unavailable",
        true,
      );
    }
    if (!response.ok) {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "browser-request",
        "Browserless rejected the request",
      );
    }

    const responseUrl = response.headers.get("x-response-url") ?? providerUrl;
    const finalTarget = await withinDeadline(
      () => resolvePublicUrl(responseUrl, policy),
      request.deadline,
      parent,
      "browser-final-url",
    );
    const rawBody = await withinDeadline(
      (signal) => readBoundedResponse(response, request.maxBytes, signal, "browser-response"),
      request.deadline,
      parent,
      "browser-response",
    );
    const body =
      request.selector === undefined
        ? rawBody
        : new TextEncoder().encode(
            selectRenderedHtml(new TextDecoder().decode(rawBody), request.selector),
          );
    if (body.byteLength > request.maxBytes) {
      throw new GroundlaneError(
        "OUTPUT_LIMIT",
        "browser-response",
        "Rendered document exceeds the byte limit",
      );
    }

    return {
      requestedUrl: request.url,
      finalUrl: finalTarget.url.href,
      status: targetStatus(response),
      headers: {},
      contentType: "text/html; charset=utf-8",
      body,
      engine: "browser",
      backend: "browserless",
    };
  }
}
