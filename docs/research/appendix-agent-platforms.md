# Groundlane 競品研究：Cloudflare、Browser Use、Firecrawl、Apify

研究日期：2026-08-20。資料只取自各產品官方網站與文件，透過 `stealth_fetch` 擷取。價格均為頁面當下顯示的美元價格；未能由官方頁面確認的項目標為 `unverified`。

## 一頁結論

| 產品 | 核心定位 | AI agent / MCP | 瀏覽器控制與擷取 | 反爬能力 | 部署模式 | 官方價格重點 |
|---|---|---|---|---|---|---|
| Cloudflare Browser Run | 邊緣上的無頭 Chrome 基礎設施；同時服務 automation、scraping、testing、content generation | 官方把「Playwright MCP 或 CDP with MCP clients」列為 AI agent browsing 路徑 | Quick Actions 可做 HTML、Markdown、截圖、PDF、links、structured JSON、crawl；Browser Sessions 可經 Playwright、Puppeteer、CDP、Stagehand 直接控制 | 官方概覽未宣稱 CAPTCHA 解題、住宅代理或 stealth 指紋；只有全球邊緣瀏覽器與 Stagehand 的 resilient scraping 定位，因此硬站反爬能力為 **unverified** | Cloudflare 託管；Quick Actions 不需部署，完整 session 可在 Workers 或任何環境經 CDP 連入 | Free：10 browser minutes/day、3 concurrent browsers；Paid：10 hours/month included，超額 $0.09/hour；10 個平均並行 included，超額 $2/browser |
| Browser Use Cloud | 「託管 agent + browser infrastructure」雙產品：自然語言任務，或直接取得雲端 browser/CDP | 官方 Cloud 文件主要提供 SDK、REST、CDP、CLI/Claude Code integration；本次官方頁面未找到 remote MCP server，**MCP 為 unverified** | Hosted Agent 可完成自然語言 web task；Browser 可供 Playwright、Puppeteer、CDP 直接控制，另有 profiles、live observability | 官方明確宣稱 stealth、住宅代理、profiles；付費方案列 Advanced stealth，瀏覽器頁稱 fork Chromium | Browser Use 全託管 Cloud；另有開源 Python library，但 Cloud SDK 與開源 API 不同 | Free $0（10 agent tasks/月；定價頁同時出現 3 sessions 與表格 10 sessions，官方頁內部不一致）；Dev $29/25 sessions、Business $299/200、Scaleup $999/500；browser $0.02/hour；managed proxy $5/GB（Scaleup $4/GB） |
| Firecrawl | 將 web 轉成 LLM-ready context 的 API：search、scrape、crawl、parse、interact、agent | 官方 remote MCP：`https://mcp.firecrawl.dev/v2/mcp`，支援 keyless、browser sign-in/OAuth 或 bearer API key | Scrape 輸出 Markdown/HTML/JSON；Search、Map、Crawl、Parse；Interact 可點擊、填表、導航與抽取動態內容；另有 managed Browser Sandbox | 官方明確宣稱 proxies、anti-bot、JavaScript rendering、dynamic content；但未在本次資料中拆解 CAPTCHA、指紋或代理品質 | 官方託管 API/MCP；官方文件也列 Open Source 與 Self-hosting，但 self-host 與 cloud 的功能差距本次未核實 | Free 1,000 credits/月；Hobby $16/月年繳 5k；Standard $83/100k；Growth $333/500k；Scale $599/1M。Scrape/Crawl/Map 1 credit/page，Search 2 credits/10 results，Interact 2 credits/browser minute |
| Apify | Actors marketplace + serverless execution + storage/proxy，廣泛覆蓋 scraping 與 agent tools | 官方 hosted MCP `https://mcp.apify.com`（Streamable HTTP + OAuth），亦可本地 stdio；可搜尋/執行 Actors、讀 storage/results/docs | 核心不是單一通用 browser，而是可選 61k+ Actors、RAG Web Browser、網站專用 scraper，並能用 Actor 自建任意 browser workflow | 官方明確列 CAPTCHA solving、fingerprinting、session management、TLS/browser checks、headless JS challenge、proxy tiering、住宅/資料中心/SERP proxy | Apify Cloud 託管 Actors；MCP hosted 或本地 stdio client；Crawlee 為開源爬蟲 library | Free $0 含 $5 usage、$0.20/CU；Starter $29、Scale $199、Business $999（各自等額 usage）；住宅代理 $8/GB Free/Starter，Unblocker $1.5/1k requests；Actor 另依 pay-per-event 或 usage 計價 |

