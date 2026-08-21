# Groundlane

[English](README.md) | [繁體中文](README.zh-TW.md)

**The trusted web access layer for AI agents.**

Groundlane is an open-source, vendor-neutral remote MCP server for giving AI agents controlled access to the public web. It presents one stable interface for search, retrieval, and deterministic extraction, routes search to replaceable providers, and escalates difficult Markdown reads through an optional Jina Reader before using an isolated local or Browserless browser.

> [!IMPORTANT]
> Groundlane is an early preview. Its tool contracts and deployment model are still evolving; do not treat the current release as a hosted service or a universal anti-bot bypass.

## Why Groundlane?

- **Model neutral:** connect any Streamable HTTP MCP client instead of depending on a model vendor's built-in web tool.
- **Provider neutral:** route across search APIs with recurring monthly free allowances behind one normalized result contract.
- **HTTP first, browser when necessary:** keep ordinary reads fast and reserve Chromium for JavaScript, wait conditions, and supported fallback signals.
- **Deterministic extraction:** select fields with CSS selectors and receive structured JSON without an implicit LLM step.
- **Security first:** authenticate the MCP endpoint and apply URL, redirect, network, deadline, byte, output, and concurrency limits.
- **Self-controlled deployment:** run the control plane and browser workload in your own environment, including Cloudflare Workers and Containers.

## MVP tools

| Tool | Purpose | Current scope |
| --- | --- | --- |
| `web_fetch` | Retrieve a URL as Markdown, text, or HTML | Bounded HTTP, optional Jina Reader, then browser fallback |
| `web_search` | Search through a configured provider | Explicit or automatic routing across seven providers |
| `web_extract` | Extract named fields from a page | CSS selectors; text, HTML, or attribute values |

Browser automation is an internal implementation detail called **Groundlane Browser**. Groundlane does not expose persistent browser sessions in the MVP.

## Quick start

### Prerequisites

- Node.js 22 or newer
- pnpm 10
- Chromium for browser fallback
- At least one supported monthly-free search provider key if you want to use
  `web_search` (Tavily, Exa, Parallel, Browserbase, Brave, Firecrawl, or SerpApi)

### Run locally

Clone this repository, then run:

```bash
pnpm install
pnpm exec playwright install chromium
cp .env.example .env
set -a
source .env
set +a
pnpm dev
```

Set a strong `GROUNDLANE_AUTH_TOKEN` in `.env`. Add one or more supported provider keys to enable search. The local server listens on the configured `PORT` and serves:

- `POST /mcp` — authenticated Streamable HTTP MCP endpoint
- `GET /healthz` — process liveness
- `GET /readyz` — Container reachability and service configuration readiness

### Connect an MCP client

Configure a Streamable HTTP MCP client with the server URL and bearer token. Client configuration shapes differ, but the connection values are:

```text
URL: http://localhost:8080/mcp
Authorization: Bearer <GROUNDLANE_AUTH_TOKEN>
```

Never put the token in a query string or commit it to source control.

With the server running, open another shell, load the same `.env`, and verify the MCP handshake and public HTTP path:

```bash
set -a
source .env
set +a
pnpm smoke
```

Set `GROUNDLANE_SMOKE_BROWSER=1` to include the browser path.

## Configuration

Groundlane reads configuration from environment variables. See [.env.example](.env.example) for a complete local template.

| Variable | Purpose | Default/example |
| --- | --- | --- |
| `GROUNDLANE_AUTH_TOKEN` | Bearer token required by `/mcp` | Required |
| `SEARCH_PROVIDER_ORDER` | Ordered automatic-routing candidates | `tavily,exa,parallel,browserbase,brave,firecrawl,serpapi` |
| `SEARCH_MONTHLY_REQUEST_BUDGETS` | Per-instance provider attempt caps, reset each UTC month | Conservative free-plan defaults |
| `TAVILY_API_KEY` | Tavily adapter credential | Optional |
| `EXA_API_KEY` | Exa adapter credential | Optional |
| `FIRECRAWL_API_KEY` | Firecrawl Search adapter credential | Optional |
| `SERPAPI_API_KEY` | SerpApi Google Search adapter credential | Optional |
| `BROWSERBASE_API_KEY` | Browserbase Search adapter credential | Optional |
| `PARALLEL_API_KEY` | Parallel Search adapter credential | Optional |
| `BRAVE_API_KEY` | Brave Search adapter credential | Optional |
| `READER_BACKEND` | Markdown Reader fallback: `disabled` or `jina` | `disabled` by default |
| `BROWSER_BACKEND` | Browser capability: `disabled`, `local`, or `browserless` | `disabled` by default; local template uses `local` |
| `BROWSERLESS_TOKEN` | Browserless `/content` credential | Required only for `browserless` |
| `BROWSERLESS_REGION` | Browserless endpoint region: `sfo`, `lon`, or `ams` | `sfo` |
| `REQUEST_TIMEOUT_MS` | End-to-end request deadline | `30000` locally |
| `MAX_RESPONSE_BYTES` | Maximum upstream response bytes | `2000000` locally |
| `MAX_OUTPUT_CHARS` | Maximum returned text characters | `100000` locally |
| `MAX_CONCURRENCY` | Maximum active requests | `4` locally |
| `MAX_QUEUE` | Maximum queued requests | `16` locally |

