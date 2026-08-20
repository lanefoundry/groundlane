# Groundlane 競品與產品定位

研究日期：2026-08-20～2026-08-21。資料僅採各廠商官方網站與文件，並以 `stealth_fetch` 擷取。價格為研究當下官方頁顯示；廠商的成功率、stealth 與效能宣稱未做獨立實測。

## 執行結論

Groundlane 最合理的第一階段定位不是「另一個萬能爬蟲」，而是：

> A vendor-neutral web access layer for AI agents, with bounded retrieval, observable provider routing, and a secure browser fallback.

中文可說：**給 AI agent 使用、可部署在自己 Cloudflare 帳號裡的供應商中立 Web 存取層。**

最值得正面對標的是：

1. **Browserless**：產品形態最接近；同時有 remote MCP、瀏覽器 API、managed 與 self-hosted。
2. **Steel**：開源、自架與 agent browser API 的最近鄰。
3. **Browserbase**：託管式企業產品與瀏覽器身分、代理、CAPTCHA 的上限標竿。
4. **Cloudflare Browser Run**：不是完全相同的產品，但會直接決定使用者為何不乾脆用 Cloudflare 官方服務。
5. **Hyperbrowser**：若未來加入 session、crawl、agent sandbox，會成為直接對手。

Bright Data、ZenRows、ScrapingBee 是「高成功率抓取與反爬」的能力標竿；Firecrawl 是「URL 轉 LLM-ready context」的替代品；Apify 是平台與 marketplace 替代品；Browser Use 則是自主 agent，而非第一階段的直接對手。

## 競品地圖

| 市場層 | 主要產品 | 它們在賣什麼 | 與 Groundlane 的關係 |
|---|---|---|---|
| 遠端瀏覽器基礎設施 | Browserless、Steel、Browserbase、Hyperbrowser、Kernel、Anchor | browser sessions、CDP/Playwright、profiles、proxy、CAPTCHA、觀測與 agent integration | **直接競品** |
| 邊緣瀏覽器執行層 | Cloudflare Browser Run | Cloudflare 上的 headless Chrome、Quick Actions、sessions、MCP/CDP | **平台基準，也可能是底層** |
| 反爬與 scraping API | Bright Data、ZenRows、ScrapingBee | proxy/fingerprint/CAPTCHA 加上 rendered HTML、JSON、screenshot | **競爭同一筆抓取預算** |
| LLM web context | Firecrawl | search、scrape、crawl、Markdown/JSON、remote MCP | **簡單讀頁情境的替代品** |
| Agent / automation 平台 | Browser Use、Apify、Anchor | 自主任務執行、Actors/marketplace、browser workflows | **功能擴張後才會正面相遇** |

## 關鍵能力交叉表