## 逐家重點與證據

### 1. Cloudflare Browser Run / MCP

- 官方定位是 Cloudflare 全球網路上的 headless Chrome，支援 browser automation、web scraping、testing、content generation。[Browser Run overview](https://developers.cloudflare.com/browser-run/)
- 產品分為 Quick Actions（stateless、單一 HTTP request、不需 code deployment）與 Browser Sessions（Playwright、Puppeteer、CDP、Stagehand）。Quick Actions 能輸出 Markdown、screenshots、PDF、snapshots、links、HTML elements、structured data 與 crawl results。[Browser Run overview](https://developers.cloudflare.com/browser-run/)
- AI agent browsing 的官方推薦是 Playwright MCP 或讓 MCP client 走 CDP；因此它更像「瀏覽器執行層」而不是替 agent 做完整任務規劃的 agent SaaS。[Browser Run overview](https://developers.cloudflare.com/browser-run/)
- 官方 MCP 文件頁存在，但目前抓到的頁面沒有展開 server URL、tool schema 或 authentication 細節；這些細節為 **unverified**。[MCP server docs](https://developers.cloudflare.com/browser-run/mcp-server/)
- Free 是每日 10 分鐘 browser hours、3 個 concurrent browsers。Workers Paid 含每月 10 小時，超額 $0.09/hour；Browser Sessions 含月平均 10 個 concurrent browsers，超額 $2/browser。Quick Actions 只按 browser hours，Sessions 同時計 browser hours 與 concurrency。[Pricing](https://developers.cloudflare.com/browser-run/pricing/)
- 差異化含全球 edge、低 cold start、session reuse、Quick Actions；但官方概覽和價格頁沒有承諾 CAPTCHA solving、residential proxy 或 stealth browser fingerprint，不能把它當成 ZenRows/Bright Data 類 unblocker 的直接等價物。

### 2. Browser Use Cloud

- 官方將 Cloud 分為 Agent（給自然語言 goal，回傳完成結果）與 Browser（提供 SDK/REST/CDP 管理瀏覽器）。Browser 可讓 Playwright、Puppeteer 或其他 CDP client 直接控制。[Cloud docs index](https://docs.browser-use.com/llms.txt) [Quickstart](https://docs.browser-use.com/cloud/quickstart)
- Cloud infrastructure 宣稱兩產品皆含 stealth、residential proxies、profiles、live observability；官方另稱 fork Chromium 以存取網站。[Cloud docs index](https://docs.browser-use.com/llms.txt)
- 定價：Free $0；Dev $29/月、25 sessions；Business $299/月、200 sessions；Scaleup $999/月、500 sessions，月費轉成 credits。Browser session $0.02/hour；managed proxy $5/GB，Scaleup $4/GB；自帶 proxy 或 proxyless egress $0.20/GB。[Pricing](https://browser-use.com/pricing)
- 需注意官方定價頁內部矛盾：Free 卡片寫 3 concurrent sessions、top up 後 10，但 comparison table 寫 10。採購前需由 dashboard 或 sales 再確認。
- 官方文件列 Claude Code / Claude Managed Agents 的 CLI integration，但本次官方資料沒有找到 Browser Use remote MCP endpoint，因此不能宣稱它具原生 MCP server；標為 **unverified**。[Cloud docs index](https://docs.browser-use.com/llms.txt)

### 3. Firecrawl

- 定位是「一個 API 完成 search、scrape、interact」並回傳 LLM-ready Markdown、structured JSON、screenshots；另有 Map、Crawl、Parse、Agent、Browser Sandbox。[Introduction](https://docs.firecrawl.dev/introduction)
- Interact 能延續 scrape session，以自然語言或 code 點擊、填表、抽取動態內容與導航，因此已從純 extraction 延伸到 browser action，但產品核心仍偏 web context/data API。[Introduction](https://docs.firecrawl.dev/introduction)
- 官方宣稱會處理 proxies、anti-bot、JavaScript rendering、dynamic content；更細的 CAPTCHA、指紋、住宅 IP 能力本次未從官方頁面核實。[Introduction](https://docs.firecrawl.dev/introduction)
- 官方 remote MCP endpoint 是 `https://mcp.firecrawl.dev/v2/mcp`；支援免帳號/免 key 的有限 Search、Scrape、Parse，也能 browser sign-in，或用 bearer API key 取得方案完整 tool surface。[MCP setup](https://docs.firecrawl.dev/mcp-server)
- 價格是 credits 制：Free 1,000/月；Hobby $16/月（年繳）5,000；Standard $83/100,000；Growth $333/500,000；Scale $599/1,000,000。Scrape/Crawl/Map 每頁 1 credit，Search 每 10 results 2 credits，Interact 每 browser minute 2 credits。[Pricing](https://www.firecrawl.dev/pricing)

### 4. Apify

- Apify 是最廣的平台型競品：61k+ Actors、serverless Actor runtime、storage、proxy、排程/API，再由 MCP 對 agent 暴露 Actor discovery/execution 與結果讀取。[Pricing](https://apify.com/pricing) [MCP docs](https://docs.apify.com/integrations/mcp)
- Hosted MCP 使用 Streamable HTTP + OAuth，網址 `https://mcp.apify.com`；也可用 `@apify/actors-mcp-server` 跑 local stdio。預設提供 Actor discovery、docs 與 RAG Web Browser，agent 還能動態搜尋、檢視 schema/price、呼叫未預先配置的 Actor。[MCP docs](https://docs.apify.com/integrations/mcp)
- MCP 有安全邊界：full-permission Actors 與 rental Actors 不允許由 MCP 搜尋/執行；執行 Actor 或讀 storage/run data 要 authentication。Hosted MCP 另提供 structured output schema inference。[MCP docs](https://docs.apify.com/integrations/mcp)
- 反爬範圍最完整：Actors 可內建 CAPTCHA solving、fingerprinting、session management；Crawlee 提供 realistic fingerprints、browser TLS、headless JS challenges、proxy tiering；Apify Proxy 有住宅、datacenter、SERP、rotation、geo targeting。[Anti-blocking](https://apify.com/anti-blocking)
- Free 含 $5 usage，$0.20/CU（1 GB RAM/hour）；Starter $29、Scale $199、Business $999，月費形成等額 prepaid usage，超額 PAYG。住宅代理從 $8/GB 起，Unblocker 從 $1.5/1,000 requests 起；Store Actor 還有 pay-per-event 或 pay-per-usage，成本預測比單一 API 複雜。[Pricing](https://apify.com/pricing)

## 對 Groundlane 的產品含義

1. **不要與 Apify 比「工具數量」**：Apify 的 moat 是 marketplace、專用 Actor、proxy 與 execution/storage 平台。Groundlane 適合主打小而可控的單一 browser primitive。
2. **不要只做 URL → Markdown**：Firecrawl 已把 search/scrape/crawl/parse/MCP 做成成熟 context API。若只回傳乾淨內容，Groundlane 很難形成區隔。
3. **最接近的正面比較是 Browser Use infrastructure 與 Cloudflare Browser Run**：應主打遠端 MCP 原生、可自訂 stealth/headers/proxy、可觀測 final URL/status/timing、可預測的 timeout 與 SSRF safety。
4. **值得保留的 wedge**：穩定的 `web_fetch`、`web_search`、`web_extract` 契約，部署在自己的 Cloudflare account，並以 Groundlane Browser 作必要時的內部 fallback；stateful browser session 不屬 MVP。
5. **名稱建議仍可用 Groundlane**：它誠實描述「agent 與 remote browser 間的 relay」，不會像 `stealth-fetch` 暗示對所有 anti-bot 都保證繞過。

## 仍需實測，不應只信產品頁

- 同一批 Cloudflare-protected、login-required、infinite-scroll 與 CAPTCHA 網站的成功率。
- Browser Run 是否具備足夠 proxy/fingerprint customization；官方概覽未證實。
- Browser Use 是否有正式 remote MCP server；官方 Cloud docs 本次只證實 SDK/REST/CDP/CLI 路徑。
- Firecrawl self-host 是否擁有 cloud 版相同 anti-bot/proxy 能力。
- 四者在相同 page set 下的 p50/p95 latency、challenge success rate、每成功頁成本，以及資料保留政策。

## 擷取限制

最初對多頁並行呼叫 `stealth_fetch` 時 MCP transport 關閉；後續改為逐頁啟動同一個 `stealth_fetch` MCP server 抓取官方頁面。這不影響上列官方內容，但代表目前工具的 parallel-call 穩定性仍值得做 regression test。
