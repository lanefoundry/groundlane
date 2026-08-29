# OpenAPI Bounded Discovery

Date: 2026-08-29

## Scope

This note covers a Phase 4 design for using Cloudflare's `api-schemas`
repository as a source-aware OpenAPI input without downloading the full
18-24 MB schema during ordinary `web_fetch` handling. It is design-only and
does not claim a runtime implementation.

## Current Evidence

- `https://api.github.com/repos/cloudflare/api-schemas/contents/` is a small
  metadata response. On 2026-08-29 it reported:
  - `openapi.json`: 24,631,939 bytes, blob
    `2ac38e4a97b2905fb9ace7d2cf2c9d790c404007`
  - `openapi.yaml`: 18,195,267 bytes, blob
    `e744b261cc1f6e8a5282b3da37afafeae883b2df`
  - `common.yaml`: 12,340 bytes
- `https://api.github.com/repos/cloudflare/api-schemas/git/trees/main?recursive=1`
  is also small and currently shows no split per-product or per-path schema
  files.
- The file-level contents response for `openapi.json` returns metadata with
  `encoding: none` and empty `content`, which is useful for identity and size
  checks but not for slicing.
- Groundlane `web_fetch` against the Git blob endpoint and raw
  `openapi.json` URL failed with `OUTPUT_LIMIT`, confirming that direct runtime
  fetch is not a bounded discovery path.
- GitHub's documented repository contents API supports metadata and raw access
  for larger files, but files over 1 MB do not return normal base64 `content`.
  GitHub's Git blob API documents blob support up to 100 MB. Those facts do not
  by themselves guarantee a reliable byte-range contract for
  `raw.githubusercontent.com`.

## Design Constraints

- Do not fetch the monolith on the interactive request path.
- Treat GitHub contents and tree endpoints as metadata sources only.
- Treat raw byte ranges as an optimization with capability probing, not as a
  correctness requirement.
- Preserve one Groundlane deadline across metadata lookup, cache lookup,
  optional index fetch, schema slice, and fallback.
- Bound bytes, decoded output, path candidates, operation candidates,
  redirects, and cache object size.
- Never log raw query text, authorization headers, provider payloads, or large
  schema excerpts.

## Recommended Strategy

Use a two-level design: a tiny runtime manifest and a generated schema index.

1. Runtime metadata discovery:
   - Fetch GitHub contents metadata or tree metadata for
     `cloudflare/api-schemas`.
   - Record `path`, `sha`, `size`, `download_url`, and source URL.
   - Reject automatic OpenAPI discovery when the candidate file exceeds the
     configured interactive byte budget and no matching local/cache index is
     available.

2. Generated index:
   - Build an offline or controlled background index keyed by repo, ref, file
     path, blob SHA, and schema format.
   - Store compact entries by exact OpenAPI path, normalized docs URL path,
     method, `operationId`, tags, summary tokens, and byte offsets if the
     source format supports safe offsets.
   - Store the minimal operation slice or a pointer to a bounded shard, not the
     whole monolith, for the default runtime path.
   - Invalidate on blob SHA change. Old indexes are read-only until replaced by
     a complete new index.

3. Runtime slice:
   - Map the requested docs URL to a Cloudflare API path candidate when the URL
     is under `developers.cloudflare.com/api/`.
   - Query the index for exact path/method first, then unique `operationId`,
     then a small capped candidate list from tags and normalized path tokens.
   - Return only one exact slice automatically. Return ambiguity as a bounded
     discovery result with candidate identifiers, not multiple large operations.
   - Include provenance: repository, ref or commit, schema file path, blob SHA,
     index version, match rule, OpenAPI path, and method.

## Raw Range Support Risks

Raw byte-range retrieval should not be the initial implementation dependency.

- Groundlane's current `web_fetch` interface does not expose custom request
  headers such as `Range`, so range probing would require lower-level HTTP
  adapter work.
- Raw GitHub URLs may behave differently from GitHub REST API endpoints for
  authentication, rate-limit visibility, caching, redirects, and error bodies.
- Byte ranges over JSON are not useful unless an index already knows safe
  structural offsets. A partial JSON range cannot be parsed as OpenAPI without
  surrounding context.
- YAML offsets are more fragile than JSON offsets because anchors, references,
  indentation, and document structure make arbitrary byte slices harder to
  validate.
- If range support is added, it should be probed with a small known file and a
  bounded range against the target blob, require `206 Partial Content`, verify
  `Content-Range`, and fall back to the cached index path on any mismatch.

## Sparse Or Partial Schema Options

The current Cloudflare repository does not expose split OpenAPI files in the
tree metadata, so a sparse checkout alone does not solve the monolith problem.
Useful partial options are:

- Upstream split schemas if Cloudflare later publishes product or path shards.
- A Groundlane-generated shard store derived from the monolith outside the
  interactive request path.
- A compact operation index plus operation JSON snippets for exact path/method
  and `operationId` lookups.
- A docs-to-schema crosswalk generated from Cloudflare docs Markdown and the
  OpenAPI index, keyed by stable docs URL prefixes.

## Cache And Indexing Plan

- Cache key:
  `openapi-index:v1:github:cloudflare/api-schemas:<ref>:<path>:<blob_sha>`.
- Minimum index metadata:
  `source_url`, `html_url`, `download_url`, `git_url`, `size`, `sha`,
  `generated_at`, `schema_format`, `openapi_version`, `path_count`,
  `operation_count`, and parser version.
- Entry shape:
  `openapi_path`, `method`, `operation_id`, `tags`, `summary`, normalized URL
  hints, small response/request schema references, and bounded operation JSON.
- Build mode:
  manual command or scheduled background job with explicit byte limits and
  atomic publish. Runtime fetches only read complete indexes.
- Miss behavior:
  return to existing Markdown/HTML source-aware paths; do not automatically
  download the monolith.

## Test Plan

- Unit tests for GitHub contents/tree metadata parsing, including
  `encoding: none`, missing `download_url`, files over budget, and unexpected
  file types.
- Unit tests for index key derivation and SHA-based invalidation.
- Unit tests for docs URL to OpenAPI path candidate mapping.
- Unit tests for exact path/method, unique `operationId`, duplicate
  `operationId`, and ambiguous candidate handling.
- Contract tests with fake GitHub responses proving the runtime path refuses to
  download the monolith when no index exists.
- Contract tests proving cache hits return a bounded operation slice with
  provenance and no unrelated operations.
- Regression tests for deadline preservation, cancellation, output truncation,
  sanitized errors, and secret non-disclosure.
- Optional live smoke, only when explicitly in scope: fetch GitHub metadata for
  the repo and verify the recorded SHA/size shape, without fetching raw schema
  contents.

## References

- `https://github.com/cloudflare/api-schemas`
- `https://api.github.com/repos/cloudflare/api-schemas/contents/`
- `https://api.github.com/repos/cloudflare/api-schemas/git/trees/main?recursive=1`
- `https://docs.github.com/en/rest/repos/contents`
- `https://docs.github.com/en/rest/git/blobs`
