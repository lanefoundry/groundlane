# MCP protocol migration and rollback

Groundlane has separate legacy MCP `2025-11-25` and modern MCP `2026-07-28`
handlers on the split TypeScript SDK v2 packages. The compatibility baseline was captured from
`@modelcontextprotocol/sdk` 1.29.0 before the official whole-package codemod was
applied. Both paths create a fresh SDK server for each request. Modern requests
also carry their client identity and capabilities in the validated request
envelope. These local implementation facts are not evidence of deployed
conformance or target-client compatibility.

## Frozen legacy baseline

The raw compatibility fixtures under
`test/fixtures/mcp/2025-11-25/` freeze the following public behavior:

- `initialize` negotiates exactly `2025-11-25` and returns Groundlane server
  information and capabilities;
- `tools/list` preserves the v1 tool description and draft-07 input/output
  schema wire shape in `tools-list.json` and `schema.json`. SDK v2's reviewed
  legacy-hosting output is recorded separately in `tools-list-sdk-v2.json` and
  `schema-sdk-v2.json`: it emits JSON Schema 2020-12 and removes the deprecated
  v1 experimental Tasks `execution.taskSupport` member;
- `tools/call` preserves both legacy text content and `structuredContent`;
- a missing tool's v1 SDK error-result shape remains in `error.json`; the
  reviewed SDK v2 legacy-hosting behavior in `error-sdk-v2.json` returns the
  standard JSON-RPC `-32602` error instead;
- an unauthenticated request preserves the bounded bearer challenge without
  exposing internal details;
- Streamable HTTP returns SSE with a `cache-control` policy containing
  `no-cache` and does not mint an `Mcp-Session-Id` in the current
  request-scoped transport. SDK v2 also adds `no-transform`; this reviewed
  strengthening does not alter the legacy protocol payload.

`test/contract/mcp-legacy-2025-11-25.test.ts` replays every fixture through the
real Container authentication and MCP transport boundary. These fixtures are a
rollback contract. They do not assert that v1 wire details are correct for a
modern request.

## Coexistence policy

`GROUNDLANE_MCP_PROTOCOL_MODE` selects `legacy-only` (the default), `dual`, or
`modern-only`. The default keeps rollout behavior unchanged: modern requests
fail closed until an operator deliberately enables `dual`. `modern-only`
disables the legacy compatibility path.

The runtime has two named paths:

1. the frozen `2025-11-25` compatibility path; and
2. a `2026-07-28` path selected from the validated protocol version and
   self-describing request envelope.

Selection uses the SDK's exported `isLegacyRequest` predicate, which is the
same classifier as the modern entry point. There is no user-defined heuristic
or retry through the other era after rejection. The modern handler runs with
`legacy: "reject"` and validates the JSON-RPC body, `_meta` envelope,
`MCP-Protocol-Version`, `Mcp-Method`, and method-specific `Mcp-Name`. The Worker
may use these headers for early routing and policy, but headers never
replace handler validation.

The Worker now performs that bounded early check after authentication. It
reads at most 1 MiB from a clone of JSON request bodies, forwards the untouched
request and its cancellation signal, and rejects only proven routing-header
drift. The Container independently repeats authoritative validation before
tool dispatch. Mismatch responses describe the failed consistency cell without
reflecting caller-controlled header or body names. Caller disconnects remain
cancellation signals rather than being rewritten as `container_unavailable`.
Static, managed, and OAuth callers continue through the same
principal/credential-binding boundary; routing headers never grant authority.

Modern `tools/list`, `prompts/list`, `resources/list`,
`resources/templates/list`, `resources/read`, and `server/discover` results
carry explicit `ttlMs: 0` and `cacheScope: private`. Registry modules are
registered in stable name order, and every request receives a fresh registry
and server bound to the authenticated principal/credential context and that
request's client capabilities. Groundlane therefore does not reuse a catalog
across callers or capability envelopes; a later positive TTL requires an
explicit partition-key design and invalidation contract.

## Multi-round request state

The first implemented MRTR slice is the read-only `document_policy` option
`interactiveTtlFor=cache|upload|artifact|corpus`. A capable modern caller first
receives `input_required` with one keyed elicitation request and an opaque
`requestState`, then retries the same tool arguments with a new JSON-RPC id,
the byte-exact state, and keyed `inputResponses`. The server caps the exchange
at three rounds.

