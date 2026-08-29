# Groundlane MCP discovery guidance

- [completed] Add self-contained MCP server instructions for Groundlane's three web tools.
- [completed] Add a contract test for initialization instructions.
- [completed] Require and allowlist Groundlane in the global Codex MCP configuration.
- [completed] Make deferred-tool discovery explicit in the global agent instructions.
- [completed] Run Groundlane's completion gate and verify the local Codex MCP listing.

## Verification

- `node --test --import tsx test/contract/tools.test.ts`: 1 passed.
- `pnpm lint`: passed.
- `pnpm typecheck`: passed.
- `pnpm test`: 94 passed.
- `pnpm build`: passed.
- `git diff --check`: passed.
- `codex mcp get groundlane`: enabled streamable HTTP server with only `web_search`, `web_fetch`, and `web_extract` enabled.

The server code is ready but was not deployed; the remote MCP will return the new initialization
instructions only after an explicitly authorized Groundlane deployment. The global Codex config and
agent instructions take effect for new local Codex sessions.
