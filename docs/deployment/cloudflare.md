# Deploying Groundlane on Cloudflare

This guide describes the intended production topology: a Cloudflare Worker exposes the authenticated MCP endpoint, while a Cloudflare Container runs the Node/Playwright service and Groundlane Browser workload.

> [!IMPORTANT]
> Groundlane is an early preview. The checked-in `wrangler.jsonc` and `Dockerfile` define the current deployment, but you should still confirm account entitlements and current Cloudflare Containers documentation before production use.

## Topology

```text
Headless/CLI client          Interactive cloud connector
    |                              |
    | HTTPS + static bearer token  | HTTPS + OAuth 2.1 access token
    v                              v
Cloudflare Worker
    | legacy bearer check first, else OAuth (workers-oauth-provider)
    v
Cloudflare Container
    | Node MCP server
    `-- bounded HTTP + Playwright/Chromium egress
```

The Worker should be the only public ingress. Do not publish an unauthenticated Container endpoint. Groundlane Browser is an internal engine inside the Container, not a separate public service.

The Worker checks the legacy static bearer token on `/mcp` first — this is
unchanged for headless/CLI clients (Codex, Claude Code) and for
headless/scheduled cloud automation (cron, cloud routines, workflow runners),
which should keep using that token directly as a secret in whatever platform
runs them. Only when that check fails does the request fall through to the
OAuth 2.1 layer, used by interactive cloud connectors (claude.ai, ChatGPT)
that don't offer a field to paste a raw API key. See [OAuth for interactive
cloud connectors](#oauth-for-interactive-cloud-connectors) below.

## Prerequisites

- A Cloudflare account with Workers and Containers access
- Node.js 22 or newer and pnpm 10
- Wrangler authenticated to the target account
- One strong Groundlane bearer token (headless/CLI clients)
- One strong, separate OAuth owner passphrase (interactive cloud connectors)
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

Store credentials with Wrangler or the Cloudflare dashboard, never in `wrangler.jsonc`, an image layer, or source control. Authenticate Wrangler first with `pnpm exec wrangler login` or an appropriately scoped `CLOUDFLARE_API_TOKEN` supplied by the execution environment.

```bash
pnpm exec wrangler login
pnpm exec wrangler whoami
pnpm secrets:status
pnpm secrets:setup
```

`secrets:status` compares the checked-in name-only manifest with Cloudflare's secret names. Cloudflare does not return secret values, so this proves presence only—not that a stored value is current or correct. `secrets:setup` shows one numbered list with current name-only status; select multiple entries with numbers/ranges such as `2,4-6` or select `all`. It then prompts with hidden input only for the selected secrets, previews only their names, and sends one JSON payload through `wrangler secret bulk` stdin. A blank selection cancels without prompting or writing. It does not write values to disk or deploy code. Neither command reads or updates the local `.env`.

Inspect the available options without authenticating or contacting Cloudflare:

```bash
pnpm secrets:status -- --help
pnpm secrets:setup -- --help
```

For a one-paste setup, use the checked-in name-only template:

```bash
cp cloudflare-secrets.example.env .cloudflare-secrets.env
# Fill only the values you use, then validate names and values locally:
pnpm secrets:setup -- --from-file .cloudflare-secrets.env --dry-run
# Review the name-only preview, then apply one bulk update:
pnpm secrets:setup -- --from-file .cloudflare-secrets.env
```

`.cloudflare-secrets.env` is ignored by Git. The importer also accepts a JSON
object, rejects unknown names and non-string JSON values, caps the input at 64
KiB, and never prints secret values. File-based dry-run performs no Cloudflare
request and needs no TTY. A non-interactive write must add `--yes`. Remove the
populated file when it is no longer needed.

The numbered `secrets:setup` menu requires an interactive TTY. Its `--dry-run` still authenticates,
lists existing secret names, and prompts for input, but stops before the bulk
write. Use `--yes` to skip the final confirmation. For non-interactive
automation, use the Wrangler bulk path described below.

Without `--env`, the commands use the top-level target in `wrangler.jsonc`.
Before using a named environment, define it in `wrangler.jsonc`; then use the
same environment for status, setup, and deploy:

```bash
pnpm secrets:status -- --env staging
pnpm secrets:setup -- --env staging
pnpm run deploy -- --env staging
```

For CI or password-manager automation, Wrangler also accepts JSON or `.env` through `pnpm exec wrangler secret bulk [file]`, and accepts JSON directly on stdin when the file is omitted. Do not pass secret values as command arguments.

Generate a bearer token with at least 32 characters, save it in a password
manager, and paste it into setup. For example, `openssl rand -hex 32` produces a
64-character token. Groundlane cannot recover this value from Cloudflare; the
same token is needed later by MCP clients and smoke tests.

Generate `OAUTH_OWNER_PASSPHRASE` the same way, as a separate value — never
reuse the bearer token here. It gates the `/authorize` consent screen for
interactive cloud connectors; a phished consent page must not also hand over
the credential every headless client uses. See [OAuth for interactive cloud
connectors](#oauth-for-interactive-cloud-connectors) below for how it's used.

Only add provider secrets that are actually used; all search-provider keys are
optional. See [Configuration](../configuration.md) before choosing providers.
`BROWSERLESS_TOKEN` is needed only when `BROWSER_BACKEND=browserless`.
`GroundlaneContainer.envVars` forwards the authentication token, available
provider keys, search order/budgets, selected Reader/browser backends,
Browserless region, and documented runtime limits into the Container. Keep that
explicit allowlist, `src/config.ts`, and `CLOUDFLARE_SECRET_DEFINITIONS`
synchronized when adding configuration.

`SEARCH_MONTHLY_REQUEST_BUDGETS` is a comma-separated provider-to-attempt mapping, for example `serpapi:250,firecrawl:500`. Zero disables automatic and explicit use for that provider. Counters reset each UTC month but are in-memory per Container instance; restarts and horizontal instances do not share them. Treat this as a guardrail and configure hard limits in every provider dashboard.

For local Worker development, copy `.dev.vars.example` to `.dev.vars` and keep the file untracked.

## OAuth for interactive cloud connectors

Headless/CLI clients and headless/scheduled cloud automation keep using the
static `GROUNDLANE_AUTH_TOKEN` bearer token directly — nothing below applies
to them. This section is only for interactive cloud connectors such as
claude.ai's and ChatGPT's Custom Connector UIs, which expect a browser-based
OAuth 2.1 consent flow and don't offer a field to paste a raw API key.

groundlane implements this with
[`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider).
The Worker checks the legacy bearer token on `/mcp` first, unchanged; only a
request that fails that check falls through to this OAuth layer, so enabling
it never changes behavior for existing static-token clients.

