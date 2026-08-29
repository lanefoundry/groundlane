# web_research tool progress

## Scope

- Add a minimal bounded `web_research` MCP tool if official provider docs define request and response contracts clearly enough for fake-fetch tests.
- Preserve concurrent work; avoid reverting existing dirty files.

## Checklist

- [x] Confirm Groundlane MCP tools are available for web research.
- [x] Inspect existing `web_answer` router/tool/adapter/test patterns.
- [x] Verify official provider docs for You.com Research, Linkup Research, and Parallel Task/Responses.
- [x] Implement only providers with clear endpoint contracts.
- [x] Add fake-fetch/router/tool tests.
- [x] Run completion gates.

## Notes

- Existing dirty files before this task: `docs/operations/provider-inventory.md`, `src/core/contracts.ts`, `.agent-work/provider-tool-expansion.md`, `src/adapters/images/`.
- You.com Research synchronous contract is clear enough for implementation.
- Parallel Responses synchronous contract and OpenAI-style URL citation annotations are clear enough for implementation.
- Linkup Research is async task-based with official latency in minutes; not implemented in synchronous `web_research`.
- Completion gates passed: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `git diff --check`.
