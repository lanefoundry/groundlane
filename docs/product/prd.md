# Groundlane MVP 產品需求文件

狀態：Draft for implementation  
日期：2026-08-21  
範圍：`web_fetch`、`web_search`、`web_answer`、`web_research`、`web_content`、`web_map`、`web_crawl`、`web_news`、`web_images`、`web_extract`，provider diagnostics，以及支撐它們的 remote MCP、security policy 與 Cloudflare deployment

## 1. 摘要

Groundlane 是供 AI agent 使用的 vendor-neutral web access layer。MVP 的核心 Web primitives 是 stateless tools：讀取頁面的 `web_fetch`、代理多家搜尋服務的 `web_search`、取得 provider-grounded answers 的 `web_answer`、取得 provider-attributed research reports 的 `web_research`、透過 provider content APIs 抓 URL 內容的 `web_content`、探索網站 URL 的 `web_map`、有界 crawl 公開網站的 `web_crawl`、搜尋 news-specific indexes 的 `web_news`、搜尋 image-specific indexes 的 `web_images`、以及依 DOM 規則抽取欄位的 `web_extract`。部署也可以暴露 provider diagnostics，例如 `provider_balance`、`provider_capabilities`、`provider_quota` 與 `search_budget_status`，分別用來檢查帳號餘額、已實作功能邊界、整合 quota 狀態與 Groundlane 本機搜尋 attempt guardrail。

系統以便宜、容易觀測的 HTTP retrieval 為優先；只有在明確需要 render 時，才升級到內部 **Groundlane Browser** engine。搜尋透過可替換 provider adapters，不自建全網 index。Extraction 必須 deterministic，不以隱藏的 LLM call 假裝穩定 structured output。

## 2. 問題

AI agent 若直接依賴模型廠商的 Web Search、單一 search API 或無限制的 remote browser，會遇到下列問題：

- client 與模型綁定，工具契約不可攜；
- 搜尋供應商的輸出、filter 與失敗語意不同；
- 普通頁面也啟動 browser，增加 latency、cost 與攻擊面；
- URL、redirect、DNS、subresource 與 response 沒有一致安全邊界；
- output、deadline、concurrency 與 provider spend 難以預測；
- schema extraction 混入不可見的模型推論，結果難以重現。

## 3. 目標與成功指標

### 3.1 產品目標

1. 任何支援 Streamable HTTP MCP 的 agent client，都能以一個 endpoint 使用 Web primitives 與只讀 provider diagnostics。
2. 使用者可替換 search provider，而不必改 tool name 與 normalized output contract。
3. 一般公開頁面由 HTTP fast path 完成；browser 只處理明確 render/fallback 條件。
4. 公開工具共用 authentication、URL policy、deadline、resource limits、errors 與 audit metadata。
5. 可在本機開發，並能遷移到 Cloudflare Worker + Container topology。

### 3.2 MVP 成功指標

- contract tests 能完成 MCP initialize、tools/list 與公開 tools/call。
- 所有公開 tool failure 都回傳穩定 error code，不洩漏 secret、stack 或 raw upstream body。
- security regression suite 覆蓋 direct private IP、DNS-to-private、redirect-to-private、IPv6、metadata endpoint 與 browser subresource。
- fetch/extract fixtures 可分辨 HTTP 與 browser engine，並保留同一 end-to-end deadline。
- provider routing tests 覆蓋 explicit selection、capability filtering、provider-rejection fallback 與 explicit-provider failure。
- 預設 CI 不需要 live provider key 或任意外網即可通過。

## 4. 使用者與情境

- **Agent developer：**需要跨 Claude、Codex 或自製 agent 共用 Web tools。
- **Platform operator：**希望 provider credentials、browser workload、limits 與 audit data 留在自己的環境。
- **Tool author：**需要固定的 search/fetch/extract schema，而不是每家 API 分別整合。

主要 job-to-be-done：

- 「讓 agent 讀取一個公開 URL，並知道實際 final URL、engine 與是否 truncated。」
- 「用同一工具搜尋 Web，由系統選擇可用 provider，但保留來源 attribution。」
- 「用同一工具並行詢問多個 answer-capable providers，保留各自答案與 citations，不做不可審計的隱藏合成。」
- 「用同一工具並行呼叫多個 provider content APIs，對照不同 provider 對同一 URL 的抽取品質與成功率。」
- 「從固定頁面 DOM 抽出具名欄位，結果可重現、缺失欄位可判斷。」