The official SDK request-state codec signs the state with
`GROUNDLANE_MCP_REQUEST_STATE_SECRET`, applies a five-minute expiry, and binds
it to the authenticated principal, credential binding, and request method.
The signed payload additionally fixes the tool, selected policy section,
canonical argument digest, original evaluation time, absolute flow expiry, and
round. State is signed, not encrypted, so it contains no credentials or other
secrets. Instances sharing the deployment secret can resume the flow without
session affinity; rotating the secret deliberately invalidates outstanding
flows. Exact replay is supported because policy evaluation is read-only and
uses the sealed original time. A disconnected HTTP leg reaches only that
leg's cancellation signal and is not a task-cancellation instruction.

## JSON Schema 2020-12 admission

Every registered tool input/output Standard Schema is converted to JSON Schema
and admitted before the SDK serves it. Groundlane caps each schema at 128 KiB,
4,096 visited nodes, depth 32, 256 total `allOf`/`anyOf`/`oneOf` branches, and
250 ms of admission work. Fragment-only `$ref` and `$dynamicRef` values are
allowed; external references fail closed and are never fetched. The modern
rich-schema fixture covers `$defs`, a local `$ref`, conditionals, composition,
and a non-object output root, plus invalid input/output enforcement.

Modern `structuredContent` may be any JSON value, including a scalar, array, or
`null`. The shared result helper emits the same value as JSON text for clients
that consume content blocks. On the legacy path the SDK keeps compatibility by
projecting a non-object root to `{ "result": value }`; the cross-era contract
pins that behavior. A missing resource is emitted as `-32602` with
`data: { uri }`; client-side tolerance also recognizes the historical `-32002`
code only when the same URI data is present.

## Authorization hardening

Groundlane's configured OAuth provider keeps three public values consistent:
the `/mcp` protected-resource URI, its authorization-server entry, and the
authorization metadata issuer. The latter advertises CIMD and RFC 9207 issuer
response support when the checked-in Cloudflare strictly-public-fetch flag is
active. Both successful and redirected-error authorization responses include
the exact `iss`. Authorization grants and access tokens retain the requested
resource; a token minted for another resource is rejected before `/mcp`
reaches the Container.

CIMD is the preferred registration path. The bearer-protected DCR endpoint is
a compatibility fallback and applies an extra Groundlane policy:
`application_type=web` requires HTTPS redirect URIs, while
`application_type=native` requires HTTP loopback redirects. Missing or
mismatched metadata fails before client storage. The pinned provider owns the
OAuth protocol machinery; Groundlane contracts independently fix metadata,
CIMD resolution, RFC 9207, resource-audience, DCR, and the existing separation
of data-plane principal, admin token, signed internal context, and provider
secrets.

## Tasks extension boundary

Tasks is an independent `2026-07-28` extension, not part of the legacy
compatibility inference. A client opts in on each request through
`io.modelcontextprotocol/tasks`; client name, a prior request, or session state
never enables it. Only the server-directed `web_research_start` call can return
the flat task result. Groundlane implements `tasks/get`, `tasks/update`, and
`tasks/cancel` and deliberately leaves the retired `tasks/list` and
`tasks/result` methods unimplemented. Non-capable clients use the explicit
`web_research_start`, `web_research_status`, `web_research_result`, and
`web_research_cancel` tools over the same runtime.

The stable extension artifact is pinned with URL, upstream commit, byte count,
and SHA-256 under `test/fixtures/mcp/extensions/tasks/2026-07-28/`. The installed
TypeScript SDK 2.0.0 still rejects the stable extension methods before a custom
SDK request handler runs, so Groundlane has a narrow raw dispatcher before the
SDK. It intercepts only the three task methods and a capable
`web_research_start`; all other requests continue through the official handler.
Remove this seam only after a newer SDK passes the same raw transcript contract.

Self-hosted Node uses the CAS-capable SQLite durable store configured by
`ASYNC_TASK_STATE_PATH`. Cloudflare handles tasks at the already-authenticated
Worker edge and uses the `mcp-tasks-v1` namespace in `MANAGED_TOKEN_D1`; the
Container receives only a discovery flag and never receives a D1 object or raw
caller credential. Both paths preserve opaque Groundlane IDs, owner and
credential binding, hidden provider IDs, bounded TTL/result state, a five-second
poll floor, terminal monotonicity, and a provider-create effect journal. A
crash after a possibly paid create but before handle persistence becomes a
terminal uncertain result and is never retried automatically.

