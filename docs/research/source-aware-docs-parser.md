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
