# Feature Opportunities — 從文件解析與工具系列文章萃取

日期：2026-09-11
來源：quidproquo 的「文件解析實戰」系列（9 篇）、RAG 技法大全系列、AI 爬蟲全景圖、Groundlane 實戰系列（5 篇）、NobodyClimb RAG Pipeline 架構
狀態：backlog，逐項評估後再排進 roadmap

---

## 一、文件解析層

### 1.1 `effort` 參數：解析品質-成本旋鈕

**靈感來源**：MinerU 的 `effort: medium | high` 參數；文件解析三層階梯（轉換→抽取→解析）的分層觀念

**現況**：`document_parse` 只有一條確定性路徑（anydoc WASM + bounded parser），`document_ocr` 和 Reducto 是獨立工具，caller 必須自己決定用哪個

**做法**：在 `document_parse` 加 `effort` 參數：

- `fast` — anydoc WASM 規則引擎，零成本，適合數位原生 PDF/DOCX/XLSX
- `standard` — 偵測到掃描頁時自動升級 OCR.space，混合數位+掃描文件的平衡點
- `deep` — VLM 或 Reducto 做版面感知解析，適合複雜表格、多欄、圖文混排

response 加 `effort_used` 欄位，讓 agent 知道實際走了哪條路徑

**大小**：medium — 主要是 `document_parse` tool handler 加路由邏輯，各 adapter 已存在

**前置**：1.2（VLM adapter）完成後 `deep` 才有第二個 backend 選項

---

### 1.2 VLM document adapter

**靈感來源**：Docling 的 VlmPipeline（GraniteDocling 258M）；Agentic Parsing 文章中「固定管線不夠」的論點

**現況**：document adapter 只有 anydoc-local、ocr-space、reducto-async、cloudconvert、workers-ai-whisper、pdf-table-extractor，沒有 VLM 路徑

**做法**：新增 document adapter，接以下任一 backend：

- **Docling-serve**（自架，MIT 授權）— 用 REST API 呼叫，支援 VlmPipeline 模式
- **Workers AI VLM**（Cloudflare 原生）— 如果有適合的視覺模型可用
- 回傳統一的 `DocumentEnvelope`，`engine: "vlm"` 標記 provenance

**大小**：medium — 寫一個新 adapter + 對應測試

**風險**：VLM 解析慢（數秒到數十秒），需要考慮 deadline 和 async fallback

---

### 1.3 `document_smart_parse` confidence routing

**靈感來源**：Agentic Parsing 文章 — 讓 agent 決定怎麼解析文件，而非一刀切

**現況**：`document_smart_parse` 用規則路由（副檔名 + magic bytes），掃描→OCR，Office→convert，其他→parse；不回報信心或替代建議

**做法**：

- 快速探測階段：前 N 頁試跑確定性 parser，回報 `confidence: 0-1` 和 `suggestedEffort`
- agent 可以接受預設路由，也可以根據 confidence 決定升級到 `deep`
- 不是自動升級（那會違反 bounded cost 原則），而是給 agent 資訊讓它決定

**大小**：small — 主要改 `document_smart_parse` 的 response schema

**前置**：1.1（effort 參數）

---

### 1.4 專用格式導出（JATS / XBRL）

**靈感來源**：Docling 的 USPTO、JATS、XBRL、DocTags 專用 XML 導出

**現況**：`document_parse` 只回 Markdown / text / structured / all projection

**做法**：加 `projection: "jats"` 和 `projection: "xbrl"` 選項：

- `jats` — 學術 PDF 導出為 JATS XML（Journal Article Tag Suite）
- `xbrl` — 財報導出為 XBRL

**大小**：large — 需要寫格式特定的序列化邏輯

**優先級**：低，除非有明確使用者需求。Docling 系列的文章已經指出這是 Docling 的差異化，不一定是 Groundlane 的戰場

---

### 1.5 影片轉錄（音軌 + 關鍵幀 OCR）

**靈感來源**：Docling 原生支援 MP4/AVI/MOV 的 ASR 轉錄 + 代表性幀

**現況**：`document_transcribe` 只做音訊（Workers AI Whisper），不接受影片

