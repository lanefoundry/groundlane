# Groundlane 可參考的開源專案

研究日期：2026-08-21。來源為專案官方 GitHub 頁與官方 README，使用 `stealth_fetch` 擷取。GitHub stars 會持續變動，僅作活躍度訊號，不作技術選型依據。

## 結論

若 Groundlane 延續現有 Node.js、Chromium、MCP 架構，建議採「參考組合」而不是整包 fork：

- browser service / session lifecycle：Steel
- MCP transport 與 browser tool schema：Playwright MCP
- agent-friendly extract/action：Stagehand
- crawl queue / retry / proxy sessions：Crawlee（第二階段）
- Docker browser operations：Browserless（只參考架構，先處理授權）

## 優先級

| 優先 | 專案 | 適合參考的部分 | 授權 | 建議 |
|---|---|---|---|---|
| 1 | [Steel](https://github.com/steel-dev/steel-browser) | session API、CDP endpoint、browser lifecycle、scrape/screenshot/PDF、proxy chain、debug UI | Apache-2.0 | 最接近 Groundlane，可深入讀或抽取設計；不必直接 fork 整套 UI/API |
| 2 | [Playwright MCP](https://github.com/microsoft/playwright-mcp) | MCP tools、HTTP endpoint、client isolation、CDP connection、accessibility snapshot、output limits | Apache-2.0 | MCP 層的主要參考；它自己的 origin flags 明言不是完整安全邊界，Groundlane 仍需保留 SSRF proxy |
| 3 | [Stagehand](https://github.com/browserbase/stagehand) | `act` / `observe` / `extract`、Zod structured output、token-efficient page context、OTel | MIT | 未來做 schema extraction 和 agent actions 時採用；第一版 fetch 不必引入 LLM |
| 4 | [Crawlee](https://github.com/apify/crawlee) | request queue、autoscaling、retry、proxy rotation、session pool、PlaywrightCrawler | Apache-2.0 | 適合 batch/crawl；對單頁 fetch 太重，不應成為第一版核心 |
| 5 | [Browserless](https://github.com/browserless/browserless) | Chromium Docker、queue/concurrency、health check、crash recovery、WebSocket API、debug viewer | SSPL-1.0 或商業授權 | 很值得讀，但封閉商用服務不能直接依賴或 fork 後部署，須先買商業授權或完成法律審查 |
| 6 | [Lightpanda](https://github.com/lightpanda-io/browser) | 低記憶體 browser、CDP server、HTTP MCP session isolation、原生 Markdown dump | AGPL-3.0 / 商業授權 | 適合未來低成本 fast path 實驗；非 Chromium，網站相容性和 anti-bot 表現需實測 |

## 次要參考

| 專案 | 值得看的能力 | 為何不是核心底座 |
|---|---|---|
| [Browser Use](https://github.com/browser-use/browser-use) | 自主 browser agent、task loop、tools、memory、Docker | Python 且偏 agent reasoning；Groundlane 現在是 execution layer |
| [HyperAgent](https://github.com/hyperbrowserai/HyperAgent) | `perform` / `ai` / `extract`、action cache、Playwright fallback | AGPL，且偏 AI automation SDK；適合看 API，不宜直接併入封閉服務 |
| [Firecrawl](https://github.com/firecrawl/firecrawl) | Markdown/JSON extraction、crawl/batch API、MCP、queue/orchestration | AGPL、系統很重，核心是 web context platform，不是單純 remote browser |

## 各專案可直接借鏡的設計

### Steel

- 將 stateful `/sessions` 與 stateless `/scrape`、`/screenshot`、`/pdf` 分開。
- SDK 只要替換 `baseURL` 就可在 Steel Cloud 與 self-host 間切換。
- session 建立時帶 proxy、dimensions、extensions 等執行參數。
- 內建 session viewer、request logs 與自動 cleanup。

Groundlane 可採相同產品分層：MVP 的 `web_fetch` 保持小而有界；`create_session`、`navigate`、`screenshot`、`release_session` 等 stateful tools 另案評估。

### Playwright MCP

- 使用 accessibility snapshot 取代每一步 screenshot，可降低 token 與視覺模型依賴。
- 已支援 CDP endpoint、HTTP transport、isolated context、service-worker blocking、output size 等設定。
- 官方 README 明確說 `allowed-origins` / `blocked-origins` 不影響 redirects，也不是 security boundary；因此不能拿它取代 Groundlane 現有的 DNS pinning、安全 proxy 與 redirect/subresource policy。

### Stagehand

- deterministic locator 與自然語言 `act` / `observe` / `extract` 可以混用。
- Zod schema 驗證 structured extraction，適合做未來 `extract_json`。
- self-healing action 與縮減後的 accessibility context，可作為 agent-friendly 工具面的參考。

### Crawlee

- request queue、retry、session pool、proxy rotation、autoscaling 都已成熟。
- 若 Groundlane 新增 `crawl_site` 或 async batch，再評估嵌入；現在直接引入會讓容器、狀態和依賴複雜許多。

### Browserless

- queue/concurrency、browser crash recovery、session persistence、debug viewer 與 Docker packaging 都很成熟。
- 但 repo 明載 SSPL-1.0 或 Browserless Commercial License；專有商用應用、CI 或商用雲端自架需要商業授權。它適合「讀設計」，不適合未審授權就成為產品 dependency。

### Lightpanda

- 用 Zig 重寫 headless browser，提供 CDP、Markdown dump、native MCP 與每個 HTTP MCP client 的 session isolation。
- 官方 benchmark 宣稱顯著低於 Chrome 的記憶體與執行時間，但這是廠商單源數據，且非 Chromium 對複雜網站的相容性需要獨立測試。

## 建議技術路線

1. 保留 Groundlane 現有安全 fetch 核心，不整包換成別人的 server。
2. 參照 Steel 將 session lifecycle 抽成獨立 service，避免全域 browser/proxy 狀態。
3. 參照 Playwright MCP 設計 Streamable HTTP、session isolation 與 accessibility snapshot，但繼續使用自己的 SSRF 防線。
4. 用 Stagehand 或自製 Zod pipeline 增加 optional structured extraction。
5. 只有要做 crawl/batch 時才引入 Crawlee。
6. Browserless、Lightpanda、HyperAgent、Firecrawl 在授權確認前只作設計參考。

## 授權風險摘要

- 較容易組進商用產品：Steel（Apache-2.0）、Playwright MCP（Apache-2.0）、Crawlee（Apache-2.0）、Stagehand（MIT）、Browser Use（MIT）。
- 需要特別審查：Browserless（SSPL / commercial）、HyperAgent（AGPL）、Firecrawl server（AGPL）、Lightpanda（AGPL / commercial）。
- 授權結論只依當下 repo 標示，不構成法律意見；實際採用仍應鎖定 commit 並讀完整 LICENSE、NOTICE 與依賴授權。

## 建議先讀的檔案順序

1. Steel：session controller、browser process manager、quick-actions routes、proxy manager。
2. Playwright MCP：HTTP transport、browser context factory、tool registration、snapshot/output handling。
3. Stagehand：`act`、`observe`、`extract` 與 schema validation。
4. Crawlee：AutoscaledPool、SessionPool、ProxyConfiguration、PlaywrightCrawler。
