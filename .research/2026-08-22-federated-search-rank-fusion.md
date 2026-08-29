# Research: 多 provider 搜尋的來源選擇、排名融合與評估

訪問日：2026-08-22

## 子問題

1. 多個搜尋 provider 應全部查詢，還是先選擇適合的來源？
2. 不同 provider 的分數尺度不一致時，如何合併結果？
3. 如何同時保留 Tavily、Exa 等異質搜尋方法的互補性？
4. 應如何衡量相關性、多樣性、成本與延遲，而不是只看單次搜尋結果？

## 結論摘要

Groundlane 面對的問題在資訊檢索領域叫做 **federated search**。成熟的系統不是單純建立更長的 fallback list，而是分成：

1. collection/provider representation：描述每個來源擅長什麼、支援什麼條件及目前健康/額度狀態；
2. resource selection：依 query 選擇少數值得查詢的來源；
3. result merging：正規化 URL、去重，再融合多份排名；
4. reranking/diversification：在有限候選集上重排，限制同網域或同來源壟斷；
5. evaluation：同時量測 relevance、coverage、latency、provider attempts、quota/cost 與失敗率。

對 Groundlane 最務實的第一版不是立即訓練 router，而是：規則式 intent/capability routing，最多平行查 2 個互補 provider，canonical URL 去重，使用 weighted Reciprocal Rank Fusion（RRF）融合，再依 domain/provider 做多樣性限制。累積 query/result logs 與人工 relevance judgments 後，才考慮學習式 router。

## 來源清單