| 產品 | Remote MCP | Stateful browser | Self-host / 自有帳號 | Stealth / 反爬 | Groundlane 應學什麼 |
|---|---:|---:|---:|---:|---|
| [Browserless](https://docs.browserless.io/mcp/browserless-mcp-server/setup) | 是 | 是 | 是，另有 managed | fingerprint、proxy、CAPTCHA | 相同 API 跨 managed/self-host；一站式 MCP 工具面 |
| [Steel](https://docs.steel.dev/overview/self-hosting/steel-local-vs-steel-cloud) | 有自架 MCP recipe；未核實 hosted endpoint | 是 | 是，Steel Local | Cloud 強、Local 有限 | 明確 session handles、透明 metered cost、開源切角 |
| [Browserbase](https://docs.browserbase.com/integrations/mcp/introduction) | 是 | 是 | 未核實自架 browser plane | residential/BYOP proxy、CAPTCHA、Verified | 企業級 identity、session debugging、可靠性上限 |
| [Hyperbrowser](https://hyperbrowser.ai/docs/integrations/model-context-protocol) | 本地 MCP；未核實 hosted endpoint | 是 | 未核實 | stealth/Ultra Stealth、proxy、CAPTCHA | Fetch/Search/Crawl 與 session/agent 的產品階梯 |
| [Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/) | 官方支援 MCP 路徑 | 是 | Cloudflare 託管 | 硬站反爬未核實 | edge economics、低摩擦 Quick Actions、原生平台整合 |
| [Bright Data](https://docs.brightdata.com/scraping-automation/scraping-browser/introduction) | 產品頁提及；細節未核實 | 是 | 否 | proxy/fingerprint/CAPTCHA/retry | 高防護站點成功率需要完整網路與指紋能力 |
| [ZenRows](https://www.zenrows.com/pricing) | 官方列 MCP | 是 | 否 | anti-bot、CAPTCHA、fingerprint | 成功才計費、Fetch/Extract/Batch/Browser 共用 credits |
| [ScrapingBee](https://www.scrapingbee.com/) | 首頁列 MCP；細節未核實 | 否，偏 declarative actions | 否 | rotating/residential/stealth proxies | 一次 request 的低整合成本 |
| [Firecrawl](https://docs.firecrawl.dev/mcp-server) | 是 | Interact / sandbox | 有 OSS；cloud parity 未核實 | 官方宣稱 proxy/anti-bot | Markdown/JSON/search/crawl 已商品化，不能只靠文字擷取區隔 |
| [Apify](https://docs.apify.com/integrations/mcp) | 是 | 依 Actor | Actor/Crawlee 可自建；平台託管 | CAPTCHA/fingerprint/session/proxy | marketplace 與專用 scraper 是另一種 moat |
| [Browser Use](https://docs.browser-use.com/cloud/quickstart) | 未核實 | 是 | 有 OSS library，Cloud 另計 | stealth、residential proxy、profiles | 自主 agent 是上層產品，不宜第一版就模仿 |

## 建議對標順序

### 第一圈：直接比較

**Browserless、Steel、Browserbase。** 銷售頁、README 與產品 demo 應直接回答相對它們的差異：

- 比 Browserless 更小、更容易部署在現有 Cloudflare 帳號，但初期工具與代理能力較少。
- 比 Steel Local 更強調安全預設、remote MCP 與 Cloudflare production deployment。
- 比 Browserbase 更有部署控制與資料邊界，但不承諾同等 proxy、CAPTCHA、identity 與企業 SLA。

### 第二圈：使用情境替代

**Cloudflare Browser Run、Firecrawl、ScrapingBee。** 使用者只想讀一頁、拿 Markdown 或 screenshot 時，這些服務都可能比完整 browser session 更簡單。Groundlane 必須靠下列項目形成理由：

- 一個 endpoint 同時給本機與雲端 Claude/Codex 使用。
- SSRF、redirect、subresource、DNS rebinding、deadline、output cap 與 concurrency 預設受控。
- 回傳 final URL、HTTP 狀態、challenge 狀態、timing、truncation 等可觀測 metadata。
- 部署與資料留在使用者自己的 Cloudflare account。

### 第三圈：暫時不要正面打

**Bright Data、ZenRows、Apify、Browser Use。** 它們的優勢分別來自大型 proxy/fingerprint/CAPTCHA 體系、成熟 scraping API、Actor 生態系與自主 agent。第一版不應宣稱能完整取代。

## 建議產品階梯

1. **Groundlane Fetch**：bounded Markdown/text/HTML、固定 structured output、安全 URL policy。
2. **Groundlane Search**：多 provider routing、normalized results 與清楚 attribution。
3. **Groundlane Extract**：selector-scoped deterministic JSON extraction。
4. **Groundlane Observe**：timings、fallback 狀態、trace 與成本資訊。
5. **Groundlane Sessions**：未來才評估隔離的 session handle、登入態與可靠 cleanup。

## 可用的定位文案

主標：

> The trusted web access layer for AI agents.

短描述：

> Search, fetch, and extract through one vendor-neutral MCP—with strict network boundaries, predictable limits, and an internal browser fallback.

不建議使用「繞過所有 Cloudflare」、「undetectable」或「Bright Data replacement」等承諾。`Groundlane` 這個名稱比 `stealth-fetch` 更誠實，因為它描述基礎設施角色，而不是保證永遠繞過反爬。

## 價格與產品基準摘要

- Browserbase：Free 1 browser hour；Developer $20/月；Startup $99/月。[官方方案](https://docs.browserbase.com/account/billing/plans)
- Browserless：Free 1,000 units；年繳月均 $25 起；self-host 為企業方案。[官方定價](https://www.browserless.io/pricing)
- Steel：Launch 無月費、按量；Scale $250/月加用量。[官方定價](https://docs.steel.dev/overview/pricinglimits)
- Hyperbrowser：browser $0.10/hour、proxy $10/GB，另依 fetch/search/agent 使用計費。[官方定價](https://hyperbrowser.ai/docs/pricing)
- Cloudflare Browser Run：Free 每日 10 browser minutes；Workers Paid 含每月 10 小時，超額 $0.09/hour。[官方定價](https://developers.cloudflare.com/browser-run/pricing/)
- Firecrawl：Free 1,000 credits/月；年繳方案 $16/月起。[官方定價](https://www.firecrawl.dev/pricing)

不同產品的 unit、credit、proxy traffic、CAPTCHA 與 concurrency 定義不同，不能直接只比較月費；採購或定價前應用同一批目標網站測量「每個成功結果成本」。

## 需要實測的下一步

以同一份測試集比較 Groundlane、Cloudflare Browser Run、Browserless、Steel Cloud 與 Firecrawl：普通 SSR、JavaScript-heavy、Cloudflare challenge、登入態、infinite scroll、selector wait、redirect/SSRF、timeout/cancel。記錄 success rate、p50/p95 latency、每成功頁成本、輸出品質與資料保留政策。

## 研究分卷

- [`appendix-browser-infrastructure.md`](appendix-browser-infrastructure.md)：Browserbase、Browserless、Steel、Hyperbrowser。
- [`appendix-scraping-platforms.md`](appendix-scraping-platforms.md)：Bright Data、ZenRows、ScrapingBee。
- [`appendix-agent-platforms.md`](appendix-agent-platforms.md)：Cloudflare Browser Run、Browser Use、Firecrawl、Apify。
