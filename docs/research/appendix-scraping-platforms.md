# Groundlane 競品研究：反爬與擷取平台

更新：2026-08-20。資料只取自廠商官方頁面，透過 `stealth_fetch` 實際抓取。金額為官方頁當下顯示的 USD 價格；未能完成官方頁抓取者標示 `unverified`。

## 快速比較

| 產品 | 核心定位 | 反爬／代理／CAPTCHA | Browser automation | API／MCP | 部署 | 官方定價 |
|---|---|---|---|---|---|---|
| Bright Data Browser API | 面向大規模、複雜互動與高防護站點的 fully managed remote browser | 自動代理輪替（含住宅 IP）、fingerprint、headers/cookies、重試、session recovery、CAPTCHA 偵測與解題；支援國家／城市／州／ASN 定位 | Playwright、Puppeteer、Selenium；CDP/WebDriver；click、scroll、hover、表單、多步流程、下載、session persistence、DevTools | Browser API 是 WebSocket/CDP 或 WebDriver。官方產品頁也列出 Bright Data MCP，但這次 MCP 文件 URL 回 404，細節 `unverified` | Bright Data 託管的 browser infrastructure，不是 self-hosted | PAYG $8/GB；$499/月含 71GB（$7/GB）；$999/月含 166GB（$6/GB）；$1,999/月含 399GB（$5/GB）；Enterprise 洽詢 |
| ZenRows | 一套共享 credits 的 web data infrastructure；Fetch、Extract、Batch、Browser Sessions 都在同一平台，偏 AI/data/automation teams | 官方稱各 primitive 都可處理 anti-bot walls、CAPTCHA、fingerprint；舊 Scraping Browser 頁明載住宅網路 fingerprint rotation。更細的 proxy/CAPTCHA 控制介面此次未驗證 | Browser Sessions；以 WebSocket 接既有 Puppeteer 或 Playwright；動態網站的 click、form、login、session state | 官網明載 MCP server、CLI、SDK，且 auth/logs built in；具體 MCP tools/transport 此次未驗證 | ZenRows 託管 remote browser；不需自行安裝／更新 browser | Free $0：5,000 credits/月；Build $16：45K；Launch $57：250K；Growth $165：1.2M；Scale $456：5M；Enterprise custom。頁面標 annual 可省 17%，但抓取畫面未能確認表列價格是否正顯示 monthly 或 annual toggle，故此點 `unverified` |
| ScrapingBee | API-first scraping service：傳 URL，回 HTML、rendered content、Markdown 或 structured data，讓客戶不用管理 browser/proxy/anti-bot | 自動 rotating proxies；premium residential 與 stealth proxies；country geolocation。官方頁未說明 CAPTCHA solver，故 CAPTCHA 為 `unverified` | 不是遠端 Playwright/CDP，而是 API 代跑 headless Chrome；支援 wait selector/event、click、scroll、fill、custom JS、viewport/header、screenshot | HTML API、AI extraction、CLI/Skills、dedicated APIs；首頁明載 MCP Server，但 MCP 詳細 URL 回 404，tools/transport/auth 細節 `unverified` | ScrapingBee 託管 browser 與 proxy fleet，不是 self-hosted | Hobby $19.99/75K credits/25 concurrency；Freelance $49.99/250K/50；Startup $99.99/1M/100；Business $249.99/3M/200；Business+ $599.99/8M/400；另有 Enterprise 與 custom |

## 1. Bright Data Browser API

### 定位與能力