## 5. MVP 功能需求

### 5.1 Remote MCP surface

- 提供 authenticated `POST /mcp` Streamable HTTP endpoint。
- 提供 unauthenticated `GET /healthz` liveness endpoint，但不得洩漏設定。
- 提供 `GET /readyz` readiness endpoint，確認 Container reachability 與必要 service configuration；MVP 不用 live provider call 作 readiness probe。
- MVP tools 為 stateless；transport session identifier 不得當成 browser session。
- 每次 request 有 request ID、單一 deadline 與一致 public error envelope。

### 5.2 `web_fetch`

預期 input：

- `url`：必填 HTTP(S) URL。
- `format`：`markdown | text | html`，預設 `markdown`。
- `selector`、`waitFor`：選填 DOM 範圍／等待條件。
- `timeoutMs`、`maxBytes`、`maxOutputChars`：選填但受 deployment 上限約束。
- `render`：`auto | never | always`，預設 `auto`。

預期 output：

```text
requestedUrl, finalUrl, status, contentType, title?, description?, author?, publishedAt?, content, format,
engine(http|reader|browser), backend, cached, truncated, bytes, durationMs,
warnings[], fallbackReason?
```

行為：

- MVP 不做 response cache，`cached` 固定為 `false`，保留此欄位供未來 adapter 相容使用。
- HTTP path 必須限制 redirect、bytes 與 deadline。
- `render=never` 不得啟動 browser。
- `render=always` 直接使用 Groundlane Browser，但仍套用同一 URL policy 與 deadline。
- `render=auto` 只在 JS-empty document、selector/wait condition 未滿足、已知 challenge response 或 HTTP path 不支援時 fallback。
- Jina Reader 僅能作無 selector／wait condition 的 Markdown fallback；HTML 與 deterministic extraction 不得假裝由 Reader 完成。
- output 的 `backend` 必須揭露 `direct | jina | local | browserless` 等實際來源。
- 一般 4xx 不因狀態碼本身自動使用 browser retry。
- output 超過字數上限時安全截斷並標示 `truncated=true`。
- 無 selector 的 HTML Markdown/text 由內建 Groundlane Reader 選擇正文、移除常見 page chrome、解析相對 HTTP(S) 連結，並擷取有界的文章 metadata；此 deterministic normalization 不改變 retrieval provenance。

### 5.3 `web_search`

預期 input：

- `query`：必填查詢字串，長度受限。
- `maxResults`：有 deployment 上限的結果數。
- `domains`、`excludeDomains`、`timeRange`：選填 filter。
- `timeoutMs`：選填 request deadline，但不得超過 deployment 上限。
- `provider`：`auto | tavily | exa | parallel | browserbase | brave | firecrawl | serpapi | linkup | keenable | serper | you`。
- `providers`：選填、有界且有順序的 provider candidate allowlist；不可與 explicit `provider` 同時使用。
- `strategy`：`fallback | balanced | deep`；`auto` 預設為 `balanced`。

預期 output：

```text
query, provider, strategy,
providersSelected[], providersAttempted[], providersSucceeded[],
results[{title,url,snippet,publishedAt?,score?,provider,fusionScore?,sources?}],
durationMs, warnings[]
```

行為：

- `auto` 先過濾能支援請求 features、具 credential 或 keyless public mode、健康且尚有本機 budget 的 providers。
- `balanced` 預設選擇最多兩個互補 provider family；`deep` 最多三個；`fallback` 依序嘗試直到第一個成功。
- 每次 provider attempt 先原子消耗該 instance 的月度 request budget；到頂後跳過並回報 warning。
- explicit provider 不可被靜默換成另一家。
- 非 explicit provider 的 `fallback` 會把單一 provider 的 HTTP rejection、timeout、rate limit、5xx 或 malformed response 轉成 warning 並換下一家；明確指定 `provider` 時不得靜默切換其他 provider。
- federated strategy 共用同一個 deadline，至少一家成功即可回傳 partial success；全部失敗才回 `PROVIDER_UNAVAILABLE`。
- 多家結果先做保守 canonical URL 去重，再以 health-adjusted RRF 融合；不得直接相加不同 provider 的 raw score。
- response 必須清楚標出 selected、attempted、successful providers，以及每筆 fused result 的 rank provenance。
- provider 回傳 URL 仍屬不可信資料，後續 fetch 必須重新套用 URL policy。

