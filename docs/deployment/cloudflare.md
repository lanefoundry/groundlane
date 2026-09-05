# Deploying Groundlane on Cloudflare

Document result storage can be enabled explicitly with
`DOCUMENT_OUTPUT_EDGE_ENABLED=true`. The private Container outbound route
`groundlane-output.internal` uses existing D1/R2 bindings and the internal
signing secret; S3 access credentials are not required for result storage.
The reference flag remains disabled pending controlled deployment acceptance.
Encoded requests are capped at 16 MiB; metadata stays in D1 and bytes in R2.
Hourly maintenance scans at most four pages of 100 due records. Disable the
flag to roll back the surface while preserving storage for later cleanup.
Local workerd/D1/R2 tests are separate from production and full Container
network-path evidence.

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
    | authenticate; MCP Tasks -> D1 + Linkup at edge
    | all other MCP traffic -> signed principal context
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

`SEARCH_MONTHLY_REQUEST_BUDGETS` is a comma-separated provider-to-attempt mapping, for example `serpapi:250,firecrawl:500`. Zero disables provider-backed dispatch for that provider after routing has selected it. Keenable may run without `KEENABLE_API_KEY` through its keyless public endpoint; set the key to use its authenticated monthly allowance. Counters reset each UTC month but are in-memory per Container instance; restarts and horizontal instances do not share them. Treat this as a guardrail and configure hard limits in every provider dashboard.

For local Worker development, copy `.dev.vars.example` to `.dev.vars` and keep the file untracked.

## Managed credentials (D1) and artifact storage (R2)

The managed-credential data plane (single-tenant multi-credential auth,
rotation/revoke/audit) and durable async artifact storage need Cloudflare
resources. The reference bindings are checked in and live:

- D1 database `groundlane-managed-tokens` (`MANAGED_TOKEN_D1`), migrated
  with `migrations/0001_managed_tokens.sql` and
  `migrations/0002_durable_records.sql`;
- R2 bucket `groundlane-artifacts` (`GROUNDLANE_ARTIFACTS`).

> [!IMPORTANT]
> The D1-backed `ManagedTokenStore` adapter (`src/worker/d1-managed-store.ts`)
> is wired: when `MANAGED_TOKEN_D1` is bound the Worker authenticates managed
> tokens against D1, otherwise the data plane stays fail-closed. Rotation runs
> as one atomic batch (guarded INSERT first, guarded UPDATE second); a lost
> race changes zero rows and returns a stable conflict. Live SQL smoke on the
> provisioned database confirmed rotate 1/0, revoke first-wins, and zero
> residue rows. A [2026-09-05 controlled public MCP smoke](../verification/managed-revoke-2026-09-05.json)
> also confirmed three successful initializations before direct D1 revoke and
> ten consecutive 401 responses after commit, with a healthy control and zero
> fixture residue. This verifies deployed authorization, not the admin revoke
> API, multi-region behavior, or modern protocol. To repeat deliberately, use
> `pnpm exec tsx scripts/smoke-managed-revoke.mts --run` with protected
> `GROUNDLANE_AUTH_TOKEN` and authenticated Wrangler remote-D1 write access.
> It creates/revokes/removes only its own 10-minute fixture; without `--run`
> it performs no I/O. No provider calls or existing credential mutations occur.
> The Worker now has a protocol-neutral, revision-fenced upload
> lifecycle over D1 and R2. When the R2 S3 presigning settings below and the
> internal signing secret are present, `document_upload_create` returns a
> short-lived conditional PUT handoff, `document_upload_complete` verifies and
> immutably finalizes the bytes, `document_artifact_delete` immediately revokes
> a source ref and its processing-cache bindings, and artifact-backed `document_parse` uses a
> purpose/body-bound binary request to the existing Container parser. Owner and
> exact credential binding are checked on every intent/ref operation. Storage
> keys, presigned URLs, S3 credentials, and caller bearer tokens never enter the
> public ArtifactRef or Container environment. Deterministic fake-D1/R2 and
> bridge tests pass; this checkout has not yet supplied a controlled production
> or target-client transcript. The checked-in hourly cron performs bounded
> staging/final cleanup, revokes logical access and cache bindings before deleting final bytes,
> and leaves partial failures pending for retry. Result artifacts, Cloudflare
> processing-cache deployment proof, a Cloudflare corpus backend, and document async
> jobs remain open. Linkup research Tasks are a
> separate path: when D1 and `LINKUP_API_KEY` are present, authenticated task
> start/get/update/cancel requests execute at the Worker edge in the
> `mcp-tasks-v1` namespace. The Container receives only a derived discovery
> flag; D1 and caller credentials are never forwarded to it. This path has
> deterministic fake-D1/reconnect coverage but has not yet been verified by a
> controlled deployment or target-client smoke.

