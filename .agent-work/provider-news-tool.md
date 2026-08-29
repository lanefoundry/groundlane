Task: Add another provider-backed tool after web_map.
Started: 2026-08-29

Checklist:
- [x] Inspect current search adapter patterns
- [x] Verify official news endpoint docs through Groundlane MCP
- [x] Implement web_news providers/router/tool
- [x] Add unit/contract tests
- [x] Update docs/capability matrix/smoke
- [x] Run completion gate

Notes:
- Added `web_news` as a stateless provider news-search tool.
- Implemented providers: Brave News Search, Serper News, and SerpApi Google News.
- Official Brave and SerpApi endpoint docs were verified through Groundlane MCP; Serper News shape was verified from Serper homepage examples and existing host convention.
- Fake-based unit and MCP contract tests passed.