Missing search credentials do not prevent `web_fetch` or `web_extract` from working. They do make the corresponding search provider unavailable.

Monthly budgets count attempted provider requests, including retryable failures, and prevent a running Groundlane instance from selecting a provider after its configured cap. They are deliberately conservative, but they are not billing truth: Containers restart, multiple instances do not share counters, and some providers charge variable credits. Keep provider-side spend limits enabled and override the budgets for your actual plans.

## Architecture

```text
MCP client
    |
    v
Cloudflare Worker / Node HTTP edge
    |  authentication, limits, request identity
    v
tool registry
    |-- web_search  -> monthly-free provider router (7 adapters)
    |-- web_fetch   -> safe HTTP -> optional Jina Reader -> browser fallback
    `-- web_extract -> fetch pipeline -> deterministic DOM extraction
```

Core policies and contracts do not depend on a provider or browser runtime. Adapters sit behind narrow interfaces. The browser backend can be Container-local Playwright or Browserless `/content`; `engine` and `backend` output fields disclose which path produced a result without changing the public MCP tools. Hosted backends receive the requested public URL, so they are opt-in rather than silent defaults.

Read [Architecture](docs/architecture.md) for component boundaries, request flow, and design decisions.

Groundlane learns from open-source projects including Crawlee, Crawl4AI, Scrapy, Playwright MCP, and Steel while keeping hosted proxy and anti-bot services behind explicit adapters. Read [Open-source foundations](docs/open-source-foundations.md) for the adoption boundaries and future crawl plan.

## Security

Web retrieval is an SSRF-sensitive capability. Groundlane treats user URLs, redirects, browser subresources, and search-provider URLs as untrusted. Deployments should keep authentication enabled, use an outbound network policy, and retain the default resource limits.

The project does **not** promise universal CAPTCHA solving, invisible automation, or access to content you are not authorized to retrieve. Operators are responsible for target-site terms, robots policies, privacy obligations, and applicable law.

See [SECURITY.md](SECURITY.md) for the security model and private vulnerability reporting process.

## Deployment

The intended production topology uses a Cloudflare Worker as the public control plane and a Cloudflare Container for the Node/Playwright browser workload. For prerequisites, secrets, deployment steps, and verification, see [Deploying on Cloudflare](docs/deployment/cloudflare.md).

## Roadmap

- [x] Define the vendor-neutral `web_fetch`, `web_search`, and deterministic `web_extract` surface
- [x] Add opt-in Jina Reader and Browserless retrieval backends with provenance
- [ ] Stabilize MCP contracts and publish compatibility fixtures
- [ ] Harden Cloudflare Worker + Container deployment and operational telemetry
- [ ] Add cache adapters and provider health/cost-aware routing
- [ ] Add opt-in batch/crawl primitives with explicit budgets
- [ ] Evaluate stateful browser sessions as a separate, lifecycle-safe capability

The roadmap is directional, not a release commitment. See the [research archive](docs/research/README.md) for the evidence behind the current scope.

## Documentation

- [Architecture](docs/architecture.md)
- [Open-source foundations](docs/open-source-foundations.md)
- [MVP product requirements](docs/product/prd.md)
- [Cloudflare deployment](docs/deployment/cloudflare.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Research archive](docs/research/README.md)

## Contributing

Issues and pull requests are welcome. Before contributing, read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Security vulnerabilities must be reported privately as described in [SECURITY.md](SECURITY.md).

## License

Groundlane is licensed under the [Apache License 2.0](LICENSE).