The Worker and `document_policy` share the same operator caps:
`DOCUMENT_UPLOAD_MAX_TTL_SECONDS` defaults to `3600`, and
`DOCUMENT_ARTIFACT_MAX_TTL_SECONDS` defaults to `2592000`. Requests above the
advertised cap fail validation; they are never silently shortened.

### Isolated PRD staging

`wrangler.staging.jsonc` targets `groundlane-prd-staging` with its own D1,
R2 bucket, OAuth KV and single Container. Always pass
`--config wrangler.staging.jsonc`; omitting it selects the production config.
The staging profile enables cache, keeps legacy-only protocol and disables
browser execution. It does not inherit production secrets or provider keys.
Resources incur Cloudflare usage; retain them only while acceptance is active.
Wrangler's generated `.wrangler/` bundles are excluded from source linting, so
running validation alongside deployment does not lint generated third-party code.

```bash
pnpm exec wrangler d1 migrations apply groundlane-prd-staging --remote --config wrangler.staging.jsonc
pnpm exec wrangler deploy --dry-run --config wrangler.staging.jsonc
pnpm exec wrangler deploy --config wrangler.staging.jsonc
```

Provision independent auth/admin/internal-signing secrets before accepting
traffic. For real upload handoff, create an R2 **Object Read & Write** token
scoped only to `groundlane-prd-staging-artifacts`, then enter its values through
the interactive prompts (never put values in argv, logs or chat):

```bash
pnpm exec wrangler secret put R2_ACCESS_KEY_ID --config wrangler.staging.jsonc
pnpm exec wrangler secret put R2_SECRET_ACCESS_KEY --config wrangler.staging.jsonc
```

With the staging URL in `GROUNDLANE_MCP_URL` and its credential supplied securely
in `GROUNDLANE_AUTH_TOKEN`, run `pnpm exec tsx scripts/smoke-document-cache.mts --run`.
Without `--run` the runner performs no network or file I/O. It checks inline
use/hit/refresh/bypass and, when upload is available, verified source deletion
and same-content source isolation. Missing upload support is reported as skipped,
not passed. Its `fullAcceptance` remains false: scoped D1/R2 evidence of actual
scheduled physical cleanup is a separate requirement. It does not run providers
or prove Claude/Codex/Cursor compatibility.

### Self-hosted and edge cache composition

Parser engine `groundlane-bounded-document-v3` changes the processing-cache key,
so the upgraded parser does not reuse earlier engine entries. No cache migration
or manual deletion is required; old entries expire under their existing policy.

For a self-hosted Node deployment, `DOCUMENT_CACHE_STATE_PATH` enables a local
SQLite cache containing revision-fenced metadata and immutable parsed-payload
blobs. `DOCUMENT_CACHE_DEFAULT_TTL_SECONDS` and
`DOCUMENT_CACHE_MAX_TTL_SECONDS` configure the advertised default and hard
maximum. Startup and hourly sweeps remove expired records and payload bytes.
For Cloudflare, the checked-in `DOCUMENT_CACHE_EDGE_ENABLED=true` setting is an
explicit opt-in. The Container receives that derived flag and the TTL values
only when D1, R2, and the internal signing secret are available. It then sends
versioned, body-bound lookup/commit requests to the private
`groundlane-cache.internal` outbound handler; D1/R2 bindings never enter the
Container, and the Container cannot override Worker-owned cache policy. The
private host mapping must be registered through the Container SDK's inherited
`outboundByHost` setter (the Worker uses a static-block assignment). An ES2022
static field with the same name shadows that setter and leaves the proxy
registry empty; a compile/evaluation regression protects both cache and output
host registrations. The
hourly cron scans a bounded number of cache pages and deletes expired immutable
payload bytes before the matching metadata CAS, so an interrupted pass is
retryable. The [2026-09-05 isolated staging evidence](../verification/staging-cache-2026-09-05.json)
records nine successful public MCP cache checks (miss/hit/rebind/refresh/bypass).
Full acceptance remains open pending verified-source upload/delete isolation
and separately recorded scheduled physical cleanup; this is not production or
Claude/Codex/Cursor acceptance.

