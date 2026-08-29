# Architecture

Groundlane is a vendor-neutral web access control plane for AI agents. Its public contract is a small set of stateless MCP tools; provider APIs, network fetchers, and Chromium are replaceable adapters behind that contract.

## Goals

- Offer one authenticated Streamable HTTP MCP endpoint.
- Normalize search, fetch, and deterministic extraction across providers and runtimes.
- Prefer cheap HTTP retrieval and escalate to a browser only for explicit reasons.
- Apply the same security and resource policies across every retrieval path.
- Keep a Cloudflare Container deployment possible without coupling core logic to Cloudflare.

Groundlane is not a crawler fleet, search index, residential proxy network, research agent, or persistent browser-session service in the MVP.

Groundlane does use mature open-source crawler and browser projects as architectural references without treating their hosted services as open-source infrastructure. See [Open-source foundations](open-source-foundations.md) for the Crawlee adoption gate and the separation between crawl orchestration and managed anti-bot providers.

## Runtime topology

```text
                         public internet
                               |
              POST /mcp (bearer token or OAuth access token)
                               |
                  +------------v-------------+
                  | Cloudflare Worker / edge |
                  | legacy bearer check first,|
                  | else OAuth 2.1 (workers-  |
                  | oauth-provider); request  |
                  | id, routing               |
                  +------------+-------------+
                               |
                 Container binding or Node HTTP
                               |
                  +------------v-------------+
                  | MCP server + tool registry|
                  +---+----------+----------+----+
                      |          |          |    |
             web_search   web_fetch   web_extract provider diagnostics
                      |          |          |    |
             SearchRouter   FetchPipeline   |    |
                      |          +----------+    |
              provider ports     |               |
                      |          safe HTTP        |
  Tavily/Exa/Linkup/Parallel/Browserbase/Brave/Firecrawl/SerpApi |
                    Serper/You.com (opt-in)                    |
                                      |
                         optional Jina Reader
                                      |
                                      v
                         Groundlane Browser backend
                        disabled | local | browserless
```

The Worker is the public control plane in a Cloudflare deployment. It forwards MCP traffic to a Node service in a Cloudflare Container, which owns protocol handling and orchestration. Chromium can run there through the `local` backend, or an operator can select Browserless `/content`. Both are called **Groundlane Browser** internally; neither changes the public tool surface.

The Worker authenticates `/mcp` two ways, checked in order. Headless/CLI clients and headless/scheduled cloud automation present the legacy static bearer token, checked first with no behavior change from earlier versions. Interactive cloud connectors (claude.ai, ChatGPT) instead complete an OAuth 2.1 authorization-code flow (`@cloudflare/workers-oauth-provider`, Dynamic Client Registration and Client ID Metadata Documents), gated by a dedicated owner passphrase at `/authorize` — deliberately separate from the bearer token so a phished consent page cannot leak the credential every static-token client also uses. Both paths converge on the same container-proxy logic; only the authentication step differs.

Jina Reader and Browserless are opt-in hosted retrieval backends rather than additional public tools. Jina is eligible only for automatic Markdown fallback; HTML, selectors, `waitFor`, and `render=always` require a browser. Groundlane requests an uncached Jina read because shared snapshots can be stale. Every result reports both an execution category (`engine=http|reader|browser`) and concrete `backend` provenance (`direct`, `jina`, `local`, or `browserless`). Cloudflare Browser Run and Firecrawl Scrape remain future adapters.

The built-in **Groundlane Reader** is a deterministic normalization stage, not another network backend. For Markdown and text without an explicit selector, Mozilla Readability running on linkedom selects the primary article region; a local bounded heuristic handles null, empty-content, and parser-error fallback. Groundlane then removes common page chrome, normalizes supported URL attributes to HTTP(S), strips known active/unsafe attributes, and bounds article metadata and output. This URL cleaning is defense in depth, not a general-purpose HTML sanitizer. HTML and selector-based requests retain their existing deterministic DOM semantics. Because this stage does not retrieve the page, it does not change `engine` or `backend` provenance. The adoption evidence is recorded in the [Reader benchmark](research/reader-benchmark.md).

