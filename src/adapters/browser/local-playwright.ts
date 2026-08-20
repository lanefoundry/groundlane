import type { Browser, BrowserContext } from "playwright";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { BrowserBackend, BrowserFetchRequest, RawDocument } from "../../core/contracts.js";
import { detectChallenge } from "../../core/browser-policy.js";
import { GroundlaneError } from "../../core/errors.js";
import { withinDeadline } from "../../core/limits.js";
import { resolvePublicUrl, type DnsLookup, type ResolvedAddress } from "../../core/url-policy.js";
import { createSafeProxy, type SafeProxy } from "./safe-proxy.js";

chromium.use(StealthPlugin());

export function mapLocalBrowserError(
  error: unknown,
  stage: "browser" | "browser-launch",
): GroundlaneError {
  if (error instanceof GroundlaneError) return error;
  return new GroundlaneError(
    "UPSTREAM_ERROR",
    stage,
    "The local browser operation failed",
    true,
    { cause: error },
  );
}

export interface LocalPlaywrightOptions { lookup?: DnsLookup; socketTimeoutMs?: number; maxResponseBytes: number; allowedPorts?: ReadonlySet<number> }

export class LocalPlaywrightBrowserBackend implements BrowserBackend {
  private browser: Browser | undefined; private proxy: SafeProxy | undefined; private launchPromise: Promise<Browser> | undefined; private shuttingDown = false;
  constructor(private readonly options: LocalPlaywrightOptions) {}
  async ready(): Promise<boolean> { try { const browser = await this.getBrowser(); return browser.isConnected(); } catch { return false; } }

  private getBrowser(): Promise<Browser> {
    if (this.shuttingDown) return Promise.reject(new GroundlaneError("PROVIDER_UNAVAILABLE", "browser", "Browser backend is shutting down"));
    if (this.browser?.isConnected()) return Promise.resolve(this.browser);
    this.launchPromise ??= createSafeProxy({ socketTimeoutMs: this.options.socketTimeoutMs ?? 30_000, maxResponseBytes: this.options.maxResponseBytes, ...(this.options.lookup ? { lookup: this.options.lookup } : {}), ...(this.options.allowedPorts ? { allowedPorts: this.options.allowedPorts } : {}) }).then(async (proxy) => {
      if (this.shuttingDown) { await proxy.close(); throw new GroundlaneError("PROVIDER_UNAVAILABLE", "browser", "Browser backend is shutting down"); }
      this.proxy = proxy;
      try {
        const browser = await chromium.launch({ headless: true, proxy: { server: proxy.url, bypass: "<-loopback>" }, args: ["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] });
        if (this.shuttingDown) { await browser.close(); await proxy.close(); throw new GroundlaneError("PROVIDER_UNAVAILABLE", "browser", "Browser backend is shutting down"); }
        this.browser = browser; browser.once("disconnected", () => { if (this.browser === browser) this.browser = undefined; if (this.proxy === proxy) this.proxy = undefined; void proxy.close(); }); return browser;
      } catch (error) {
        if (this.proxy === proxy) this.proxy = undefined;
        await proxy.close();
        throw mapLocalBrowserError(error, "browser-launch");
      }
    }).finally(() => { this.launchPromise = undefined; });
    return this.launchPromise;
  }

  async fetch(request: BrowserFetchRequest, parent?: AbortSignal): Promise<RawDocument> {
    const cache = new Map<string, readonly ResolvedAddress[]>();
    const policy = { cache, ...(this.options.lookup ? { lookup: this.options.lookup } : {}), ...(this.options.allowedPorts ? { allowedPorts: this.options.allowedPorts } : {}) };
    await withinDeadline(() => resolvePublicUrl(request.url, policy), request.deadline, parent, "browser-url");
    const browser = await withinDeadline(() => this.getBrowser(), request.deadline, parent, "browser-launch");
    let context: BrowserContext | undefined;
    try {
      context = await withinDeadline(() => browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: "block" }), request.deadline, parent, "browser-context");
      let blocked = 0; let blockedNavigation: GroundlaneError | undefined;
      await context.routeWebSocket("**/*", (websocket) => { blocked += 1; void websocket.close(); });
      await context.route("**/*", async (route) => {
        const browserRequest = route.request();
        try {
          await withinDeadline(() => resolvePublicUrl(browserRequest.url(), policy), request.deadline, parent, "browser-request");
          if (["image", "media", "font"].includes(browserRequest.resourceType())) { blocked += 1; await route.abort("blockedbyclient"); return; }
          await route.continue();
        } catch (error) {
          blocked += 1;
          if (browserRequest.isNavigationRequest() && browserRequest.frame() === browserRequest.frame().page().mainFrame()) blockedNavigation = error instanceof GroundlaneError ? error : new GroundlaneError("URL_BLOCKED", "browser-request", "Browser navigation was blocked");
          await route.abort("blockedbyclient");
        }
      });
      const page = await withinDeadline(() => context!.newPage(), request.deadline, parent, "browser-page");
      let response;
      try { response = await withinDeadline(() => page.goto(request.url, { waitUntil: "domcontentloaded", timeout: request.deadline.remainingMs("browser-navigate") }), request.deadline, parent, "browser-navigate"); }
      catch (error) { if (blockedNavigation) throw blockedNavigation; throw error; }
      while (await withinDeadline(() => Promise.all([page.title(), page.locator("body").innerText({ timeout: request.deadline.remainingMs("browser-challenge") })]).then(([title, body]) => detectChallenge(title, body.slice(0, 1_000))), request.deadline, parent, "browser-challenge")) {
        await withinDeadline((signal) => new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 250);
          signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new GroundlaneError("CANCELLED", "browser-challenge", "The request was cancelled")); }, { once: true });
        }), request.deadline, parent, "browser-challenge");
      }
      if (request.waitFor) {
        try { await page.locator(request.waitFor).first().waitFor({ state: "attached", timeout: request.deadline.remainingMs("browser-selector") }); }
        catch (error) { if (error instanceof GroundlaneError) throw error; throw new GroundlaneError("INVALID_INPUT", "browser-selector", "The selector was invalid or did not appear"); }
      }
      let html: string;
      try { html = await withinDeadline(() => request.selector ? page.locator(request.selector).first().evaluate((element) => element.outerHTML) : page.content(), request.deadline, parent, "browser-content"); }
      catch (error) { if (error instanceof GroundlaneError) throw error; if (request.selector) throw new GroundlaneError("INVALID_INPUT", "browser-selector", "The selector was invalid or did not match"); throw error; }
      const body = new TextEncoder().encode(html);
      if (body.byteLength > request.maxBytes) throw new GroundlaneError("OUTPUT_LIMIT", "browser-content", "Rendered document exceeds the byte limit");
      return { requestedUrl: request.url, finalUrl: page.url(), status: response?.status() ?? 200, headers: response?.headers() ?? {}, contentType: "text/html; charset=utf-8", body, engine: "browser", backend: "local", blockedSubrequests: blocked };
    } catch (error) {
      throw mapLocalBrowserError(error, "browser");
    } finally { if (context) void context.close().catch(() => undefined); }
  }

  async close(): Promise<void> {
    this.shuttingDown = true;
    const launching = this.launchPromise;
    if (launching) await launching.catch(() => undefined);
    const browser = this.browser; const proxy = this.proxy; this.browser = undefined; this.proxy = undefined;
    if (browser?.isConnected()) await browser.close().catch(() => undefined);
    await proxy?.close().catch(() => undefined);
  }
}

export { LocalPlaywrightBrowserBackend as LocalPlaywrightBackend };