For a self-hosted Node deployment, `CORPUS_STATE_PATH` separately enables the
durable corpus composition over revision-fenced SQLite manifests, immutable
normalized source blobs, and a rebuildable derived text index. Set
`CORPUS_TENANT_ID` to the deployment tenant boundary and bound enrollment with
`CORPUS_MAX_SOURCE_BYTES`. Do not set this filesystem path in the Cloudflare
Container; a Worker-owned D1/R2 corpus composition has not yet been implemented
or verified.

`ASYNC_TASK_STATE_PATH` separately enables revision-fenced SQLite metadata for
durable Linkup research. It requires `LINKUP_API_KEY`; without both, the four
explicit async tools remain discoverable but fail closed. In Cloudflare, do not
set this filesystem path. The Worker derives `ASYNC_TASK_EDGE_ENABLED` from the
D1 binding plus Linkup key so `server/discover` can advertise the extension,
then owns the D1 execution path itself.

1. (Already done for the reference deployment; repeat only for a new
   account.) Create the D1 database and the R2 bucket, then record their
   identifiers:

   ```bash
   pnpm exec wrangler d1 create groundlane-managed-tokens
   pnpm exec wrangler r2 bucket create groundlane-artifacts
   ```

2. Fill the real `database_id` into `wrangler.jsonc`'s `d1_databases`
   entry. Never commit placeholder IDs.
3. Apply the checked-in migration to the database (remote shown; drop
   `--remote` for the local dev copy):

   ```bash
   pnpm exec wrangler d1 migrations apply groundlane-managed-tokens --remote
   ```

   `migrations/0001_managed_tokens.sql` stores verifiers/digests and bounded
   metadata only — raw bearer secrets are never persisted.
   `migrations/0002_durable_records.sql` creates a separate namespaced,
   revision-fenced metadata table for job/upload/artifact/cache/corpus
   repositories; large bytes must remain in R2. Planned rotation
   must run as a single atomic conditional write (see the SQL comments); a
   lost race returns a stable conflict instead of a second successor.
4. Create a bucket-scoped R2 S3 API token with only the object permissions
   needed for this bucket. Set `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`
   through `pnpm secrets:setup`. Set `R2_ACCOUNT_ID` and
   `R2_BUCKET_NAME=groundlane-artifacts` as deployment variables. The native
   `GROUNDLANE_ARTIFACTS` binding cannot create a presigned URL by itself; the
   S3 credentials are used only by the Worker-side SigV4 signer and are never
   forwarded to the Container or caller. The presigned request fixes
   `Content-Type`, `Content-Length`, `If-None-Match: *`, expiry, and bounded
   intent metadata. Missing any input keeps the feature fail-closed.
5. Set the operator authentication/signing secrets through
   `pnpm secrets:setup`; they are part of the checked-in manifest. Generate
   each locally with `openssl rand -hex 32`. `GROUNDLANE_AUTH_TOKEN`,
   `OAUTH_OWNER_PASSPHRASE`, provider keys, `GROUNDLANE_ADMIN_TOKEN`,
   `GROUNDLANE_INTERNAL_SIGNING_SECRET`,
   `GROUNDLANE_MCP_REQUEST_STATE_SECRET`, and both R2 S3 credential values
   must never be reused across roles:

   - `GROUNDLANE_ADMIN_TOKEN` bootstraps and recovers managed credentials
     via `/admin/credentials` only; it cannot call `/mcp`.
   - `GROUNDLANE_INTERNAL_SIGNING_SECRET` signs the bounded Worker-to-
     Container internal principal context; raw caller credentials never
     cross that boundary.
   - `GROUNDLANE_MCP_REQUEST_STATE_SECRET` signs five-minute modern MRTR state
     shared across Container instances. Use at least 32 bytes. It is not a
     Wrangler plain-text variable; rotation invalidates outstanding flows.
