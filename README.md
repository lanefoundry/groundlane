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
| `web_research` | Retrieves provider-attributed research reports | Parallel fan-out or fallback across You.com Research and Parallel Responses, with citations |
| `web_content` | Fetches URL content through provider content APIs | Parallel fan-out or fallback across Linkup Fetch, You.com Contents, Exa Contents, Tavily Extract, Firecrawl Scrape, and Keenable Fetch |
| `web_map` | Discovers URLs from a public site | Parallel fan-out or fallback across Firecrawl Map and Tavily Map, with provider attribution |
| `web_crawl` | Crawls bounded pages from a public site | Parallel fan-out or fallback across Firecrawl Crawl and Tavily Crawl, with capped pages and content |
| `web_news` | Searches news-specific provider indexes | Parallel fan-out or fallback across Brave News, Serper News, and SerpApi Google News |
| `web_images` | Searches image-specific provider indexes | Parallel fan-out or fallback across Brave Images, Serper Images, and SerpApi Google Images |
| `web_extract` | Extracts named fields into structured JSON | CSS selectors for text, HTML, or attributes, with per-call output caps; no implicit LLM step |
| `provider_balance` | Checks provider account-balance APIs when available | You.com keyed credits and Linkup credits; unsupported providers return explicit diagnostic status |
| `provider_capabilities` | Lists provider features and Groundlane-exposed surfaces | Static capability matrix that separates vendor features from currently implemented Groundlane tools |

Fetch/extract results report retrieval provenance such as `engine`, `backend`, `finalUrl`, `bytes`, and `truncated`. Automatic search defaults to batches of at most two complementary providers, canonical-URL deduplication, and RRF while retaining selected/attempted/succeeded provider provenance; if a federated batch has no successful provider, Groundlane tries the next eligible batch within the same deadline. Provider-backed tools such as `web_answer`, `web_research`, `web_content`, `web_map`, `web_crawl`, `web_news`, and `web_images` default to parallel fan-out and return each provider result separately instead of synthesizing them. Pinning a provider stays single-source. `web_fetch` and `web_extract` work without a search-provider key.

Provider vendors expose more APIs than Groundlane currently wires into MCP. See [provider inventory](docs/operations/provider-inventory.md) for the verified feature backlog and the distinction between vendor capability, implemented Groundlane tool, live smoke, and account balance evidence.

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

| Capability | Adapters |
| --- | --- |
| Search | Linkup, Keenable, Parallel, Browserbase, Brave, SerpApi, Tavily, Exa, Firecrawl, Serper, You.com |
| News search | Brave, Serper, SerpApi |
| Site map discovery | Firecrawl, Tavily |
| Hosted Reader fallback | Jina Reader (opt-in) |
| Browser rendering | Local Playwright or Browserless (opt-in) |

Automatic search routing can apply conservative per-instance monthly attempt budgets. These are safeguards, not provider billing truth; provider dashboards and spend limits remain authoritative. See [Configuration](docs/configuration.md) for credentials, routing, limits, and budget semantics, and [Provider inventory](docs/operations/provider-inventory.md) for the current production provider status and capability matrix.

## How it works

```text
MCP client
    |
    v
Worker / Node HTTP edge       authentication, request identity
    |
    v
tool registry                 web_search | web_answer | web_research | web_content | web_map | web_crawl | web_news | web_images | web_fetch | web_extract
                              provider_balance | provider_capabilities
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
- Implemented: three core web MCP tools, two provider diagnostic MCP tools, eleven search adapters, self-hosted Reader, optional Jina/Browserless backends, Cloudflare Worker + Container deployment.
- Next: compatibility fixtures, cache/health-aware routing, operational telemetry, and opt-in bounded crawl primitives.

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
