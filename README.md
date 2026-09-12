<div align="center">

# Groundlane

**The trusted web access layer for AI agents.**

[![CI](https://github.com/vincentxuu/groundlane/actions/workflows/ci.yml/badge.svg)](https://github.com/vincentxuu/groundlane/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-early_preview-orange.svg)

[Quick start](#quick-start) · [Connect](#connect-an-mcp-client) · [Tools](#tools-at-a-glance) · [Deploy](#run-groundlane) · [Docs](#documentation)

[English](README.md) · [繁體中文](README.zh-TW.md)

</div>

Canonical document provenance uses `null` for unknown cost or confidence. Provider credits remain separate metadata; they are not converted into currency or reported as zero cost.

The parser engine version is `groundlane-bounded-document-v3`. Its cache keys exclude earlier engine versions from reuse; upgrading requires no cache migration or manual deletion.

Async document development includes a restartable dispatcher, native D1/R2 composition, durable output write reservations and retryable cancellation/expiry cleanup. Sync and async stored results share `{envelope, projection}`. This is not a public async API: atomic job-owned source snapshots, source-to-job revocation, scheduler/tool configuration and live acceptance are still required before enablement.

The opt-in edge output profile also links uploaded sources to derived results. Reads revalidate the original source; source deletion or expiry revokes derived access and retains a durable cleanup cursor for retries. These paths have deterministic tests; controlled deployment and client acceptance remain open.

`document_parse` also accepts an enrolled `{ "kind": "corpus", "corpusId": "…", "sourceId": "…" }` source when `CORPUS_STATE_PATH` is configured. This parses retained normalized text, enforces current ACL/identity/expiry, and shares cache bindings with corpus update/remove/delete. It does not reprocess the original Office/PDF binary.

The optional `DOCUMENT_OUTPUT_EDGE_ENABLED=true` profile stores oversized inline/URL/corpus results through a signed private D1/R2 bridge. It requires D1, R2 and the internal signing secret. The bridge enforces a 16 MiB encoded request limit, Worker-owned TTL, bounded chunks and cleanup. The reference flag remains off pending controlled deployment and client acceptance.

Self-hosted document results: set `DOCUMENT_ARTIFACT_STATE_PATH` to retain oversized inline/URL `document_parse` output as JSON for 24 hours. Read its `outputArtifact.refId` with `document_result_read` in bounded base64 chunks; use `document_result_delete` to revoke the result and clean up its retained source. Ownership includes tenant and credential binding. Cleanup runs in pages of 100 once per minute; restart resumes cleanup. The MCP inventory also exposes explicit fallback `document_job_create`, `document_job_status`, and `document_job_cancel` tools. Cloudflare execution is fail-closed and remains disabled unless async and output edge flags, the internal signing secret, Reducto credential, primary D1, and R2 are all configured. Controlled Cloudflare output/async acceptance remains pending.

Client evidence: `pnpm mcp:clients --client Claude` (or `Codex` / `Cursor`) probes local executable versions and isolation flags without running a model. See `--help` for explicit live capture. A captured transcript requires per-scenario review; successful process exit does not mark Tasks, reconnect, or upload compatibility as passed.

Groundlane is an open-source remote MCP server and trusted content access layer for AI agents. Today it provides one controlled interface for Web search, retrieval, deterministic extraction, URL/raw-HTML parsing, and a first bounded synchronous `document_parse` slice. The document tool accepts inline bytes or policy-checked public URLs and returns one canonical envelope with Markdown, structured, text, or all projection. A fully configured Cloudflare Worker can also create direct-to-R2 upload handoffs, finalize verified source `ArtifactRef`s, process them through a signed Worker-to-Container bridge, and keep the processing cache in D1/R2 through a separate private two-phase bridge. These paths have deterministic tests but no controlled production or target-client proof yet. Self-hosted Node deployments can opt into a durable SQLite processing cache and durable corpus runtime. OCR is available through `document_ocr` (OCR.space), audio transcription through `document_transcribe` (Workers AI Whisper), and legacy Office conversion through `document_convert` (anydoc WASM, zero cost). `document_smart_parse` auto-detects file type and routes to the correct tool. Async document execution, model-assisted parsing, and a Cloudflare corpus backend remain roadmap work. The operator-owned corpus control plane keeps portable corpus identity, source enrollment, access, freshness, deletion, and citation contracts separate from its rebuildable SQLite index.

> [!IMPORTANT]
> Groundlane is an early preview (`0.1.0`). Tool contracts and deployment behavior may change. The target OSS V1 Stable Release is an operator-hosted open-source product; Managed Groundlane Cloud is a later roadmap item, not an available service. Groundlane is not a CAPTCHA solver or a universal anti-bot bypass.

OSS V1 Stable is planned as a Web + document release rather than a Web-only release. The current `document_parse` implementation has deterministic local profiles for text-based PDF; DOCX, XLSX, and PPTX; CSV, TXT, Markdown, JSON, XML, and HTML; and bounded ODF, RTF, EPUB, and EML. These profiles still require the remaining security corpus and live client/release gates before V1 can be declared stable. OCR is implemented via `document_ocr`, legacy Office conversion via `document_convert` (anydoc WASM, zero cost), audio transcription via `document_transcribe`, and table extraction via `document_table_extract`. Complex layout/formula/figure recovery and scholarly full-text extraction remain experimental roadmap candidates. The existing `parse` tool remains the backward-compatible URL/raw-HTML parser.

The document roadmap uses configurable, bounded retention rather than silent permanent storage. Working defaults are a 15-minute upload intent, a one-hour staging cleanup window, a 24-hour transient artifact, and a 24-hour ownership-scoped processing cache. Callers may adjust upload, artifact, and cache expiry within operator-advertised bounds; out-of-range requests are rejected instead of silently clamped. The staging cleanup window is operator-controlled. Operators may change defaults/maxima or disable caching through an observable document policy. Explicit corpus enrollment uses its own retention policy and defaults to retention until removal; expiry extension is always explicit.

`document_parse` returns the versioned, provider-neutral canonical document envelope and a deterministic projection. Markdown is the default projection; text, structured, and all-output modes are explicit options and declare lossiness, omissions, and canonical references. Self-hosted inline and URL parsing can return a durable result reference when DOCUMENT_ARTIFACT_STATE_PATH is configured; otherwise oversized output is rejected. Artifact source input is active only on the Cloudflare edge profile when D1, R2, R2 S3 presigning credentials, and the internal signing secret are all configured; otherwise it fails closed. The existing URL/raw-HTML `parse` schema remains compatible.

Document execution keeps an explicit dual-track contract. The current deterministic slice is synchronous and bounded by one end-to-end deadline; it never silently becomes an async job. Set `DOCUMENT_CACHE_STATE_PATH` on the self-hosted Node service to enable the ownership-scoped SQLite processing cache; `document_parse` then supports `use`, `refresh`, and `bypass`, including restart-safe hits and source-specific rebinding. The reference Cloudflare profile explicitly enables the same cache contract over D1 metadata and R2 immutable payloads. Container parsing uses a versioned, body-bound private lookup/commit bridge; Worker-owned TTL policy cannot be overridden by the Container. Credential-scoped source bindings and artifact-expiry caps prevent cross-credential reuse or cache retention beyond the source. Set `CORPUS_STATE_PATH` to mount the self-hosted durable corpus runtime: its manifest is lifecycle and authorization truth, normalized source bytes are immutable artifacts, and its SQLite search index is rebuildable derived state. Corpus/source expiry, ACL, credential and tenant binding, restart, exact rebuild, removal, and retryable deletion are enforced without changing public-Web `web_search`. A Cloudflare corpus backend, controlled result-storage acceptance, and document async jobs remain open. The checked-in hourly Worker cron performs bounded artifact, staging, and cache cleanup; controlled deployment evidence remains pending. Linkup async research is a separate, conditionally configured MCP Tasks path described below.

## Tools at a glance

| Tool | What it does | Current execution paths |
| --- | --- | --- |
| `web_fetch` | Reads a public URL as Markdown, text, or HTML | Bounded HTTP, local readable normalization, and eligible optional Jina/browser fallbacks |
| `web_search` | Searches the public web with normalized results | Bounded auto fusion with next-batch retry, explicit single-provider, fallback, or deep routing across fourteen providers |
| `web_answer` | Retrieves grounded answers from answer-capable providers | Parallel fan-out or fallback across You.com Answer and Linkup sourced answers, with provider attribution and citations |
| `web_research` | Retrieves provider-attributed research reports | Parallel fan-out or fallback across Linkup Research, You.com Research, and Parallel Responses, with citations |
| `web_research_start` / `status` / `result` / `cancel` | Starts and reconnects to durable Linkup research | Explicit compatibility tools over the same durable runtime as MCP Tasks; no global list and no provider task ID exposure |
| `web_content` | Fetches URL content through provider content APIs | Parallel fan-out or fallback across Linkup Fetch, You.com Contents, Exa Contents, Tavily Extract, Firecrawl Scrape, TinyFish Fetch, Keenable Fetch, and Crawl4AI |
| `web_map` | Discovers URLs from a public site | Parallel fan-out or fallback across Firecrawl Map and Tavily Map, with provider attribution |
| `web_crawl` | Crawls bounded pages from a public site | Parallel fan-out or fallback across Firecrawl Crawl and Tavily Crawl, with capped pages and content |
| `web_news` | Searches news-specific provider indexes | Parallel fan-out or fallback across Brave News, Serper News, and SerpApi Google News |
| `web_images` | Searches image-specific provider indexes | Parallel fan-out or fallback across Brave Images, Serper Images, and SerpApi Google Images |
| `web_extract` | Extracts named fields into structured JSON | Deterministic selector and bounded pattern engines with per-call output caps; no implicit LLM step |
| `web_extract_schema` | Extracts structured fields from a URL against a caller-provided bounded schema using a provider model | Explicit opt-in provider-backed extraction; remote `$ref` and unbounded nesting are rejected |
| `parse` | Parses a URL or raw HTML into reusable structures | Local document, metadata, link, media, and table parsers; URL inputs use the bounded fetch pipeline |
| `document_smart_parse` | Auto-detects file type and routes to the correct parser | Meta-tool: scanned PDF→OCR, legacy Office→convert, ZIP→archive, EML→email, audio→transcribe, else→parse; no LLM; reports `routedTo` and `routeReason` |
| `document_archive_extract` | Extracts and parses files from a ZIP archive | Deterministic, no LLM or external API; each supported file inside parsed through the same engine as `document_parse` |
| `document_chunk` | Splits parsed document blocks into hierarchical multi-level chunks for RAG | Deterministic, no LLM; configurable token levels (default 2048→512→128); each chunk has parent-child references and block provenance |
| `document_toc` | Extracts a structured table-of-contents tree from a document | Deterministic heading detection via Markdown `#`, HTML `<h1>`–`<h6>`, ALL-CAPS, and Title Case heuristics |
| `document_email_extract` | Parses EML with recursive attachment extraction | Deterministic; returns headers, body text, and each attachment parsed through the same engine as `document_parse` |
| `document_ocr` | Extracts text from scanned PDFs and images using OCR | OCR.space API (free 25k requests/month); supports PDF, PNG, JPEG, GIF, TIFF, BMP, WebP; fail-closed when `OCR_SPACE_API_KEY` is not configured |
| `document_transcribe` | Transcribes audio to text with word-level timestamps | Cloudflare Workers AI Whisper (free 10k Neurons/day); supports MP3, WAV, WebM, OGG, FLAC, M4A; reuses `CF_BROWSER_ACCOUNT_ID` and `CF_BROWSER_API_TOKEN` |
| `document_convert` | Converts document files to Markdown or modern Office formats | Default: anydoc WASM (14 formats, zero cost, no API key); optional CloudConvert fallback for `.docx`/`.xlsx`/`.pptx` binary output |
| `document_table_extract` | Extracts tables from PDFs using spatial heuristics | Deterministic, no LLM or external API; pdf.js-based coordinate analysis; works best on regular grid-aligned tables |
| `document_compare` | Compares two documents and returns a structured diff | Deterministic, no LLM or external API; parses both documents through `document_parse`, then produces block-level additions, deletions, and changes |
| `document_parse` | Parses a bounded document into a canonical envelope and deterministic projection; `effort` parameter controls quality-cost tradeoff (`fast` = local anydoc, `standard` = auto OCR upgrade, `deep` = Docling-serve VLM or MinerU Cloud) | Inline base64 or policy-checked public URL; optional self-hosted SQLite cache; verified source ArtifactRef on the fully configured Cloudflare edge profile |
| `document_upload_create` / `document_upload_complete` | Creates a credential-bound single-PUT handoff, then verifies and finalizes a source ArtifactRef | Cloudflare Worker edge only when D1, R2, R2 S3 presigning credentials, and internal signing are configured; otherwise fail-closed |
| `document_artifact_delete` | Immediately revokes a caller-owned source ArtifactRef, deletes its immutable bytes, and revokes all parser-option cache bindings for that source | Cloudflare Worker edge; deletion and expiry cleanup are credential/owner scoped and retryable |
| `document_result_read` / `document_result_delete` | Reads or revokes a durable self-hosted document result by its `refId` | Self-hosted Node when `DOCUMENT_ARTIFACT_STATE_PATH` is configured; bounded base64 chunks with ownership and credential binding |
| `document_job_create` / `status` / `cancel` | Creates, reads, or cancels an async document job from a verified source | Cloudflare edge when async, output edge, internal signing, Reducto credential, D1, and R2 are all configured; otherwise fail-closed |
| `document_policy` | Reads the provider-neutral document/artifact policy: cache, upload, artifact, and corpus defaults with hard caps | Read-only policy introspection; interactive TTL available in modern protocol mode |
| `corpus_create` / `corpus_delete` | Creates or deletes an operator-owned corpus with retention caps | Self-hosted durable SQLite runtime when `CORPUS_STATE_PATH` is configured |
| `corpus_enroll` / `corpus_update` / `corpus_remove` | Enrolls, updates, or removes a source in a corpus with ACL, retention, and provenance | Self-hosted durable SQLite runtime; removal immediately revokes access and cache bindings |
| `corpus_status` | Reads corpus manifest truth, enrollment counts, backend health, and deletion state | Self-hosted durable SQLite runtime |
| `corpus_search` | Searches an operator-owned corpus with boundary and freshness provenance | Self-hosted durable SQLite runtime; results are never labeled as public web search |
| `corpus_retrieval_test` | Tests retrieval quality for a corpus query against expected source IDs | Wraps `corpus_search`; reports recall, rank, and missed sources — no LLM, read-only |
| `corpus_source_inspect` | Inspects a corpus source by parsing it into document blocks with previews and field labels | Requires durable corpus storage; read-only, no LLM — useful for QA before RAG indexing |
| `corpus_chunk_inspect` | Inspects how a corpus source will be chunked for RAG ingestion with hierarchical previews and field labels | Requires durable corpus storage; read-only, no LLM — useful for verifying chunk quality before indexing |
| `crawl_create` / `crawl_status` / `crawl_result` / `crawl_cancel` | Creates, reads, pages, or cancels a durable provider-neutral crawl job | Full/Container mode only; Lite advertises the tools but fails closed with `PROVIDER_UNAVAILABLE` because it has no durable crawl-job store |
| `provider_balance` | Checks provider account-balance APIs when available | Linkup credits, You.com keyed credits, Firecrawl remaining credits, and SerpApi searches left; unsupported providers return explicit diagnostic status |
| `provider_capabilities` | Lists provider features and Groundlane-exposed surfaces | Static capability matrix that separates vendor features from currently implemented Groundlane tools |
| `provider_quota` | Combines account balance, local tool budgets, capabilities, and routing hints | One provider-scoped diagnostic view for billing status, Groundlane provider-dispatch guardrails, exposed tools, keyless availability, and next checks |
| `search_budget_status` | Inspects Groundlane's local provider attempt guardrails | Instance-local daily/monthly counters with limit, used, remaining, exhausted, and reset metadata; not provider billing truth |
| `tool_policy` | Queries tool cost tier, latency tier, provider requirements, and read-only status | Static policy metadata for agent decision-making before tool calls; no live measurements |
| `paper_search` | Searches academic papers on Semantic Scholar | Free API (1k req/s unauthenticated); returns title, abstract, authors, year, venue, citations, TL;DR, DOI, ArXiv ID, and open access PDF link |
| `paper_lookup` | Looks up a specific paper by ID, DOI, or ArXiv ID | Free API; returns full metadata with references and citations lists |
| `error_log` | Operator-only: queries the Groundlane error log | Cloudflare Analytics Engine query filtered by tool, code, hintCode, or time range; returns up to `limit` most recent matching events newest first |

Fetch/extract/parse results report retrieval provenance such as `engine`, `backend`, `finalUrl`, `bytes`, and `truncated` when they fetch a URL. Automatic search defaults to batches of at most two complementary providers, canonical-URL deduplication, and RRF while retaining selected/attempted/succeeded provider provenance; if a federated batch has no successful provider, Groundlane tries the next eligible batch within the same deadline. Non-explicit `web_search` fallback treats a single provider rejection, timeout, quota error, 5xx, or malformed response as a warning and continues to the next eligible provider; an explicit `provider` preserves that provider's error instead of silently switching sources. Provider-backed tools such as `web_answer`, `web_research`, `web_content`, `web_map`, `web_crawl`, `web_news`, and `web_images` default to parallel fan-out and return each provider result separately instead of synthesizing them. Pinning a provider stays single-source. `web_fetch`, `web_extract`, and URL-backed `parse` work without a search-provider key.

Provider vendors expose more APIs than Groundlane currently wires into MCP. See [provider inventory](docs/operations/provider-inventory.md) for the verified feature backlog and the distinction between vendor capability, implemented Groundlane tool, live smoke, account balance evidence, and Groundlane's local attempt budgets.

Use `provider_quota` as the first diagnostic view when a provider-backed tool exhausts local attempts or `web_search` returns zero results: it shows provider account-balance status, Groundlane's local provider-dispatch budgets, implemented tools, and `searchRouting` hints together. Use `provider_balance` for provider-owned account credits only, and `search_budget_status` when you specifically need the raw local attempt counters. A balance result of `not_configured` means the runtime lacks the credential needed for that provider's balance API, not that keyless quota is exhausted.

### Research compatibility

`web_research` deliberately keeps one synchronous MCP contract even when an upstream provider is asynchronous. You.com Research and Parallel Responses return synchronously. Linkup Research creates an upstream task with `POST /v1/research`, then Groundlane polls `GET /v1/research/{id}` inside the same request deadline and returns the completed report when available.

Long Linkup research jobs can outlive the MCP request. In that case Groundlane returns a bounded timeout/cancellation error instead of blocking indefinitely; the upstream provider task may still continue outside Groundlane. Use `effort=lite`, `strategy=fallback`, and `provider=linkup` when you want the cheapest bounded Linkup path.

For durable research, self-hosted Node operators configure both `ASYNC_TASK_STATE_PATH` and `LINKUP_API_KEY`. Modern `2026-07-28` callers that declare the per-request `io.modelcontextprotocol/tasks` extension may receive a server-directed task from `web_research_start` and then use exactly `tasks/get`, `tasks/update`, and `tasks/cancel`. Other callers use the four explicit tools above. Task IDs are Groundlane-owned and owner/credential-bound; provider IDs stay private. State uses revision-fenced SQLite locally and D1 at the Cloudflare Worker edge, with a five-second minimum polling interval, bounded TTL, monotonic terminal states, and a durable provider-create effect journal. Linkup documents no Research cancel endpoint, so cancellation stops Groundlane polling but does not claim upstream cancellation. These paths have deterministic local/D1 tests; the current checkout has not yet supplied controlled deployment or Claude/Codex/Cursor transcripts.

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

Groundlane uses the split TypeScript SDK v2 packages and has explicit legacy
`2025-11-25` and modern `2026-07-28` handlers. The conservative default is
`GROUNDLANE_MCP_PROTOCOL_MODE=legacy-only`; use `dual` only for controlled
migration testing, or `modern-only` to disable legacy compatibility. The modern
path supports self-contained requests, `server/discover`, and per-request
client metadata without `initialize` or `Mcp-Session-Id`. Modern catalog and
resource cache hints are explicitly private with a zero TTL, so dynamic
availability and caller capabilities are rebuilt per request. This local runtime
also checks the standard routing headers against the JSON-RPC body at both the
Worker and Container, caps authenticated JSON edge inspection at 1 MiB, does
not reflect caller-controlled names in mismatch errors, and propagates request
cancellation instead of rewriting it as a Container outage. This local runtime
support is not evidence of deployed conformance or target-client support. The
fixtures, coexistence gates, and rollback sequence are documented in
[MCP protocol migration and rollback](docs/mcp-migration.md).

In `dual` or `modern-only` mode, `document_policy` can request an interactive
TTL with `interactiveTtlFor`. This bounded, read-only multi-round trip requires
the separate `GROUNDLANE_MCP_REQUEST_STATE_SECRET` (at least 32 bytes). Its
five-minute request state is signed, caller/credential/method-bound, safe to
resume on another instance sharing the secret, and readable rather than
encrypted; it must never contain secrets. Exact retries are supported, while
disconnecting one HTTP leg only cancels that leg and does not cancel a task.

MCP Tasks is separately opt-in on every request. It is advertised only when a
durable runtime is configured locally or when the Worker has both D1 and a
Linkup key. The installed SDK does not yet dispatch the stable extension
methods, so Groundlane uses a bounded raw adapter for the official three-method
surface and leaves every other method on the SDK handler. This is an
implementation compatibility seam, not target-client proof.

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
DCR clients must explicitly send `application_type`: `web` requires HTTPS
redirects, while `native` is limited to HTTP loopback redirects.
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
| **Cloudflare Worker Lite** | **Zero-cost production ($0)** | `wrangler deploy -c wrangler.lite.jsonc` |
| Cloudflare Worker + Container | Full mode with Playwright browser | `wrangler deploy` |

### Lite vs Full mode

Groundlane supports two Cloudflare deployment modes:

| | Lite (Worker-only) | Full (Worker + Container) |
| --- | --- | --- |
| Config | `wrangler.lite.jsonc` | `wrangler.jsonc` |
| Entry | `src/worker/lite-index.ts` | `src/worker/index.ts` |
| Data layer | D1 + R2 | node:sqlite (in-container) |
| HTTP fetcher | Workers `fetch()` | SSRF-safe `node:http` with DNS filtering |
| Browser | Disabled (CF Browser Rendering ready) | Playwright + Chromium |
| MCP tools | All 57 tools | All 57 tools |
| Cost | **$0** (Workers free tier) | ~$1.5–3/mo (container memory + disk) |

Lite keeps the same discoverable tool surface, but `crawl_create`,
`crawl_status`, `crawl_result`, and `crawl_cancel` return
`PROVIDER_UNAVAILABLE`; durable crawl-job state currently requires Full mode.

Deploy lite mode:

```bash
wrangler d1 migrations apply groundlane-managed-tokens -c wrangler.lite.jsonc --remote
wrangler secret bulk .cloudflare-secrets.env -c wrangler.lite.jsonc
wrangler deploy -c wrangler.lite.jsonc
```

## Supported adapters

| Groundlane capability | Implemented adapters |
| --- | --- |
| Search | Linkup, Keenable, TinyFish, Parallel, Browserbase, Brave, SerpApi, SearchAPI.io, Tavily, Exa, Firecrawl, Serper, You.com, SearXNG (self-hosted) |
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
| Browser rendering | Local Playwright, Browserless, Hyperbrowser, or CF Browser Rendering API (opt-in) |
| Cloudflare runtime | Worker-only lite mode or Worker + Container full mode; CF Browser Rendering, AI Search, AI Gateway, Agents, and Workflows are documented future adapter surfaces |

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

### Document, browser, and research provider credentials

The tools below use external services that are separate from the search provider router. Each is optional and fail-closed when not configured. Env var names link to signup pages.

| Provider | Groundlane tool | Env var | Free allowance | Card required? |
| --- | --- | --- | --- | --- |
| [OCR.space](https://ocr.space/OCRAPI) | `document_ocr` | `OCR_SPACE_API_KEY` | 25,000 requests/month (permanent) | No |
| [Cloudflare Workers AI](https://dash.cloudflare.com/) | `document_transcribe` | `CF_BROWSER_ACCOUNT_ID` + `CF_BROWSER_API_TOKEN` | 10,000 Neurons/day (permanent) | No |
| [CloudConvert](https://cloudconvert.com/api/v2) | `document_convert` (modern-office output only) | `CLOUDCONVERT_API_KEY` | 25 conversions/day (permanent) | No |
| [Semantic Scholar](https://www.semanticscholar.org/product/api#api-key-form) | `paper_search` / `paper_lookup` | `SEMANTIC_SCHOLAR_API_KEY` | 100 req/s with key; ~1 req/min without | No |
| [Hyperbrowser](https://app.hyperbrowser.ai/) | `web_fetch` (browser render) | `HYPERBROWSER_API_KEY` | 1,000 credits once (not renewable) | No |
| [Crawl4AI](https://github.com/unclecode/crawl4ai) | `web_content` | `CRAWL4AI_BASE_URL` | Open source; run `docker run -p 11235:11235 unclecode/crawl4ai` then set URL | N/A |
| [SearXNG](https://docs.searxng.org/) | `web_search` | `SEARXNG_BASE_URL` | Open source; run `docker run -p 8888:8080 searxng/searxng` then set URL; unlimited searches | N/A |
| anydoc (built-in) | `document_convert` (markdown output) | — | Built-in WASM, zero cost | N/A |

`document_parse`, `document_table_extract`, `document_archive_extract`, `document_email_extract`, `document_chunk`, `document_toc`, `document_compare`, and `document_smart_parse` are fully built-in and require no external credentials.

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
                              document_smart_parse | document_parse | document_ocr | document_convert
                              document_table_extract | document_chunk | document_toc | document_compare
                              document_archive_extract | document_email_extract | document_transcribe
                              paper_search | paper_lookup
                              diagnostics: provider_quota | provider_balance | search_budget_status | provider_capabilities | error_log
    |
    +-- provider router       replaceable search adapters (14 providers incl. self-hosted SearXNG)
    +-- safe HTTP + Reader    bounded retrieval and readable content
    +-- browser backend       local Playwright, Browserless, Hyperbrowser, or CF Browser Rendering
    `-- document engine       bounded parser, anydoc WASM, OCR.space, Workers AI Whisper
```

Core policies do not depend on a search provider or browser runtime. Groundlane Reader uses Mozilla Readability with a local fallback for selector-free Markdown/text; raw HTML and explicit selectors retain deterministic DOM semantics. See [Architecture](docs/architecture.md) and the reproducible [Reader benchmark](docs/research/reader-benchmark.md).

## Security and limitations

Web retrieval is SSRF-sensitive. Groundlane treats user URLs, redirects, provider-returned URLs, browser subresources, WebSockets, and DNS answers as untrusted. Keep authentication enabled, preserve the default limits, and apply an outbound network policy in production.

Groundlane does **not** guarantee CAPTCHA solving, invisible automation, or access to content the operator is not authorized to retrieve. Rendering JavaScript is not proof of anti-bot bypass. The local browser gives a detected access challenge at most five seconds to clear; if the original request deadline has not expired first, a persistent challenge returns retryable `UPSTREAM_ERROR` at `browser-challenge`. `web_fetch` does not automatically spend provider credits by switching to `web_content`; callers must opt into provider-backed retrieval explicitly. See [SECURITY.md](SECURITY.md) for the threat model and private vulnerability reporting.

## Project status

An isolated PRD staging profile is available in `wrangler.staging.jsonc`, with independent Cloudflare storage and no production provider keys. See the [staging deployment and cache smoke runbook](docs/deployment/cloudflare.md#isolated-prd-staging). Provisioning or deploying it does not satisfy the remaining live acceptance gates.

Staging's [nine public MCP inline cache checks](docs/verification/staging-cache-2026-09-05.json) passed on 2026-09-05 after fixing private outbound-handler registration. Source-upload/delete and scheduled physical-cleanup evidence remain separate gates.

`pnpm smoke` checks the default profile's exact tool inventory and basic calls; inventory drift is regression-tested against the local MCP composition. It does not replace upload/cache lifecycle or Claude/Codex/Cursor acceptance.

- Current source version: `0.1.0` early preview; no stable tool-contract guarantee yet.
- Implemented locally: the listed Web/search/extraction/parser/provider/corpus tools; synchronous deterministic `document_parse`; optional restart-safe SQLite document cache and corpus runtime; Cloudflare Worker + Container; D1 managed-token authentication; MCP Tasks; the credential-bound D1/R2 source upload/finalize/parse path; and private Container-to-Worker D1/R2 cache composition. These paths have deterministic bridge, fake-D1/R2, deadline/cancellation, restart/rebuild, isolation, and bounded-cleanup tests. Cloudflare corpus composition, controlled result-storage deployment, and live client verification remain pending.
- Controlled D1 revoke acceptance passed on 2026-09-05: three initializations before revoke, ten 401 responses after commit, healthy control and fixture cleanup. [Evidence and scope](docs/verification/managed-revoke-2026-09-05.json); [repeatable operator smoke](docs/deployment/cloudflare.md). Admin revoke API and multi-region behavior were not exercised.
- Next: complete controlled dual-protocol, Tasks, R2 upload, scheduled-cleanup, and explicit async-document smokes, then retain Claude/Codex/Cursor transcripts before enabling the modern protocol in production. The managed-token registry and admin-only credential API are already wired to D1; the operator CLI is `tsx scripts/groundlane-credentials.mts`. Remaining document work includes controlled result-storage/async acceptance and a Cloudflare corpus backend. Short research stays synchronous unless the caller explicitly chooses the Tasks/fallback path, and provider results remain separate. Generic LLM extraction, persistent authenticated browser sessions, and broader Groundlane-owned long-running orchestration remain demand-gated roadmap items.
- Open-source references are split into primary references and watchlist/discovery sources in the product requirements so low-maintenance candidates do not become runtime priorities by default.
- Self-hosted document processing can enable an ownership-scoped, content-addressed SQLite result cache with a 24-hour working default, bounded caller TTL/cache controls, engine/version provenance, and source rebinding. The Cloudflare profile composes the same contract over D1/R2 when `DOCUMENT_CACHE_EDGE_ENABLED=true`; nine inline cache checks passed in isolated staging; verified-source delete and physical-cleanup acceptance remain open. `document_artifact_delete` and artifact expiry cleanup revoke every parser-option binding for that source without invalidating another source with identical bytes. Corpus update/remove/delete invalidates the corresponding normalized-source cache bindings; the Cloudflare corpus backend and its controlled lifecycle acceptance remain open. This does not cache `web_fetch`, `web_extract`, or `parse`.
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