6. Deploy with `pnpm run deploy` as usual.

The reference Container starts in `worker_internal_context` mode whenever the signing secret is bound. The Worker authenticates static, managed, or OAuth credentials and signs issuer, audience, issued/expiry time, HTTP method/path, request ID, principal, and a non-secret credential binding. Artifact parsing additionally binds an internal-only purpose and the exact body SHA-256, uses a 10 MiB binary route rather than expanding bytes into the 1 MiB JSON-RPC body, preserves the original absolute deadline, and carries only bounded source metadata. The Container verifies every field and does not fall back to a raw caller bearer. Direct local Node operation uses the separate `local_static` mode and does not advertise the Cloudflare upload path.

For authenticated modern MCP POSTs, the Worker reads at most 1 MiB from a
clone of an `application/json` body and uses the SDK classifier to reject
proven `MCP-Protocol-Version` or `Mcp-Method` drift. It also verifies the
required standard headers and the method-specific `Mcp-Name`, including the
canonical Base64 sentinel form. The original request, body, routing headers,
and abort signal continue to the Container. This edge check is only an early
policy gate: the Container's strict modern handler independently parses and
validates the JSON-RPC body, envelope, standard headers, capabilities, and
tool parameters before dispatch. Authentication, signed principal context,
credential binding, tool deadlines, concurrency limits, and error redaction
remain separate enforcement boundaries.

Remaining adapter constraints:
authorization reads require the D1 Sessions API with a `first-primary`
constraint and fail closed when it is unavailable; KV must not become
managed-token truth; R2 objects must stay content-addressed with
owner binding, content hash, and retention/deletion policy, and must never be
addressable through caller-supplied keys or presigned URLs passed as tool
input. The reference `0 * * * *` cron invokes a bounded cleanup pass; verify
the deployed trigger and an expired-object deletion before claiming the
physical cleanup window in production.

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
MCP URL (`https://your-worker.example/mcp`). Modern clients register through
CIMD without a separate pre-registration step. The Dynamic Client Registration
compatibility endpoint (`POST /register`) is bearer-protected with
`GROUNDLANE_AUTH_TOKEN`, so unsupported clients must be pre-registered by an
operator instead of registering anonymously. DCR requests must include
`application_type=web` with HTTPS redirect URIs or `application_type=native`
with HTTP loopback redirect URIs; omission and mismatched combinations fail
with `invalid_client_metadata`. After registration, the connector
opens `/authorize`, a groundlane-owned consent page. Enter
`OAUTH_OWNER_PASSPHRASE` to approve. Registration alone never grants access by
itself; only a correct passphrase does.

The protected-resource document for `/mcp` names that exact canonical resource
and the authorization-server issuer. Authorization metadata advertises the
same issuer, CIMD, and RFC 9207 issuer response support. Successful and
redirected-error authorization responses carry `iss`; issued access tokens are
resource-bound, so a token minted for a different resource cannot call `/mcp`.
Groundlane delegates protocol storage and token mechanics to the pinned
Cloudflare provider, while repository contracts pin these configured
invariants and the separation between data-plane, admin, internal-context, and
provider credentials.

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
2. Authenticated `GET /readyz` proxies Container dependency/configuration readiness without exposing secrets.
3. `POST /mcp` without a bearer token is rejected.
4. A valid client can initialize MCP and list exactly the intended tools.
5. `web_fetch` succeeds on an authorized public fixture through the HTTP path.
6. A JavaScript fixture exercises the Container browser path.
7. `web_search` identifies its selected provider.
8. `web_extract` returns deterministic structured data and missing fields.
9. `document_parse` accepts a bounded inline text fixture and a controlled public-URL fixture, then returns a canonical envelope and the requested projection.
10. Forged, expired, wrong-audience, wrong-path, and replayed internal contexts are rejected; raw bearer fallback at the Container is rejected.
11. Private, loopback, metadata, redirect-to-private, and browser-subresource targets are blocked.
12. Timeouts, byte/output caps, concurrency, and queue limits behave as configured.

