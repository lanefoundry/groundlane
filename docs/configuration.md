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

## Search routing

| Variable | Purpose | Default/example |
| --- | --- | --- |
| `SEARCH_PROVIDER_ORDER` | Ordered automatic-routing candidates | `tavily,exa,parallel,browserbase,brave,firecrawl,serpapi` |
| `SEARCH_MONTHLY_REQUEST_BUDGETS` | Per-instance provider attempt caps, reset each UTC month | Conservative free-plan defaults in `.env.example` |
| `TAVILY_API_KEY` | Tavily credential | Optional |
| `EXA_API_KEY` | Exa credential | Optional |
| `PARALLEL_API_KEY` | Parallel credential | Optional |
| `BROWSERBASE_API_KEY` | Browserbase Search credential | Optional |
| `BRAVE_API_KEY` | Brave Search credential | Optional |
| `FIRECRAWL_API_KEY` | Firecrawl Search credential | Optional |
| `SERPAPI_API_KEY` | SerpApi credential | Optional |

Blank optional keys are treated as unset. Providers without credentials are unavailable and are skipped by automatic routing. Missing search credentials do not prevent `web_fetch` or `web_extract` from working.

Monthly budgets count attempted provider requests, including retryable failures. They prevent one running Groundlane instance from selecting a provider after the configured cap. They are deliberately conservative safeguards, not billing truth: restarts reset the in-memory counters, multiple instances do not share them, and some services charge variable credits. Keep provider-side spend limits enabled and set budgets for your actual plans.

## Reader and browser backends

| Variable | Purpose | Default/example |
| --- | --- | --- |
| `READER_BACKEND` | Hosted Markdown Reader fallback: `disabled` or `jina` | `disabled` |
| `BROWSER_BACKEND` | Browser capability: `disabled`, `local`, or `browserless` | `disabled` in code; local `.env.example` uses `local` |
| `BROWSERLESS_TOKEN` | Browserless `/content` credential | Required only for `browserless` |
| `BROWSERLESS_REGION` | Browserless endpoint region: `sfo`, `lon`, or `ams` | `sfo` |

The built-in Groundlane Reader is local normalization and needs no credential. Enabling Jina or Browserless sends eligible public target URLs to that hosted provider. HTML, explicit CSS selectors, wait conditions, and `render=always` do not use Jina Reader.

## Verification

With the local service running and the token exported:

```bash
pnpm smoke
```

Set `GROUNDLANE_SMOKE_BROWSER=1` to include the configured browser path. The smoke script calls only the reserved `example.com` documentation domain and does not require a search-provider key.

For Cloudflare secret setup and the Worker-to-Container environment allowlist, see the [deployment guide](deployment/cloudflare.md).