### 5.4 `web_answer`

預期 input：

- `query`：必填查詢字串，長度受限。
- `maxResults`：有 deployment 上限的引用來源數。
- `domains`、`excludeDomains`、`timeRange`：選填 filter。
- `timeoutMs`：選填 request deadline，但不得超過 deployment 上限。
- `provider`：`auto | linkup | you`。
- `providers`：選填、有界且有順序的 answer provider candidate allowlist；不可與 explicit `provider` 同時使用。
- `strategy`：`parallel | fallback`；預設為 `parallel`。

預期 output：

```text
query, strategy,
providersSelected[], providersAttempted[], providersSucceeded[],
answers[{provider, answer, citations[{url,title?,excerpts[]}],
results[{title,url,snippet,publishedAt?,provider}], durationMs, warnings[]}],
durationMs, warnings[]
```

行為：

- `auto` 只選擇已設定 credential 且支援該請求 filters 的 answer providers。
- `parallel` 在同一 deadline 與 abort signal 下並行呼叫多個 providers；至少一家成功即可回 partial success。
- `fallback` 依序嘗試直到第一個成功，適合想節省 answer-call credits 的 client。
- 回傳多家答案時不做 LLM synthesis；caller 可自行比較或另行合成。
- provider 回傳 citation/source URL 必須套用 public URL policy；不安全來源丟棄。
- 第一批實作 provider 是 You.com Answer API 與 Linkup `outputType=sourcedAnswer`。

### 5.5 `web_content`

預期 input：

- `url`：必填 HTTP(S) URL。
- `maxContentChars`：單一 provider content 的字數上限。
- `timeoutMs`：選填 request deadline，但不得超過 deployment 上限。
- `provider`：`auto | linkup | you | exa | tavily | firecrawl | keenable`。
- `providers`：選填、有界且有順序的 content provider candidate allowlist；不可與 explicit `provider` 同時使用。
- `strategy`：`parallel | fallback`；預設為 `parallel`。
- `live`：選填，要求支援的 provider 嘗試 live/fresh retrieval。

預期 output：

```text
url, strategy,
providersSelected[], providersAttempted[], providersSucceeded[],
contents[{provider,url,finalUrl,title?,content,format(markdown|text),truncated,durationMs,warnings[]}],
durationMs, warnings[]
```

行為：

- 呼叫 provider 前先用 Groundlane public URL policy 驗證目標 URL。
- `auto` 只選擇已設定 credential 或 keyless public mode 且支援該請求的 content providers。
- `parallel` 在同一 deadline 與 abort signal 下並行呼叫多個 provider content APIs；至少一家成功即可回 partial success。
- `fallback` 依序嘗試直到第一個成功，適合想節省 content-call credits 的 client。
- 回傳多家內容時不做 LLM synthesis；caller 可自行比較品質、長度與來源。
- provider 回傳 final URL 必須重新套用 public URL policy；不安全來源丟棄。
- 第一批實作 provider 是 Linkup Fetch、You.com Contents、Exa Contents、Tavily Extract、Firecrawl Scrape 與 Keenable Fetch。

### 5.6 `web_map`

預期 input：

- `url`：必填 HTTP(S) root URL。
- `maxLinks`：最多回傳 URL 數，上限 1,000。
- `provider`：`auto | firecrawl | tavily`。
- `providers`：選填、有界且有順序的 map provider candidate allowlist；不可與 explicit `provider` 同時使用。
- `strategy`：`parallel | fallback`；預設為 `parallel`。
- `search`：選填，交給支援 provider 做相關 URL discovery。
- `includeSubdomains`、`ignoreCache`、`maxDepth`、`maxBreadth`：有界 provider map controls。
- `timeoutMs`：選填 request deadline。

預期 output：

```text
url, strategy,
providersSelected[], providersAttempted[], providersSucceeded[],
links[{provider,url,title?,description?}],
providerResults[{provider,url,links[],durationMs,warnings[]}],
durationMs, warnings[]
```

行為：