## Component boundaries

| Area | Responsibility | Must not own |
| --- | --- | --- |
| `src/worker/` | Public Worker entry, authentication, edge routing, Container lifecycle | Tool semantics or browser automation |
| `src/container/` | Node HTTP process, MCP transport, health/readiness, shutdown | Provider-specific policy decisions |
| `src/core/` | Contracts, URL policy, limits, normalization, routing, extraction | Environment lookups or concrete network clients |
| `src/adapters/` | HTTP, search provider, browser, and telemetry implementations | Public MCP schema changes |
| `src/tools/` | Input schemas, handler composition, public results/errors | Direct credential or process management |

Concrete adapters are wired in one composition layer. Dependencies point inward: adapters implement core ports, and tools call core use cases.

## Tool flows

### `web_fetch`

1. Validate input and create one request deadline.
2. Normalize the URL and enforce network policy.
3. Perform a bounded HTTP fetch through a DNS-safe connection path.
4. Follow only validated redirects within the original budget.
5. Normalize the document to the requested format; Markdown/text use the built-in Groundlane Reader unless an explicit selector is supplied.
6. For an eligible Markdown request, optionally try Jina Reader after a retryable HTTP failure or supported fallback signal.
7. If Reader is ineligible, unavailable, or rate-limited—or if `render=always`—call the configured Groundlane Browser with the remaining budget.
8. Return content plus final URL, status, engine, backend provenance, truncation, timing, and warnings metadata. The current compatibility field `cached` is always `false`; response caching is deferred.

A generic upstream 4xx does not automatically receive an expensive browser retry.

### `web_search`

1. Validate the query, domains, time range, strategy, provider allowlist, and bounded result count.
2. Filter configured providers by requested capabilities, health, and remaining local attempt budget.
3. An explicit provider stays single-source. Automatic searches default to `balanced`, which deterministically selects at most two complementary provider families; `deep` selects at most three and `fallback` retains sequential first-success routing.
4. Atomically consume one instance-local monthly attempt immediately before each selected provider call.
5. Run federated calls concurrently under the original shared abort signal and deadline. One successful provider is a partial success; all-provider failure returns a stable sanitized error.
6. Canonicalize public HTTP(S) result URLs, remove conservative tracking parameters, merge exact duplicates, and combine ranks with health-adjusted Reciprocal Rank Fusion. Raw provider scores remain provenance and are never added together.
7. Apply a bounded hostname-diversity policy and return selected, attempted, successful, and per-result provider attribution.

Automatic fusion is deliberately bounded rather than query-all: `balanced` makes at most two attempts and `deep` at most three. Callers that prioritize a single attempt can use `strategy=fallback` or pin `provider` explicitly.
Monthly counters reset on a UTC month boundary and are intentionally conservative. They are not durable or shared across Container instances, so provider-side quotas and spend limits remain authoritative. A durable multi-instance ledger requires a later storage/control-plane design.

### `web_answer`

1. Validate the query, provider selectors, filters, result count, and deadline.
2. Filter answer-capable providers by configured credentials and request support.
3. `strategy=parallel` fans out to all selected providers under the same abort signal and deadline. One provider success is enough for a partial-success response; all-provider failure returns `PROVIDER_UNAVAILABLE`.
4. `strategy=fallback` tries providers sequentially and returns the first success.
5. Return each provider answer separately with citations, source result metadata, selected providers, attempted providers, and successful providers. Groundlane does not synthesize or rank the answer texts with an LLM.

The first implemented answer providers are You.com Answer and Linkup sourced answers. Parallel's cited Responses API remains cataloged as a vendor feature but is not wired into `web_answer` until its endpoint and response contract are verified in this repo.

### `web_research`

1. Validate the research query, provider selectors, effort, source controls, result count, and deadline.
2. Filter research-capable providers by configured credentials and request support.
3. `strategy=parallel` fans out to selected provider research APIs under one abort signal and deadline. `strategy=fallback` returns the first successful provider report.
4. Return each provider report separately with citations, selected providers, attempted providers, and successful providers. Groundlane does not synthesize provider reports with an LLM.