- [Federated Search](https://docs.lib.purdue.edu/ccpubs/402/) — Shokouhi & Si, 2011；來源角色：一手綜述；取用層級：完整摘要與書目，全文 PDF 僅取得原始 bytes。
- [Relevant document distribution estimation method for resource selection](https://dl.acm.org/doi/10.1145/860435.860490) — Si & Callan, SIGIR 2003；來源角色：一手；取用層級：搜尋摘要與後續一手論文的引用，ACM 頁面遭 403。
- [Taily: shard selection using the tail of score distributions](https://research.utwente.nl/en/publications/taily-shard-selection-using-the-tail-of-score-distributions) — Aly et al., SIGIR 2013；來源角色：一手機構頁；取用層級：完整摘要與書目。
- [Combination of Multiple Searches](https://trec.nist.gov/pubs/trec2/papers/txt/23.txt) — Fox & Shaw, TREC-2, 1994；來源角色：一手；取用層級：全文純文字。
- [Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods](https://research.google/pubs/reciprocal-rank-fusion-outperforms-condorcet-and-individual-rank-learning-methods/) — Cormack, Clarke & Büttcher, SIGIR 2009；來源角色：一手官方書目頁；取用層級：書目與搜尋摘要，作者 PDF 僅取得原始 bytes。
- [FeB4RAG: Evaluating Federated Search in the Context of Retrieval Augmented Generation](https://arxiv.org/html/2402.11891) — Wang et al., 2024；來源角色：一手；取用層級：全文 HTML。
- [Efficient Federated Search for Retrieval-Augmented Generation using Lightweight Routing](https://arxiv.org/html/2502.19280) — Dhasade et al., 2025/2026 version；來源角色：一手；取用層級：全文 HTML。
- [BEIR: A Heterogeneous Benchmark for Zero-shot Evaluation of Information Retrieval Models](https://arxiv.org/html/2104.08663) — Thakur et al., 2021；來源角色：一手；取用層級：方法、結果與結論（Groundlane 上限 100,000 字元，但涵蓋本研究所需段落）。

## 讀取完整度盤點

| 來源 | 讀到什麼程度 | 阻礙 |
|---|---|---|
| Federated Search | 🟡 完整摘要與目錄/搜尋片段 | Groundlane 對 PDF 回傳原始 `%PDF` bytes，未轉為可讀文字 |
| ReDDE | 🟡 摘要與可靠轉引 | ACM HTML 回 403；沒有把搜尋 snippet 當全文 |
| Taily | ✅ 完整摘要與書目 | 無；足以支持本文引用的效果主張 |
| Combination of Multiple Searches | ✅ 全文 | 無，NIST 提供純文字版本 |
| RRF | 🟡 官方書目頁、摘要片段 | 作者 PDF 經 Groundlane 取回為原始 PDF bytes |
| FeB4RAG | ✅ 全文 HTML（69,340 字元） | 無 |
| RAGRoute | ✅ 全文 HTML（64,335 字元） | 無 |
| BEIR | 🟡 所需方法、結果與結論 | 取回內容達 Groundlane 100,000 字元上限；相關段落完整 |

## 事實交叉表

| 事實 | 來源 1 | 來源 2 | 驗證狀態 |
|---|---|---|---|
| Federated search 的核心工作包含來源/collection representation、resource selection、result merging | Shokouhi & Si 摘要明列三項問題 | FeB4RAG 將 resource selection 與 result merging 定義為兩個關鍵任務 | ✅ |
| 查詢所有來源再 round-robin 合併，會帶來品質、API 成本與延遲風險 | FeB4RAG §1、§6 | RAGRoute §1–2 | ✅ |
| query-aware 選來源可以保留品質並降低工作量 | RAGRoute 在三個 benchmark 報告 communication volume 最多降低 80.65%、end-to-end latency 最多降低 52.50%，同時匹配查詢全部來源的 accuracy | Taily 在大型 web collections 上報告與 sample-based selection 類似 effectiveness，resources/response time 約改善 20% | ✅，但數字只適用各自實驗設定 |
| 多份搜尋結果融合通常優於依賴單一 run，但效果依 query 而異 | Fox & Shaw：CombSUM 多數設定優於單一 run，也明列 per-topic 差異 | RRF 論文摘要主張 RRF 幾乎總能改善被合併方法中的最佳結果 | ✅，非 Groundlane provider 的直接保證 |
| 不同來源的 raw score 不應無條件直接相加 | Fox & Shaw 的實驗建立在相似度可直接比較的設定，並把不同 weighting schemes 的 normalization 列為後續問題 | RRF 改用 rank 而非 raw score，因此不要求跨系統分數校準 | ✅ |
| 不同 retrieval 方法會在不同資料集/任務表現不同 | BEIR 在 18 個異質資料集上發現 in-domain 表現不能預測 zero-shot 泛化，且不同 architecture 的表現差異明顯 | FeB4RAG 強調真實 federation 的來源異質性 | ✅ |
| 好的 resource selection 與 result merging 能改善 RAG 輸出 | FeB4RAG 的 80-query 人工 pairwise study 較常偏好模擬最佳 selection/merging，而非 query-all + round-robin | RAGRoute 以多 benchmark 顯示 selection 可維持 end-to-end accuracy | ✅，FeB4RAG 的 best-fed 是 oracle simulation，不是可直接部署的演算法 |

## 我的推論（與上表分開）

| 推論 | 依據 | 這個推論可能錯在哪 |
|---|---|---|
| Groundlane 應把現在的線性 fallback 保留為可靠性層，另加 federation 模式 | 現有 `SearchRouter` 成功即返回；研究將來源選擇與結果融合視為獨立任務 | 使用者可能更重視最低延遲，並不需要多來源模式 |
| 第一版 fusion 應採 weighted RRF，而不是相加 provider score | provider score 尺度未校準；RRF 只依 rank 且是強 baseline | 特定 provider 的 calibrated relevance score 可能包含 RRF 會丟掉的資訊 |
| 預設最多查 2 個互補 provider 是合理起點 | 能增加 coverage，又比 query-all 更可控；RAGRoute/Taily 都支持 selective retrieval 的方向 | 最佳數量依 query、額度、延遲及 provider overlap 而變，必須用 Groundlane workload 驗證 |
| Tavily 與 Exa 應是「intent-aware 配對」而非永久先後順位 | 異質 retrieval 在不同任務的表現不同；federated search 需要 query-aware resource selection | 尚未有 Groundlane 自己的 relevance judgments 證明兩者的實際互補幅度 |
| 第一階段 router 不需要 LLM 或 neural classifier | provider 數少，可先依 capability、timeRange、domain filters、query intent、健康與額度做規則選擇 | 規則可能無法捕捉模糊 query；累積資料後學習式 router 可能明顯更好 |
| fusion 前必須 canonicalize URL，fusion 後需要 domain/provider diversity cap | 同頁跨 provider 重複會被錯當多份獨立證據，且單一來源可能壟斷 top-k | canonicalization 可能誤合併語言版、鏡像或帶不同內容的 URL |

## 對 Groundlane 的具體設計

目前 `SearchRouter.search()` 的 `auto` 行為是依固定 order 逐一嘗試，第一個成功就立即回傳。這是 **fallback routing**，不是 federated search；它能處理 provider 不可用與額度耗盡，但不會同時利用 Tavily/Exa 的互補結果。

建議新增明確模式而不是偷偷改變 `auto` 語意：

```text
query
  -> capability / health / budget filter
  -> intent-aware source selector (1 provider for fast; up to 2 for balanced/deep)
  -> bounded parallel search under one deadline
  -> canonical URL + duplicate clustering
  -> weighted RRF
  -> domain/provider diversity cap
  -> top-k normalized results + provenance/warnings
```

建議 API 概念：

- `strategy: "fallback" | "balanced" | "deep"`
- `fallback`：維持現況，第一個成功 provider 即回傳。
- `balanced`：通常選 2 個互補 provider，融合後回傳；任一失敗仍可 partial success。
- `deep`：查更多合適來源，但仍受 provider count、attempt budget、deadline、concurrency 與 output cap 限制。
- `providers` 可讓 caller 明確指定候選集合，但不能繞過 budget/security policy。
- 每筆結果保留 `providers[]`、各 provider rank、fusion score；不要把融合分數偽裝成任一 provider 的 raw score。

初始 RRF 可採：

```text
fusionScore(document) = Σ_provider weight(provider, query) / (k + rank_provider(document))
```

其中 `weight` 初期只使用可解釋規則，`k` 與權重透過離線 benchmark 調整；不要從 provider raw score 推導權重。

## 評估設計

建立 Groundlane 自己的 query set，至少分成：

- freshness/news；
- semantic/conceptual discovery；
- exact fact/navigation；
- technical docs/domain-filtered；
- multilingual；
- long-tail research。

每一類同時比較：單一 provider、現有 fallback、query-all round-robin、unweighted RRF、weighted RRF、規則式 source selection + RRF。指標至少包含：

- nDCG@k、Recall@k、MRR；
- unique relevant domains、duplicate rate、provider contribution；
- p50/p95 latency、attempts/query、partial failure rate；
- provider quota/credit consumption（維持各家原始單位，不擅自換算）；
- 若下游是 RAG，再評 coverage、correctness、citation support 與 answer preference。

## 建議閱讀順序

1. **Federated Search**：先建立 representation → selection → merging 的完整問題框架。
2. **RRF**：理解為何在分數不可比較時先融合 rank。
3. **FeB4RAG**：把經典 federated search 問題接到現代 RAG。
4. **RAGRoute**：看 query-aware routing 如何換取成本/延遲收益。
5. **Taily / ReDDE**：深入來源選擇的經典方法；Groundlane 初期可借概念，不必照搬 shard statistics。
6. **BEIR**：設計異質 query benchmark，避免只用單一類型測出假優勢。
7. **Combination of Multiple Searches**：理解 score fusion、agreement boost 與 normalization 的歷史脈絡。

## 工具與產品證據

- 本輪候選搜尋使用 Groundlane `web_search`。
- Tavily 搜尋成功；Brave 曾成功但後續觸發 rate limit；Exa 的 live call 回傳 sanitized `UPSTREAM_ERROR: Search provider rejected the request`。因此本輪只證明 Tavily 可用，不把 Exa secret「已設定」誤報為 provider「已可用」。
- Groundlane `web_fetch` 可完整讀取 arXiv HTML、Purdue、UTwente 與 NIST 純文字來源。
- 對兩份 PDF，`web_fetch` 回傳原始 PDF bytes 而非可讀文本；這是 Groundlane PDF extraction 的產品缺口，已在讀取完整度中標記。

## 待解問題

- Tavily 與 Exa 在 Groundlane 自己的 query set 上究竟有多少 overlap / unique relevant contribution？
- `balanced` 是否應固定選 2 家，或由 query confidence 動態選 1–3 家？
- partial failure 的成功 response 要如何呈現，才能讓 agent 知道 coverage 可能降低？
- 是否要加入廉價 lexical reranker，或只用 RRF + diversity cap？
- URL canonicalization 如何兼顧 tracking parameter 去除與不同語言/版本頁面的辨識？