### One-time setup

1. Create the KV namespace the provider uses to store clients, grants, and
   tokens, then paste the returned id into `wrangler.jsonc`'s `kv_namespaces`
   binding (`OAUTH_KV`):

   ```bash
   pnpm exec wrangler kv namespace create OAUTH_KV
   ```

2. Set `OAUTH_OWNER_PASSPHRASE` through `pnpm secrets:setup` (see above) — a
   value separate from `GROUNDLANE_AUTH_TOKEN`.
3. Deploy. The `global_fetch_strictly_public` compatibility flag is already
   checked in, required for Client ID Metadata Document (CIMD) support.

### Adding a connector

In claude.ai or ChatGPT, add a custom connector using the deployed Worker's
MCP URL (`https://your-worker.example/mcp`). The platform registers itself
automatically — via CIMD (preferred) or Dynamic Client Registration
(compatibility fallback, `POST /register`) — then opens `/authorize`, a
groundlane-owned consent page. Enter `OAUTH_OWNER_PASSPHRASE` to approve.
Registration alone (CIMD or DCR) never grants access by itself; only a
correct passphrase does.

This is single-user by design: `/authorize` gates consent with one shared
passphrase rather than a real identity provider, matching groundlane's
single-operator deployment model. It is not intended for multi-tenant use.

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
pnpm run deploy
```

If you configured a named environment, deploy with the same target, for example
`pnpm run deploy -- --env staging`.

Treat deployment as incomplete until the public route and Container binding are both verified.

## Continuous deployment from GitHub

The checked-in [CI workflow](../../.github/workflows/ci.yml) runs the existing
quality job for pull requests and pushes. On `main` pushes (or a manual run on
`main`), its `deploy` job starts only after quality succeeds, installs the locked
dependencies, and runs `pnpm run deploy`. Deployments use a non-cancelling
`groundlane-production` concurrency group so a newer push cannot interrupt an
in-progress Container rollout.

Create a Cloudflare API token from the account-level API Tokens page using the
**Edit Cloudflare Workers** template, then restrict it to only the account that
hosts Groundlane. Add these two GitHub Actions secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

Use interactive stdin so the token does not appear in shell history:

```bash
gh secret set CLOUDFLARE_ACCOUNT_ID
gh secret set CLOUDFLARE_API_TOKEN
gh secret list --app actions
```

The workflow validates that both names are present before deployment and never
passes their values as command-line arguments. These credentials authorize code
and Container deployment only. Existing `GROUNDLANE_AUTH_TOKEN` and provider
keys remain Cloudflare Worker secrets and are not copied into GitHub Actions.

The deploy job uses the GitHub `production` environment. Repository owners can
add environment reviewers or branch protection in GitHub without changing the
workflow. Until both Actions secrets exist, CI quality still runs but the deploy
job fails with the missing secret name instead of attempting an unauthenticated
deployment.

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

- Rotate the Groundlane token, the OAuth owner passphrase, and provider credentials on a defined schedule and after suspected exposure. Rotating `OAUTH_OWNER_PASSPHRASE` does not revoke already-issued OAuth access/refresh tokens; use `OAuthHelpers.revokeGrant` (or clear `OAUTH_KV`) if immediate revocation is required.
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
| `/mcp` returns unauthorized (static-token client) | Bearer header format and `GROUNDLANE_AUTH_TOKEN` secret binding |
| Cloud connector can't complete OAuth | `OAUTH_KV` binding exists and matches a real namespace, `OAUTH_OWNER_PASSPHRASE` is set, `global_fetch_strictly_public` compatibility flag is present |
| `/authorize` never shows the consent form | Client registration failed upstream — check the connector's client_id/redirect_uri and that `/register` or CIMD succeeded |
| `/readyz` fails but `/healthz` passes | Provider credentials, browser capability, forwarded Container configuration, and Container readiness |
| HTTP works but Reader fails | `READER_BACKEND`, Jina rate limit, deadline, hosted-provider availability |
| HTTP works but render fails | `BROWSER_BACKEND`, Browserless token/region, Container binding, Chromium installation, memory limits |
| Search reports unavailable | Provider order, matching API key, provider quota or rate limit |
| Requests end early | End-to-end deadline, proxy/socket timeout, Container CPU limits |
| Unexpected blocked URL | DNS answers, redirect chain, IP category, port allowlist, browser subresource policy |
