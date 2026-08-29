# Groundlane 擴展為 Agent Web Access Platform

研究日期：2026-08-21。官方能力來源：Tavily Search/Extract、Exa Search/Contents、Jina Reader/Reranker，均以 `stealth_fetch` 擷取。

## 結論

可以對標 Tavily、Exa、Jina，但 Groundlane 的 browser retrieval 只是完整產品的一個內部 engine。完整的 Web access layer 還需要搜尋來源、內容正規化、cache、citation；chunk/rerank 與 research orchestration 則屬後續範圍。

若範圍擴到這裡，建議：

- 對外產品統一稱 **Groundlane**。
- 處理 JavaScript、challenge 與互動頁面的底層 engine 稱 **Groundlane Browser**，只作內部技術名稱。

## 能力對照

| 能力 | Tavily / Exa / Jina 現況 | Groundlane 可否做 | 實作難度 |
|---|---|---:|---:|
| URL → Markdown/text | Tavily Extract、Exa Contents、Jina Reader | 可以，現有 fetch 已接近 | 低 |
| HTML / screenshot | 三者各有不同程度支援 | 可以，已具備 | 低 |
| selector wait / dynamic rendering | Jina Reader 與抓取產品提供相關選項 | 可以，現有 browser path 可做 | 低 |
| structured JSON extraction | Tavily/Exa 可回整理內容，其他產品也提供 schema extraction | 可以，加 schema + model/DOM pipeline | 中 |
| crawl / map / batch | Tavily 有 Crawl/Map；Exa Contents 可抓 subpages | 可以，加 queue、dedupe、robots、budget | 中 |
| query-aware chunks / highlights | Tavily Extract 可依 query rerank chunks；Exa Contents 可回 highlights | 可以，加 chunking + reranker | 中 |
| rerank | Jina 有專門 Reranker API/model | 可以，串 API 或部署模型 | 中 |
| web search | Tavily與 Exa 有自己的 search endpoint/index | 不能只靠 browser 等價取代 | 高 |
| semantic / neural search | Exa 的核心能力 | 需要自己的 index 或外部 provider | 很高 |
| answer / deep research | Tavily Research、Exa Answer/Agent | 可以在 search + fetch + rerank 上做 orchestration | 中高 |

## 建議架構

```text
Agent / MCP client
        |
        v
Groundlane API
  |- web_search      -> Tavily / Exa / other search provider
  |- web_fetch       -> HTTP fast path -> Groundlane Browser fallback
  |- web_extract     -> clean Markdown / schema JSON
  |- web_crawl       -> queue + dedupe + per-job budget
  |- web_rerank      -> Jina / local model / Workers AI
  |- web_research    -> search -> fetch -> rerank -> synthesize
  `- browser_session -> stateful login/click workflows
```

Browser 不應是所有工作的預設路徑：

1. 先查 cache。
2. 普通 HTTP fetch 能讀就直接讀。
3. HTML 清理並轉 Markdown。
4. 只有 JS、challenge 或互動需求才升級到 Groundlane Browser；MVP 不提供持久登入 session。
5. 依 query chunk/rerank，最後才把有限內容交給 agent。

這樣才能接近 Jina 的速度與 token 效率，同時保留 Groundlane 對難抓網站的優勢。

## 產品工具面建議

### 第一版

- `web_fetch(url, format, selector, waitFor, render, timeoutMs, maxBytes, maxOutputChars)`
- `web_search(query, maxResults, domains, excludeDomains, timeRange, provider, providers, strategy, timeoutMs)`：`auto` 預設最多選兩個互補 provider 並以 RRF 融合；可明確指定單一 provider、ordered candidate allowlist、sequential fallback 或最多三家的 deep search。預設候選包含 Tavily／Exa／Linkup／Parallel／Browserbase／Brave／Firecrawl／SerpApi／TinyFish；SearchAPI.io／Serper 作 opt-in finite-trial SERP provider；You.com 可用 keyless daily MCP profile 或 keyed REST，不自建索引。
- `web_extract(url, fields)`：以 CSS selector 做 deterministic extraction

### 第二版

- `web_crawl(url, depth, max_pages, include, exclude)`
- `web_rerank(query, documents, top_n)`
- `browser_session_create/navigate/extract/release`

### 第三版

- `web_research(question, sources, budget)`
- provider routing、quality telemetry、per-domain strategy、shared cache。

## 最重要的產品邊界

- **可以自己做的 moat**：安全 browser fallback、Cloudflare-native、自有部署、可觀測性、固定輸出契約、provider routing。
- **初期不要自己造的東西**：全網搜尋索引、住宅代理網路、大型 CAPTCHA/fingerprint 研發、通用 reranker model。
- **初期最佳策略**：把每月免費的搜尋 API 當可替換 provider；Jina keyless Reader（持續 rate-limit）、Cloudflare Browser Run 等抓取／browser 能力則放在 retrieval backend 層，不混入 `web_search`。

## 命名影響

**Groundlane** 作為整體 web access layer 的總產品名；各能力可依需要使用功能名稱：

- Groundlane Search
- Groundlane Reader
- Groundlane Browser（僅內部 engine）
- Groundlane Research

如此既不會把產品綁死在 Chromium，也能清楚表達 Groundlane 是其中一個執行引擎。

## 官方來源

- [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search)
- [Tavily Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract)
- [Exa Search](https://docs.exa.ai/reference/search)
- [Exa Contents](https://docs.exa.ai/reference/get-contents)
- [Jina Reader](https://jina.ai/reader/)
- [Jina Reranker](https://jina.ai/reranker/)
