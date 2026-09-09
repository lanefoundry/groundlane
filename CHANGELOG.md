# Changelog

## Unreleased

- Modern MCP requests with coherent routing headers but SEP-2575 `_meta`
  missing `_meta`/`protocolVersion`/`clientCapabilities` now fail with
  `-32602 Invalid params` (HTTP 400) instead of `-32020`; header/body
  routing drift and the legacy handshake keep `-32020`. Worker edge and
  Container agree; see `docs/verification/conformance-2026-07-28-2026-09-06.json`.
- Added optional private D1/R2 result storage with signed save/read/delete,
  streaming body caps, bounded reads and retryable scheduled cleanup.
- Connected enrolled normalized corpus text to `document_parse` and shared
  SQLite/remote cache invalidation on update/remove/delete.
- Added provider-neutral async document lifecycle with durable provider receipts,
  source snapshots and result artifacts. Actual provider/dispatcher wiring and
  live acceptance remain pending.

- Added an explicit dual-mode MCP migration path: frozen `2025-11-25`
  compatibility plus opt-in `2026-07-28` discovery, routing validation,
  request-scoped catalogs, multi-round requests, and Tasks extension handling.
- Added durable MCP Tasks over SQLite and Worker-edge D1, with explicit fallback
  tools, ownership and credential binding, reconnect, bounded polling, and
  receipt-journaled updates plus conservative, acknowledgment-bound
  cancellation reporting.
- Added the conditional Cloudflare document upload path: credential-bound D1
  intents, direct single-PUT R2 handoff, verified immutable source
  `ArtifactRef`, a body-bound Worker-to-Container parser bridge, and bounded
  hourly staging/final cleanup with logical revocation before byte deletion.
  The new `document_artifact_delete` tool and expiry cleanup also revoke all
  document-cache bindings registered for that source.
- Added private two-phase Container-to-Worker document-cache composition over
  D1 metadata and R2 immutable payloads, with credential-scoped source
  bindings, source-expiry caps, bounded hourly cleanup, and fail-open errors.
- Added the opt-in self-hosted durable corpus composition over revision-fenced
  SQLite manifests, immutable normalized source blobs, and a rebuildable
  derived index, including restart, ACL/tenant/credential isolation, expiry,
  removal, and retryable deletion semantics.
- Added D1 managed credentials and the admin-only credential lifecycle/API.

These features have deterministic local coverage. Modern-protocol production
enablement, official conformance, controlled Cloudflare upload/Tasks smokes,
deployed upload/cache cleanup verification, a Cloudflare corpus backend, and Claude/Codex/Cursor transcripts remain
release gates; this entry does not claim those gates have passed.