Implemented research paths are Linkup Research, You.com Research, and Parallel's synchronous OpenAI-compatible Responses API. Linkup is asynchronous upstream; Groundlane wraps it as a bounded synchronous MCP call by creating the task and polling at a conservative interval until completion, failure, cancellation, or the shared request deadline.

### `web_content`

1. Validate the target URL with the same public URL policy before calling any provider.
2. Filter content-capable providers by configured credentials and request support.
3. `strategy=parallel` fans out to selected provider content APIs under one abort signal and deadline. `strategy=fallback` returns the first successful provider result.
4. Normalize each provider response to `{provider,url,finalUrl,title?,content,format,truncated,durationMs,warnings[]}`.
5. Revalidate provider-returned final URLs and locally enforce `maxContentChars`, even when the upstream provider ignores or over-returns its own limit.

Implemented content paths are Linkup Fetch, You.com Contents, Exa Contents, Tavily Extract, Firecrawl Scrape, and Keenable Fetch. Browserbase Fetch is documented as a vendor feature but is not exposed until the exact runtime endpoint and contract are added to this repo.

### `web_map`

1. Validate the root URL with the same public URL policy before calling any provider.
2. Filter map-capable providers by configured credentials and request support.
3. `strategy=parallel` fans out to selected provider map APIs under one abort signal and deadline. `strategy=fallback` returns the first successful provider result.
4. Normalize each provider response to attributed `{provider,url,title?,description?}` links and per-provider result blocks.
5. Revalidate every provider-returned URL and deduplicate the top-level link list without hiding provider attribution.

Implemented map paths are Firecrawl Map and Tavily Map. Groundlane treats map as URL discovery only; content extraction remains in `web_content` or `web_fetch`.

### `web_crawl`

1. Validate the root URL with the same public URL policy before calling any provider.
2. Filter crawl-capable providers by configured credentials and request support.
3. `strategy=parallel` fans out to selected provider crawl APIs under one abort signal and deadline. `strategy=fallback` returns the first successful provider result.
4. Normalize each provider response to bounded pages, provider job status metadata, and per-provider result blocks.
5. Revalidate every provider-returned page URL, cap page count and per-page content, and deduplicate the top-level page list without hiding provider attribution.

Implemented crawl paths are Firecrawl Crawl with bounded polling and Tavily Crawl. Groundlane treats crawl as bounded discovery/content retrieval, not an unbounded site mirror.

### `web_news`

1. Validate query, provider selection, result limits, and optional country/language controls before calling any provider.
2. Filter news-capable providers by configured credentials and request support.
3. `strategy=parallel` fans out to selected provider news APIs under one abort signal and deadline. `strategy=fallback` returns the first successful provider result.
4. Normalize each provider response to attributed `{provider,title,url,snippet,source?,publishedAt?,thumbnailUrl?}` news items.
5. Revalidate provider-returned result URLs and deduplicate the top-level result list without hiding provider attribution.

Implemented news paths are Brave News Search, Serper News, and SerpApi Google News.

### `web_images`

1. Validate query, provider selection, result limits, and optional country/language controls before calling any provider.
2. Filter image-capable providers by configured credentials and request support.
3. `strategy=parallel` fans out to selected provider image APIs under one abort signal and deadline. `strategy=fallback` returns the first successful provider result.
4. Normalize each provider response to attributed `{provider,title?,imageUrl,sourceUrl?,thumbnailUrl?,width?,height?}` image items.
5. Revalidate provider-returned image, thumbnail, and source URLs and deduplicate the top-level result list without hiding provider attribution.

Implemented image paths are Brave Image Search, Serper Images, and SerpApi Google Images.

### `web_extract`

1. Retrieve the page through the same fetch pipeline and security policy as `web_fetch`.
2. Validate field names, selectors, value modes, and result limits.
3. Extract text, HTML, or attribute values deterministically from the DOM.
4. Return structured data and an explicit `missingFields` list.

