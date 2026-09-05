# Groundlane configuration

## Async document development gate

`createEdgeDocumentAsyncRuntime` composes the durable job/effect runtime, verified upload reads and immutable output storage using native D1/R2 bindings. Its `submit` acknowledges only after an independent dispatcher entry is durable; retry the same idempotency key after an interrupted submit. The `document-dispatch-v1` namespace uses record expiry solely for next-attempt/lease eligibility, never content retention. Do not run artifact deletion sweeps against it. Drains use bounded concurrency, CAS leases, backoff and a persisted fairness cursor; no HTTP poll request drives work.

This factory is not mounted as a public endpoint, cron or MCP tool. It takes an explicitly supplied provider port and does not enable credentials, spend, or deployment. Production enablement still requires atomic job-owned source snapshots, source deletion to job cancellation, an appropriate scheduler, and controlled provider/client acceptance. Both sync and async stored payloads are `{envelope, projection}`, using the same canonical schema and invariant validation. A durable `document-output-intents-v1` namespace reserves caller/job-bound source and result identities before writing bytes. Recovery can locate a saved result or source-only partial write after a lost acknowledgment; incomplete writes are not blindly repeated. Keep this namespace with output metadata during backup/rollback, and do not apply ordinary artifact sweeps to its revocation tombstones.

Canonical document provenance represents unknown `cost` and `confidence` as `null`; known values remain finite, nonnegative numbers (confidence is at most one). Provider usage credits are separate metadata, not an inferred monetary amount.

Uploaded-source outputs keep a credential-bound `externalSourceRef` and immutable byte digest. Every result read revalidates the original verified upload. Source deletion/expiry writes a durable revocation tombstone and removes at most 100 derived results per cleanup attempt; failures retain a restart-safe cursor. Existing upload cleanup retries pending batches. Tombstones remain to fence late publication; they are not expired as ordinary artifact records. This is deterministic runtime coverage, not controlled deployment acceptance.

## Durable self-hosted document results

For Cloudflare, opt into `DOCUMENT_OUTPUT_EDGE_ENABLED=true` on the Worker; the Container receives the flag only with D1/R2/signing bindings present. `groundlane-output.internal` binds signed method/path/purpose/body and principal/credential identity. D1 contains metadata; source and canonical JSON bytes are immutable R2 objects. The encoded bridge body is capped at 16 MiB with streaming limits and cancellation; the output chunk cap remains 48 KiB and is further reduced to respect `MAX_OUTPUT_CHARS`. Scheduled cleanup processes at most four pages of 100 due records per run, retaining failures for retry. Keep the flag off for rollback and retain storage. Controlled deployment acceptance remains open.

With `CORPUS_STATE_PATH`, `source: {kind: "corpus", corpusId, sourceId}` parses enrolled normalized text after current ACL, tenant, credential, expiry, digest and manifest checks. SQLite and remote D1/R2 cache share corpus/source/hash identity with credential binding. Updates and removals revoke all parser-option bindings through the signed cache revoke route. Original document formats are not reconstructed from normalized text. Legacy role-bound blobs can be read using the exact original caller binding and migrated; unknown historical roles are not guessed.

Set `DOCUMENT_ARTIFACT_STATE_PATH` to a writable SQLite file on persistent storage. Oversized inline/URL results return `data.outputArtifact` instead of inline envelope/projection. The immutable JSON contains both fields. Each result is bound to the authenticated principal, credential and self-hosted tenant, carries SHA-256 and byte size, and expires after 24 hours (subject to the artifact operator cap). This setting does not enable Cloudflare result storage or async document jobs; source ArtifactRef parsing still follows the separate edge profile.

`document_result_read({refId, offset, maxBytes})` returns base64 bytes, `nextOffset` (`null` at EOF), total size and hash. Decode each chunk, concatenate bytes, then decode UTF-8 and parse JSON. Maximum chunk size is 48 KiB. `document_result_delete({refId})` revokes access before physical removal of result and retained source; retry when `cleanupPending` is true. Startup and minute maintenance process up to 100 due records per page, preserving retryable cleanup after storage failure. Backlog can require multiple ticks. Removing this setting disables access and maintenance; preserve the database when rolling back.

