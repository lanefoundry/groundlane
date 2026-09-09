import type {
  BrowserBackend,
  BrowserFetchRequest,
  RawDocument,
} from "../../core/contracts.js";
import { GroundlaneError } from "../../core/errors.js";
import { withinDeadline } from "../../core/limits.js";
import { readBoundedResponse } from "../shared/bounded-response.js";
import { selectRenderedHtml } from "./browserless.js";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface CfBrowserRenderingOptions {
  accountId: string;
  apiToken: string;
  /** Daily budget in milliseconds (default: 600_000 = 10 min free tier). */
  dailyBudgetMs?: number;
  fetch?: FetchLike;
}

interface DailyUsage {
  date: string;
  usedMs: number;
}

export class CfBrowserRenderingBackend implements BrowserBackend {
  private readonly fetcher: FetchLike;
  private readonly endpoint: string;
  private readonly dailyBudgetMs: number;
  private usage: DailyUsage = { date: "", usedMs: 0 };

  constructor(private readonly options: CfBrowserRenderingOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.endpoint = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/browser-rendering/content`;
    this.dailyBudgetMs = options.dailyBudgetMs ?? 600_000;
  }

  private todayUtc(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private remainingMs(): number {
    const today = this.todayUtc();
    if (this.usage.date !== today) {
      this.usage = { date: today, usedMs: 0 };
    }
    return Math.max(0, this.dailyBudgetMs - this.usage.usedMs);
  }

  private recordUsage(ms: number): void {
    const today = this.todayUtc();
    if (this.usage.date !== today) {
      this.usage = { date: today, usedMs: ms };
    } else {
      this.usage.usedMs += ms;
    }
  }

  ready(): Promise<boolean> {
    return Promise.resolve(this.remainingMs() > 0);
  }

  async fetch(request: BrowserFetchRequest, parent?: AbortSignal): Promise<RawDocument> {
    if (this.remainingMs() <= 0) {
      throw new GroundlaneError(
        "RATE_LIMITED",
        "cf-browser",
        "Daily browser rendering budget exhausted",
      );
    }

    const startMs = Date.now();

    const body: Record<string, unknown> = {
      url: request.url,
      rejectResourceTypes: ["image", "media", "font"],
      gotoOptions: {
        waitUntil: "domcontentloaded",
        timeout: Math.min(
          request.deadline.remainingMs("cf-browser-navigate"),
          this.remainingMs(),
        ),
      },
    };

    if (request.waitFor !== undefined) {
      body.waitForSelector = {
        selector: request.waitFor,
        timeout: request.deadline.remainingMs("cf-browser-selector"),
      };
    }

    const response = await withinDeadline(
      (signal) =>
        this.fetcher(this.endpoint, {
          method: "POST",
          headers: {
            accept: "text/html",
            authorization: `Bearer ${this.options.apiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal,
        }),
      request.deadline,
      parent,
      "cf-browser-request",
    ).catch((error: unknown) => {
      if (error instanceof GroundlaneError) throw error;
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "cf-browser-request",
        "Cloudflare Browser Rendering request failed",
        true,
      );
    });

    const elapsedMs = Date.now() - startMs;
    this.recordUsage(elapsedMs);

    const usedHeader = response.headers.get("x-browser-ms-used");
    if (usedHeader !== null) {
      const serverMs = Number(usedHeader);
      if (Number.isFinite(serverMs) && serverMs > elapsedMs) {
        this.recordUsage(serverMs - elapsedMs);
      }
    }

    if (response.status === 408) {
      throw new GroundlaneError(
        "DEADLINE_EXCEEDED",
        "cf-browser-request",
        "Browser rendering navigation timed out",
        true,
      );
    }
    if (response.status === 429) {
      this.usage.usedMs = this.dailyBudgetMs;
      throw new GroundlaneError(
        "RATE_LIMITED",
        "cf-browser-request",
        "Cloudflare Browser Rendering rate limit reached",
        true,
      );
    }
    if (response.status >= 500) {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "cf-browser-request",
        "Cloudflare Browser Rendering is unavailable",
        true,
      );
    }
    if (!response.ok) {
      throw new GroundlaneError(
        "UPSTREAM_ERROR",
        "cf-browser-request",
        "Cloudflare Browser Rendering rejected the request",
      );
    }

    const finalUrl = response.headers.get("x-response-url") ?? request.url;

    const rawBody = await withinDeadline(
      (signal) =>
        readBoundedResponse(response, request.maxBytes, signal, "cf-browser-response"),
      request.deadline,
      parent,
      "cf-browser-response",
    );

    const resultBody =
      request.selector === undefined
        ? rawBody
        : new TextEncoder().encode(
            selectRenderedHtml(new TextDecoder().decode(rawBody), request.selector),
          );

    if (resultBody.byteLength > request.maxBytes) {
      throw new GroundlaneError(
        "OUTPUT_LIMIT",
        "cf-browser-response",
        "Rendered document exceeds the byte limit",
      );
    }

    return {
      requestedUrl: request.url,
      finalUrl,
      status: 200,
      headers: {},
      contentType: "text/html; charset=utf-8",
      body: resultBody,
      engine: "browser",
      backend: "cf-browser-rendering",
    };
  }
}
