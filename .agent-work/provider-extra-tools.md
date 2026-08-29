Task: Expand extra provider tools beyond Linkup and You.com.
Started: 2026-08-29T11:00:00+08:00

Plan:
- [x] Verify official provider docs for URL content/fetch/extract APIs.
- [x] Inspect current provider adapters/config.
- [x] Implement a provider-backed content tool across multiple providers.
- [x] Add tests/docs and run full gates.

Docs verified through Groundlane:
- Exa Contents: `POST https://api.exa.ai/contents`, `urls`, `text`, `maxAgeHours`.
- Tavily Extract: `POST https://api.tavily.com/extract`, `urls`, `extract_depth`, `format`.
- Firecrawl Scrape: `POST https://api.firecrawl.dev/v2/scrape`, markdown under `data.markdown`.
- Keenable Fetch: `GET /v1/fetch` and `/v1/fetch/public`, keyless requires `X-Keenable-Title`.
- You.com Contents: `POST https://ydc-index.io/v1/contents`, `urls`, `formats`.
- Linkup Fetch: `POST https://api.linkup.so/v1/fetch`, markdown response.

Implementation:
- Added `web_content` with parallel/fallback routing.
- Runtime providers: Linkup, You.com, Exa, Tavily, Firecrawl, Keenable.
- Keenable supports keyless content fetch; all other content providers require configured keys.
- Browserbase Fetch remains documented but not implemented because the exact reference endpoint was not verified in this pass.

Verification:
- Local gate passed: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
  and `git diff --check`.
- Tests increased to 156 passing tests.
- Production deployment: `2ead0734-a0e0-4ba7-9aab-7adbbf862768`;
  container app version 24 uses image digest
  `sha256:1b4fa901328fa1ab7566a40de5fd5b58d49afc9b5d3c4192d39e78f807027cf1`.
- Production smoke listed:
  `provider_balance`, `provider_capabilities`, `web_answer`, `web_content`,
  `web_extract`, `web_fetch`, `web_search`.
- Live `web_content` with
  `providers=["linkup","you","exa","tavily","firecrawl","keenable"]`,
  `strategy="parallel"`, and `maxContentChars=500` attempted all six.
  Successful providers: Linkup, You.com, Tavily, Keenable. Exa returned a
  sanitized credential rejection when pinned. Firecrawl returned a sanitized
  request rejection when pinned. Keenable used its public endpoint.