- 呼叫 provider 前先用 Groundlane public URL policy 驗證 root URL。
- `auto` 只選擇已設定 credential 且支援該請求的 map providers。
- `parallel` 在同一 deadline 與 abort signal 下並行呼叫 provider map APIs；至少一家成功即可回 partial success。
- `fallback` 依序嘗試直到第一個成功，適合想節省 map-call credits 的 client。
- provider 回傳的 URL 必須重新套用 public URL policy；不安全候選直接丟棄。
- 第一批實作 provider 是 Firecrawl Map 與 Tavily Map。

### 5.7 `web_news`

預期 input：

- `query`：必填 news query。
- `maxResults`：最多回傳 news results，上限 50。
- `provider`：`auto | brave | serper | serpapi`。
- `providers`：選填、有界且有順序的 news provider candidate allowlist；不可與 explicit `provider` 同時使用。
- `strategy`：`parallel | fallback`；預設為 `parallel`。
- `timeRange`：選填 `day | week | month | year`，映射到支援 provider 的 freshness / when 參數。
- `country`、`language`：選填 2-letter locale controls。
- `timeoutMs`：選填 request deadline。

預期 output：

```text
query, strategy,
providersSelected[], providersAttempted[], providersSucceeded[],
results[{provider,title,url,snippet,source?,publishedAt?,thumbnailUrl?}],
providerResults[{provider,query,results[],durationMs,warnings[]}],
durationMs, warnings[]
```

行為：

- `auto` 只選擇已設定 credential 且支援該請求的 news providers。
- `parallel` 在同一 deadline 與 abort signal 下並行呼叫 provider news APIs；至少一家成功即可回 partial success。
- `fallback` 依序嘗試直到第一個成功，適合想節省 news-call credits 的 client。
- provider 回傳的 URL 必須重新套用 public URL policy；不安全候選直接丟棄。
- 第一批實作 provider 是 Brave News Search、Serper News 與 SerpApi Google News。

### 5.8 `web_extract`

預期 input：

- `url`：必填 HTTP(S) URL。
- `fields`：具名欄位陣列，每項含 `name`、`selector`、`value(text|html|attribute)`，attribute mode 另含 `attribute`，並可設定 `many`。
- 共用 `render`、`waitFor`、`timeoutMs`、`maxBytes` 與 `maxOutputChars` 控制。

預期 output：

```text
requestedUrl, finalUrl, data, engine, backend, missingFields[],
truncated, bytes, blockedSubrequests?, durationMs, warnings[], fallbackReason?
```

行為：

- 使用與 `web_fetch` 相同的 retrieval、安全與 deadline pipeline。
- 驗證 field name uniqueness、selector syntax/count、attribute requirement、per-field result count 與 total output size。
- 單值欄位找不到時在 `missingFields` 明確列出，不以空字串偽裝成功。
- `many=true` 固定回傳陣列；單值欄位固定回傳單值或明確缺失。
- 不呼叫 LLM；相同 DOM 與 input 應產生相同結果。

### 5.9 Provider diagnostics

`provider_capabilities` 回傳靜態 provider matrix，明確分開 vendor 自家功能、Groundlane 目前 expose 的 tools、filter support 與 balance support。這個工具不呼叫第三方 API。

`provider_balance` 只呼叫已實作且官方文件明確的帳號餘額 API。已支援：

- You.com：`GET https://api.you.com/v1/billing/account_balance`，回傳 cents。
- Linkup：`GET https://api.linkup.so/v1/credits/balance`，回傳 credits。
- Firecrawl：`GET https://api.firecrawl.dev/v2/team/credit-usage`，回傳 remaining credits。
- SerpApi：`GET https://serpapi.com/account.json`，回傳 searches left。

沒有 key、沒有已實作 balance API、或 upstream 拒絕時，必須回傳 sanitized status，不得洩漏 secret、raw provider body 或 provider-specific error payload。它不是 durable billing ledger，也不取代 provider dashboard。

`provider_balance(provider=all)` 必須並行查詢所有已實作的 balance checkers，並在同一 response 中保留 unsupported / not-configured providers 的診斷狀態。

`provider_quota(provider=all)` 必須整合 `provider_balance` 類帳號餘額、Groundlane 本機 `web_search` attempt budgets、provider capabilities、filter support 與 `searchRouting` hints。它是操作時的第一層診斷視圖，但 response 必須明確分開 accountBalance、toolBudgets 與 routing hints，不能把本機 guardrail 說成 provider 帳務真相。

