<div align="center">

# Groundlane

**The trusted web access layer for AI agents.**

[![CI](https://github.com/vincentxuu/groundlane/actions/workflows/ci.yml/badge.svg)](https://github.com/vincentxuu/groundlane/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-early_preview-orange.svg)

[Quick start](#quick-start) · [Connect](#connect-an-mcp-client) · [Tools](#tools-at-a-glance) · [Deploy](#run-groundlane) · [Docs](#documentation)

[English](README.md) · [繁體中文](README.zh-TW.md)

</div>

Groundlane is an open-source remote MCP server and trusted content access layer for AI agents. Today it provides one controlled interface for Web search, retrieval, deterministic extraction, URL/raw-HTML parsing, and a first bounded synchronous `document_parse` slice. The document tool accepts inline bytes or policy-checked public URLs and returns one canonical envelope with Markdown, structured, text, or all projection. Self-hosted Node deployments can opt into a durable SQLite processing cache; R2 artifacts, Cloudflare-backed cache, async document execution, OCR, and model-assisted parsing remain roadmap work. The operator-owned corpus control plane keeps portable corpus identity, source enrollment, access, freshness, deletion, and citation contracts separate from replaceable indexing and ranking backends.

> [!IMPORTANT]
> Groundlane is an early preview (`0.1.0`). Tool contracts and deployment behavior may change. The target OSS V1 Stable Release is an operator-hosted open-source product; Managed Groundlane Cloud is a later roadmap item, not an available service. Groundlane is not a CAPTCHA solver or a universal anti-bot bypass.

OSS V1 Stable is planned as a Web + document release rather than a Web-only release. The current `document_parse` implementation has deterministic local profiles for text-based PDF; DOCX, XLSX, and PPTX; CSV, TXT, Markdown, JSON, XML, and HTML; and bounded ODF, RTF, EPUB, and EML. These profiles still require the remaining security corpus and live client/release gates before V1 can be declared stable. OCR, legacy Office conversion, complex layout/table/formula/figure recovery, scholarly extraction, and audio transcription remain experimental roadmap candidates. The existing `parse` tool remains the backward-compatible URL/raw-HTML parser.

The document roadmap uses configurable, bounded retention rather than silent permanent storage. Working defaults are a 15-minute upload intent, a one-hour staging cleanup window, a 24-hour transient artifact, and a 24-hour ownership-scoped processing cache. Callers may adjust upload, artifact, and cache expiry within operator-advertised bounds; out-of-range requests are rejected instead of silently clamped. The staging cleanup window is operator-controlled. Operators may change defaults/maxima or disable caching through an observable document policy. Explicit corpus enrollment uses its own retention policy and defaults to retention until removal; expiry extension is always explicit.

`document_parse` returns the versioned, provider-neutral canonical document envelope and a deterministic projection. Markdown is the default projection; text, structured, and all-output modes are explicit options and declare lossiness, omissions, and canonical references. The current runtime rejects oversized output because durable result artifacts are not wired yet. Its artifact source schema is reserved, but returns `PROVIDER_UNAVAILABLE` until an operator configures a verified artifact reader. The existing URL/raw-HTML `parse` schema remains compatible.

Document execution keeps an explicit dual-track contract. The current deterministic slice is synchronous and bounded by one end-to-end deadline; it never silently becomes an async job. Set `DOCUMENT_CACHE_STATE_PATH` on the self-hosted Node service to enable the ownership-scoped SQLite processing cache; `document_parse` then supports `use`, `refresh`, and `bypass`, including restart-safe hits and source-specific rebinding. The repository also includes bounded D1 metadata, durable job/artifact/corpus repositories, a side-effect receipt journal, and an immutable R2 binding adapter with deterministic tests. The Cloudflare cache, upload/artifact, durable corpus, and async-job paths are not mounted in production.

## Tools at a glance

| Tool | What it does | Current execution paths |
| --- | --- | --- |
| `web_fetch` | Reads a public URL as Markdown, text, or HTML | Bounded HTTP, local readable normalization, and eligible optional Jina/browser fallbacks |
| `web_search` | Searches the public web with normalized results | Bounded auto fusion with next-batch retry, explicit single-provider, fallback, or deep routing across thirteen providers |
| `web_answer` | Retrieves grounded answers from answer-capable providers | Parallel fan-out or fallback across You.com Answer and Linkup sourced answers, with provider attribution and citations |
| `web_research` | Retrieves provider-attributed research reports | Parallel fan-out or fallback across Linkup Research, You.com Research, and Parallel Responses, with citations |
| `web_content` | Fetches URL content through provider content APIs | Parallel fan-out or fallback across Linkup Fetch, You.com Contents, Exa Contents, Tavily Extract, Firecrawl Scrape, TinyFish Fetch, and Keenable Fetch |
| `web_map` | Discovers URLs from a public site | Parallel fan-out or fallback across Firecrawl Map and Tavily Map, with provider attribution |
| `web_crawl` | Crawls bounded pages from a public site | Parallel fan-out or fallback across Firecrawl Crawl and Tavily Crawl, with capped pages and content |
| `web_news` | Searches news-specific provider indexes | Parallel fan-out or fallback across Brave News, Serper News, and SerpApi Google News |
| `web_images` | Searches image-specific provider indexes | Parallel fan-out or fallback across Brave Images, Serper Images, and SerpApi Google Images |
| `web_extract` | Extracts named fields into structured JSON | Deterministic selector and bounded pattern engines with per-call output caps; no implicit LLM step |
| `parse` | Parses a URL or raw HTML into reusable structures | Local document, metadata, link, media, and table parsers; URL inputs use the bounded fetch pipeline |
| `document_parse` | Parses a bounded document into a canonical envelope and deterministic projection | Inline base64 or policy-checked public URL; optional self-hosted SQLite cache; artifact input is reserved but unavailable until a verified artifact backend is wired |
| `provider_balance` | Checks provider account-balance APIs when available | Linkup credits, You.com keyed credits, Firecrawl remaining credits, and SerpApi searches left; unsupported providers return explicit diagnostic status |
| `provider_capabilities` | Lists provider features and Groundlane-exposed surfaces | Static capability matrix that separates vendor features from currently implemented Groundlane tools |
| `provider_quota` | Combines account balance, local tool budgets, capabilities, and routing hints | One provider-scoped diagnostic view for billing status, Groundlane provider-dispatch guardrails, exposed tools, keyless availability, and next checks |
| `search_budget_status` | Inspects Groundlane's local provider attempt guardrails | Instance-local daily/monthly counters with limit, used, remaining, exhausted, and reset metadata; not provider billing truth |
| `error_log` | Operator-only: queries the Groundlane error log | Cloudflare Analytics Engine query filtered by tool, code, hintCode, or time range; returns up to `limit` most recent matching events newest first |

Fetch/extract/parse results report retrieval provenance such as `engine`, `backend`, `finalUrl`, `bytes`, and `truncated` when they fetch a URL. Automatic search defaults to batches of at most two complementary providers, canonical-URL deduplication, and RRF while retaining selected/attempted/succeeded provider provenance; if a federated batch has no successful provider, Groundlane tries the next eligible batch within the same deadline. Non-explicit `web_search` fallback treats a single provider rejection, timeout, quota error, 5xx, or malformed response as a warning and continues to the next eligible provider; an explicit `provider` preserves that provider's error instead of silently switching sources. Provider-backed tools such as `web_answer`, `web_research`, `web_content`, `web_map`, `web_crawl`, `web_news`, and `web_images` default to parallel fan-out and return each provider result separately instead of synthesizing them. Pinning a provider stays single-source. `web_fetch`, `web_extract`, and URL-backed `parse` work without a search-provider key.

Provider vendors expose more APIs than Groundlane currently wires into MCP. See [provider inventory](docs/operations/provider-inventory.md) for the verified feature backlog and the distinction between vendor capability, implemented Groundlane tool, live smoke, account balance evidence, and Groundlane's local attempt budgets.

Use `provider_quota` as the first diagnostic view when a provider-backed tool exhausts local attempts or `web_search` returns zero results: it shows provider account-balance status, Groundlane's local provider-dispatch budgets, implemented tools, and `searchRouting` hints together. Use `provider_balance` for provider-owned account credits only, and `search_budget_status` when you specifically need the raw local attempt counters. A balance result of `not_configured` means the runtime lacks the credential needed for that provider's balance API, not that keyless quota is exhausted.

### Research compatibility

`web_research` deliberately keeps one synchronous MCP contract even when an upstream provider is asynchronous. You.com Research and Parallel Responses return synchronously. Linkup Research creates an upstream task with `POST /v1/research`, then Groundlane polls `GET /v1/research/{id}` inside the same request deadline and returns the completed report when available.

Long Linkup research jobs can outlive the MCP request. In that case Groundlane returns a bounded timeout/cancellation error instead of blocking indefinitely; the upstream provider task may still continue outside Groundlane. Use `effort=lite`, `strategy=fallback`, and `provider=linkup` when you want the cheapest bounded Linkup path.

## Quick start

Requirements: Node.js 22.13+, pnpm 10, and Git. Chromium is needed only when the local browser backend is enabled.

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

The basic static-token deployment needs two caller-facing secrets with **different values**. The reference deployment also uses a separate internal signing secret; managed-credential administration uses a fourth isolated secret:

- `GROUNDLANE_AUTH_TOKEN` — the bearer token headless/CLI clients (Codex,
  Claude Code, scheduled cloud automation) send to `/mcp`.
- `OAUTH_OWNER_PASSPHRASE` — gates the `/authorize` consent screen shown to
  interactive cloud connectors (claude.ai, ChatGPT). Reusing the bearer token
  here would let a phished consent page leak the same credential every
  headless client uses, so generate it separately.
- `GROUNDLANE_INTERNAL_SIGNING_SECRET` — signs the short-lived principal context sent from the Worker to the Container. The Container does not accept the raw caller bearer in this mode.
- `GROUNDLANE_ADMIN_TOKEN` — required only for managed-credential administration; it cannot call `/mcp`.

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
Actions secrets, plus `GROUNDLANE_AUTH_TOKEN` for post-deploy smoke; see
[Continuous deployment](docs/deployment/cloudflare.md#continuous-deployment-from-github).

Cloudflare Container deploys build a Docker image locally before upload. If `pnpm run deploy` stalls while loading Docker Hub metadata or pulling `node:22-bookworm-slim`, check the local Docker credential helper first; this is a local Docker/registry problem, not a Worker or TypeScript build result. The production smoke test remains the final deployment proof:

```bash
GROUNDLANE_MCP_URL="https://your-worker.example/mcp" pnpm smoke
```

CI runs `pnpm run wait:container` and `pnpm run smoke:retry` after deploy, so a
successful run means the Cloudflare Container application has left provisioning
and the deployed MCP server responds with the expected tool contracts. At
runtime, the Worker also starts the named Container instance before
authenticated `/readyz` and `/mcp` requests when Cloudflare reports it as not
running.

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
(`https://your-worker.example/mcp`). Modern clients can register through CIMD
without a separate pre-registration step; the DCR compatibility endpoint
(`/register`) is bearer-protected to avoid unauthenticated OAuth state growth.
See [Cloudflare deployment](docs/deployment/cloudflare.md) for the exact flow.
The connector opens a consent screen after registration. Enter the
`OAUTH_OWNER_PASSPHRASE` you configured during deployment to approve — this is
a separate secret from `GROUNDLANE_AUTH_TOKEN`, used only to gate that consent
screen.

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
- **Explicit hosted fallbacks:** Jina Reader and Browserless receive a preflight-validated public final URL only when the operator enables them.

## Run Groundlane

| Mode | Best for | Entry point |
| --- | --- | --- |
| Local Node | Development and evaluation | [Quick start](#quick-start) |
| Docker | Standalone Node/Chromium container | `docker build -t groundlane .` then `docker run --rm -p 8080:8080 --env-file .env groundlane` |
| Cloudflare Worker + Container | Intended production topology | [Deploy to Cloudflare](#deploy-to-cloudflare) |

## Supported adapters

| Groundlane capability | Implemented adapters |
| --- | --- |
| Search | Linkup, Keenable, TinyFish, Parallel, Browserbase, Brave, SerpApi, SearchAPI.io, Tavily, Exa, Firecrawl, Serper, You.com |
| Grounded answer | Linkup, You.com |
| Research report | Linkup, You.com, Parallel |
| URL content API | Linkup, You.com, Exa, Tavily, Firecrawl, TinyFish, Keenable |
| Site map discovery | Firecrawl, Tavily |
| Bounded site crawl | Firecrawl, Tavily |
| News search | Brave, Serper, SerpApi |
| Image search | Brave, Serper, SerpApi |
| Account balance | Linkup, You.com, Firecrawl, SerpApi |
| Quota diagnostics | Provider quota summary and local provider budget status |
| Hosted Reader fallback | Jina Reader (opt-in) |
| Browser rendering | Local Playwright or Browserless (opt-in) |
| Cloudflare runtime | Worker + Container deployment today; Browser Run, AI Search, AI Gateway, Agents, and Workflows are documented future adapter surfaces |

### Provider capabilities, pricing, and free allowances

Verified against public official pricing and billing pages on **2026-08-30**. Prices below are public USD list prices before applicable tax; enterprise contracts and logged-in account offers may differ. “Groundlane tools” lists implemented runtime paths, not every product the vendor sells. Free monthly/daily allowances, balance top-ups, ongoing rate-limited access, and one-time signup credits are deliberately kept distinct. See the [detailed free search and scraping comparison](https://quidproquo.cc/posts/ai/2026-08-21-free-search-scraping-tools-en/) for the accounting method and broader browser/scraping market.

| Provider | Groundlane tools | Public pricing relevant to those tools | Free allowance and important conditions |
| --- | --- | --- | --- |
| [Tavily](https://docs.tavily.com/documentation/api-credits) | Search, Content/Extract, Map, Crawl | PAYG `$0.008/credit`; basic/advanced Search costs 1/2 credits; Extract, Map, and Crawl use page-based credit formulas | 1,000 credits every month, resets on the first day of the month; no card required |
| [Exa](https://exa.ai/docs/reference/pricing) | Search, Content | Search starts at `$7/1k` requests; Contents is `$1/1k` pages per requested content type; deeper search modes cost more | New account receives `$20` once, then `$10` credits each month; no payment method required; exact reset anchor/rollover is not public |
| [Parallel](https://parallel.ai/pricing) | Search, Research | Search is `$1–$5/1k` requests with 10 results; Responses research is `$10–$250/1k` depending on processor | Eligible organization receives `$5` monthly; card required, one organization per card, unused credit expires at month end; signup/startup promotions have separate eligibility |
| [Browserbase](https://docs.browserbase.com/account/billing/plans.md) | Search only | Developer is `$20/month`; paid Search overage is `$7/1k` calls. Browser sessions, Fetch, Extract, and Agents are vendor features not exposed by Groundlane | Free plan includes 1,000 Search calls and 1 browser hour monthly, 3 concurrent sessions; no card required; Free Search has no overage |
| [Brave](https://api-dashboard.search.brave.com/documentation/pricing) | Search, News, Images | Search is `$5/1k` requests. Brave Answers has a different query-plus-token price and is not a Groundlane tool | Each selected product plan receives `$5` monthly credit; card required for anti-fraud verification; official free-credit terms also require attribution |
| [Firecrawl](https://docs.firecrawl.dev/billing) | Search, Content/Scrape, Map, Crawl | Scrape/Crawl costs 1 credit/page, Map 1 credit/call, Search 2 credits/10 results; paid self-serve plans can buy plan-dependent `$5` reload batches | 1,000 credits monthly, no card; normally no rollover. Auto-reload is configurable and can be disabled. Public pages currently disagree on one Standard plan headline, so verify checkout before purchase |
| [SerpApi](https://serpapi.com/pricing) | Search, News, Images | Starter `$25/month` for 1,000 successful searches; Developer `$75` for 5,000. Cached, errored, and failed searches do not count | 250 successful searches per billing cycle; resets at renewal. Current public page does not state whether a card is required |
| [SearchAPI.io](https://www.searchapi.io/pricing) | Search | Developer `$40/month` for 10,000 successful searches (`$4/1k`); larger plans reduce the unit price. Only HTTP 200 searches are billed | 100 signup requests, no card; this is a finite trial, not a documented monthly allowance; Groundlane keeps it opt-in by default |
| [Linkup](https://docs.linkup.so/pages/documentation/platform/pricing) | Search, Answer, Research, Content/Fetch | Standard Search `$0.005`, sourced answer `$0.006`, deep Search `$0.05–$0.055`; Fetch `$0.001–$0.01`; Research `$0.25–$2.50` per call | Professional-email signup receives `$20`; eligible accounts are topped **back to** `$20` monthly, not given another fixed `$20`. Eligibility and top-up date are not fully public |
| [Keenable](https://keenable.ai/pricing) | Search, Content/Fetch | Public headline is `$4/1k` requests, or `$1/1k` at 100 RPS+; actual SKU usage is reported per response and can vary | Verified organization receives 100,000 requests monthly. Keyless public Search/Fetch does not use that pool and is shared per IP: 1,000/hour and 10/second |
| [Serper](https://serper.dev/#pricing) | Search, News, Images | Prepaid packs start at `$50` for 50,000 queries (`$1/1k`) and decrease to `$0.30/1k`; purchased credits expire after six months | 2,500 signup queries, no card; no documented monthly reset; Groundlane keeps it opt-in by default |
| [You.com](https://you.com/docs/administration/billing) | Search, Answer, Research, Content | Search and Answer are `$5/1k` calls; Contents `$1/1k` pages; Research starts at `$12/1k` and rises by effort tier | Keyless Search: 100 queries/day. Keyed new account: `$100` one-time starter credit, no card. These are separate pools; auto top-up is opt-in and currently has no monthly spending cap |
| [TinyFish](https://www.tinyfish.ai/pricing) | Search, Content/Fetch | Search and Fetch are `$0`; vendor Agent is `$0.016/step` and Browser `$0.002/minute`, but Groundlane does not expose those paid surfaces | Search 30 requests/minute and Fetch 150 URLs/minute remain free at `$0` Wallet balance; API key still required. New-account `$8` Wallet is one-time and applies to paid surfaces |

Provider-backed routing can apply conservative per-instance monthly and daily attempt budgets. These are safeguards, not provider billing truth; provider dashboards and spend limits remain authoritative. `provider_balance` reports account balances only for providers with implemented official balance APIs, currently Linkup, You.com, Firecrawl, and SerpApi. Exa, Browserbase, and Cloudflare are better modeled as usage/cost diagnostics. See [Configuration](docs/configuration.md) for credentials, routing, limits, and budget semantics, and [Provider inventory](docs/operations/provider-inventory.md) for the current production provider status, capability matrix, and balance API verification.

### Provider selection

Automatic `web_search` uses the configured `SEARCH_PROVIDER_ORDER`, capability filtering, provider health, and attempt budgets. The default order favors renewable or account-backed providers first, keeps keyless Keenable and You.com available as low-friction fallback paths, and keeps finite-trial providers opt-in when their free allowance is not renewable or not measurable through an API. Explicit `provider` calls bypass automatic selection but still require credentials, capability support, URL safety checks, and configured budgets.

For provider-backed tools other than `web_search`, `strategy=parallel` returns attributed results from every selected provider; `strategy=fallback` stops at the first successful provider to reduce spend.

### Runtime and billing boundaries

Cloudflare is Groundlane's production runtime today, and it also exposes adjacent capabilities that could become future Groundlane adapters. AI Search is a managed search service for operator-provided data with Workers, REST, and MCP access. Browser Run / Browser Rendering exposes content, markdown, screenshot, PDF, accessibility tree, links, crawl, and structured JSON browser actions through REST APIs or Workers bindings. Agents and Workflows provide durable agent sessions, scheduled work, WebSockets, recoverable steps, and tool orchestration. AI Gateway can add model observability, caching, retries, rate limiting, and fallback.

Those services are not the same thing as the public-web search providers in the provider router. Cloudflare is therefore not listed under `provider_balance`: that tool is reserved for web-data provider account balances exposed by official provider APIs, currently Linkup credits, You.com API credits, Firecrawl remaining credits, and SerpApi searches left.

Cloudflare usage must be tracked through the Cloudflare dashboard, billing exports, logs, metrics, or future Cloudflare-specific diagnostics. Container cost is based on active runtime resources such as vCPU, memory, disk, egress, Workers, Durable Objects, and logs; those units are separate from search-provider requests or credits. Groundlane local budgets do not cap Cloudflare runtime spend.

Potential Cloudflare-specific Groundlane work should stay separate from search-provider routing: a Browser Run backend for rendered `web_fetch` / `web_content`, an AI Search adapter for private/operator-owned indexes, Cloudflare diagnostics for runtime usage, and Workflows-based async tools for long research or crawl jobs.

Large generated documentation sites need source-aware parsing instead of raw page extraction. Cloudflare's docs publish Markdown pages, scoped `llms.txt` / `llms-full.txt` indexes, and OpenAPI schemas for the API reference. Groundlane should prefer those machine-readable sources for Cloudflare docs and other similar sites, then slice by product, endpoint, heading, or schema operation. Raising `maxBytes` or selecting the whole `main` element is a last resort because it can exceed output limits before the useful section is isolated. The current runtime path proactively handles likely documentation URLs for Markdown/text `web_fetch` requests by trying the same URL with `Accept: text/markdown`, trying Cloudflare-style `/index.md`, then checking same-origin scoped/root `llms.txt` manifests for a nearest Markdown page after bounded direct failures. Generic machine API paths such as `/api/v1/...` are not treated as documentation solely because they contain an `api` segment, and source discovery never suppresses request deadlines or cancellation. Source Markdown cleanup removes front matter and common docs chrome before normal output truncation. OpenAPI slicing exists as pure JSON logic and is not automatically wired into runtime fetch until large schema discovery is bounded.

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
                              web_news | web_images | web_fetch | web_extract | parse
                              diagnostics: provider_quota | provider_balance | search_budget_status | provider_capabilities | error_log
    |
    +-- provider router       replaceable search adapters
    +-- safe HTTP + Reader    bounded retrieval and readable content
    `-- browser backend       isolated local or hosted rendering
```

Core policies do not depend on a search provider or browser runtime. Groundlane Reader uses Mozilla Readability with a local fallback for selector-free Markdown/text; raw HTML and explicit selectors retain deterministic DOM semantics. See [Architecture](docs/architecture.md) and the reproducible [Reader benchmark](docs/research/reader-benchmark.md).

## Security and limitations

Web retrieval is SSRF-sensitive. Groundlane treats user URLs, redirects, provider-returned URLs, browser subresources, WebSockets, and DNS answers as untrusted. Keep authentication enabled, preserve the default limits, and apply an outbound network policy in production.

Groundlane does **not** guarantee CAPTCHA solving, invisible automation, or access to content the operator is not authorized to retrieve. Rendering JavaScript is not proof of anti-bot bypass. The local browser gives a detected access challenge at most five seconds to clear; if the original request deadline has not expired first, a persistent challenge returns retryable `UPSTREAM_ERROR` at `browser-challenge`. `web_fetch` does not automatically spend provider credits by switching to `web_content`; callers must opt into provider-backed retrieval explicitly. See [SECURITY.md](SECURITY.md) for the threat model and private vulnerability reporting.

## Project status

- Current source version: `0.1.0` early preview; no stable tool-contract guarantee yet.
- Implemented: the Web/search/extraction/parser/provider/corpus tools listed above; synchronous deterministic `document_parse` with canonical output and an optional restart-safe self-hosted SQLite processing cache; Cloudflare Worker + Container deployment; D1 managed-token authentication; and signed Worker-to-Container principal context. Durable D1/R2 lifecycle repositories are covered by deterministic tests, but Cloudflare cache composition, R2 upload/artifact processing, durable async/corpus MCP lifecycles, and live document client/production verification remain pending.
- Next: wire the new multi-credential principal contract, managed-token registry runtime (fake-D1 port with deterministic tests; live D1 binding and controlled smoke pending), and admin-only credential API into deployment (operator CLI available via `tsx scripts/groundlane-credentials.mts`; add a package.json script entry, no `bin`). The new admin secret is isolated from the existing `GROUNDLANE_AUTH_TOKEN`, which remains a legacy/local data-plane credential and never gains credential-management privileges. Other next steps are hardening tool contracts and compatibility fixtures; preserving machine-readable Reader/parser/extractor benchmark artifacts; evaluating the async research API surface; adding stateless login/challenge diagnostics; and running live Claude/Codex/Cursor verification of the new async-task lifecycle runtime before choosing an async research API. Short research remains synchronous and provider results remain separated. The approved document-source contract is bounded inline bytes, policy-checked public URLs, or Groundlane-issued opaque `ArtifactRef`; the Cloudflare reference upload path uses an MCP-created provisional upload intent, an upload-capable client/CLI/dashboard, direct presigned PUT to an R2 staging object, and verification/immutable finalization before minting the artifact reference. Self-hosted deployments may replace the artifact backend. Operator-owned corpus lifecycle and `corpus_search` are now mounted with an in-memory backend port; remaining work is managed/external backend adapters. Scoped results carry explicit corpus, freshness, access-control, retention, deletion, and backend provenance rather than changing public-Web `web_search`. Generic LLM extraction, monitoring/scheduling, persistent authenticated browser sessions, and Groundlane-owned durable orchestration remain demand-gated roadmap items rather than committed runtime features. Any future authenticated-browser slice will use a separate opt-in tool family, human login/MFA, provider-owned opaque profile references, explicit owner/TTL/delete controls, and read-only bounded navigation before Groundlane considers credential custody or general account actions.
- Open-source references are split into primary references and watchlist/discovery sources in the product requirements so low-maintenance candidates do not become runtime priorities by default.
- Self-hosted document processing can enable an ownership-scoped, content-addressed SQLite result cache with a 24-hour working default, bounded caller TTL/cache controls, engine/version provenance, and source rebinding. Its repository enforces source-specific revocation, but no public artifact/corpus deletion path invokes that lifecycle yet. This does not cache `web_fetch`, `web_extract`, or `parse`; Cloudflare D1 cache composition remains pending.
- Planned file/document output uses a canonical structured envelope with stable block/source references and typed tables, assets, formulas, citations, capability states, spans, warnings, errors, and engine/model provenance. Markdown remains the default lossy projection; provider raw JSON is never the public contract, and the current HTML `parse` schema remains unchanged.
- Commercial roadmap: OSS V1 Stable remains an operator-hosted open-source product. Self-hosting never requires a Groundlane Cloud account, license server, activation check, or mandatory phone-home. Managed Groundlane Cloud is an approved later roadmap phase released progressively as Internal Alpha, Invite-only Beta, then Managed Cloud Public Launch. A public no-card trial waits for verified tenant/secret isolation, allowance hard stops, abuse controls, Claude/Codex/Cursor compatibility, provider cost attribution, token revocation, project deletion, and basic incident handling. Cloud uses a hosted Remote MCP endpoint plus Web dashboard, preset-first routing with full provenance, and no silent funding switch. Importing OSS configuration into Cloud remains optional.

The detailed product requirements, capability matrix, roadmap, and acceptance criteria live in the [product requirements](docs/product/prd.md).

## Documentation

- [Configuration](docs/configuration.md)
- [Architecture](docs/architecture.md)
- [Cloudflare deployment](docs/deployment/cloudflare.md)
- [Open-source foundations](docs/open-source-foundations.md)
- [Reader benchmark](docs/research/reader-benchmark.md)
- [Parser benchmark](docs/research/parser-benchmark.md)
- [Research archive](docs/research/README.md)

## Contributing and support

Use [GitHub Issues](https://github.com/vincentxuu/groundlane/issues) for bugs and feature proposals. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) before opening a pull request. Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Groundlane is licensed under the [Apache License 2.0](LICENSE).