Linkup has no verified Research cancellation endpoint. A deliberate task cancel
can stop Groundlane polling and record upstream-cancel intent, but it cannot
claim that Linkup cancelled. Closing an individual HTTP request only aborts that
request leg and never mutates task state. Deterministic SQLite/D1 contracts do
not replace controlled Cloudflare or Claude/Codex/Cursor evidence; those remain
release gates.

## Reproducible evidence matrix

Native client probing is available through `pnpm mcp:clients --client Claude` (also Codex or Cursor). Default execution only checks executable version/help. Explicit `--run` uses an isolated temporary workspace, a literal loopback endpoint and synthetic fixtures; it requires model credentials and can incur charges. Captured transcripts remain unaccepted until reviewed per `test/fixtures/mcp/client-scenarios.json` against native server wire evidence. Cursor isolation is unverified, so live capture is currently unavailable. The deterministic matrix is not a substitute for these transcripts.

Self-hosted `DOCUMENT_ARTIFACT_STATE_PATH` additionally registers `document_result_read` and `document_result_delete`. Oversized inline/URL `document_parse` results then return `outputArtifact` instead of inline envelope/projection; clients must retrieve base64 byte chunks and parse the assembled JSON wrapper (version 1). Rollback can unset the path to disable these tools; retain the SQLite file and resume maintenance later. This does not enable Cloudflare output storage or validate target-client compatibility.

Run the deterministic matrix with:

```bash
pnpm mcp:matrix
```

The checked-in manifest is `test/fixtures/mcp/matrix.json`; the command writes
a mode-`0600` result to `.work/mcp-matrix/results.json` by default. It keeps
deterministic protocol tests, official conformance, controlled Cloudflare, and
Claude/Codex/Cursor evidence as four separate statuses. Passing the first one
does not update the others.

The latest released official conformance CLI checked on 2026-09-05 was
`@modelcontextprotocol/conformance@0.1.16`. It rejected `2026-07-28` as an
unknown spec filter, and its active `draft` suite contained zero scenarios.
Its full `2025-11-25` fixture-server suite also expects optional tools,
resources, prompts, logging, and completion fixtures that Groundlane does not
advertise. Those results are recorded as a tooling blocker, not rewritten as a
modern pass or used as an expected-failure waiver. Pin and run a requirements-
aware official release once it can select the accepted `2026-07-28` surface.

## Legacy retirement gate

The compatibility path remains enabled until all of these are true:

- deterministic legacy and modern suites pass together;
- the official conformance suite passes for the modern path;
- controlled Cloudflare smoke transcripts prove both paths;
- Claude, Codex, and Cursor transcripts cover the operations in the target
  client matrix; and
- release notes announce the retirement window and an operator rollback.

SDK type compatibility, a successful `tools/list`, or a modern-looking
request-scoped deployment is not sufficient evidence. Legacy retirement is a
separate release decision and follows the MCP minimum deprecation window.

## Rollback

Before or after dual-protocol enablement, set
`GROUNDLANE_MCP_PROTOCOL_MODE=legacy-only`, redeploy, and rerun the frozen
fixture suite plus the production smoke. This routes only supported legacy
requests to the frozen handler and rejects modern requests instead of
reinterpreting them as legacy. If the new image itself is suspect, redeploy the
last verified image as a second rollback step. Database, R2 artifact, upload,
and document core state must stay
protocol-neutral so a transport rollback does not rewrite or orphan that state.
The current upload implementation follows this boundary: both MCP eras
register the same `document_upload_create`/`document_upload_complete` module,
while authenticated Cloudflare calls execute once at the Worker edge over the
same D1/R2 service. Artifact parsing reuses the same byte-to-canonical service
through a signed binary bridge. A protocol-mode rollback changes transport
admission, not intent IDs, ArtifactRefs, ownership, credential binding, expiry,
or immutable objects.

### Rehearse rollback in isolated staging

