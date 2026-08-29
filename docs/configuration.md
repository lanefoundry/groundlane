# Groundlane configuration

Groundlane reads runtime configuration from environment variables. Copy [`.env.example`](../.env.example) for local development and add only the provider credentials you intend to use.

## Core service

| Variable | Purpose | Default/example |
| --- | --- | --- |
| `PORT` | Node container HTTP port | `8080` |
| `GROUNDLANE_AUTH_TOKEN` | Bearer token required by `/mcp` | Required; use a long random secret |
| `REQUEST_TIMEOUT_MS` | One end-to-end request deadline | `30000` locally |
| `MAX_RESPONSE_BYTES` | Maximum upstream response bytes | `2000000` locally |
| `MAX_OUTPUT_CHARS` | Maximum returned text characters | `100000` locally |
| `MAX_CONCURRENCY` | Maximum active requests | `4` locally |
| `MAX_QUEUE` | Maximum queued requests | `16` locally |

`GET /healthz` is a public process-liveness check. On the Node service, `GET /readyz` checks required service configuration. Through the Worker, a successful proxied response also confirms that the Container answered. Neither form probes provider health. `POST /mcp` requires the bearer token.

## Worker-only configuration (OAuth)

These variables exist only on the Cloudflare Worker, not in `.env.example` or the Container — they are never forwarded by `GroundlaneContainer.envVars`. They back the OAuth 2.1 layer used by interactive cloud connectors (claude.ai, ChatGPT); headless/CLI clients and headless cloud automation are unaffected and keep using `GROUNDLANE_AUTH_TOKEN` directly. See [OAuth for interactive cloud connectors](deployment/cloudflare.md#oauth-for-interactive-cloud-connectors) for setup.

| Variable | Purpose | Default/example |
| --- | --- | --- |
| `OAUTH_KV` | Workers KV binding storing OAuth clients, grants, and tokens | Required; created with `wrangler kv namespace create OAUTH_KV` |
| `OAUTH_OWNER_PASSPHRASE` | Gates the `/authorize` consent screen | Required; use a long random secret, separate from `GROUNDLANE_AUTH_TOKEN` |

## Search routing

| Variable | Purpose | Default/example |
| --- | --- | --- |
| `SEARCH_PROVIDER_ORDER` | Ordered automatic-routing candidates | `tavily,exa,brave,you,tinyfish,keenable,browserbase,firecrawl,linkup,parallel,serpapi` |
| `SEARCH_MONTHLY_REQUEST_BUDGETS` | Per-instance provider dispatch attempt caps, reset each UTC month | Conservative free-plan defaults in `.env.example` |
| `SEARCH_DAILY_REQUEST_BUDGETS` | Per-instance provider dispatch attempt caps, reset each UTC day | `you:100` |
| `TAVILY_API_KEY` | Tavily credential | Optional |
| `EXA_API_KEY` | Exa credential | Optional |
| `PARALLEL_API_KEY` | Parallel credential | Optional |
| `BROWSERBASE_API_KEY` | Browserbase Search credential | Optional |
| `BRAVE_API_KEY` | Brave Search credential | Optional |
| `FIRECRAWL_API_KEY` | Firecrawl Search credential | Optional |
| `SERPAPI_API_KEY` | SerpApi credential | Optional |
| `SEARCHAPI_API_KEY` | SearchAPI.io credential | Optional; opt in because its free allowance is a one-time trial |
| `LINKUP_API_KEY` | Linkup Search credential | Optional; configured keys join automatic routing with a conservative cap |
| `KEENABLE_API_KEY` | Keenable credential | Optional; when omitted, Groundlane uses Keenable's keyless public endpoint |
| `TINYFISH_API_KEY` | TinyFish Search/Fetch credential | Optional; configured keys join automatic routing with a conservative cap |
| `SERPER_API_KEY` | Serper Google Search credential | Optional; opt in because its free allowance is a one-time trial |
| `YOU_API_KEY` | You.com REST Search credential | Optional; keyless mode (100/day) is used when unset |

Blank optional keys are treated as unset. Providers without credentials are unavailable and are skipped by automatic routing, except Keenable, which has keyless public search/content paths, and You.com, which has a keyless public search path. Missing search credentials do not prevent `web_fetch`, `web_extract`, `parse`, `provider_capabilities`, `provider_quota`, or `search_budget_status` from working. `web_answer` requires keyed answer-capable providers; today that means Linkup and You.com. `web_research` can use keyed Linkup Research, You.com Research, and Parallel Responses. `web_content` can use Linkup, You.com, Exa, Tavily, Firecrawl, TinyFish, and Keenable, with Keenable available keyless. `web_map` can use Firecrawl and Tavily when their keys are configured. `web_crawl` can use Firecrawl and Tavily when their keys are configured. `web_news` can use Brave, Serper, and SerpApi when their keys are configured. `web_images` can use Brave, Serper, and SerpApi when their keys are configured. `provider_balance` returns account balances only for providers with configured credentials and implemented balance checkers: Linkup, You.com, Firecrawl, and SerpApi. `search_budget_status` returns Groundlane's instance-local provider dispatch attempt counters and never calls third-party billing APIs. `provider_quota` combines those account-balance diagnostics, local provider dispatch budgets, and provider capabilities in one response.

`web_search` defaults to `strategy=balanced` when `provider=auto`: it selects at most two configured, capable, healthy, non-exhausted providers from `SEARCH_PROVIDER_ORDER`, preferring complementary retrieval families, and fuses exact canonical-URL matches with quality-weighted RRF (provider weights adjusted by health penalty). If a federated batch has no successful provider, Groundlane tries the next eligible batch within the same request deadline. Use `strategy=fallback` for sequential first-success routing, `strategy=deep` for at most three providers per batch, or an explicit `provider` for exactly one provider. An optional `providers` array narrows and orders the candidate pool but never bypasses credentials, capabilities, health, or budgets.

Each selected federated provider consumes a separate attempt. A partial success identifies selected, attempted, and successful providers and includes sanitized warnings for failures. Fused results expose `fusionScore` plus per-provider `sources`; raw provider `score` values are retained only as provenance because their scales are not comparable.

`web_answer` defaults to `strategy=parallel`: it selects configured answer providers, calls them concurrently, and returns each provider's grounded answer and citations separately. Use `strategy=fallback` to spend at most one successful answer call, or pin `provider=linkup` / `provider=you`. You.com Answer requires `YOU_API_KEY`; You.com's keyless MCP profile is search-only in Groundlane. Linkup Answer uses the same `LINKUP_API_KEY` as search and calls `/v1/search` with `outputType=sourcedAnswer`.

`web_research` defaults to `strategy=parallel`: it selects configured research providers and returns each provider's report and citations separately. Use `strategy=fallback` to spend at most one successful research call, or pin `provider=linkup` / `provider=you` / `provider=parallel`. Implemented provider paths are Linkup `/v1/research`, You.com `/v1/research`, and Parallel `/v1/responses` with model `parallel`. Linkup is asynchronous upstream; Groundlane creates the task and polls within the MCP request deadline, so long Linkup runs can still time out while the upstream task continues.

`web_content` defaults to `strategy=parallel`: it selects configured content providers and returns each provider's extracted content separately. Use `strategy=fallback` to spend at most one successful content call, or pin `provider`. Implemented provider paths are Linkup `/v1/fetch`, You.com `/v1/contents`, Exa `/contents`, Tavily `/extract`, Firecrawl `/v2/scrape`, TinyFish Fetch, and Keenable `/v1/fetch` or `/v1/fetch/public`. Provider-returned final URLs are validated again before they leave Groundlane.

`web_map` defaults to `strategy=parallel`: it selects configured map providers and returns attributed discovered URLs from each provider plus a deduplicated top-level link list. Use `strategy=fallback` to spend at most one successful map call, or pin `provider=firecrawl` / `provider=tavily`. Implemented provider paths are Firecrawl `/v2/map` and Tavily `/map`. Groundlane validates the root URL before calling providers and validates every provider-returned URL before returning it.

`web_crawl` defaults to `strategy=parallel`: it selects configured crawl providers and returns bounded, provider-attributed pages plus job status metadata. Use `strategy=fallback` to spend at most one successful crawl call, or pin `provider=firecrawl` / `provider=tavily`. Implemented provider paths are Firecrawl `/v2/crawl` with bounded status polling and Tavily `/crawl`. Groundlane validates the root URL before calling providers and validates every provider-returned page URL before returning it.

`web_news` defaults to `strategy=parallel`: it selects configured news providers and returns attributed news results from each provider plus a deduplicated top-level result list. Use `strategy=fallback` to spend at most one successful news call, or pin `provider=brave` / `provider=serper` / `provider=serpapi`. Implemented provider paths are Brave `/res/v1/news/search`, Serper `/news`, and SerpApi `engine=google_news`. Provider-returned result URLs are validated before they leave Groundlane.

`web_images` defaults to `strategy=parallel`: it selects configured image providers and returns attributed image results from each provider plus a deduplicated top-level result list. Use `strategy=fallback` to spend at most one successful image call, or pin `provider=brave` / `provider=serper` / `provider=serpapi`. Implemented provider paths are Brave `/res/v1/images/search`, Serper `/images`, and SerpApi `engine=google_images`. Provider-returned image, thumbnail, and source URLs are validated before they leave Groundlane.

`parse` is a local deterministic parser, not a provider-backed tool. It accepts either one public `url` or caller-provided `html` with `baseUrl`, then returns one requested purpose: `document`, `metadata`, `links`, `media`, `tables`, or `all`. URL inputs first use the same bounded fetch pipeline as `web_fetch`; raw HTML inputs do not access the network. The first implementation is Groundlane-owned and uses existing HTML parsing/readability libraries behind a stable parser contract. Open-source projects such as Trafilatura, Crawl4AI, MarkItDown, anydoc, and Docling are adapter references for future parser engines, not required runtime dependencies today.

The public provider enum includes `linkup`, `keenable`, `tinyfish`, `searchapi`, `serper`, and `you`. Linkup joins the default order when its key is configured, with a conservative 100-attempt cap. Its current pricing page advertises 4,000 free queries, while account balance is exposed through Linkup's `/credits/balance` endpoint; `100` is a Groundlane safety limit, not provider billing truth or a conversion from credits. Keenable joins automatic routing even without a key by calling `/v1/search/public` with `X-Keenable-Title`; configure `KEENABLE_API_KEY` to use its authenticated monthly allowance instead. TinyFish joins automatic routing when `TINYFISH_API_KEY` is configured; official docs describe Search as 30 requests/minute and Fetch as 150 URLs/minute, free at any wallet balance. You.com joins automatic routing even without a key through `https://api.you.com/mcp?profile=free`, which the official docs limit to 100 Search queries per day; configure `YOU_API_KEY` to use account API credits and the REST Search endpoint instead. SearchAPI.io and Serper free allowances remain finite trials, so they stay outside the automatic order and default to zero attempt caps. To use them, add them explicitly and choose caps from the provider billing screens, for example:

```text
SEARCH_PROVIDER_ORDER=linkup,tavily,exa,searchapi,serper
SEARCH_MONTHLY_REQUEST_BUDGETS=linkup:100,tavily:1000,exa:1000,searchapi:25,serper:25
```

These sample values are per-instance attempt caps, not conversions from dollars or credits and not provider billing truth. Serper currently supports only unfiltered queries in Groundlane. SearchAPI.io maps included and excluded domains to Google `site:` query operators and does not support date ranges in Groundlane. TinyFish supports include/exclude domains and maps Groundlane time ranges to its `recency_minutes` parameter. Linkup supports domain/date filters; Brave maps included and excluded domains to documented `site:` search operators; Keenable supports at most one included domain through its `site` parameter and does not support excluded domains; You.com supports either include or exclude domain lists in one request, not both together. You.com's keyless free MCP profile is separate from `YOU_API_KEY` account credits; the adapter reports a warning when it uses the free profile.

Monthly and daily budgets count attempted provider requests across `web_search`, `web_answer`, `web_research`, `web_content`, `web_map`, `web_crawl`, `web_news`, and `web_images`, including retryable failures. They prevent one running Groundlane instance from dispatching a provider-backed request after the configured cap. They are deliberately conservative safeguards, not billing truth: restarts reset the in-memory counters, multiple instances do not share them, and some services charge variable credits. Keep provider-side spend limits enabled and set budgets for your actual plans.

Use `provider_quota` first when a provider-backed tool exhausts local attempts or a search returns zero results and you need a provider-scoped diagnostic view. It combines provider account balance status, Groundlane local provider-dispatch budgets, currently exposed tools, and `searchRouting` hints for credential/keyless/budget checks. Use `search_budget_status` when you specifically need the raw local daily or monthly attempt counters. Use `provider_balance` only for provider-owned account balances. A `provider_balance` result of `not_configured` means the runtime lacks the credential needed for that provider's balance API; it does not prove that keyless quota or provider-side credits are exhausted.

Providers that return errors (429, 5xx) accumulate a dynamic penalty that temporarily deprioritizes them; five consecutive failures trip a circuit breaker that skips the provider for 60 seconds. Both mechanisms self-recover when the provider starts responding again.

## Reader and browser backends

| Variable | Purpose | Default/example |
| --- | --- | --- |
| `READER_BACKEND` | Hosted Markdown Reader fallback: `disabled` or `jina` | `jina` in deployment config; `disabled` in code defaults |
| `BROWSER_BACKEND` | Browser capability: `disabled`, `local`, or `browserless` | `disabled` in code; local `.env.example` uses `local` |
| `BROWSERLESS_TOKEN` | Browserless `/content` credential | Required only for `browserless` |
| `BROWSERLESS_REGION` | Browserless endpoint region: `sfo`, `lon`, or `ams` | `sfo` |
| `JINA_READER_RPM` | Proactive Jina Reader rate limit (requests per minute) | `20` |
| `BROWSERLESS_MONTHLY_UNITS` | Proactive Browserless monthly unit cap | `1000` |

The built-in Groundlane Reader is local normalization and needs no credential. Enabling Jina or Browserless sends eligible public target URLs to that hosted provider. HTML, explicit CSS selectors, wait conditions, and `render=always` do not use Jina Reader.

The fetch pipeline proactively tracks Jina Reader RPM and Browserless monthly units in-memory. When a backend's budget is exhausted, the pipeline skips it and falls back to the next option instead of wasting latency on a 429 response.

## Verification

With the local service running and the token exported:

```bash
pnpm smoke
```

Set `GROUNDLANE_SMOKE_BROWSER=1` to include the configured browser path. The smoke script calls only the reserved `example.com` documentation domain and does not require a search-provider key.

For Cloudflare secret setup and the Worker-to-Container environment allowlist, see the [deployment guide](deployment/cloudflare.md).
