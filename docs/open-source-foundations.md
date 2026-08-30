# Open-source foundations

[English](open-source-foundations.md) | [繁體中文](open-source-foundations.zh-TW.md)

Groundlane is built as a small TypeScript control plane, not as a fork of one crawler or browser server. This document records which open-source projects influence the architecture, what Groundlane may reuse, and where the boundary remains intentionally different.

The expanded, time-sensitive reference landscape lives in [Open-source references](research/open-source-references.md); this page keeps only the stable architecture decision.

## Decision

Groundlane keeps its current stateless `web_fetch`, `web_search`, and `web_extract` core. It does not add a crawler framework to the MVP dependency graph.

When multi-page crawling becomes an active product requirement, [Crawlee](https://github.com/apify/crawlee) is the first implementation candidate because it is TypeScript, Apache-2.0 licensed, and already provides request queues, retries, session pools, proxy configuration, autoscaling, and Playwright integration.

The other major references influence contracts and internal design without adding another production runtime:

| Project | What Groundlane adopts | What Groundlane does not assume |
|---|---|---|
| [Crawlee](https://github.com/apify/crawlee) | Queue, retry, session, proxy, and autoscaling patterns for future bounded crawl jobs | That a crawler queue can replace Groundlane's URL, deadline, byte, output, or cancellation policies |
| [Crawl4AI](https://github.com/unclecode/crawl4ai) | Agent-friendly Markdown, structured extraction, crawl-result and waiting UX | A Python sidecar in the MVP, or that extraction implies anti-bot capability |
| [Scrapy](https://github.com/scrapy/scrapy) | Downloader middleware, retry classification, throttling, duplicate filtering, and operational statistics | A second crawler runtime or Scrapy-specific public contracts |
| [Selenium](https://github.com/SeleniumHQ/selenium) | Cross-browser automation lessons | A second browser driver alongside Playwright, or any claim that WebDriver alone bypasses challenges |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | MCP browser-tool ergonomics, client isolation, and bounded output | Origin flags as an SSRF security boundary |
| [Steel](https://github.com/steel-dev/steel-browser) | Browser session lifecycle and process-management patterns | Stateful sessions inside Groundlane's stateless MVP tools |

## Open source is not the managed network

An open-source SDK or crawler does not make the corresponding hosted platform open source. For example, Crawlee and Apify SDKs are open-source projects, while Apify's managed execution and proxy services are separate products. The same distinction applies when Groundlane integrates hosted anti-bot, proxy, search, reader, or browser providers.

Groundlane therefore separates two concerns:

```text
crawl orchestration (queue, retry, dedupe, budgets)
                         |
                         v
retrieval backends (safe HTTP, reader, browser, managed anti-bot adapter)
```

Open-source orchestration improves reliability and self-hosting. Residential IPs, CAPTCHA solving, managed fingerprints, and provider-operated unblockers remain explicit adapters with their own credentials, pricing, privacy, and terms.

## Crawlee adoption gate

Crawlee should be added only when all of the following are true:

1. Groundlane has an approved `web_crawl` or asynchronous crawl-job contract rather than overloading `web_fetch`.
2. Every discovered URL and redirect passes the existing URL policy before retrieval.
3. One job budget bounds pages, depth, duration, redirects, response bytes, output bytes, concurrency, and queue size.
4. Cancellation stops queued and active work and releases browser, proxy, and network resources.
5. Request queue and result persistence have explicit ownership, retention, tenancy, and cleanup semantics.
6. Crawlee's retry/session behavior maps to Groundlane's stable errors and does not silently reset deadlines.
7. Tests run without live provider credentials or unrestricted external network access.

Until these conditions are met, the current fetch pipeline remains smaller, easier to audit, and more suitable for the three stateless MCP tools.

## First bounded crawl contract

The likely next primitive is deliberately narrow:

```text
web_crawl(
  startUrl,
  maxPages,
  maxDepth,
  includePatterns,
  excludePatterns,
  render,
  timeoutMs,
  maxBytesPerPage,
  maxTotalOutputChars
)
```

It should return normalized per-page results plus skipped/failed URL summaries and explicit budget exhaustion metadata. It should not imply a persistent crawler fleet, unrestricted recursive crawling, universal anti-bot bypass, or permission to ignore site policies.

## License discipline

Before copying code or adding a dependency, contributors must pin the reviewed revision, read its LICENSE and NOTICE files, inspect transitive licenses, preserve required attribution, and document whether the use is source reuse, dependency use, protocol compatibility, or architectural inspiration. This document is an engineering decision, not legal advice.