- 主打「完整 browser interaction + advanced unblocking」，腳本跑在其 fully managed cloud browsers；使用者不需維護 browser、proxy network 或 anti-bot logic。[官方文件](https://docs.brightdata.com/scraping-automation/scraping-browser/introduction)
- 後台代管代理輪替、browser fingerprint、headers/session、CAPTCHA detection/solving、intelligent retries 和 session recovery。[官方文件](https://docs.brightdata.com/scraping-automation/scraping-browser/introduction)
- 可沿用 Playwright、Puppeteer、Selenium；連接介面包括 Chrome DevTools Protocol WebSocket 與 Selenium WebDriver。[產品頁](https://brightdata.com/products/scraping-browser)
- 適合 multi-step flows、表單、click/scroll、JavaScript-heavy sites，以及 anti-bot 行為不可預期的大規模工作。產品頁另列出 session persistence、file downloads、device emulation、ad blocker、live DevTools 與 logs。[產品頁](https://brightdata.com/products/scraping-browser)

### 定價

- PAYG：$8/GB，無月承諾。
- $499/月：含 71GB，$7/GB。
- $999/月：含 166GB，$6/GB。
- $1,999/月：含 399GB，$5/GB。
- Enterprise：custom package、Premium SLA、priority support、SSO、audit logs 等，需洽詢。[官方產品頁（價格數字完整）](https://brightdata.com/products/scraping-browser)；[官方 pricing 頁](https://brightdata.com/pricing/scraping-browser)

### 對 Groundlane 的啟示

- 這是最直接的「高成功率 scraping browser」標竿；競爭核心不只是 stealth plugin，而是 proxy pool、fingerprint、CAPTCHA、重試與可觀測性的一體化。
- 按 bandwidth 計價對簡單文字擷取不透明。Groundlane 可用「每次成功 fetch／每分鐘 browser」與明確截斷上限，提供更容易預估的成本。
- Bright Data 頁面已把 Agent Browser、MCP 放入 agentic web execution 敘事。[產品頁](https://brightdata.com/products/scraping-browser) 但本輪指定的 [MCP 文件 URL](https://docs.brightdata.com/api-reference/MCP-Server) 回 404，因此 MCP transport、tools 與免費條件均標為 `unverified`。

## 2. ZenRows

### 定位與能力

- 舊「Scraping Browser」已改名「Browser Sessions」；既有 `wss://browser.zenrows.com` endpoint 未變。其定位是讓 Puppeteer／Playwright 連 remote managed browser，不需自行安裝或維護瀏覽器。[官方 legacy product 頁](https://www.zenrows.com/products/scraping-browser)
- 現行平台把 Fetch、Extract、Batch、Browser Sessions 放在同一共享 credit balance；Browser Sessions 用於 click、forms、login、session state。[官方定價頁](https://www.zenrows.com/pricing)
- 官方定價頁宣稱 anti-bot、CAPTCHA、fingerprint checks 可套用於「every primitive」，並明載 MCP server、CLI、SDK，以及 auth/logs built in。[官方定價頁](https://www.zenrows.com/pricing)
- Legacy 頁另載明 concurrency/browser availability 由 ZenRows 管理，並以住宅網路輪換 fingerprints。[官方 legacy product 頁](https://www.zenrows.com/products/scraping-browser)

### 定價

- Free：$0，5,000 credits/月，5 concurrency。
- Build：$16/月，45K credits，20 concurrency。
- Launch：$57/月，250K credits，50 concurrency。
- Growth：$165/月，1.2M credits，100 concurrency。
- Scale：$456/月，5M credits，200 concurrency。
- Enterprise：custom volume，custom concurrency 400–1,000+，SLA、SOC 2、ISO 27001、DPA。[官方定價頁](https://www.zenrows.com/pricing)
- 官方頁稱只有成功 request 扣 credits，404/410 仍算 usable result；Extract beta 暫不額外收費，Batch 與 Fetch 同 rate。[官方定價頁](https://www.zenrows.com/pricing)
- 頁面同時顯示 Monthly / Annual（save 17%），但抓取文字無法辨識表內數字當下屬於哪個 toggle，故上面 `$16/$57/$165/$456` 的 billing cadence 顯示狀態為 `unverified`，不可直接拿來做採購承諾。

### 對 Groundlane 的啟示

- ZenRows 比 Bright Data 更像「單一 Agent Web Data API」競品：fetch、structured extraction、batch、browser、MCP 共用認證和 credits。
- Groundlane 若只提供 `web_fetch`，產品面會明顯窄於 ZenRows；MVP 因此以 `web_fetch`、`web_search`、deterministic `web_extract` 與安全 browser fallback 組成可驗證的最小工具面。
- ZenRows 的成功才計費與永久 free tier 是很強的 developer acquisition 方案；Groundlane 若部署於既有 Cloudflare Paid，可考慮小額 free quota 或 per-success accounting。

## 3. ScrapingBee

### 定位與能力

- 主打 web scraping API：一個 request 取得 HTML、browser-rendered content、Markdown 或 structured data，不用自行管理 proxy、browser、retry 與 blocking。[官方首頁](https://www.scrapingbee.com/)
- headless Chrome 支援 wait selector/browser event、custom interaction scenario、viewport/header 與 screenshot。[官方首頁](https://www.scrapingbee.com/)
- JavaScript Scenario 可執行 click、wait for CSS/XPath、scroll、fill input、evaluate custom JavaScript；它是 declarative API instructions，不是讓客戶直接連 remote Playwright browser。[官方 JavaScript Scenario 頁](https://www.scrapingbee.com/features/javascript-scenario/)
- 自動 proxy rotation，並提供 premium residential／stealth proxies 與 country geolocation。[官方首頁](https://www.scrapingbee.com/)
- AI extraction 可輸出 JSON/Markdown；另有 CSS/XPath extraction、HTML API、screenshots、Fast Search 與多種 dedicated scraping APIs。[官方首頁](https://www.scrapingbee.com/)
- 首頁明列 MCP Server（「Give your AI agent direct access to web scraping」）及 CLI/Skills，且稱 CLI 可接 Claude、Codex、Cursor 等。[官方首頁](https://www.scrapingbee.com/) 但 [MCP 詳細 URL](https://www.scrapingbee.com/mcp/) 回 404，因此 MCP tool list、transport、auth 和限制均為 `unverified`。
- 官方頁沒有在已抓內容中聲稱 CAPTCHA auto-solving，因此不能把 proxy/anti-bot 能力等同內建 CAPTCHA solver；此項為 `unverified`。

### 定價

- Hobby：$19.99/月，75K credits，25 concurrency。
- Freelance：$49.99/月，250K credits，50 concurrency。
- Startup：$99.99/月，1M credits，100 concurrency。
- Business：$249.99/月，3M credits，200 concurrency。
- Business+：$599.99/月，8M credits，400 concurrency。
- Enterprise 14：$999.99/月，14M credits，500 concurrency；其後還有 Enterprise 24/41/69/120 與 custom。
- JavaScript rendering、rotating/premium proxies、geotargeting、screenshots/extraction rules 列為各 plan 能力；新帳號有 1,000 free API credits，免信用卡。價格未含 VAT。[官方 pricing 頁](https://www.scrapingbee.com/pricing/)

### 對 Groundlane 的啟示

- ScrapingBee 的優勢是簡單 request/response API 與 declarative browser scenarios，整合門檻低於 CDP remote browser；這也是 Groundlane 維持小型、固定 MCP tool contracts 的重要參考。
- 它已把 HTML、Markdown、JSON extraction、screenshot 和 MCP 放在同一產品層。Groundlane 若保留 text/html/screenshot 三輸出，應再補 selector-scoped extraction 與 typed structured output 才有清楚產品差異。
- Groundlane 的防守點仍是 self-controlled Cloudflare deployment 與 security-first bounds；ScrapingBee 則在 managed proxies、geo、現成 API surface 與 SLA/scale 佔優。

## 建議定位

Groundlane 不應聲稱是完整 Bright Data／ZenRows 替代品。較可信的第一階段定位是：

> A security-first remote browser MCP for agents: bounded fetches, anti-bot browsing, predictable limits, and deploy-on-your-own-Cloudflare control.

差異化順序：

1. **MCP-native 與低操作成本**：一個 endpoint，Claude Code 本機與雲端共用。
2. **安全邊界是產品能力**：SSRF、redirect/subrequest policy、deadline、output caps、concurrency 與 audit metadata 預設開啟。
3. **部署控制**：Cloudflare Container 由自己帳號持有；和 SaaS 廠商代管瀏覽器區隔。
4. **成本可預測**：把 browser time、request outcome、bytes 與 challenge 狀態透明回傳。
5. **先聚焦 fetch/screenshot，再擴展**：若後續要正面對標 ZenRows，再加 JSON extraction、browser sessions、batch jobs；若要對標 Bright Data，則必須補 proxy network、fingerprint、CAPTCHA 與高規模 observability。

## 證據限制

- 全部事實僅採官方頁；沒有引用第三方評測或廠商互比頁的排名宣稱。
- Bright Data pricing 頁的動態數字未完整出現在抽取文字，但同一官方產品頁完整顯示方案數字，因此採後者。
- ScrapingBee 的首頁、pricing 與 JavaScript Scenario 已成功抓取；MCP 詳細 URL 回 404，因此只確認「有 MCP Server」這項首頁宣稱，不推論其實作細節。
