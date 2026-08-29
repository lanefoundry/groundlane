<div align="center">

# Groundlane

**The trusted web access layer for AI agents.**

[![CI](https://github.com/vincentxuu/groundlane/actions/workflows/ci.yml/badge.svg)](https://github.com/vincentxuu/groundlane/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-early_preview-orange.svg)

[Quick start](#quick-start) · [Connect](#connect-an-mcp-client) · [Tools](#tools-at-a-glance) · [Deploy](#run-groundlane) · [Docs](#documentation)

[English](README.md) · [繁體中文](README.zh-TW.md)

</div>

Groundlane is an open-source remote MCP server that gives AI agents one controlled interface for web search, retrieval, and deterministic extraction. It is model-neutral, routes replaceable providers behind stable contracts, and keeps authentication and resource limits under the operator's control.

> [!IMPORTANT]
> Groundlane is an early preview (`0.1.0`). Tool contracts and deployment behavior may change. It is not a hosted service, a CAPTCHA solver, or a universal anti-bot bypass.

## Tools at a glance

| Tool | What it does | Current execution paths |
| --- | --- | --- |
| `web_fetch` | Reads a public URL as Markdown, text, or HTML | Bounded HTTP, local readable normalization, and eligible optional Jina/browser fallbacks |
| `web_search` | Searches the public web with normalized results | Bounded auto fusion with next-batch retry, explicit single-provider, fallback, or deep routing across eleven providers |
| `web_answer` | Retrieves grounded answers from answer-capable providers | Parallel fan-out or fallback across You.com Answer and Linkup sourced answers, with provider attribution and citations |
| `web_research` | Retrieves provider-attributed research reports | Parallel fan-out or fallback across Linkup Research, You.com Research, and Parallel Responses, with citations |
| `web_content` | Fetches URL content through provider content APIs | Parallel fan-out or fallback across Linkup Fetch, You.com Contents, Exa Contents, Tavily Extract, Firecrawl Scrape, and Keenable Fetch |
| `web_map` | Discovers URLs from a public site | Parallel fan-out or fallback across Firecrawl Map and Tavily Map, with provider attribution |
| `web_crawl` | Crawls bounded pages from a public site | Parallel fan-out or fallback across Firecrawl Crawl and Tavily Crawl, with capped pages and content |
| `web_news` | Searches news-specific provider indexes | Parallel fan-out or fallback across Brave News, Serper News, and SerpApi Google News |
| `web_images` | Searches image-specific provider indexes | Parallel fan-out or fallback across Brave Images, Serper Images, and SerpApi Google Images |
| `web_extract` | Extracts named fields into structured JSON | CSS selectors for text, HTML, or attributes, with per-call output caps; no implicit LLM step |
| `provider_balance` | Checks provider account-balance APIs when available | Linkup credits, You.com keyed credits, Firecrawl remaining credits, and SerpApi searches left; unsupported providers return explicit diagnostic status |
| `provider_capabilities` | Lists provider features and Groundlane-exposed surfaces | Static capability matrix that separates vendor features from currently implemented Groundlane tools |
| `provider_quota` | Combines account balance, local tool budgets, capabilities, and routing hints | One provider-scoped diagnostic view for billing status, Groundlane `web_search` guardrails, exposed tools, keyless availability, and next checks |
| `search_budget_status` | Inspects Groundlane's local search attempt guardrails | Instance-local daily/monthly counters with limit, used, remaining, exhausted, and reset metadata; not provider billing truth |

Fetch/extract results report retrieval provenance such as `engine`, `backend`, `finalUrl`, `bytes`, and `truncated`. Automatic search defaults to batches of at most two complementary providers, canonical-URL deduplication, and RRF while retaining selected/attempted/succeeded provider provenance; if a federated batch has no successful provider, Groundlane tries the next eligible batch within the same deadline. Provider-backed tools such as `web_answer`, `web_research`, `web_content`, `web_map`, `web_crawl`, `web_news`, and `web_images` default to parallel fan-out and return each provider result separately instead of synthesizing them. Pinning a provider stays single-source. `web_fetch` and `web_extract` work without a search-provider key.

Provider vendors expose more APIs than Groundlane currently wires into MCP. See [provider inventory](docs/operations/provider-inventory.md) for the verified feature backlog and the distinction between vendor capability, implemented Groundlane tool, live smoke, account balance evidence, and Groundlane's local attempt budgets.

Use `provider_quota` as the first diagnostic view when `web_search` returns zero results: it shows provider account-balance status, Groundlane's local `web_search` budgets, implemented tools, and `searchRouting` hints together. Use `provider_balance` for provider-owned account credits only, and `search_budget_status` when you specifically need the raw local attempt counters. A balance result of `not_configured` means the runtime lacks the credential needed for that provider's balance API, not that keyless quota is exhausted.

### Research compatibility

`web_research` deliberately keeps one synchronous MCP contract even when an upstream provider is asynchronous. You.com Research and Parallel Responses return synchronously. Linkup Research creates an upstream task with `POST /v1/research`, then Groundlane polls `GET /v1/research/{id}` inside the same request deadline and returns the completed report when available.

Long Linkup research jobs can outlive the MCP request. In that case Groundlane returns a bounded timeout/cancellation error instead of blocking indefinitely; the upstream provider task may still continue outside Groundlane. Use `effort=lite`, `strategy=fallback`, and `provider=linkup` when you want the cheapest bounded Linkup path.

## Quick start

Requirements: Node.js 22+, pnpm 10, and Git. Chromium is needed only when the local browser backend is enabled.

```bash
git clone https://github.com/vincentxuu/groundlane.git
cd groundlane
pnpm install
pnpm exec playwright install chromium
cp .env.example .env
```

Set a long random `GROUNDLANE_AUTH_TOKEN` in `.env`, then start the server:

```bash
set -a
source .env
set +a
pnpm dev
```

Groundlane now exposes an authenticated Streamable HTTP MCP endpoint at `http://localhost:8080/mcp`. Search keys are optional; add them only for the providers you want to enable. Keenable can run without a key through its public endpoint, and You.com can run without a key through its free MCP Search profile; set provider keys only when you want authenticated account allowances.

### Deploy to Cloudflare

For a fresh Cloudflare deployment, authenticate Wrangler, create the OAuth KV
namespace, inspect the target's configured secret names, enter the two
required authentication secrets and any optional provider keys, then deploy:

```bash
pnpm exec wrangler login
pnpm exec wrangler whoami
pnpm exec wrangler kv namespace create OAUTH_KV
# paste the returned id into wrangler.jsonc's kv_namespaces[0].id
pnpm secrets:status
pnpm secrets:setup
pnpm run deploy
```

These secret commands affect Cloudflare only; they do not read or update the
local `.env`. Without `--env`, Wrangler uses the top-level target in
`wrangler.jsonc`; if you select a named environment, use that same `--env` for
status, setup, and deploy.

Two authentication secrets are required, and must be **different values**:

- `GROUNDLANE_AUTH_TOKEN` — the bearer token headless/CLI clients (Codex,
  Claude Code, scheduled cloud automation) send to `/mcp`.
- `OAUTH_OWNER_PASSPHRASE` — gates the `/authorize` consent screen shown to
  interactive cloud connectors (claude.ai, ChatGPT). Reusing the bearer token
  here would let a phished consent page leak the same credential every
  headless client uses, so generate it separately.

Generate each with at least 32 random characters, for example:

```bash
openssl rand -hex 32
```

Save both in a password manager. Run `pnpm secrets:setup`; at the numbered
prompt these two are listed under `authentication` (`GROUNDLANE_AUTH_TOKEN`,
then `OAUTH_OWNER_PASSPHRASE`) — select both, e.g. `1,2`, then paste each
value when prompted (input is hidden, nothing is echoed back). Search-provider
keys are optional. Use `pnpm secrets:setup -- --help` to inspect the safe
interactive flow. Setup first presents one numbered list: select multiple
secrets with an entry such as `2,4-6`, then it prompts only for those values
and sends one bulk update. To paste everything once, copy
[`cloudflare-secrets.example.env`](cloudflare-secrets.example.env) to the ignored
`.cloudflare-secrets.env`, fill the values you use, then run:

```bash
pnpm secrets:setup -- --from-file .cloudflare-secrets.env --dry-run
pnpm secrets:setup -- --from-file .cloudflare-secrets.env
```

The import accepts `.env` or JSON, rejects unknown names, and never prints
values. Delete the populated file after setup if you do not need it locally.
Then follow the [Cloudflare deployment guide](docs/deployment/cloudflare.md)
to verify health, readiness, authentication, and MCP behavior.

Pushes to `main` automatically deploy after the CI quality job succeeds. The
repository must have `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` GitHub
Actions secrets; see [Continuous deployment](docs/deployment/cloudflare.md#continuous-deployment-from-github).

Cloudflare Container deploys build a Docker image locally before upload. If `pnpm run deploy` stalls while loading Docker Hub metadata or pulling `node:22-bookworm-slim`, check the local Docker credential helper first; this is a local Docker/registry problem, not a Worker or TypeScript build result. The production smoke test remains the final deployment proof:

```bash
GROUNDLANE_MCP_URL="https://your-worker.example/mcp" pnpm smoke
```

## Connect an MCP client

Export the same token in the shell that starts your client:

```bash
export GROUNDLANE_AUTH_TOKEN="your-long-random-secret"
```

### Codex

```bash
codex mcp add groundlane \
  --url http://localhost:8080/mcp \
  --bearer-token-env-var GROUNDLANE_AUTH_TOKEN
```

### Claude Code

```bash
claude mcp add --transport http --scope user groundlane \
  http://localhost:8080/mcp \
  --header "Authorization: Bearer ${GROUNDLANE_AUTH_TOKEN}"
```

The Claude Code command expands the token into its MCP configuration. For shared or production machines, use a secret-backed header helper instead of storing a plaintext token.

These bearer-token steps also cover headless and scheduled cloud automation
(cron jobs, cloud routines, workflow runners): configure
`GROUNDLANE_AUTH_TOKEN` as a secret in that platform once, no OAuth needed.

### claude.ai / ChatGPT (OAuth)

Interactive cloud connectors expect OAuth, not a pasted API key. Add
groundlane as a custom connector using your deployed Worker's `/mcp` URL
(`https://your-worker.example/mcp`); the platform registers itself
automatically (via CIMD or DCR — see
[Cloudflare deployment](docs/deployment/cloudflare.md)) and opens a consent
screen. Enter the `OAUTH_OWNER_PASSPHRASE` you configured during deployment
to approve — this is a separate secret from `GROUNDLANE_AUTH_TOKEN`, used
only to gate that consent screen.

### Make the first call

Ask the client to call `web_fetch` with:

```json
{
  "url": "https://example.com/",
  "format": "markdown",
  "render": "never"
}
```

The structured response includes an envelope like this (abridged):

```json
{
  "ok": true,
  "data": {
    "finalUrl": "https://example.com/",
    "title": "Example Domain",
    "content": "This domain is for use in illustrative examples...",
    "engine": "http",
    "backend": "direct",
    "truncated": false
  }
}
```

Use `pnpm smoke` while the server is running to verify the MCP handshake plus `web_fetch` and `web_extract` against `example.com`.

## Why Groundlane?

- **One MCP contract:** clients do not need provider-specific tool schemas.
- **HTTP first:** ordinary reads avoid browser cost; Chromium is reserved for rendering and wait conditions.
- **Deterministic extraction:** CSS selectors produce structured output without an unrequested model inference step.
- **Bounded by default:** URL policy, DNS/redirect checks, one deadline, byte/output caps, and concurrency limits remain in the Groundlane boundary.
- **Explicit hosted fallbacks:** Jina Reader and Browserless receive a URL only when the operator enables them.

## Run Groundlane

| Mode | Best for | Entry point |
| --- | --- | --- |
| Local Node | Development and evaluation | [Quick start](#quick-start) |
| Docker | Standalone Node/Chromium container | `docker build -t groundlane .` then `docker run --rm -p 8080:8080 --env-file .env groundlane` |
| Cloudflare Worker + Container | Intended production topology | [Deploy to Cloudflare](#deploy-to-cloudflare) |

## Supported adapters

| Groundlane capability | Implemented adapters |
| --- | --- |
| Search | Linkup, Keenable, Parallel, Browserbase, Brave, SerpApi, Tavily, Exa, Firecrawl, Serper, You.com |
| Grounded answer | Linkup, You.com |
| Research report | Linkup, You.com, Parallel |
| URL content API | Linkup, You.com, Exa, Tavily, Firecrawl, Keenable |
| Site map discovery | Firecrawl, Tavily |
| Bounded site crawl | Firecrawl, Tavily |
| News search | Brave, Serper, SerpApi |
| Image search | Brave, Serper, SerpApi |
| Account balance | Linkup, You.com, Firecrawl, SerpApi |
| Quota diagnostics | Provider quota summary and local search budget status |
| Hosted Reader fallback | Jina Reader (opt-in) |
| Browser rendering | Local Playwright or Browserless (opt-in) |
| Cloudflare runtime | Worker + Container deployment today; Browser Run, AI Search, AI Gateway, Agents, and Workflows are documented future adapter surfaces |

Automatic search routing can apply conservative per-instance monthly and daily attempt budgets. These are safeguards, not provider billing truth; provider dashboards and spend limits remain authoritative. `provider_balance` reports account balances only for providers with implemented official balance APIs, currently Linkup, You.com, Firecrawl, and SerpApi. Exa, Browserbase, and Cloudflare are better modeled as usage/cost diagnostics. See [Configuration](docs/configuration.md) for credentials, routing, limits, and budget semantics, and [Provider inventory](docs/operations/provider-inventory.md) for the current production provider status, capability matrix, and balance API verification.

### Provider selection

Automatic `web_search` uses the configured `SEARCH_PROVIDER_ORDER`, capability filtering, provider health, and attempt budgets. The default order favors renewable or account-backed providers first, keeps keyless Keenable and You.com available as low-friction fallback paths, and keeps finite-trial providers opt-in when their free allowance is not renewable or not measurable through an API. Explicit `provider` calls bypass automatic selection but still require credentials, capability support, URL safety checks, and configured budgets.

For provider-backed tools other than `web_search`, `strategy=parallel` returns attributed results from every selected provider; `strategy=fallback` stops at the first successful provider to reduce spend.

### Runtime and billing boundaries

Cloudflare is Groundlane's production runtime today, and it also exposes adjacent capabilities that could become future Groundlane adapters. AI Search is a managed search service for operator-provided data with Workers, REST, and MCP access. Browser Run / Browser Rendering exposes content, markdown, screenshot, PDF, accessibility tree, links, crawl, and structured JSON browser actions through REST APIs or Workers bindings. Agents and Workflows provide durable agent sessions, scheduled work, WebSockets, recoverable steps, and tool orchestration. AI Gateway can add model observability, caching, retries, rate limiting, and fallback.

Those services are not the same thing as the public-web search providers in the provider router. Cloudflare is therefore not listed under `provider_balance`: that tool is reserved for web-data provider account balances exposed by official provider APIs, currently Linkup credits, You.com API credits, Firecrawl remaining credits, and SerpApi searches left.

Cloudflare usage must be tracked through the Cloudflare dashboard, billing exports, logs, metrics, or future Cloudflare-specific diagnostics. Container cost is based on active runtime resources such as vCPU, memory, disk, egress, Workers, Durable Objects, and logs; those units are separate from search-provider requests or credits. Groundlane local budgets do not cap Cloudflare runtime spend.

Potential Cloudflare-specific Groundlane work should stay separate from search-provider routing: a Browser Run backend for rendered `web_fetch` / `web_content`, an AI Search adapter for private/operator-owned indexes, Cloudflare diagnostics for runtime usage, and Workflows-based async tools for long research or crawl jobs.

Large generated documentation sites need source-aware parsing instead of raw page extraction. Cloudflare's docs publish Markdown pages, scoped `llms.txt` / `llms-full.txt` indexes, and OpenAPI schemas for the API reference. Groundlane should prefer those machine-readable sources for Cloudflare docs and other similar sites, then slice by product, endpoint, heading, or schema operation. Raising `maxBytes` or selecting the whole `main` element is a last resort because it can exceed output limits before the useful section is isolated. The current runtime path proactively handles likely documentation URLs for Markdown/text `web_fetch` requests by trying the same URL with `Accept: text/markdown`, trying Cloudflare-style `/index.md`, then checking same-origin scoped/root `llms.txt` manifests for a nearest Markdown page after bounded direct failures. Source Markdown cleanup removes front matter and common docs chrome before normal output truncation. OpenAPI slicing exists as pure JSON logic and is not automatically wired into runtime fetch until large schema discovery is bounded.

## How it works

```text
MCP client
    |
    v
Worker / Node HTTP edge       authentication, request identity
                              Cloudflare hosts this layer in production
    |
    v
tool registry                 web_search | web_answer | web_research | web_content | web_map | web_crawl
                              web_news | web_images | web_fetch | web_extract
                              diagnostics: provider_quota | provider_balance | search_budget_status | provider_capabilities
    |
    +-- provider router       replaceable search adapters
    +-- safe HTTP + Reader    bounded retrieval and readable content
    `-- browser backend       isolated local or hosted rendering
```

Core policies do not depend on a search provider or browser runtime. Groundlane Reader uses Mozilla Readability with a local fallback for selector-free Markdown/text; raw HTML and explicit selectors retain deterministic DOM semantics. See [Architecture](docs/architecture.md) and the reproducible [Reader benchmark](docs/research/reader-benchmark.md).

## Security and limitations

Web retrieval is SSRF-sensitive. Groundlane treats user URLs, redirects, provider-returned URLs, browser subresources, WebSockets, and DNS answers as untrusted. Keep authentication enabled, preserve the default limits, and apply an outbound network policy in production.

Groundlane does **not** guarantee CAPTCHA solving, invisible automation, or access to content the operator is not authorized to retrieve. Rendering JavaScript is not proof of anti-bot bypass. See [SECURITY.md](SECURITY.md) for the threat model and private vulnerability reporting.

## Project status

- Current source version: `0.1.0` early preview; no stable tool-contract guarantee yet.
- Implemented: ten web MCP tools, two provider diagnostic MCP tools, eleven search adapters, provider-backed answer/research/content/map/crawl/news/images paths, self-hosted Reader, optional Jina/Browserless backends, and Cloudflare Worker + Container deployment.
- Next: async research job tools, structured extraction providers, finance research, durable quota ledgers, broader compatibility fixtures, cache policy, and operational telemetry.

The detailed direction and acceptance criteria live in the [product requirements](docs/product/prd.md).

## Documentation

- [Configuration](docs/configuration.md)
- [Architecture](docs/architecture.md)
- [Cloudflare deployment](docs/deployment/cloudflare.md)
- [Open-source foundations](docs/open-source-foundations.md)
- [Reader benchmark](docs/research/reader-benchmark.md)
- [Research archive](docs/research/README.md)

## Contributing and support

Use [GitHub Issues](https://github.com/vincentxuu/groundlane/issues) for bugs and feature proposals. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) before opening a pull request. Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Groundlane is licensed under the [Apache License 2.0](LICENSE).
