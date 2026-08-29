Task: Add more provider-backed tools in parallel and test them.
Started: 2026-08-29

Checklist:
- [x] Inspect current tool/router/provider patterns
- [x] Verify provider docs for new endpoints through Groundlane MCP if needed
- [x] Implement new provider-backed tool surfaces
- [x] Add unit/contract tests
- [x] Update docs and capability matrix
- [x] Run completion gate

Notes:
- Added `web_map` as a stateless provider URL-discovery tool.
- Implemented providers: Firecrawl `/v2/map` and Tavily `/map`.
- Official endpoint docs were verified through Groundlane MCP `web_fetch` / `web_extract`.
- Local runtime smoke passed and listed `web_map`.
- Production deploy was attempted with `pnpm run deploy`, but wrangler did not return a terminal deployment/version ID before the stuck PTY was interrupted; do not count production as verified for this change.
