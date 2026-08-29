# Provider inventory

Updated: 2026-08-29.

This file records Groundlane's provider operating state. It deliberately keeps
three concepts separate:

- **Provider account balance or quota**: the vendor billing truth from a
  dashboard or vendor usage API.
- **Groundlane budget**: an instance-local attempt guardrail configured through
  `SEARCH_MONTHLY_REQUEST_BUDGETS`.
- **Live smoke**: whether Groundlane successfully called the provider at the
  time of the smoke test.

Secrets are never recorded here. `present` means the secret name exists in
Cloudflare Workers secrets, not that its value was read.

## Production provider state

| Provider | Secret present | Groundlane default budget | Latest live smoke | Provider balance / quota evidence | Programmatic balance API |
| --- | --- | ---: | --- | --- | --- |
| Linkup | present | 100 | OK, 1 result | Production `provider_balance` on 2026-08-29 returned `13.363` credits after live answer smoke | Implemented in `provider_balance` through `GET /v1/credits/balance` |
| Keenable | no keyed secret verified | 100 | OK, 1 result through public endpoint | Keyless public endpoint plus authenticated 100,000 requests/month | No Groundlane balance check implemented |
| You.com | present | 100 | OK, 1 result through keyed REST; OK through free MCP profile in direct smoke | Production `provider_balance` on 2026-08-29 returned `9984` cents (`$99.84`) after live answer smoke; earlier user dashboard screenshot showed `$99.92` | Implemented in `provider_balance` through `GET https://api.you.com/v1/billing/account_balance`, returns cents |
| Parallel | present | 1000 | OK, 1 result | Unknown in Groundlane | No Groundlane balance check implemented |
| Browserbase | present | 1000 | OK, 1 result | Unknown in Groundlane | No Groundlane balance check implemented |
| Brave | present | 1000 | OK, 1 result; domain/exclude domain smoke OK | Unknown in Groundlane | No Groundlane balance check implemented |
| SerpApi | present | 250 | OK, 1 result | Unknown in Groundlane | No Groundlane balance check implemented |
| Tavily | present | 1000 | Upstream rejected request | Unknown in Groundlane | No Groundlane balance check implemented |
| Exa | present | 1000 | Upstream rejected request | Unknown in Groundlane | No Groundlane balance check implemented |
| Firecrawl | present | 500 | Upstream rejected request | Unknown in Groundlane | No Groundlane balance check implemented |
| Serper | present | 0 | OK, 1 result when temporarily probed with budget 1 | Actual remaining credits unknown; Serper says successful responses deduct from account balance and requests stop when balance reaches zero | No public balance endpoint found in reviewed Serper pages |

## Allowance and feature inventory