`search_budget_status(provider=all)` 回傳 Groundlane 當前 process 內的 search attempt budget 快照，包括 daily/monthly period、limit、used、remaining、exhausted 與 resetAt。它不呼叫第三方 API，不代表 provider 帳務真相，也不能跨 Container instance 合併計數。當 `web_search` 回傳 0 results 時，操作者應先檢查 `web_search.providersSelected/providersAttempted/warnings` 與 `search_budget_status`，再用 `provider_balance` 查 vendor account 狀態。

## 6. Cross-cutting requirements

### 6.1 Security

- 強制 bearer authentication，token 不接受 query parameter。
- URL 僅允許 HTTP(S)，拒絕 embedded credentials 與未 allowlist 的 port。
- 驗證每次 DNS resolution 與 redirect；拒絕 loopback、private、link-local、multicast、reserved 與 cloud metadata address。
- 使用 IP pinning 或等價 dispatcher，避免驗證後重新解析造成 TOCTOU。
- browser navigation、redirect、subresource、worker 與 WebSocket 都套用同一 destination policy。
- Container 只接收執行已啟用 adapter 所需的 allowlisted provider keys；Chromium page/context 不得取得這些 secrets，且 Container 不接收其他不必要 credentials。

### 6.2 Bounds and cancellation

- HTTP、provider、browser 共用一個 AbortSignal/deadline；fallback 不重設計時。
- 限制 redirect、response bytes、DOM/output、results、fields、per-field matches、concurrency 與 queue depth。
- client disconnect 或 deadline 到期會取消可取消的 upstream work 並釋放 browser/page/resource。

### 6.3 Observability and privacy

- 記錄 request ID、tool、hostname、provider/engine、status/error code、duration、bytes、truncation 與 fallback reason。
- 預設不記錄 response body、secret、authorization header、cookie、browser profile 或完整 query。
- client output 不包含 raw provider error body 或 stack trace。

### 6.4 Configuration

- startup 集中 parse 與 validate environment，不由各 adapter 零散讀取。
- 月度搜尋 budgets 必須驗證 provider name 與非負整數；UTC 換月時重置。MVP 明確揭露其為 instance-local、非 durable 帳務資料。
- 無 search key 不造成整個 process startup failure；只讓對應 provider unavailable。
- Reader capability 可明確設定為 `disabled | jina`，且預設關閉，避免未告知就把 URL 傳給 hosted provider。
- browser capability 可明確設定為 `disabled | local | browserless`；Cloudflare 部署中的 `local` 指 Container 內的 Playwright backend，不代表 Worker 本身啟動 Chromium。
- `browserless` 必須有 token，且 token 只能以 Authorization header 傳給固定區域 endpoint，不得出現在 target URL、log 或 tool output。
- readiness 能指出 search/browser capability，但不把單一 capability failure 誤報成 process death。

## 7. Edge cases 與預期行為

| 情境 | 預期行為 |
| --- | --- |
| URL 含 username/password | `URL_BLOCKED`，不發 request |
| Public hostname 解析出任一 private address | blocked；不得只挑 public answer 繞過政策 |
| Redirect 從 public 跳 private/metadata | redirect 前阻擋 |
| DNS validation 後答案改變 | 連線使用已驗證 address 或安全 dispatcher |
| HTTP body 大於 byte cap | 取消 upstream；回穩定 limit error 或明確 truncated policy |
| Browser 載入 private iframe/image/WebSocket | subresource blocked 並回 warnings/metadata |
| `render=auto` 遇到普通 404 | 不啟動 browser，只回/映射 HTTP 結果 |
| Deadline 在 HTTP 後只剩少量時間 | browser 只取得剩餘 budget，不重設 deadline |
| Explicit search provider 沒有 key | `PROVIDER_UNAVAILABLE`，不換 provider |
| Auto provider rate limited | 依 policy 嘗試下一家並記錄 warning |
| Search provider 回 malformed JSON | retryable fallback；不得把 raw body交給 client |
| Invalid CSS selector | `INVALID_INPUT`，不可變成 generic upstream error |
| Extract 單值 selector 命中多筆 | 採明文化的第一筆規則或 validation error；contract test 固定行為 |
| `many=true` 無命中 | 回空陣列並列入 `missingFields` |
| Client 取消 request | upstream/browser 中止並 cleanup |
| Queue 已滿 | 快速拒絕，不無限等待或建立更多 browser |
| 所有 search providers down | search unready；fetch/extract 仍可用 |

