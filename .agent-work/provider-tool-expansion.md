# Provider tool expansion

Started: 2026-08-29T04:07:37Z

## Goal

Document vendor capabilities beyond the current Groundlane tool surface, then
add the next provider-backed MCP tools with deterministic tests.

## Parallel work

- `web_images`: worker `01a04bb3-25a9-7360-9a5b-6ac63af107cb`
  - Scope: images adapters/router/tool/tests.
  - Providers: Brave Images first, then Serper/SerpApi Images if the endpoint
    shape is clear from existing adapters.
- `web_crawl`: worker `01a04bb3-7c09-7991-b0c7-a70326b84690`
  - Scope: crawl adapters/router/tool/tests.
  - Providers: Firecrawl Crawl and Tavily Crawl when the official endpoint
    shape is clear.
- Main thread:
  - Update provider inventory/backlog docs.
  - Integrate shared contracts, composition, smoke, and contract tests after
    worker patches return.

## Verification notes

- Groundlane MCP in the current Codex session exposes only
  `web_search`, `web_fetch`, and `web_extract`; the just-pushed local code
  exposes more tools, but production deployment of that commit has not been
  verified.
- Official docs rechecked in this turn with Groundlane:
  - You.com docs and search guide
  - Linkup docs
  - Keenable API reference
  - Brave Web Search and News API reference
  - Browserbase Search and Fetch docs
  - Parallel `llms.txt`
  - Exa Search API guide
  - Tavily Search docs
  - Firecrawl API introduction
  - Serper homepage via structured extraction; direct API reference URL was 404

## Current status

- [x] Spawn independent workers for `web_images` and `web_crawl`.
- [x] Document verified vendor feature backlog.
- [x] Integrate worker changes.
- [x] Run full completion gate.