**做法**：

- 接受影片 URL/上傳 → 抽音軌 → 走現有 Whisper 路徑
- 可選：每 N 秒截一幀 → OCR（用現有 `document_ocr`）→ 合併成「逐字稿 + 畫面文字」的 timeline
- 需要 ffmpeg 或等效工具，Container 環境可行，Worker-only 模式不行

**大小**：large — 需要影片處理 runtime

**限制**：Worker-only lite mode 無法支援，只能在 Container 或自架環境用

---

## 二、RAG 管線

### 2.1 `document_chunk` field-aware 模式

**靈感來源**：RAG Attribute Conflation 文章 — embedding 把名字當難度搜，因為多個欄位壓進同一個向量

**現況**：`document_chunk` 做 hierarchical multi-level chunk（2048→512→128 tokens），每個 chunk 有 parent-child 和 block provenance，但不區分欄位

**做法**：

- 當 input document 有結構化欄位（表格行、metadata key-value）時，chunk 帶 `fields` 標記
- 例如一個產品頁的 chunk 會標 `fields: ["name", "price", "description"]`
- 下游向量庫可以用 field 做 metadata pre-filter，避免 embedding 混淆不同屬性

**大小**：small — 改 `document_chunk` 的 output schema + 從 structured projection 提取欄位資訊

**價值**：直接解決 RAG 系統最常見的檢索品質問題之一

---

### 2.2 `corpus_retrieval_test` — 召回品質檢查

**靈感來源**：RAGFlow 的 Retrieval Test — 在生成回答前看見召回內容

**現況**：`corpus_search` 回傳匹配結果，但沒有「給定 expected answer，檢查召回品質」的工具

**做法**：

- 輸入：query + expected_answer（或 expected_source_ids）
- 輸出：top-K 命中的 source、rank、relevance score、是否命中 expected
- 不走 LLM 生成，純檢索 + 比對

**大小**：small — 包一層在現有 `corpus_search` 上

**前置**：corpus runtime 已經可用

---

### 2.3 Corpus rank fusion

**靈感來源**：RAG multi-field retrieval 文章的 score fusion 三層防線；NobodyClimb 的 BM25 + dense hybrid

**現況**：`web_search` 有 parallel fan-out 和 rank fusion，但 `corpus_search` 沒有

**做法**：把 `web_search` 的 fusion 引擎（RRF 或 linear combination）複用到 corpus：

- corpus 的 SQLite FTS5（BM25）+ Vectorize（dense）兩路結果做 fusion
- 可選：加 metadata boost（caller 指定某些欄位加權）

**大小**：medium — 需要在 corpus 查詢路徑加 fusion 層

**前置**：corpus backend 支援多路查詢

---

## 三、Web 工具層

### 3.1 `web_extract` selector healing

**靈感來源**：AI 爬蟲全景圖的「智慧擷取」分類 — 選擇器自動修復

**現況**：`web_extract` 是確定性 selector + bounded pattern，selector 對不上就是空結果

**做法**：

- selector 完全匹配失敗時，用 DOM 結構相似度（tag sequence、class pattern、position）找最近匹配
- response 加 `healed: true` + `originalSelector` + `healedSelector`
- 不用 LLM，保持確定性；只在完全無匹配時嘗試，不替換已有匹配

**大小**：medium — 需要 DOM 結構比對邏輯

**風險**：healing 可能找到錯誤的元素，需要保守的相似度閾值

---

### 3.2 Browser stealth 等級

**靈感來源**：AI Agent 繞過 Cloudflare 反爬蟲完整指南

**現況**：browser fallback 有 Browserless / CF Browser Rendering / Hyperbrowser / local Playwright，但沒有顯式的反偵測等級

**做法**：

- `web_fetch` 和 `web_content` 加 `render: "stealth"` 選項
- stealth 模式優先使用 Hyperbrowser 或 Browserbase 的反偵測設定
- response 標 `stealthUsed: true`，保持 provenance 透明

**大小**：small — 主要是 browser adapter 選擇邏輯，底層 adapter 已存在

**注意**：README 明確說 Groundlane 不是 anti-bot bypass，stealth 定位為「提高公開頁面成功率」而非「繞過付費牆」

