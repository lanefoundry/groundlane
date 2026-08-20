# Deploying Groundlane on Cloudflare

This guide describes the intended production topology: a Cloudflare Worker exposes the authenticated MCP endpoint, while a Cloudflare Container runs the Node/Playwright service and Groundlane Browser workload.

> [!IMPORTANT]
> Groundlane is an early preview. The checked-in `wrangler.jsonc` and `Dockerfile` define the current deployment, but you should still confirm account entitlements and current Cloudflare Containers documentation before production use.

## Topology

```text
MCP client
    |
    | HTTPS + bearer token
    v
Cloudflare Worker
    | authentication, request routing, health checks
    v
Cloudflare Container
    | Node MCP server
    `-- bounded HTTP + Playwright/Chromium egress
```

The Worker should be the only public ingress. Do not publish an unauthenticated Container endpoint. Groundlane Browser is an internal engine inside the Container, not a separate public service.

## Prerequisites

- A Cloudflare account with Workers and Containers access
- Node.js 22 or newer and pnpm 10
- Wrangler authenticated to the target account
- One strong Groundlane bearer token
- Optional credentials for any supported monthly-free search provider

Install dependencies and verify locally first:

```bash
pnpm install
pnpm exec playwright install chromium
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Configure the Worker

The checked-in Wrangler configuration is the deployment source of truth when present. Review at least:

- Worker name and account/environment selection;
- the Container binding used by the Worker;
- Container image/build configuration;
- compatibility date and compatibility flags;
- CPU, memory, instance, and outbound network limits;
- observability and log-retention settings.

Use separate Cloudflare environments for development and production. Do not use production provider keys in preview deployments.

## Configure secrets

Store credentials with Wrangler or the Cloudflare dashboard, never in `wrangler.jsonc`, `.dev.vars`, `.env`, an image layer, or source control.

```bash
pnpm exec wrangler secret put GROUNDLANE_AUTH_TOKEN
pnpm exec wrangler secret put TAVILY_API_KEY
pnpm exec wrangler secret put EXA_API_KEY
pnpm exec wrangler secret put FIRECRAWL_API_KEY
pnpm exec wrangler secret put SERPAPI_API_KEY
pnpm exec wrangler secret put BROWSERBASE_API_KEY
pnpm exec wrangler secret put PARALLEL_API_KEY
pnpm exec wrangler secret put BRAVE_API_KEY
pnpm exec wrangler secret put BROWSERLESS_TOKEN
```

Only add provider secrets that are actually used. `BROWSERLESS_TOKEN` is needed only when `BROWSER_BACKEND=browserless`. `GroundlaneContainer.envVars` forwards the authentication token, available provider keys, search order/budgets, selected Reader/browser backends, Browserless region, and documented runtime limits into the Container. Keep that explicit allowlist synchronized with `src/config.ts` when adding configuration.

`SEARCH_MONTHLY_REQUEST_BUDGETS` is a comma-separated provider-to-attempt mapping, for example `serpapi:250,firecrawl:500`. Zero disables automatic and explicit use for that provider. Counters reset each UTC month but are in-memory per Container instance; restarts and horizontal instances do not share them. Treat this as a guardrail and configure hard limits in every provider dashboard.

For local Worker development, copy `.dev.vars.example` to `.dev.vars` and keep the file untracked.

## Browser mode

The Worker itself cannot launch local Chromium. It forwards MCP traffic to the Node service in the Container. The checked-in deployment uses Playwright inside that Container:

```text
BROWSER_BACKEND=local
```

The Container image must install a Playwright-compatible Chromium build and the required Linux libraries. Keep browser process startup, crash recovery, request cleanup, and Container lifecycle inside the browser adapter/Container boundary.

The checked-in deployment uses one `basic` Container instance (1/4 vCPU and
1 GiB memory). Cloudflare's `lite` instance can start Chromium but was observed
to crash while creating a page under the platform VM overhead. Because the
Worker currently routes every request to the single named `groundlane-mcp`
instance, raising `max_instances` alone does not add request sharding; change
the routing and quota-ledger design before increasing it.