## Native client evidence capture

`pnpm mcp:clients --client Claude` defaults to version/help probing. `--run` additionally requires an explicit model, synthetic prompt file, literal loopback MCP endpoint, `GROUNDLANE_CLIENT_TEST_TOKEN`, and the selected client's API key. This invokes a real model and can incur charges. Run only against a disposable local server with synthetic fixtures. Evidence files redact known credentials and signed URL query values; the harness bounds time and output. Review captured client events together with native server wire evidence against `test/fixtures/mcp/client-scenarios.json`. No scenario is automatically passed. Cursor live capture is currently unavailable because its configuration isolation has not been verified; that status does not assert lack of Cursor MCP support.

Groundlane reads runtime configuration from environment variables. Copy [`.env.example`](../.env.example) for local development and add only the provider credentials you intend to use.

## Core service

Document parser engine version `groundlane-bounded-document-v3` is part of the
processing-cache key. Upgrading makes earlier engine entries ineligible for hits;
no cache migration or manual deletion is required. Old entries retain their
existing expiry and normal cleanup policy.

| Variable | Purpose | Default/example |
| --- | --- | --- |
| `PORT` | Node container HTTP port | `8080` |
| `GROUNDLANE_AUTH_TOKEN` | Bearer token required by `/mcp` | Required; use a long random secret |
| `GROUNDLANE_MCP_PROTOCOL_MODE` | MCP protocol exposure: `legacy-only`, `dual`, or `modern-only` | `legacy-only` |
| `GROUNDLANE_MCP_REQUEST_STATE_SECRET` | Dedicated HMAC key for modern multi-round request state; store as a secret, never a plain Worker variable | Unset (interactive MRTR disabled); minimum 32 bytes |
| `REQUEST_TIMEOUT_MS` | One end-to-end request deadline | `30000` locally |
| `MAX_RESPONSE_BYTES` | Maximum upstream response bytes | `2000000` locally |
| `MAX_OUTPUT_CHARS` | Maximum returned text characters | `100000` locally |
| `MAX_CONCURRENCY` | Maximum active requests | `4` locally |
| `MAX_QUEUE` | Maximum queued requests | `16` locally |
| `DOCUMENT_CACHE_STATE_PATH` | Optional SQLite file for durable self-hosted `document_parse` cache | Unset (cache disabled) |
| `DOCUMENT_ARTIFACT_STATE_PATH` | Optional SQLite file for self-hosted oversized document result bytes and metadata; mounts `document_result_read` / `document_result_delete` | Unset |
| `DOCUMENT_OUTPUT_EDGE_ENABLED` | Opt-in signed Container-to-Worker output storage in D1/R2; requires internal signing and native bindings | `false` |
| `DOCUMENT_CACHE_EDGE_ENABLED` | Explicitly use the private Cloudflare D1/R2 cache bridge; requires D1, R2, and `GROUNDLANE_INTERNAL_SIGNING_SECRET` | `false` locally; `true` in the reference Worker config |
| `ASYNC_TASK_STATE_PATH` | Optional SQLite file for durable self-hosted Linkup research tasks | Unset (async research tools fail closed) |
| `DOCUMENT_CACHE_DEFAULT_TTL_SECONDS` | Default `document_parse` cache TTL | `86400` (24 hours) |
| `DOCUMENT_CACHE_MAX_TTL_SECONDS` | Operator maximum caller cache TTL | `2592000` (30 days) |
| `DOCUMENT_UPLOAD_MAX_TTL_SECONDS` | Operator maximum upload-intent TTL; requests above it fail rather than clamp | `3600` (1 hour; minimum allowed cap `900`) |
| `DOCUMENT_ARTIFACT_MAX_TTL_SECONDS` | Operator maximum finalized source-artifact TTL; requests above it fail rather than clamp | `2592000` (30 days; minimum allowed cap `86400`) |