---

### 3.3 `web_interact` — bounded 頁面互動

**靈感來源**：AI 爬蟲全景圖的「AI 瀏覽器代理」分類；anti-bot 文章的 Playwright 操作

**現況**：所有 web 工具都是單次讀取，沒有「點按鈕→等結果→再讀取」的互動能力

**做法**：

- bounded 互動：caller 提供 action sequence（click selector / fill input / wait for selector），最多 N 步
- 回傳互動後的頁面快照（同 `web_fetch` 的 Markdown/HTML output）
- 每步有獨立 deadline，總體有 end-to-end deadline
- 不暴露 session：每次呼叫是獨立的 browser context

**大小**：large — 需要 stateful browser session + action 序列化 + 安全邊界

**風險**：互動工具的攻擊面遠大於只讀工具，需要嚴格的 URL/action allow list

**優先級**：低，直到有明確的使用者需求（大部分 agent 用例不需要頁面互動）

---

## 四、Arena 與品質基建

### 4.1 Document track automated benchmark

**靈感來源**：掃描 PDF 10 工具 benchmark 的評測方法論；Arena 設計文件的 Document track

**現況**：Arena 設計文件已完成（`docs/product/arena-design.md`），但未實作

**做法**：先跳過 UI 和 Elo 投票，做 CLI 版 automated benchmark：

- 用 benchmark 文章的考古題（掃描 PDF、繁體中文、多欄版面）當 test fixtures
- 跑 anydoc vs OCR.space vs Reducto 的 character-level F1
- 輸出 JSON leaderboard，可嵌進 README 當 badge

**大小**：medium — test fixtures 準備 + benchmark runner script

**價值**：Arena 最快能出可見成果的 track，不需要前端

---

### 4.2 Search track automated benchmark

**靈感來源**：Arena 設計文件的 Search track

**現況**：15 個 search provider adapter 已就位，沒有自動化的品質比較

**做法**：

- 50 個 query corpus（factual / current events / technical / multi-hop / ambiguous）
- 各 provider 的 top-5 precision/recall 對 ground truth
- 跑一次大約消耗各 provider 50 次 API call，成本可控

**大小**：medium — ground truth 準備是主要工作

**前置**：需要至少 3 個 provider 的 API key

---

## 五、優先級建議

按「投入大小 × 使用者價值 × 與現有架構的契合度」排序：

| 優先級 | 項目 | 大小 | 狀態 | 理由 |
|---|---|---|---|---|
| **P1** | 2.1 document_chunk field-aware | small | ✅ Done | 直接解決 RAG attribute conflation，改動小，價值大 |
| **P1** | 1.1 effort 參數 | medium | ✅ Done | 把已有的三條路徑（anydoc / OCR / Reducto）統一成一個旋鈕，使用者體驗大幅改善 |
| **P2** | 4.1 Document benchmark CLI | medium | ✅ Done | 讓 README 有數據說話，吸引貢獻者 |
| **P2** | 3.2 Browser stealth 等級 | ~~small~~ medium | ⏭ Skipped | 需要 FetchPipeline 多 backend 架構改動，不是 small |
| **P2** | 1.3 smart_parse confidence | small | ✅ Done | 1.1 做完後自然延伸 |
| **P3** | 1.2 VLM adapter | medium | ✅ Done | Docling-serve adapter + effort=deep wiring |
| **P3** | 2.2 corpus_retrieval_test | small | ✅ Done | corpus 使用者少時價值有限 |
| **P3** | 3.1 selector healing | medium | ✅ Done | 有用但風險需要控制 |
| **P4** | 2.3 corpus rank fusion | medium | 🔲 Backlog | 等 corpus 有更多使用者再做 |
| **P4** | 4.2 Search benchmark | medium | ✅ Done | Framework + 5-query corpus，需 provider key 才能實跑 |
| **P5** | 1.5 影片轉錄 | large | 🔲 Backlog | Worker-only 不支援，使用場景窄 |
| **P5** | 3.3 web_interact | large | 🔲 Backlog | 攻擊面大，使用者需求不明確 |
| **P5** | 1.4 JATS/XBRL 導出 | large | 🔲 Backlog | 除非有明確企業需求 |