The bundled smoke client verifies the default profile's exact MCP tool list (including artifact deletion and explicit research lifecycle tools) and diagnostic tools, plus `web_fetch`, `web_extract`, and inline `document_parse`, against the reserved `example.com` documentation domain. An integration regression compares its independent expected inventory with the real local composition. This smoke does not invoke upload/delete or research jobs, and does not prove cache, optional output-profile, or target-client acceptance:

```bash
GROUNDLANE_MCP_URL=https://your-worker.example/mcp \
GROUNDLANE_AUTH_TOKEN='your-deployment-token' \
pnpm smoke
```

Add `GROUNDLANE_SMOKE_BROWSER=1` to exercise Groundlane Browser as well. `web_search` is intentionally omitted from this smoke command because it requires a live provider credential and consumes provider quota.

Do not use arbitrary third-party sites as a production smoke test. Host controlled fixtures and keep live-provider tests opt-in.

After `wrangler deploy`, Cloudflare can report the Worker deployment as
successful while the Container application is still provisioning a new image.
CI therefore runs `pnpm run wait:container` before `pnpm run smoke:retry`.
`wait:container` polls `wrangler containers list` until
`groundlane-groundlanecontainer` is `active` or `ready`; `smoke:retry` then
retries the MCP smoke until the deployed Container responds with the expected
schema. This catches stale named Container instances instead of treating
`wrangler deploy` as the final readiness signal.

## Operations

- Rotate the Groundlane token, the OAuth owner passphrase, and provider credentials on a defined schedule and after suspected exposure. Rotating `OAUTH_OWNER_PASSPHRASE` does not revoke already-issued OAuth access/refresh tokens. Use `OAuthHelpers.revokeGrant` to initiate grant revocation; OAuth state remains KV-backed, so propagation is eventual and immediate cross-edge revocation is not guaranteed. The managed-token D1 revoke guarantee does not apply to OAuth grants.
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
| Worker accepts auth but Container returns unauthorized | `GROUNDLANE_INTERNAL_SIGNING_SECRET`, derived auth mode, `groundlane-mcp-v2` audience/instance, and Worker/Container deployment version alignment |
| Cloud connector can't complete OAuth | `OAUTH_KV` binding exists and matches a real namespace, `OAUTH_OWNER_PASSPHRASE` is set, `global_fetch_strictly_public` compatibility flag is present |
| `/authorize` never shows the consent form | Client registration failed upstream — check the connector's client_id/redirect_uri and that `/register` or CIMD succeeded |
| `/readyz` fails but `/healthz` passes | Provider credentials, browser capability, forwarded Container configuration, and Container readiness |
| HTTP works but Reader fails | `READER_BACKEND`, Jina rate limit, deadline, hosted-provider availability |
| HTTP works but render fails | `BROWSER_BACKEND`, Browserless token/region, Container binding, Chromium installation, memory limits |
| Search reports unavailable | Provider order, matching API key, provider quota or rate limit |
| Requests end early | End-to-end deadline, proxy/socket timeout, Container CPU limits |
| Modern `/mcp` returns `-32020` | Compare `MCP-Protocol-Version`, `Mcp-Method`, method-specific `Mcp-Name`, and the JSON-RPC body/envelope; headers do not replace body validation |
| Unexpected blocked URL | DNS answers, redirect chain, IP category, port allowlist, browser subresource policy |
| `document_parse` rejects a file | Confirm supported MIME/extension, encryption or active/external package content, archive/page/byte/output limits; for ArtifactRef sources also confirm D1/R2, all R2 S3 presigning settings, and internal signing are configured |