`GET /healthz` is a public process-liveness check. On the Node service, `GET /readyz` checks required service configuration. Through the Worker, a successful proxied response also confirms that the Container answered. Neither form probes provider health. `POST /mcp` requires the bearer token.

`legacy-only` is the conservative rollout default: `2025-11-25` requests use
the frozen compatibility handler and modern requests fail closed. `dual`
enables both explicit paths. `modern-only` disables the compatibility handler;
legacy traffic receives the SDK's unsupported-protocol-version response. The
runtime uses the SDK's exported era classifier before dispatch, and the modern
handler still validates the JSON-RPC body, request envelope, and standard MCP
headers. An unknown mode is a startup configuration error.

`GROUNDLANE_MCP_REQUEST_STATE_SECRET` enables the optional interactive TTL flow
on `document_policy`. The SDK-signed state expires after five minutes and is
bound to the authenticated principal, credential binding, and JSON-RPC method.
The payload is signed but not encrypted, and Groundlane stores no secrets in
it. Every Container instance that may resume a request must receive the same
deployment secret; rotating it invalidates outstanding flows. Exact replay is
allowed because this first flow is read-only and seals its evaluation time.
Keep this key distinct from caller, admin, internal-context, and provider
credentials.

## Worker authentication and Cloudflare bindings