### 額外完成（PR #4, #5）

| 項目 | 大小 | 狀態 | 來源 |
|---|---|---|---|
| corpus_source_inspect 工具 | small | ✅ Done | RAGFlow 文章 |
| audit_log 工具 + InMemoryAuditLog | small | ✅ Done | mcp-guardrail 文章 |
| MinerU cloud adapter (effort=deep fallback) | medium | ✅ Done | read4all 文章 |
| web_fetch credential scan | medium | ✅ Done | CS329Z Week 8 + GTIG credential theft |
| Crawl4AI content adapter tests | small | ✅ Done | AI 爬蟲全景圖 |
| 92 個 pre-existing eslint errors 修復 | medium | ✅ Done | CI 紅燈 |

---

## 六、下一波機會（從第二輪文章掃描萃取）

| 來源文章 | 機會 | 大小 |
|---|---|---|
| CS329Z Week 3 (MCP+tools) | `tool_policy` 內省工具：讓 agent 查詢可用工具的成本/延遲 | small |
| CS329Z Week 4 (ReAct+MemGPT) | `web_session` stateful 多輪瀏覽：跨 tool call 保持 browser context | large |
| CS329Z Week 6 (data flywheel) | `search_quality_log`：per-query 品質回饋，餵回 provider ranking | medium |
| GTIG credential theft | rate-limit anomaly detection：偵測同一 credential 的異常高頻呼叫 | medium |
| GraphRAG/LightRAG/HippoRAG | `corpus_graph_index` backend：knowledge-graph-aware multi-hop retrieval | large |
| NobodyClimb RAG pipeline | `web_search` query rewriting：低相關結果時自動加 metadata constraint 重寫 | medium |
| RAGFlow | `corpus_chunk_inspect`：讀取個別 chunk 和 metadata 做 QA | small |
| Agentic RAG survey | lazy corpus ingestion：enroll 時不自動 chunk，query 時才決定策略 | medium |
| mcp-guardrail | tool-call structured audit log：已有 InMemoryAuditLog，接下來做 auto-logging wrapper | small |
| KRU | credential-scoped tool routing：不同 credential 路由到不同 provider 子集 | small |
| ToolHive | document container isolation：在 sandbox 容器裡跑不信任的 document parsing | medium |
| read4all | `document_parse` MinerU cloud adapter | ✅ Done |
| AI scraping landscape (Crawl4AI) | Crawl4AI adapter for web_content | ✅ Done（adapter 已存在，補了 tests） |

---

## 附錄：文章對照表

| quidproquo 文章 | 萃取出的機會 |
|---|---|
| 文件解析三層階梯 | 1.1 effort 參數 |
| Docling 深入介紹 | 1.2 VLM adapter、1.4 專用格式、1.5 影片 |
| Agentic Parsing | 1.3 confidence routing |
| 掃描 PDF 10 工具 benchmark | 4.1 Document benchmark |
| RAG Attribute Conflation | 2.1 field-aware chunk |
| RAG 多實體查詢 | 2.1 field-aware chunk |
| RAGFlow 深入介紹 | 2.2 retrieval test、corpus_source_inspect、corpus_chunk_inspect |
| NobodyClimb RAG Pipeline | 2.3 rank fusion、query rewriting |
| AI 爬蟲工具全景圖 | 3.1 selector healing、3.3 web_interact、Crawl4AI adapter |
| AI Agent 繞過 Cloudflare 反爬蟲 | 3.2 stealth 等級 |
| Groundlane 系列篇 5（踩坑） | 3.1 selector healing、3.2 stealth |
| Arena 設計文件 | 4.1、4.2 automated benchmark |
| CS329Z 系列 | tool_policy、web_session、search_quality_log |
| GraphRAG/LightRAG/HippoRAG | corpus_graph_index |
| GTIG credential theft | credential scan、rate-limit anomaly detection |
| mcp-guardrail / mcp-spend-guard | audit log、spend caps（已有） |
| read4all | MinerU cloud adapter |
| ToolHive | document container isolation |
| KRU | credential-scoped routing |