## 8. Acceptance criteria

### MCP 與工具契約

- [ ] MCP client 可 initialize、list tools，且只看到已註冊的 Groundlane stateless tools 與 provider diagnostics。
- [ ] 每個工具至少有 success、invalid input、deadline、limit 與 upstream failure contract test。
- [ ] MCP text content 與 `structuredContent` 表達同一結果，供不同 client 相容使用。
- [ ] error codes 與 schema 由測試固定，raw exception 不外洩。

### Fetch 與 browser fallback

- [ ] SSR fixture 走 `engine=http`。
- [ ] Jina 啟用時，符合條件的 Markdown fallback 走 `engine=reader, backend=jina`。
- [ ] JS/wait fixture 在 `render=auto` 以可觀測 reason 走 `engine=browser`。
- [ ] `render=never` 在同一 fixture 不啟動 browser。
- [ ] generic 4xx 不觸發 browser retry。
- [ ] redirect、byte cap、output truncation、cancel 與 shared deadline 有測試；MVP `cached` 固定為 `false`。

### Search routing

- [ ] Explicit provider、auto order、capability selection、missing key、provider-rejection fallback 與 explicit-provider no-fallback 有 deterministic fake-adapter tests。
- [ ] 所有結果符合 normalized schema 並保留 selected provider。
- [ ] 預設 CI 不呼叫真實 provider。

### Extraction

- [ ] text、HTML、attribute、many、missing、invalid selector、duplicate field name 與 total output limit 有 fixture tests。
- [ ] 相同 fixture/input 的結果 deterministic。
- [ ] extract 與 fetch 共用 URL policy、render control 與 deadline。

### Security 與 deployment

