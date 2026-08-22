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
| `web_search` | Searches the public web with normalized results | Bounded two-provider auto fusion, explicit single-provider, fallback, or deep routing across ten providers |
| `web_extract` | Extracts named fields into structured JSON | CSS selectors for text, HTML, or attributes; no implicit LLM step |

Fetch/extract results report retrieval provenance such as `engine`, `backend`, and `finalUrl`. Automatic search defaults to at most two complementary providers, canonical-URL deduplication, and RRF while retaining per-provider rank provenance; pinning a provider stays single-source. `web_fetch` and `web_extract` work without a search-provider key.

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

Groundlane now exposes an authenticated Streamable HTTP MCP endpoint at `http://localhost:8080/mcp`. Search keys are optional; add them only for the providers you want to enable.

### Deploy to Cloudflare

For a fresh Cloudflare deployment, authenticate Wrangler, inspect the target's
configured secret names, enter the required bearer token and any optional
provider keys, then deploy:

```bash
pnpm exec wrangler login
pnpm exec wrangler whoami
pnpm secrets:status
pnpm secrets:setup
pnpm run deploy
```

These secret commands affect Cloudflare only; they do not read or update the
local `.env`. Without `--env`, Wrangler uses the top-level target in
`wrangler.jsonc`; if you select a named environment, use that same `--env` for
status, setup, and deploy. Generate and retain a bearer token with at least 32
characters (for example, `openssl rand -hex 32`), then paste it into setup—the
same value authenticates MCP clients and smoke tests. Search-provider keys are
optional. Use `pnpm secrets:setup -- --help` to inspect the safe interactive
flow. Setup first presents one numbered list: select multiple secrets with an
entry such as `2,4-6`, then it prompts only for those values and sends one bulk
update. To paste everything once, copy
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
| Search | Tavily, Exa, Parallel, Browserbase, Brave, Firecrawl, SerpApi, Linkup, Serper, You.com |
| Hosted Reader fallback | Jina Reader (opt-in) |
| Browser rendering | Local Playwright or Browserless (opt-in) |

Automatic search routing can apply conservative per-instance monthly attempt budgets. These are safeguards, not provider billing truth. See [Configuration](docs/configuration.md) for credentials, routing, limits, and budget semantics.

## How it works

```text
MCP client
    |
    v
Worker / Node HTTP edge       authentication, request identity
    |
    v
tool registry                 web_search | web_fetch | web_extract
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
- Implemented: three remote MCP tools, ten search adapters, self-hosted Reader, optional Jina/Browserless backends, Cloudflare Worker + Container deployment.
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
