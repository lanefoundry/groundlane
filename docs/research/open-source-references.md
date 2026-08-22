# Groundlane 可參考的開源專案

更新日期：2026-08-22。來源為專案官方 GitHub repository metadata 與官方 README。GitHub stars 會持續變動，僅作活躍度訊號，不作技術選型依據。

## 結論

若 Groundlane 延續現有 Node.js、Chromium、MCP 架構，建議採「參考組合」而不是整包 fork：

- browser service / session lifecycle：Steel
- MCP transport 與 browser tool schema：Playwright MCP
- agent-friendly extract/action：Stagehand
- crawl queue / retry / proxy sessions：Crawlee（第二階段）
- LLM-friendly Markdown / extraction UX：Crawl4AI（借鏡契約，不引入 Python runtime）
- downloader middleware / throttle / crawl statistics：Scrapy（借鏡成熟模式）
- Docker browser operations：Browserless（只參考架構，先處理授權）

## 先分清楚：開源核心與託管服務

這份研究同時涵蓋能自行部署的開源核心、開源 client/SDK，以及商業託管能力。三者不能因為同一家公司或品牌而視為等價：

| 類型 | 專案／服務 | Groundlane 的使用方式 |
|---|---|---|
| 開源核心 | [Crawlee](https://github.com/apify/crawlee)、[Crawl4AI](https://github.com/unclecode/crawl4ai)、[Scrapy](https://github.com/scrapy/scrapy)、[Selenium](https://github.com/SeleniumHQ/selenium) | 可讀原始碼、依授權採用依賴或借鏡架構；仍需逐一檢查 LICENSE、NOTICE 與 transitive dependencies |
| 開源 SDK／client | [Apify SDK for Python](https://github.com/apify/apify-sdk-python) 等 | SDK 開源不代表其呼叫的雲端執行、代理網路或資料服務也是開源 |
| 商業託管能力 | Apify Platform、Bright Data、Zyte 等 | 透過可替換 adapter 使用；住宅代理、CAPTCHA 與 managed anti-bot 不應被描述成 Groundlane 可自行部署的開源能力 |

開源 crawler 可以解決 queue、retry、session、extraction 與 observability，但不會憑空提供住宅 IP、CAPTCHA 解題或持續更新的 managed fingerprint。Groundlane 因此把「crawl orchestration」與「anti-bot provider」維持為兩個不同邊界。

## 依 Groundlane layer 選參考，不只選一套 framework

| Layer | 首選參考 | 可借鏡的能力 | 是否適合直接整合 |
|---|---|---|---|
| Reader 正文抽取 | [Mozilla Readability](https://github.com/mozilla/readability) | Firefox Reader View 使用的 article scoring、metadata、link density、element cap | **高**：JavaScript、Apache-2.0；需搭配不執行 script／不自動抓 remote resource 的 DOM implementation，輸出仍須 sanitizer 與 Groundlane bounds |
| Reader metadata | [Metascraper](https://github.com/microlinkhq/metascraper) | Open Graph、JSON-LD、HTML meta 與 fallback rules | **中高**：JavaScript、MIT；應只選需要的 rules，避免 dependency/output 膨脹 |
| Reader 完整 parser | [Postlight Parser](https://github.com/postlight/parser) | 正文、作者、日期、lead image 與 domain-specific extractors | **中**：JavaScript、Apache-2.0；適合 corpus benchmark，不一定要和 Readability 同時依賴 |
| LLM-ready extraction | [Crawl4AI](https://github.com/unclecode/crawl4ai) | Fit Markdown、BM25 filtering、citations、chunking、CSS/LLM schema extraction、deep crawl recovery | **概念高／dependency 低**：能力完整且 browser integration 強，但主要為 Python，不應為此增加 sidecar |
| Crawl orchestration | [Crawlee](https://github.com/apify/crawlee) | HTTP/browser 統一介面、queue、session/proxy rotation、fingerprints、retry、robots、transactional results | **高（web_crawl 階段）**：TypeScript、Apache-2.0；仍須置於 Groundlane security/budget boundary 內 |
| 成熟 crawl pipeline | [Scrapy](https://github.com/scrapy/scrapy) | scheduler、downloader/spider middleware、item pipeline、signals/stats、retry/AutoThrottle | **概念高／dependency 低**：Python；browser 通常經 [scrapy-playwright](https://github.com/scrapy-plugins/scrapy-playwright) plugin，因此比 Crawlee 間接 |
| URL discovery／security crawl | [Katana](https://github.com/projectdiscovery/katana) | scope rules、JS endpoint/XHR extraction、similarity dedupe、duration/response/domain caps、headless hybrid | **概念中**：Go、MIT；適合學 URL frontier 與 bounds，不適合作為 Node library dependency |
| 高擬真 Web archive | [Browsertrix Crawler](https://github.com/webrecorder/browsertrix-crawler) | Brave/Puppeteer browser crawl、CDP capture、WARC/high-fidelity archival | **低**：TypeScript 但 AGPL，產品目標是 preservation，不是 LLM-ready Reader |
| Metasearch discovery | [SearXNG](https://github.com/searxng/searxng) | 聚合多個 search services、engine adapters、privacy-oriented metasearch | **adapter 中／core 低**：Python、AGPL；沒有自己的全網 index，適合獨立部署後由 Groundlane adapter 呼叫 |
| 大規模 vertical index | [Apache Nutch](https://github.com/apache/nutch) | 可擴展 crawler、plugin pipeline、長期 index ingestion | **低**：Java/Hadoop-oriented，適合研究自建 index 架構，不適合目前 Container MVP |

因此「直接採用」與「設計參考」應分開：Reader 已依 [130 組 fixture benchmark](reader-benchmark.md) 導入 Mozilla Readability + linkedom；多頁 crawl 才評估 Crawlee；Crawl4AI、Scrapy、Katana 適合借鏡 feature 和 failure semantics；SearXNG／Nutch 則屬 search discovery 的另一條產品線。

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
| [Crawl4AI](https://github.com/unclecode/crawl4ai) | LLM-friendly Markdown、structured extraction、crawl strategy 與 adaptive waiting | Apache-2.0，但主要為 Python；適合借鏡 tool contract 和 extraction UX，不為 Groundlane 增加第二套 runtime |
| [Scrapy](https://github.com/scrapy/scrapy) | scheduler、downloader middleware、retry、AutoThrottle、duplicate filtering 與統計 | BSD-3-Clause，但主要為 Python；適合借鏡 pipeline hooks 與運維語意 |
| [Selenium](https://github.com/SeleniumHQ/selenium) | 跨瀏覽器 WebDriver automation 與 Grid | Apache-2.0；Groundlane 已以 Playwright 作 Chromium backend，且 Selenium 本身不是 anti-bot service，沒有引入的必要 |

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

### Crawl4AI、Scrapy 與 Selenium

- Crawl4AI 的 Markdown、schema extraction 與 crawl-result UX 很接近 agent 的需求，也原生涵蓋 Playwright、remote browser、profiles、sessions 與 proxy；不採用它的主因是 Python runtime 邊界，不是 browser 能力不足。Groundlane 可採用相同的「輸出先正規化、再交給模型」思路，但維持 TypeScript 單一 runtime。
- Scrapy 的 downloader middleware、重試分類、AutoThrottle、去重與 stats 是未來 crawl worker 的成熟參考；browser automation 則通常透過獨立的 `scrapy-playwright` download handler/plugin 接入，所以對現有 Playwright core 較間接。這些概念仍必須服從 Groundlane 現有的 URL policy、單一 deadline 與 byte/output budgets。
- Selenium 是 browser automation framework，不等於 Cloudflare/CAPTCHA bypass。Groundlane 已使用 Playwright，新增 Selenium 只會造成雙重 driver 與測試矩陣。
- Apify 品牌下的 Crawlee 與 SDK 是開源專案；Apify Platform、Proxy 與託管 Actor execution 則是另一個商業服務層。

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
5. 只有要做 crawl/batch 時才引入 Crawlee；採用前需證明它能沿用 Groundlane 的 SSRF、deadline、bytes、concurrency 與 cancellation 邊界。
6. Crawl4AI 與 Scrapy 先借鏡契約和 orchestration，不新增 Python sidecar；Selenium 不列入 runtime 候選。
7. Browserless、Lightpanda、HyperAgent、Firecrawl 在授權確認前只作設計參考。

## 授權風險摘要

- 較容易組進商用產品：Steel（Apache-2.0）、Playwright MCP（Apache-2.0）、Crawlee（Apache-2.0）、Stagehand（MIT）、Browser Use（MIT）。
- 需要特別審查：Browserless（SSPL / commercial）、HyperAgent（AGPL）、Firecrawl server（AGPL）、Lightpanda（AGPL / commercial）。
- 授權結論只依當下 repo 標示，不構成法律意見；實際採用仍應鎖定 commit 並讀完整 LICENSE、NOTICE 與依賴授權。

## 建議先讀的檔案順序

1. Steel：session controller、browser process manager、quick-actions routes、proxy manager。
2. Playwright MCP：HTTP transport、browser context factory、tool registration、snapshot/output handling。
3. Stagehand：`act`、`observe`、`extract` 與 schema validation。
4. Crawlee：AutoscaledPool、SessionPool、ProxyConfiguration、PlaywrightCrawler。