- [ ] direct/private、DNS-to-private、redirect-to-private、IPv4/IPv6 special ranges、metadata 與 browser subresource policy regression tests 通過。
- [ ] unauthenticated `/mcp` 被拒絕，health response 不洩漏 secret。
- [ ] `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 全部通過。
- [ ] Cloudflare deployment 文件與實際 Wrangler/Container contract 一致，並完成 controlled-fixture smoke test。

## 9. Non-goals

MVP 明確不包含：

- 自建全網 search index 或 crawler fleet；
- residential proxy network、通用 CAPTCHA solving 或「undetectable」保證；
- persistent login profiles 與 stateful browser sessions；
- crawl queue、scheduled monitoring、async batch jobs；
- Groundlane 自行執行的 LLM-based semantic extraction、answer synthesis 或 research agent；
- reranker model、knowledge graph、marketplace 或 site-specific scrapers；
- 對 robots、網站條款或存取授權做法律判定。

## 10. 風險與 mitigation

| 風險 | 影響 | MVP mitigation |
| --- | --- | --- |
| SSRF / DNS rebinding / redirect bypass | 存取內部服務或 metadata | address validation、pinning、安全 proxy/dispatcher、subresource policy、egress firewall |
| Browser escape 或 process leak | Container/host compromise、資源耗盡 | isolated Container、least privilege、deadline、cleanup、memory/concurrency caps |
| Provider outage/rate limit | 搜尋失敗或 latency 上升 | health-aware routing、有限 fallback、明確 attribution/error |
| 成本失控 | provider、browser、egress 費用 | request/result/byte/time budgets、provider spend alerts、audit metadata |
| Anti-bot 宣稱過度 | 使用者期待落差與濫用 | 不承諾 universal bypass；browser 只作 fallback；記錄 engine/reason |
| Output/content injection | agent 接收惡意頁面指令 | 將內容標為不可信資料、固定結構、bounded output；不宣稱內容安全 |
| 網站與隱私合規 | 法律與信任風險 | self-controlled deployment、metadata-only logs、operator responsibility、retention minimization |
| Tool contract 過早膨脹 | 相容性與維護成本 | MVP 固定三工具；session/crawl/research 分開設計 |

## 11. Design influences

| 參考來源 | 採用的影響 | 明確不採用／延後 | 證據 |
| --- | --- | --- | --- |
| Steel | browser lifecycle port、stateless 與 stateful surface 分離、可自架思路 | 不 fork 完整 UI/session platform；MVP 不公開 session handles | [Steel](https://github.com/steel-dev/steel-browser) |
| Playwright MCP | Streamable HTTP、tool registration、client isolation、accessibility/DOM-first、output bounds | 不把 origin allow/block flags當成 SSRF security boundary | [Playwright MCP](https://github.com/microsoft/playwright-mcp) |
| Stagehand | 未來 schema validation 與 agent-friendly extract/observe API 參考 | MVP 不引入 LLM act/observe/extract 或 self-healing action | [Stagehand](https://github.com/browserbase/stagehand) |
| Crawlee | 未來 crawl queue、retry、session pool、autoscaling 參考 | 單頁 MVP 不加入 crawler framework | [Crawlee](https://github.com/apify/crawlee) |
| Browserless | Container/browser operations、queue、crash recovery、同 API 跨部署的參考 | 不依賴或複製 SSPL/commercial code；不承諾其 proxy/CAPTCHA breadth | [Browserless](https://github.com/browserless/browserless) |
| Tavily / Exa / Jina / Firecrawl / SerpApi | Search/contents/reader/rerank 能力拆分、provider adapter 與 normalized contract | 不複製其 index；MVP 不做 rerank/research synthesis | [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search), [Exa Search](https://docs.exa.ai/reference/search), [Jina Reader](https://jina.ai/reader/), [Firecrawl Search](https://docs.firecrawl.dev/api-reference/endpoint/search), [SerpApi Google Search](https://serpapi.com/search-api) |
| Parallel / Linkup | vendor-neutral web intelligence control-plane 願景、structured/cited result 方向 | MVP 可轉接 provider research API，但不做自家 deep-research agent、monitor、FindAll 或自己的 web index | [Parallel](https://parallel.ai/), [Linkup](https://docs.linkup.so/) |
| Cloudflare Containers | Worker control plane + isolated Node/Playwright browser workload、self-controlled deployment | core contracts 不依賴 Cloudflare；不把 Container instance 當持久 browser session | [Cloudflare Containers](https://developers.cloudflare.com/containers/) |

授權與功能會變動；採用第三方 code 前必須鎖定版本、閱讀完整 LICENSE/NOTICE 並完成 dependency review。上表只描述設計影響，不表示包含對方程式碼。

## 12. Roadmap

### Phase 1：MVP contract

- 完成三 tools、remote MCP、authentication、health/readiness。
- 完成 URL policy、bounded HTTP、browser fallback、deterministic extraction。
- 完成 Tavily/Exa/Linkup/Parallel/Browserbase/Brave/Firecrawl/SerpApi adapters，並提供
  Serper/You.com opt-in adapters 與 fake-based contract tests；預設 auto order
  僅消耗已確認適合持續路由的服務。

### Phase 2：Production hardening

- Cloudflare Worker + Container deployment、controlled-fixture E2E。
- cache adapter、provider health/cost telemetry、rate limit 與 usage budgets。
- compatibility fixtures、versioning policy、release automation。

### Phase 3：Bounded expansion

- opt-in crawl/batch queue、dedupe、robots/budget controls。
- source-aware documentation parser：優先使用 `llms.txt`、scoped `llms-full.txt`、
  Markdown endpoints、OpenAPI schemas 與 sitemap，再依 heading/path/operation
  切片；不要靠提高整頁 HTML output limit 解決大型 generated docs。
- query-aware chunking/rerank provider。
- 另案評估 stateful browser sessions，先定義 ownership、isolation、expiry、cleanup 與 billing。

### Phase 4：Research layer（需重新驗證需求）

- cited research orchestration、monitoring 或 semantic extraction。
- 每項能力保持 provider-neutral、可觀測且有明確 cost/data boundary。

## 13. English glossary

| Term | Groundlane 中的意義 |
| --- | --- |
| web access layer | agent 與多種 Web/search/browser providers 間的統一控制層 |
| control plane | authentication、routing、policy、limits 與 orchestration 所在層 |
| Groundlane Browser | 僅供內部 fallback 使用的 Playwright/Chromium engine |
| deterministic extraction | 不依賴 LLM、由 DOM selector 與固定規則決定結果的抽取 |
| provider routing | 依能力、設定順序、健康狀態與錯誤類型選擇 search adapter |
| fallback | 前一路徑發生明確、可支援原因時，使用剩餘 deadline 升級到另一路徑 |
| bounded output | 具 byte、character、result 與 field-count 上限的回應 |
| readiness | process 存活之外，對設定與依賴 capability 是否可服務的判斷 |
