# Architecture

Groundlane is a vendor-neutral web access control plane for AI agents. Its public contract is a small set of stateless MCP tools; provider APIs, network fetchers, and Chromium are replaceable adapters behind that contract.

## Goals

- Offer one authenticated Streamable HTTP MCP endpoint.
- Normalize search, fetch, and deterministic extraction across providers and runtimes.
- Prefer cheap HTTP retrieval and escalate to a browser only for explicit reasons.
- Apply the same security and resource policies across every retrieval path.
- Keep a Cloudflare Container deployment possible without coupling core logic to Cloudflare.

Groundlane is not a crawler fleet, search index, residential proxy network, research agent, or persistent browser-session service in the MVP.

## Runtime topology

```text
                         public internet
                               |
                         POST /mcp
                               |
                  +------------v-------------+
                  | Cloudflare Worker / edge |
                  | auth, request id, routing|
                  +------------+-------------+
                               |
                 Container binding or Node HTTP
                               |
                  +------------v-------------+
                  | MCP server + tool registry|
                  +---+----------+----------+-+
                      |          |          |
             web_search   web_fetch   web_extract
                      |          |          |
             SearchRouter   FetchPipeline   |
                      |          +----------+
              provider ports     |
                      |          safe HTTP
 Tavily/Exa/Parallel/Browserbase/Brave/Firecrawl/SerpApi |
                                      |
                         optional Jina Reader
                                      |
                                      v
                         Groundlane Browser backend
                        disabled | local | browserless
```

The Worker is the public control plane in a Cloudflare deployment. It forwards MCP traffic to a Node service in a Cloudflare Container, which owns protocol handling and orchestration. Chromium can run there through the `local` backend, or an operator can select Browserless `/content`. Both are called **Groundlane Browser** internally; neither changes the public tool surface.

Jina Reader and Browserless are opt-in hosted retrieval backends rather than additional public tools. Jina is eligible only for automatic Markdown fallback; HTML, selectors, `waitFor`, and `render=always` require a browser. Groundlane requests an uncached Jina read because shared snapshots can be stale. Every result reports both an execution category (`engine=http|reader|browser`) and concrete `backend` provenance (`direct`, `jina`, `local`, or `browserless`). Cloudflare Browser Run and Firecrawl Scrape remain future adapters.

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
5. Normalize the document to the requested format.
6. For an eligible Markdown request, optionally try Jina Reader after a retryable HTTP failure or supported fallback signal.
7. If Reader is ineligible, unavailable, or rate-limited—or if `render=always`—call the configured Groundlane Browser with the remaining budget.
8. Return content plus final URL, status, engine, backend provenance, truncation, timing, and warnings metadata. The current compatibility field `cached` is always `false`; response caching is deferred.

A generic upstream 4xx does not automatically receive an expensive browser retry.

### `web_search`

1. Validate the query, domains, time range, and bounded result count.
2. Filter configured providers by requested capabilities.
3. Honor an explicitly selected provider, or use configured automatic order.
4. Atomically consume one instance-local monthly attempt from the candidate's configured budget; skip exhausted candidates.
5. Fall back only on retryable failures such as timeout, rate limit, provider 5xx, or malformed response.
6. Normalize results while retaining provider attribution.

Groundlane does not silently merge rankings from multiple providers in the MVP.
Monthly counters reset on a UTC month boundary and are intentionally conservative. They are not durable or shared across Container instances, so provider-side quotas and spend limits remain authoritative. A durable multi-instance ledger requires a later storage/control-plane design.

### `web_extract`

1. Retrieve the page through the same fetch pipeline and security policy as `web_fetch`.
2. Validate field names, selectors, value modes, and result limits.
3. Extract text, HTML, or attribute values deterministically from the DOM.
4. Return structured data and an explicit `missingFields` list.

There is no hidden LLM extraction step. A future semantic extractor must be opt-in and identify its provider in output metadata.

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

The architecture intentionally leaves ports for cache backends, new search providers, alternate browser execution, and future semantic extraction. Crawl queues, research synthesis, and stateful sessions require separate designs rather than expanding the three MVP handlers indefinitely.