There is no hidden LLM extraction step. A future semantic extractor must be opt-in and identify its provider in output metadata.

### Provider diagnostics

`provider_capabilities` returns a static capability matrix that separates vendor
features from Groundlane-exposed tools and current filter support.
`provider_balance` calls only official provider balance APIs that Groundlane has
implemented. It currently supports You.com keyed account credits and Linkup
credits. `provider_balance(provider=all)` fans out to implemented balance
checkers in parallel under one deadline and returns explicit unsupported or
not-configured statuses for other providers. Balance diagnostics are operational
metadata; they are not used as a durable spend ledger.

## Stable public failures

Public errors use stable, non-secret-bearing codes such as:

- `INVALID_INPUT`
- `URL_BLOCKED`
- `DEADLINE_EXCEEDED`
- `OUTPUT_LIMIT`
- `PROVIDER_UNAVAILABLE`
- `UPSTREAM_ERROR`

Raw upstream bodies, stack traces, authorization headers, and credentials do not cross the public boundary.

## Security invariants

- Accept only HTTP and HTTPS destinations; reject embedded credentials and disallowed ports.
- Validate all resolved addresses and every redirect; block loopback, private, link-local, multicast, reserved, and metadata destinations.
- Prevent DNS validation/connection time-of-check-to-time-of-use gaps through pinning or an equivalent safe dispatcher.
- Apply destination policy to browser navigations, subresources, workers, and WebSockets.
- Share one abort deadline across HTTP, provider, and browser work.
- Bound redirects, inbound bytes, output size, search results, extracted values, concurrency, and queue length.
- Log metadata needed to operate the service, not bodies, secrets, authorization headers, or full queries.

An external egress firewall remains recommended because application policy is not a complete isolation boundary.

## State and scaling

The MVP tools are stateless. Protocol session identifiers, if required by an MCP transport, are not browser sessions and do not convey browsing identity. Each request is independently bounded and cancellable.

The MVP does not cache responses; `web_fetch.cached` is reserved for a future adapter and is currently always `false`. A distributed cache or provider-health store can be added behind new ports without changing tool contracts.

Stateful browser sessions are deferred because they require explicit ownership, expiry, cleanup, isolation, and billing semantics.

## Observability

Structured audit events should include request ID, tool, destination hostname, provider or engine, final status/error code, duration, bytes, truncation, and fallback reason. They should not include response content, tokens, headers, browser cookies, or full search queries by default.

Health endpoints serve different purposes:

- `/healthz` confirms that the process is alive.
- `/readyz` confirms Container reachability and required service configuration. The MVP does not make live search-provider calls during readiness checks.

The absence of every search provider should make search unready, not disable fetch and extraction.

## Design evolution

The architecture intentionally leaves ports for cache backends, new search providers, alternate browser execution, deeper source-aware documentation parsing, and future semantic extraction. Crawl queues, research synthesis, and stateful sessions require separate designs rather than expanding the three MVP handlers indefinitely.

Large generated documentation sites should not be handled by raising output limits or selecting the whole `main` element. A future source-aware parser should first discover machine-readable sources such as `llms.txt`, scoped `llms-full.txt`, Markdown endpoints, OpenAPI schemas, and sitemaps. It should then fetch only the relevant page, heading range, schema path, or operation before falling back to bounded HTML selectors. This keeps token use and output bytes predictable while preserving deterministic provenance.

The first runtime slice started as a conservative `web_fetch` fallback, and now
proactively handles likely documentation URLs. Markdown/text requests without
selectors, `waitFor`, or `render=always` try source Markdown before broad HTML
for likely docs URLs. If direct HTTP later exceeds the byte limit, Groundlane can
still consult scoped/root `llms.txt` manifests for a nearest same-origin
Markdown page. Candidate source responses must be Markdown/text; HTML returned
by a server that ignores content negotiation falls back to the normal path.

For a future bounded crawl primitive, Crawlee is the first TypeScript implementation candidate. It must remain behind Groundlane's existing URL, deadline, byte, output, concurrency, queue, and cancellation policies rather than becoming a parallel security boundary.