To consume Browserless's renewable hosted allowance instead, configure the non-secret vars and add its secret token:

```text
BROWSER_BACKEND=browserless
BROWSERLESS_REGION=sfo
```

Valid regions are `sfo`, `lon`, and `ams`. Groundlane calls the fixed regional `/content` endpoint and sends the token in an Authorization header, never in a query string.

Jina's keyless Reader is a separate, opt-in Markdown fallback:

```text
READER_BACKEND=jina
```

When enabled, a qualifying `web_fetch(format=markdown, render=auto)` may send the requested public URL to Jina after a retryable HTTP failure or supported fallback signal. HTML, selectors, `waitFor`, extraction, and `render=always` do not use Reader.

If browser mode is disabled, `web_fetch` and `web_extract` must report the capability limitation instead of silently pretending a rendered result was obtained.

## Deploy

After reviewing the generated plan and target account:

```bash
pnpm deploy
```

Treat deployment as incomplete until the public route and Container binding are both verified.

## Verify

Run checks from a network outside the deployment account:

1. `GET /healthz` responds without exposing configuration or secrets.
2. Public `GET /readyz` proxies Container dependency/configuration readiness without exposing secrets.
3. `POST /mcp` without a bearer token is rejected.
4. A valid client can initialize MCP and list exactly the intended tools.
5. `web_fetch` succeeds on an authorized public fixture through the HTTP path.
6. A JavaScript fixture exercises the Container browser path.
7. `web_search` identifies its selected provider.
8. `web_extract` returns deterministic structured data and missing fields.
9. Private, loopback, metadata, redirect-to-private, and browser-subresource targets are blocked.
10. Timeouts, byte/output caps, concurrency, and queue limits behave as configured.

The bundled smoke client verifies the exact MCP tool list plus `web_fetch` and `web_extract` against the reserved `example.com` documentation domain:

```bash
GROUNDLANE_MCP_URL=https://your-worker.example/mcp \
GROUNDLANE_AUTH_TOKEN='your-deployment-token' \
pnpm smoke
```

Add `GROUNDLANE_SMOKE_BROWSER=1` to exercise Groundlane Browser as well. `web_search` is intentionally omitted from this smoke command because it requires a live provider credential and consumes provider quota.

Do not use arbitrary third-party sites as a production smoke test. Host controlled fixtures and keep live-provider tests opt-in.

## Operations

- Rotate the Groundlane token and provider credentials on a defined schedule and after suspected exposure.
- Restrict who can view Worker/Container secrets and deployment logs.
- Alert on authorization failures, queue saturation, blocked destinations, browser crashes, provider rate limits, and deadline errors.
- Retain metadata only as long as operationally required; never log response bodies or browser profiles.
- Set provider-side spend limits and Cloudflare usage notifications.
- Keep an external egress policy where possible; application URL validation is not a complete firewall.

## Rollback

Before deployment, record the last known-good Worker version and Container image digest. If health, authentication, URL policy, or browser isolation regresses, roll back both control plane and Container image as one compatible unit, then rotate secrets if exposure is possible.

Tool schema changes should be backward compatible whenever possible. If a rollback crosses an incompatible contract change, coordinate client configuration and publish the compatibility impact.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `/mcp` returns unauthorized | Bearer header format and `GROUNDLANE_AUTH_TOKEN` secret binding |
| `/readyz` fails but `/healthz` passes | Provider credentials, browser capability, forwarded Container configuration, and Container readiness |
| HTTP works but Reader fails | `READER_BACKEND`, Jina rate limit, deadline, hosted-provider availability |
| HTTP works but render fails | `BROWSER_BACKEND`, Browserless token/region, Container binding, Chromium installation, memory limits |
| Search reports unavailable | Provider order, matching API key, provider quota or rate limit |
| Requests end early | End-to-end deadline, proxy/socket timeout, Container CPU limits |
| Unexpected blocked URL | DNS answers, redirect chain, IP category, port allowlist, browser subresource policy |
