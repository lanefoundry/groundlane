# Source-Aware Documentation Parser

Date: 2026-08-29

## Problem

Large generated documentation sites can exceed Groundlane's response byte limit
before the useful API reference section is isolated. Cloudflare API reference,
Firecrawl docs, Exa docs, Browserbase docs, Parallel docs, and Keenable docs all
show this class of failure.

This should not be solved by raising global `maxBytes` or `maxOutputChars`.
Those limits are part of Groundlane's safety and cost contract.

## Design Direction

Groundlane should prefer source-native documentation formats before broad HTML
fetching:

1. Discover `llms.txt`, scoped `llms-full.txt`, `/index.md`, Markdown alternate
   links, OpenAPI schemas, and sitemaps.
2. Fetch the smallest source that can identify the relevant page or operation.
3. Slice by product, URL, heading, schema path, `operationId`, or anchor.
4. Return bounded content with provenance describing the source format and slice
   rule.
5. Fall back to bounded HTML fetch/extract when no source-aware path is
   available.
6. Use OCR or VLM extraction only for scanned PDFs, screenshots, images, visual
   tables, or charts where no reliable text/source format is available.

## First Runtime Slice

The first implementation is intentionally narrow:

- Only `web_fetch` Markdown/text requests are eligible.
- Explicit selectors, `waitFor`, and `render=always` stay on the existing
  deterministic HTML/browser path.
- When direct HTTP fails with `OUTPUT_LIMIT`, Groundlane retries the same URL
  with `Accept: text/markdown`, then tries documentation Markdown candidates
  such as Cloudflare-style `/index.md`.
- If a source-aware candidate succeeds, the result uses the existing
  `engine=http` provenance with a source-specific backend marker.
- If every candidate fails, Groundlane returns the original bounded failure.

## Phase 2 Runtime Slice

The second implementation extends discovery without changing public tool
schemas:

- After direct Markdown candidates fail, Groundlane checks scoped `llms.txt`
  before root `/llms.txt`.
- `llms.txt` is treated as a discovery manifest, not a content body.
- Only same-origin HTTP(S) links are eligible for automatic selection.
- Discovered link parsing is capped at 500 links per manifest.
- Candidate selection compares normalized documentation paths and prefers the
  nearest parent page for the requested URL.
- Markdown hash fragments can slice an ATX heading range before normal output
  truncation.

OpenAPI support starts as pure JSON slicing helpers for exact path/method or
unique `operationId` matches. It is not automatically wired into `web_fetch`
yet, because Cloudflare's canonical OpenAPI files are large monoliths and need
metadata-first or range-aware retrieval before runtime use.

## Phase 3 Runtime Slice

Likely documentation URLs are now resolved proactively for Markdown/text
`web_fetch` requests without selectors, `waitFor`, or `render=always`.

- Groundlane tries source Markdown before broad HTML for likely docs URLs.
- Candidate responses must actually be Markdown/text source; HTML returned by a
  server that ignores `Accept: text/markdown` is rejected and normal direct HTTP
  continues.
- Source Markdown cleanup removes YAML front matter, leading docs chrome before
  the first ATX heading, and common controls such as `Skip to content`,
  `Copy Markdown`, `On this page`, and feedback/edit labels.
- Ordinary URLs still use the existing direct HTTP path first.

## References

- `https://llmstxt.org/`
- `https://developers.cloudflare.com/docs-for-agents/`
- `https://blog.cloudflare.com/markdown-for-agents/`
- `https://github.com/cloudflare/api-schemas`
- `https://docling.ai/`
- `https://arxiv.org/html/2501.17887v1`
- `https://github.com/Unstructured-IO/unstructured`
- `https://trafilatura.readthedocs.io/`
- `https://github.com/mozilla/readability`
- `https://github.com/datalab-to/marker`