| Provider | Current free / credit allowance evidence | Actual remaining amount known today | Vendor features | Groundlane surface today | Notes |
| --- | --- | --- | --- | --- | --- |
| You.com | Pricing page: 100 Web Search queries/day with no API key; new accounts get `$100` API credits | `$99.84` from production `provider_balance` on 2026-08-29 after live answer smoke | Web Search, Contents, Answer, Research, Finance Research, hosted MCP, `you-balance`, Account Balance API | `web_search` via keyed REST or keyless free MCP profile; `web_answer` via keyed Answer API; `web_content` via keyed Contents API; `provider_balance`; `provider_capabilities` | Keyless free MCP daily quota remains separate from keyed API credits; Answer and Contents require configured API key |
| Linkup | Official docs state eligible accounts receive `$20` credits and expose `GET /v1/credits/balance` | `13.363` credits from production `provider_balance` on 2026-08-29 after live answer smoke | Search, Fetch, Research, Tasks, Extract, source/domain filtering | `web_search` keyed REST; `web_answer` via `outputType=sourcedAnswer`; `web_content` via Fetch; `provider_balance`; `provider_capabilities` | Balance response shape verified from official docs as `{ balance: number }` |
| Keenable | Docs: 100,000 authenticated requests/month; keyless public endpoint with per-IP public limits | Unknown | Independent-index Search and Fetch, MCP, CLI, REST | `web_search` keyed or keyless public endpoint; `web_content` keyed or keyless Fetch | Keyless path currently works and reports a warning |
| Browserbase | Prior official plan snapshot: Free plan has Search calls, Fetch calls, and one browser hour | Unknown | Search, Fetch, browser sessions, Stagehand/Runtime, hosted MCP, proxies, CAPTCHA handling on paid plans | `web_search`; browser backend exists through Browserless, not Browserbase | Browserbase has broader platform features than current Groundlane adapter |
| Brave | Prior official pricing snapshot: monthly credits roughly cover basic Search usage | Unknown | Independent Web Search API, news/images/local, LLM snippets/context, Goggles, MCP | `web_search` keyed REST; `web_news` via News Search | Domain filters are mapped to documented `site:` operators |
| SerpApi | Prior official pricing snapshot: 250 searches/month free | Unknown | Google and vertical SERP APIs | `web_search` keyed Google organic adapter; `web_news` via Google News | Groundlane normalizes organic web and Google News results today |
| Parallel | Prior official pricing snapshot: eligible organizations receive monthly credits | Unknown | Search, Extract, cited responses, deep/task-style primitives | `web_search` keyed REST | Keep behind conservative cap because credits expire and overage can apply |
| Tavily | Prior official pricing snapshot: 1,000 API credits/month | Unknown | Search, Extract, Crawl, Map, later research workflows | `web_search` keyed REST; `web_content` via Extract; `web_map` via Map | Production `web_content` smoke succeeded on 2026-08-29; current production search smoke was rejected by upstream, so search key/account/path needs follow-up |
| Exa | Prior official pricing snapshot: signup credits plus monthly credits | Unknown | Neural Search, Contents, Answer/research-style APIs | `web_search` keyed REST; `web_content` via Contents | Production `web_content(provider=exa)` on 2026-08-29 returned sanitized credential rejection |
| Firecrawl | Prior official pricing snapshot: 1,000 credits/month | Unknown | Search, Scrape, Crawl, Map, Extract, hosted MCP | `web_search` keyed REST; `web_content` via Scrape; `web_map` via Map | Production `web_content(provider=firecrawl)` on 2026-08-29 returned sanitized request rejection |
| Serper | Homepage: 2,500 free queries; paid credits valid for 6 months | Unknown | Google Search, Images, News, Maps, Places, Videos, Shopping, Scholar, Patents, Autocomplete | `web_search` keyed Google organic adapter, opt-in budget; `web_news` via News | No public balance API found; dashboard remains authoritative |

## Capability matrix

| Provider | Groundlane role today | Vendor features relevant to future Groundlane | Current filter support in Groundlane |
| --- | --- | --- | --- |
| Linkup | `web_search`, `web_answer`, `web_content` provider | Search, Fetch, Research, Tasks, Extract | include domains, exclude domains, date range |
| Keenable | `web_search` and `web_content` provider, keyed or keyless | Independent-index Search and Fetch, MCP/CLI/REST | one include domain, date range; no exclude domains |
| You.com | `web_search` provider, keyed REST or keyless free MCP profile; `web_answer` and `web_content` provider with key | Search, Contents, Answer, Research, Finance Research, hosted MCP, balance API | include domains or exclude domains, date range; not both include and exclude together |
| Parallel | `web_search` provider | Search, extract, cited responses, task/research primitives | include domains, exclude domains; no date range in current adapter |
| Browserbase | `web_search` provider | Search, Fetch, managed browser sessions, proxies, CAPTCHA handling on paid plans | unfiltered queries only in current adapter |
| Brave | `web_search` and `web_news` provider | Independent-index Web Search API and News Search | date range; include/exclude domains mapped to documented `site:` query operators |
| SerpApi | `web_search` and `web_news` provider | Google organic SERP, Google News, and vertical engines | include/exclude domains mapped to Google query operators, date range |
| Tavily | `web_search`, `web_content`, and `web_map` provider | Search, Extract, Crawl, Map, later research workflows | include domains, exclude domains, time range |
| Exa | `web_search` and `web_content` provider | Neural search and contents | include domains only; no exclude domains or time range in current adapter |
| Firecrawl | `web_search`, `web_content`, and `web_map` provider | Search, scrape, crawl, map, extract, hosted MCP | include or exclude domains; not both together |
| Serper | `web_search` and `web_news` provider | Google SERP and News endpoints | unfiltered web queries; news supports locale controls |

## Current action items

1. Run production `provider_balance` after deployment to refresh You.com and
   Linkup balances from their official APIs.
2. Keep Serper balance as dashboard-only unless an official API endpoint is
   found.
3. Add more balance checkers only when a provider exposes an official,
   bounded, account-level usage or balance API.
4. Do not infer real provider quota from Groundlane local budgets or live smoke
   success. They answer different questions.
