# Groundlane 延伸競品地圖

研究日期：2026-08-21。官方產品頁與文件以 `stealth_fetch` 擷取。產品方自行公布的 benchmark 與品質宣稱未經獨立驗證。

## 新增競品中最重要的三類

### 1. 最直接的 full-stack Web Intelligence API

| 產品 | 官方能力 | 對 Groundlane 的威脅 |
|---|---|---|
| [Parallel](https://parallel.ai/) | 自有 web index；Search、Extract、Monitor、Deep Research、FindAll；cited structured output 與 confidence | 目前最接近 Groundlane 終局的競品，從 retrieval 一路覆蓋 research 與 monitoring |
| [Linkup](https://docs.linkup.so/) | Search、Fetch、Research、Tasks、Extract；structured JSON、source filtering、BYOC | 和 Groundlane 的 API 表面高度重疊，且主打 production/security/data sovereignty |
| [You.com API](https://www.you.com/api) | Search、Contents、Answer、Research、Finance Research、remote MCP | 幾乎完整覆蓋建議中的 Groundlane 工具面，且有免 key MCP 入門方案 |
| [Perplexity API](https://docs.perplexity.ai/) | raw Search、Agent API、grounded answer、embeddings、source filters | 強在 model + search + citation 的整合，不需使用者自行編排 research pipeline |

### 2. 搜尋索引與特殊資料供應商

| 產品 | 官方能力 | 市場角色 |
|---|---|---|
| [Brave Search API](https://brave.com/search/api/) | 獨立 web index、web/news/image/local、LLM context、Answers、Goggles rerank/filter、MCP | 可作 Groundlane 的 search provider，也會直接競爭 `web_search` |
| [SerpApi](https://serpapi.com/search-api) | Google 與多種垂直搜尋引擎的結構化 SERP API；Free 方案每月 250 searches、每小時 throughput 50 | 適合作為低門檻 provider；MVP 只映射 Google organic results，避免混合不相容的垂直 schema |
| [Valyu](https://www.valyu.ai/) | Web 加 finance、science、healthcare、compliance 等專業與授權資料；research 與 cited structured output | 垂直專業研究競品；提醒 Groundlane 只做 open web 很難打高價值專業市場 |
| [Diffbot Extract](https://www.diffbot.com/products/extract/) | 以 computer vision/NLP 分類頁面並依標準 ontology 產出 structured JSON，另有 Knowledge Graph | 結構化 extraction 與 entity data 標竿，不只是 Markdown reader |

較傳統的 search API，例如 SerpApi、Serper、SearchAPI.io，也會競爭基礎 SERP 預算，但產品 moat 通常比較偏「取得搜尋結果」，不是完整 agent research layer。[SerpApi pricing](https://serpapi.com/pricing)

### 3. Browser、unblocking 與 extraction 平台

| 產品 | 官方能力 | 與 Groundlane 關係 |
|---|---|---|
| [Zyte API](https://www.zyte.com/zyte-api/) | automatic ban handling、browser rendering、sessions/actions、proxy rotation、typed/AI extraction，依成功 response 計費 | Groundlane 困難網站 fallback 的直接競品 |
| Bright Data、ZenRows、ScrapingBee | proxy、fingerprint、CAPTCHA、browser/API extraction | 已在前一輪研究，競爭高成功率抓取預算 |
| Oxylabs、Nimble、ScraperAPI、Crawlbase | managed proxy/unblock/scraping API | 同類替代者；若 Groundlane 加 managed unblocker 就會正面競爭 |

## 最容易被忽略的競品：模型平台內建工具

這些不一定被稱為 Web API 公司，但可能直接消除額外 MCP 的需求：

- [OpenAI Web Search](https://platform.openai.com/docs/guides/tools-web-search)：Responses API 內建 quick search、agentic search、deep research、source citations。
- [Anthropic Web Search](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool)：Claude API server tool，支援多輪搜尋、引用、domain controls 與動態結果過濾。
- [Gemini Grounding with Google Search](https://ai.google.dev/gemini-api/docs/google-search)：模型自動產生查詢、處理搜尋結果並回傳 citation。

這類產品的優勢是零額外整合；缺點則是綁定模型供應商、底層 retrieval 控制與可攜性較低。Groundlane 必須靠 model-neutral、可觀測、可部署控制與 browser fallback 才有存在理由。

## 威脅排序

1. **Parallel、Linkup**：與 Groundlane 的完整願景最相似。
2. **模型原生 Web Search**：最可能讓一般使用者覺得不需要額外工具。
3. **You.com、Tavily、Exa、Firecrawl、Perplexity API**：API/MCP 型功能正面重疊。
4. **Brave Search API**：既是競品，也可能是最合理的底層 provider。
5. **Browserless、Steel、Zyte、Bright Data、ZenRows**：Groundlane engine 的直接競品。
6. **Valyu、Diffbot**：往專業資料或 knowledge graph 發展時才會正面相遇。

## Groundlane 不應選擇的戰場

- 不自建全網搜尋 index 與 crawler fleet 去正面打 Brave、Exa、Parallel。
- 不自建住宅代理網路去正面打 Bright Data、Oxylabs、Zyte。
- 不用自己的 LLM research agent 去和所有模型平台拼 benchmark。

## 比較可信的產品切角

Groundlane 應定位為 **vendor-neutral web access control plane**：

1. 統一 Tavily、Exa、Parallel、Browserbase、Brave、Firecrawl、SerpApi 等每月免費 provider 的輸出契約；Jina 的 keyless Reader 可作持續免費 retrieval backend，但不列入目前搜尋 provider。
2. 依 latency、cost、domain、freshness 與成功率自動 routing。
3. provider 抓不到時，升級到內部的 Groundlane Browser。
4. 統一處理 cache、citations、dedupe、rerank、budgets、audit metadata。
5. 可部署在自己的 Cloudflare account，避免被單一 model/search vendor 綁定。

這個切角不是宣稱每一項能力都勝過專業供應商，而是讓 agent 用一套 MCP、安全政策與觀測面取得整個 web。