Use the [isolated staging profile](deployment/cloudflare.md#isolated-prd-staging)
and record the verified Worker version and Container image digest before a
change. Set `vars.GROUNDLANE_MCP_PROTOCOL_MODE` to `legacy-only` in
`wrangler.staging.jsonc`, then run:

```bash
pnpm exec wrangler deploy --dry-run --config wrangler.staging.jsonc
pnpm exec wrangler deploy --config wrangler.staging.jsonc
node --test --import tsx test/contract/mcp-legacy-2025-11-25.test.ts
pnpm smoke
```

For `pnpm smoke`, supply the staging `/mcp` URL in `GROUNDLANE_MCP_URL` and its
credential securely through `GROUNDLANE_AUTH_TOKEN`. Never reuse the production
credential or omit the explicit staging config from Wrangler commands. Verify
that the deployed Container has received the changed protocol mode before
recording rollback success. A Worker-only rollout with `--containers-rollout none`
does not establish that a running Container received changed environment values.
The basic smoke proves legacy inventory/calls only; retain a separate modern
request rejection transcript to prove that the modern admission path is closed.

Retain applied D1 migrations, R2 objects, upload metadata, task/effect receipts,
output reservations and source-revocation tombstones during a rollback. Preserve
the `document-output-intents-v1` records needed to find partial writes. The
`document-dispatch-v1` expiry is next-attempt/lease eligibility, not content
retention: never feed those records to ordinary artifact deletion sweeps.
Disabling an output/cache profile can also disable its maintenance. Resume
cleanup with a verified compatible Worker and the same storage bindings; do not
clear tombstones or restore logically revoked access to make old results readable.
If reverting across a private bridge contract change, restore a compatible
Worker/Container pair rather than mixing versions.

### Observe scheduled cleanup separately

The [staging cache runner](deployment/cloudflare.md#isolated-prd-staging) emits
sanitized fixture IDs, content hashes and effective cache timestamps. Its nine
inline checks do not establish physical cleanup. For an authorized staging run:

1. Capture the runner's fixture-specific hash and expiry. Before expiry, identify
   only the matching `document-cache` core records and their R2 payload references;
   never dump arbitrary cached content. Replace the placeholder hash below with
   the exact synthetic fixture hash:

   ```bash
   pnpm exec wrangler d1 execute groundlane-prd-staging --remote --config wrangler.staging.jsonc --command "SELECT key, expires_at, json_extract(value, '$.payloadBlob.blobKey') AS blob_key FROM durable_records WHERE namespace = 'document-cache' AND json_extract(value, '$.key.contentHash') = 'sha256-REPLACE_WITH_FIXTURE_HASH' LIMIT 20;"
   ```

2. Retain the exact returned keys privately and observe the next actual hourly
   scheduled invocation in Cloudflare's Worker observability view, including its
   timestamp, outcome and any cleanup failure event. Do not rewarm this fixture
   while measuring expiry. Request-time expiry rejection alone is insufficient.
3. Repeat the same scoped D1 query after the invocation. For each previously
   captured R2 reference, verify absence in the staging bucket; the CLI can read
   only that synthetic fixture object into a private temporary file:

   ```bash
   umask 077
   pnpm exec wrangler r2 object get 'groundlane-prd-staging-artifacts/REPLACE_WITH_CAPTURED_BLOB_KEY' --remote --file '/private/tmp/REPLACE_WITH_PRIVATE_FIXTURE_FILE' --config wrangler.staging.jsonc
   ```

   A successful read means bytes remain. Only a confirmed object-not-found result
   establishes absence; authorization, timeout or other storage failures do not.
   Record sanitized before/after metadata and delete any local synthetic payload
   copy when finished. These commands must target the captured fixture only.
4. Keep cleanup pending if rows/objects remain or the invocation failed. A cache
   pass is bounded to four pages of 50 records, so backlog may require more
   invocations. For upload/delete acceptance, also retain the independent verified
   source binding and staging-object evidence. Manually removing fixture rows or
   objects cleans up the fixture but does not prove scheduled cleanup worked.

The current [inline staging artifact](verification/staging-cache-2026-09-05.json)
records `fullAcceptance: false`; upload/delete was skipped and physical cleanup
remains pending. Neither this procedure nor a successful deployment changes that
status until the corresponding evidence is collected.

## Migration sequence

1. Keep this fixture suite green. The official v1-to-v2 codemod has been run at
   the package root so imports in `src/`, `test/`, and `scripts/` are covered.
2. The generated imports were reviewed, codemod diagnostics resolved, and the
   v1 `Transport` casts removed after the v2 types agreed with the runtime.
3. Keep the split v2 packages on the explicit legacy path while the default
   protocol mode remains `legacy-only`.
4. The explicit modern handler, strict era selection, and per-request metadata
   are implemented. Cache hints, MRTR, authorization changes, and the Tasks
   extension remain separate acceptance gates.
5. Run deterministic, official conformance, controlled Cloudflare, and
   target-client gates in that order.

Primary migration references:

- <https://ts.sdk.modelcontextprotocol.io/v2/migration/>
- <https://modelcontextprotocol.io/specification/2026-07-28>
- <https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks>
- <https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2663-tasks-extension.md>