OAuth and managed-token state remain Worker-only. The Worker validates static, managed, or OAuth credentials, then signs a bounded principal context for the Container. `GroundlaneContainer.envVars` forwards only the derived Container auth mode and the internal signing secret; it never forwards caller credentials. A direct local Node server uses `local_static` mode instead. See [OAuth for interactive cloud connectors](deployment/cloudflare.md#oauth-for-interactive-cloud-connectors) for setup.

| Variable | Purpose | Default/example |
| --- | --- | --- |
| `OAUTH_KV` | Workers KV binding storing OAuth clients, grants, and tokens | Required; created with `wrangler kv namespace create OAUTH_KV` |
| `OAUTH_OWNER_PASSPHRASE` | Gates the `/authorize` consent screen | Required; use a long random secret, separate from `GROUNDLANE_AUTH_TOKEN` |
| `MANAGED_TOKEN_D1` | D1 binding used as managed-token truth | Required for managed credentials; absent binding fails closed |
| `GROUNDLANE_ADMIN_TOKEN` | Bootstraps and recovers managed credentials through the admin API only | Optional unless managed administration is enabled; cannot call `/mcp` |
| `GROUNDLANE_INTERNAL_SIGNING_SECRET` | HMAC secret for short-lived Worker-to-Container principal contexts | Required by the Cloudflare reference deployment; keep distinct from every caller/admin secret |
| `GROUNDLANE_MCP_REQUEST_STATE_SECRET` | HMAC secret shared by Container instances for modern MRTR resume | Optional until modern interactive flows are enabled; minimum 32 bytes |
| `ASYNC_TASK_EDGE_ENABLED` | Internal Worker-to-Container discovery flag derived from D1 plus `LINKUP_API_KEY` | `false`; do not set manually in the Cloudflare reference deployment |
| `ARTIFACT_EDGE_ENABLED` | Internal Worker-to-Container discovery flag derived from D1, R2, R2 S3 presigning credentials, and internal signing | `false`; do not set manually in the Cloudflare reference deployment |
| `R2_ACCOUNT_ID` | Cloudflare account ID used to construct the direct R2 S3 upload endpoint | Required for the Cloudflare upload profile |
| `R2_BUCKET_NAME` | R2 bucket name used by the S3 presigner; must identify the `GROUNDLANE_ARTIFACTS` bucket | `groundlane-artifacts` in the reference deployment |
| `R2_ACCESS_KEY_ID` | Scoped R2 S3 API access key used only to sign short-lived upload URLs | Optional secret; upload stays unavailable without it |
| `R2_SECRET_ACCESS_KEY` | Scoped R2 S3 API secret used only to sign short-lived upload URLs | Optional secret; upload stays unavailable without it |
| `DOCUMENT_UPLOAD_MAX_TTL_SECONDS` | Maximum upload-intent TTL advertised and enforced by the Worker | `3600` |
| `DOCUMENT_ARTIFACT_MAX_TTL_SECONDS` | Maximum source-artifact TTL advertised and enforced by the Worker | `2592000` |

## Search routing

| Variable | Purpose | Default/example |
| --- | --- | --- |
| `SEARCH_PROVIDER_ORDER` | Ordered automatic-routing candidates | `tavily,exa,brave,you,tinyfish,keenable,browserbase,firecrawl,linkup,parallel,serpapi` |
| `SEARCH_MONTHLY_REQUEST_BUDGETS` | Per-instance provider dispatch attempt caps, reset each UTC month | Conservative free-plan defaults in `.env.example` |
| `SEARCH_DAILY_REQUEST_BUDGETS` | Per-instance provider dispatch attempt caps, reset each UTC day | `you:100` |
| `TAVILY_API_KEY` | Tavily credential | Optional |
| `EXA_API_KEY` | Exa credential | Optional |
| `PARALLEL_API_KEY` | Parallel credential | Optional |
| `BROWSERBASE_API_KEY` | Browserbase Search credential | Optional |
| `BRAVE_API_KEY` | Brave Search credential | Optional |
| `FIRECRAWL_API_KEY` | Firecrawl Search credential | Optional |
| `SERPAPI_API_KEY` | SerpApi credential | Optional |
| `SEARCHAPI_API_KEY` | SearchAPI.io credential | Optional; opt in because its free allowance is a one-time trial |
| `LINKUP_API_KEY` | Linkup Search credential | Optional; configured keys join automatic routing with a conservative cap |
| `KEENABLE_API_KEY` | Keenable credential | Optional; when omitted, Groundlane uses Keenable's keyless public endpoint |
| `TINYFISH_API_KEY` | TinyFish Search/Fetch credential | Optional; configured keys join automatic routing with a conservative cap |
| `SERPER_API_KEY` | Serper Google Search credential | Optional; opt in because its free allowance is a one-time trial |
| `YOU_API_KEY` | You.com REST Search credential | Optional; keyless mode (100/day) is used when unset |

Blank optional keys are treated as unset. Providers without credentials are unavailable and are skipped by automatic routing, except Keenable, which has keyless public search/content paths, and You.com, which has a keyless public search path. Missing search credentials do not prevent `web_fetch`, `web_extract`, `parse`, `provider_capabilities`, `provider_quota`, or `search_budget_status` from working. `web_answer` requires keyed answer-capable providers; today that means Linkup and You.com. `web_research` can use keyed Linkup Research, You.com Research, and Parallel Responses. `web_content` can use Linkup, You.com, Exa, Tavily, Firecrawl, TinyFish, and Keenable, with Keenable available keyless. `web_map` can use Firecrawl and Tavily when their keys are configured. `web_crawl` can use Firecrawl and Tavily when their keys are configured. `web_news` can use Brave, Serper, and SerpApi when their keys are configured. `web_images` can use Brave, Serper, and SerpApi when their keys are configured. `provider_balance` returns account balances only for providers with configured credentials and implemented balance checkers: Linkup, You.com, Firecrawl, and SerpApi. `search_budget_status` returns Groundlane's instance-local provider dispatch attempt counters and never calls third-party billing APIs. `provider_quota` combines those account-balance diagnostics, local provider dispatch budgets, and provider capabilities in one response.

`web_search` defaults to `strategy=balanced` when `provider=auto`: it selects at most two configured, capable, healthy, non-exhausted providers from `SEARCH_PROVIDER_ORDER`, preferring complementary retrieval families, and fuses exact canonical-URL matches with quality-weighted RRF (provider weights adjusted by health penalty). If a federated batch has no successful provider, Groundlane tries the next eligible batch within the same request deadline. Use `strategy=fallback` for sequential first-success routing, `strategy=deep` for at most three providers per batch, or an explicit `provider` for exactly one provider. An optional `providers` array narrows and orders the candidate pool but never bypasses credentials, capabilities, health, or budgets.

Each selected federated provider consumes a separate attempt. A partial success identifies selected, attempted, and successful providers and includes sanitized warnings for failures. Fused results expose `fusionScore` plus per-provider `sources`; raw provider `score` values are retained only as provenance because their scales are not comparable.

`web_answer` defaults to `strategy=parallel`: it selects configured answer providers, calls them concurrently, and returns each provider's grounded answer and citations separately. Use `strategy=fallback` to spend at most one successful answer call, or pin `provider=linkup` / `provider=you`. You.com Answer requires `YOU_API_KEY`; You.com's keyless MCP profile is search-only in Groundlane. Linkup Answer uses the same `LINKUP_API_KEY` as search and calls `/v1/search` with `outputType=sourcedAnswer`.

`web_research` defaults to `strategy=parallel`: it selects configured research providers and returns each provider's report and citations separately. Use `strategy=fallback` to spend at most one successful research call, or pin `provider=linkup` / `provider=you` / `provider=parallel`. Implemented provider paths are Linkup `/v1/research`, You.com `/v1/research`, and Parallel `/v1/responses` with model `parallel`. Linkup is asynchronous upstream; Groundlane creates the task and polls within the MCP request deadline, so long Linkup runs can still time out while the upstream task continues.

`ASYNC_TASK_STATE_PATH` enables a separate durable Linkup path for self-hosted Node. It stores bounded lifecycle metadata, the private provider mapping, idempotency index, and provider-create effect receipts in one revision-fenced SQLite database; provider credentials and raw authorization headers are never stored. The four compatibility tools are always discoverable but fail closed until both this path and `LINKUP_API_KEY` are configured. A capable modern caller may instead opt in to `io.modelcontextprotocol/tasks` on each request. Groundlane then returns the official flat task handle and accepts only `tasks/get`, `tasks/update`, and `tasks/cancel`; it intentionally provides no protocol `tasks/list` or `tasks/result`. TTL is 60 seconds to 24 hours, polling is throttled to at least five seconds, and unknown, expired, or unauthorized task IDs are indistinguishable. Disconnecting one HTTP request does not cancel durable work. Linkup has no verified Research cancellation endpoint, so a cancel records caller/Groundlane intent while `upstreamCancelled` remains false.

In the Cloudflare topology, the Worker derives `ASYNC_TASK_EDGE_ENABLED` for Container discovery only when `MANAGED_TOKEN_D1` and `LINKUP_API_KEY` are present. Actual task execution remains at the authenticated Worker edge because D1 bindings cannot be treated as Container-local files. This code path has deterministic fake-D1/reconnect tests; deployment and target-client support require separate live evidence.

`web_content` defaults to `strategy=parallel`: it selects configured content providers and returns each provider's extracted content separately. Use `strategy=fallback` to spend at most one successful content call, or pin `provider`. Implemented provider paths are Linkup `/v1/fetch`, You.com `/v1/contents`, Exa `/contents`, Tavily `/extract`, Firecrawl `/v2/scrape`, TinyFish Fetch, and Keenable `/v1/fetch` or `/v1/fetch/public`. Provider-returned final URLs are validated again before they leave Groundlane.

`web_map` defaults to `strategy=parallel`: it selects configured map providers and returns attributed discovered URLs from each provider plus a deduplicated top-level link list. Use `strategy=fallback` to spend at most one successful map call, or pin `provider=firecrawl` / `provider=tavily`. Implemented provider paths are Firecrawl `/v2/map` and Tavily `/map`. Groundlane validates the root URL before calling providers and validates every provider-returned URL before returning it.

`web_crawl` defaults to `strategy=parallel`: it selects configured crawl providers and returns bounded, provider-attributed pages plus job status metadata. Use `strategy=fallback` to spend at most one successful crawl call, or pin `provider=firecrawl` / `provider=tavily`. Implemented provider paths are Firecrawl `/v2/crawl` with bounded status polling and Tavily `/crawl`. Groundlane validates the root URL before calling providers and validates every provider-returned page URL before returning it.

`web_news` defaults to `strategy=parallel`: it selects configured news providers and returns attributed news results from each provider plus a deduplicated top-level result list. Use `strategy=fallback` to spend at most one successful news call, or pin `provider=brave` / `provider=serper` / `provider=serpapi`. Implemented provider paths are Brave `/res/v1/news/search`, Serper `/news`, and SerpApi `engine=google_news`. Provider-returned result URLs are validated before they leave Groundlane.

`web_images` defaults to `strategy=parallel`: it selects configured image providers and returns attributed image results from each provider plus a deduplicated top-level result list. Use `strategy=fallback` to spend at most one successful image call, or pin `provider=brave` / `provider=serper` / `provider=serpapi`. Implemented provider paths are Brave `/res/v1/images/search`, Serper `/images`, and SerpApi `engine=google_images`. Provider-returned image, thumbnail, and source URLs are validated before they leave Groundlane.

`parse` is a local deterministic parser, not a provider-backed tool. It accepts either one public `url` or caller-provided `html` with `baseUrl`, then returns one requested purpose: `document`, `metadata`, `links`, `media`, `tables`, or `all`. URL inputs first use the same bounded fetch pipeline as `web_fetch`; raw HTML inputs do not access the network. The first implementation is Groundlane-owned and uses existing HTML parsing/readability libraries behind a stable parser contract. Open-source projects such as Trafilatura, Crawl4AI, MarkItDown, anydoc, and Docling are adapter references for future parser engines, not required runtime dependencies today; the broader PDF/OCR/Office reference taxonomy lives in [Open-source references](research/open-source-references.md).

`document_parse` is the bounded synchronous file/document tool. Its `source` accepts canonical base64 inline bytes, a public URL protected by the existing fetch/SSRF policy, a verified source `ArtifactRef`, or an enrolled corpus source. With `CORPUS_STATE_PATH` configured, `{ "kind": "corpus", "corpusId": "…", "sourceId": "…" }` parses retained normalized text after current ACL, credential, identity and expiry checks; it does not reparse the original Office/PDF binary. Corpus update/remove/delete revokes the corresponding processing-cache source bindings. Inline and URL work in every profile. The Cloudflare Worker enables artifact input only when D1, `GROUNDLANE_ARTIFACTS`, all four R2 S3 settings above, and `GROUNDLANE_INTERNAL_SIGNING_SECRET` are present. `document_upload_create` then creates an owner/credential-bound, idempotent 15-minute intent and returns a short-lived, single-object presigned PUT; `document_upload_complete` reads the staging object through the native R2 binding, verifies exact size, declared/sniffed MIME and optional SHA-256, immutably finalizes it, returns a storage-neutral source ref, and removes staging. `document_artifact_delete` CAS-revokes a caller-owned ref before deleting its bytes and revokes every processing-cache binding registered for that artifact source; another source with the same content hash remains valid. The PUT URL and R2 key are transfer coordinates only and must not be persisted, logged, or passed to `document_parse`. Artifact parsing uses a separate body-hash/purpose-bound internal route so D1/R2 credentials never enter the Container or public MCP arguments. The reference Worker cron runs hourly with bounded pages: it CAS-revokes expired refs and their cache bindings before final-byte deletion, revalidates staging metadata before deletion, and retries partial failures without restoring access. Missing configuration leaves the artifact tools discoverable but fail-closed, and `document_policy` reports the runtime unavailable. This path has deterministic tests; controlled Cloudflare and target-client proof remain separate.

`output` selects `markdown` (default), `structured`, `text`, or `all`; `maxBytes`, `maxPages`, `maxOutputChars`, and `timeoutMs` only narrow operator limits. Set `DOCUMENT_CACHE_STATE_PATH` to a writable SQLite file to enable the self-hosted ownership-scoped processing cache. On Cloudflare, `DOCUMENT_CACHE_EDGE_ENABLED=true` selects the private Container-to-Worker two-phase cache bridge and stores revision-fenced metadata in D1 plus immutable payloads in R2. The bridge carries only versioned lookup/commit data; cache enablement and TTL bounds remain Worker-owned. `cacheMode=use|refresh|bypass` defaults to `use`; `cacheTtlSeconds` must be between 60 seconds and the configured `DOCUMENT_CACHE_MAX_TTL_SECONDS`, otherwise the request is rejected. Hits reuse only content-addressed parsed payload; each response rebuilds source identity and the canonical envelope for the current invocation. Bindings include a one-way credential scope; artifact-derived binding TTL cannot outlive the artifact. Cache failures fail open to fresh parsing and expose only a stable sanitized cache error. Current deterministic profiles cover text PDF, DOCX/XLSX/PPTX, CSV/TXT/Markdown/JSON/XML/HTML, and bounded ODF/RTF/EPUB/EML. OCR is not active. Explicit async document tools are present but Cloudflare execution stays disabled unless `DOCUMENT_ASYNC_EDGE_ENABLED=true`, `DOCUMENT_OUTPUT_EDGE_ENABLED=true`, `GROUNDLANE_INTERNAL_SIGNING_SECRET`, `REDUCTO_API_KEY`, primary D1, and R2 are configured together. The minute trigger drains at most eight jobs with concurrency two; the hourly trigger remains dedicated to cleanup. Neither path has controlled deployment proof yet.

`document_policy` reports the deployment's cache enablement/default mode and configured TTL bounds, and explicitly reports whether upload, artifact-source, durable async-job, and durable-corpus paths are available. The self-hosted SQLite file stores small revision-fenced metadata separately from immutable parsed-payload blobs (up to the 32 MiB internal blob cap), so protect it as application data and place it on persistent storage. Expired entries are logically unavailable immediately; the service sweeps metadata and payload bytes at startup and hourly while running. Multiple Node processes must not treat one SQLite file as a distributed cache; use a deployment-specific durable adapter after that runtime is composed and verified.

Set `CORPUS_STATE_PATH` to a writable persistent SQLite file to replace the development in-memory corpus backend with the self-hosted durable runtime. `CORPUS_TENANT_ID` sets the deployment tenant boundary and `CORPUS_MAX_SOURCE_BYTES` bounds normalized UTF-8 source content. Enrollment computes the content hash from NFC/LF-normalized bytes; a caller-provided hash is only a consistency check. Revision-fenced manifests own identity, membership, ACL, retention, deletion, and credential binding; immutable source blobs and the SQLite text index survive restart, while the index remains derived state that `rebuild` can replace exactly. `document_policy.runtime.durableCorporaAvailable` is true only when this composition is mounted. This is single-process self-host storage, not proof of a Cloudflare corpus backend.

The public provider enum includes `linkup`, `keenable`, `tinyfish`, `searchapi`, `serper`, and `you`. Linkup joins the default order when its key is configured, with a conservative 100-attempt cap. Its current pricing page advertises 4,000 free queries, while account balance is exposed through Linkup's `/credits/balance` endpoint; `100` is a Groundlane safety limit, not provider billing truth or a conversion from credits. Keenable joins automatic routing even without a key by calling `/v1/search/public` with `X-Keenable-Title`; configure `KEENABLE_API_KEY` to use its authenticated monthly allowance instead. TinyFish joins automatic routing when `TINYFISH_API_KEY` is configured; official docs describe Search as 30 requests/minute and Fetch as 150 URLs/minute, free at any wallet balance. You.com joins automatic routing even without a key through `https://api.you.com/mcp?profile=free`, which the official docs limit to 100 Search queries per day; configure `YOU_API_KEY` to use account API credits and the REST Search endpoint instead. SearchAPI.io and Serper free allowances remain finite trials, so they stay outside the automatic order and default to zero attempt caps. To use them, add them explicitly and choose caps from the provider billing screens, for example:

```text
SEARCH_PROVIDER_ORDER=linkup,tavily,exa,searchapi,serper
SEARCH_MONTHLY_REQUEST_BUDGETS=linkup:100,tavily:1000,exa:1000,searchapi:25,serper:25
```

These sample values are per-instance attempt caps, not conversions from dollars or credits and not provider billing truth. Serper currently supports only unfiltered queries in Groundlane. SearchAPI.io maps included and excluded domains to Google `site:` query operators and does not support date ranges in Groundlane. TinyFish supports include/exclude domains and maps Groundlane time ranges to its `recency_minutes` parameter. Linkup supports domain/date filters; Brave maps included and excluded domains to documented `site:` search operators; Keenable supports at most one included domain through its `site` parameter and does not support excluded domains; You.com supports either include or exclude domain lists in one request, not both together. You.com's keyless free MCP profile is separate from `YOU_API_KEY` account credits; the adapter reports a warning when it uses the free profile.

Monthly and daily budgets count attempted provider requests across `web_search`, `web_answer`, `web_research`, `web_content`, `web_map`, `web_crawl`, `web_news`, and `web_images`, including retryable failures. They prevent one running Groundlane instance from dispatching a provider-backed request after the configured cap. They are deliberately conservative safeguards, not billing truth: restarts reset the in-memory counters, multiple instances do not share them, and some services charge variable credits. Keep provider-side spend limits enabled and set budgets for your actual plans.

Use `provider_quota` first when a provider-backed tool exhausts local attempts or a search returns zero results and you need a provider-scoped diagnostic view. It combines provider account balance status, Groundlane local provider-dispatch budgets, currently exposed tools, and `searchRouting` hints for credential/keyless/budget checks. Use `search_budget_status` when you specifically need the raw local daily or monthly attempt counters. Use `provider_balance` only for provider-owned account balances. A `provider_balance` result of `not_configured` means the runtime lacks the credential needed for that provider's balance API; it does not prove that keyless quota or provider-side credits are exhausted.

Providers that return errors (429, 5xx) accumulate a dynamic penalty that temporarily deprioritizes them; five consecutive failures trip a circuit breaker that skips the provider for 60 seconds. Both mechanisms self-recover when the provider starts responding again.

## Reader and browser backends

| Variable | Purpose | Default/example |
| --- | --- | --- |
| `READER_BACKEND` | Hosted Markdown Reader fallback: `disabled` or `jina` | `jina` in deployment config; `disabled` in code defaults |
| `BROWSER_BACKEND` | Browser capability: `disabled`, `local`, or `browserless` | `disabled` in code; local `.env.example` uses `local` |
| `BROWSERLESS_TOKEN` | Browserless `/content` credential | Required only for `browserless` |
| `BROWSERLESS_REGION` | Browserless endpoint region: `sfo`, `lon`, or `ams` | `sfo` |
| `JINA_READER_RPM` | Proactive Jina Reader rate limit (requests per minute) | `20` |
| `BROWSERLESS_MONTHLY_UNITS` | Proactive Browserless monthly unit cap | `1000` |

The built-in Groundlane Reader is local normalization and needs no credential. Enabling Jina or Browserless sends eligible public target URLs to that hosted provider. HTML, explicit CSS selectors, wait conditions, and `render=always` do not use Jina Reader.

The fetch pipeline proactively tracks Jina Reader RPM and Browserless monthly units in-memory. When a backend's budget is exhausted, the pipeline skips it and falls back to the next option instead of wasting latency on a 429 response.

## Verification

Run `pnpm mcp:matrix` to execute the deterministic legacy/modern/auth/MRTR/
Tasks/upload matrix and write the machine-readable result under `.work/`.
Official conformance, controlled Cloudflare, and target-client evidence remain
separate fields and are never inferred from that local result.

With the local service running and the token exported:

```bash
pnpm smoke
```

Set `GROUNDLANE_SMOKE_BROWSER=1` to include the configured browser path. The smoke script calls only the reserved `example.com` documentation domain and does not require a search-provider key.

For Cloudflare secret setup and the Worker-to-Container environment allowlist, see the [deployment guide](deployment/cloudflare.md).
