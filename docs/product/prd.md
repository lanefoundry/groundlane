# Groundlane 產品需求與路線文件

狀態：Draft for implementation  
日期：2026-08-30
範圍：`web_fetch`、`web_search`、`web_answer`、`web_research`、`web_content`、`web_map`、`web_crawl`、`web_news`、`web_images`、`web_extract`、`parse`，provider diagnostics，以及支撐它們的 remote MCP、security policy 與 Cloudflare deployment

## 1. 摘要

Groundlane 是供 AI agent 使用的 vendor-neutral **trusted content access layer**。產品方向是透過一個 endpoint 安全取得並解析 Web 與文件內容，讓來源、execution path 與 provider provenance 可追蹤。現有 runtime 已實作 Web search/retrieval、deterministic extraction，以及 URL/raw HTML parsing；PDF、Office、spreadsheet、image/OCR 等 file/document ingestion 仍在 Phase 3 roadmap，不能宣稱已上線。目前 operator 可使用 Groundlane 自有 retrieval/parser/browser engines，並在內建 provider catalog 中設定一家或多家 managed providers 作混合 routing；operator-hosted provider registration 是後續產品目標，不是現有 runtime configuration。MVP 的核心 Web primitives 是 stateless tools：讀取頁面的 `web_fetch`、代理多家搜尋服務的 `web_search`、取得 provider-grounded answers 的 `web_answer`、取得 provider-attributed research reports 的 `web_research`、透過 provider content APIs 抓 URL 內容的 `web_content`、探索網站 URL 的 `web_map`、有界 crawl 公開網站的 `web_crawl`、搜尋 news-specific indexes 的 `web_news`、搜尋 image-specific indexes 的 `web_images`、依 DOM 規則抽取欄位的 `web_extract`，以及把 URL 或 raw HTML 解析成 document/metadata/links/media/tables 的 `parse`。部署也可以暴露 provider diagnostics，例如 `provider_balance`、`provider_capabilities`、`provider_quota` 與 `search_budget_status`，分別用來檢查帳號餘額、已實作功能邊界、整合 quota 狀態與 Groundlane 本機 provider-dispatch attempt guardrail。

系統以便宜、容易觀測的 HTTP retrieval 為優先；只有在明確需要 render 時，才升級到內部 **Groundlane Browser** engine。搜尋透過可替換 provider adapters，不自建全網 index；未來可另行提供 operator-owned、domain-scoped corpus search，但不得和 public Web search 混為同一 provenance。Extraction 與 parser 必須 deterministic，不以隱藏的 LLM call 假裝穩定 structured output。Parser 第一版參考 Readability、Trafilatura、Crawl4AI、MarkItDown、anydoc、Docling 等開源專案的分層與 contract，但 runtime 先維持 Groundlane 自寫 parser layer；外部專案只能透過明確 adapter/engine 邊界逐步加入。

V1 是 operator-hosted open-source product，官方 reference deployment 由 operator 部署到自己的 Cloudflare account；目前沒有由專案方代管的 hosted service。Managed Groundlane Cloud 已確認為後續商業化 roadmap，不屬於 V1。Public tool contracts、核心 URL/security policy、provider contracts 與 normalized results 必須由 OSS 與未來 managed service 共用，且不依賴 Cloudflare binding types；Cloudflare deployment tooling 與 managed control plane 可以存在，但必須維持明確 infrastructure boundary，不能讓 hosted-only contract 破壞自架可攜性。

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
4. 公開工具共用 authentication、URL policy、deadline、resource limits、errors 與 audit metadata；不同 credential path 必須收斂成同一個 provider-neutral principal contract。
5. 可在本機開發，並以 Cloudflare Worker + Container 作官方 reference deployment；相同 core contracts 不綁定單一 Cloudflare runtime primitive。
6. 對已存在多種 execution paths 的 capability，可在 Groundlane-native engine 與已註冊 managed providers 間選擇或混合，且每次結果都能辨識實際 engine/provider 與 fallback path；未來 operator-hosted adapter 也必須遵守相同 contract。Public Web search 不因此承諾 Groundlane-native 全網 index。
7. 先交付 operator-hosted OSS；在核心 contract、tenant isolation、usage attribution 與營運證據成立後，提供使用相同 tool contracts 的 Managed Groundlane Cloud，降低不想自行部署與維運的使用門檻。
8. 商業化採「完整 OSS core + paid managed operations」。Apache-2.0 OSS 保留可獨立使用的單一 operator data plane、provider-neutral tools/contracts、security policy、provider adapters、reference deployment、diagnostics 與可攜資料格式；Managed Cloud 收費價值集中在多租戶治理、代管容量、enterprise identity/network/data lifecycle、SLO 與 support，不以人工降低 OSS concurrency、隱藏安全修復或 hosted-only tool schema 製造轉換壓力。
9. 將相同的 bounded input、deterministic parsing、source provenance 與安全 contract 從 Web/HTML 延伸至 file/document processing；各格式必須逐項通過 threat model、limits、sandbox 與品質 gate，不能因產品定位擴大就視為已實作。Document processing 不會自動建立 durable artifact、corpus membership 或 index sync，但可依公開且可調整的 policy 使用有界 transient artifact 與 processing cache；response 必須揭露 effective expiry 與 cache provenance。
10. 為 operator-owned corpus 提供 backend-neutral lifecycle contract；Groundlane 管理 corpus identity、source enrollment/status、ACL、freshness、retention/deletion 與 citation provenance，indexing/query/ranking 則由可替換 backend 執行。
11. Document source 使用 provider-neutral tagged contract：bounded inline bytes、受現有 URL policy 保護的 public HTTP(S) URL，以及 Groundlane-issued opaque `ArtifactRef`。Cloudflare reference path 由 MCP 建立 upload intent，upload-capable client／CLI／dashboard 以短效 presigned PUT 直接上傳 R2 staging object，完成驗證與 immutable finalization 後才取得 `ArtifactRef` 呼叫 processing；public contract 不接受 caller local path、caller-selected bucket/object key 或帶 credential URL。

### 3.2 MVP 成功指標

- contract tests 能完成 MCP initialize、tools/list 與公開 tools/call。
- 所有公開 tool failure 都回傳穩定 error code，不洩漏 secret、stack 或 raw upstream body。
- security regression suite 覆蓋 direct private IP、DNS-to-private、redirect-to-private、IPv6、metadata endpoint 與 browser subresource。
- fetch/extract fixtures 可分辨 HTTP 與 browser engine，並保留同一 end-to-end deadline。
- provider routing tests 覆蓋 explicit selection、capability filtering、provider-rejection fallback 與 explicit-provider failure。
- 預設 CI 不需要 live provider key 或任意外網即可通過。

## 4. 使用者與情境

- **Platform operator：**希望 provider credentials、browser workload、limits 與 audit data 留在自己的環境。
- **個人 AI-tool user／agent developer：**會使用 Claude、Codex、Cursor 或其他支援 MCP／API 的 AI 工具，但不一定熟悉部署、Cloudflare、provider 選型或 secret 管理；希望註冊後直接取得 endpoint 與 token，依引導完成連線。
- **Team agent developer：**需要跨 Claude、Codex 或自製 agent 共用 Web tools，不希望每個應用各自整合 provider。
- **Tool author：**需要固定的 search/fetch/extract schema，而不是每家 API 分別整合。

主要 job-to-be-done：

- 「讓 agent 讀取一個公開 URL，並知道實際 final URL、engine 與是否 truncated。」
- 「用同一工具搜尋 Web，由系統選擇可用 provider，但保留來源 attribution。」
- 「用同一工具並行詢問多個 answer-capable providers，保留各自答案與 citations，不做不可審計的隱藏合成。」
- 「用同一工具並行呼叫多個 provider content APIs，對照不同 provider 對同一 URL 的抽取品質與成功率。」
- 「從固定頁面 DOM 抽出具名欄位，結果可重現、缺失欄位可判斷。」
- 「把 URL 或 raw HTML 解析成 document、metadata、links、media 或 tables，供後續 ingestion、引用與抽取流程重用。」
- 「讓 operator 對具有多種 execution paths 的 capability 選擇 Groundlane 自有 backend、已註冊 provider 或混合 routing，而 agent developer 不需改 tool contract；未來可透過受控 registration 加入 operator-hosted adapter。」
- 「讓同一位 operator 為 Codex、CI、排程 agent 與其他固定 client 發出可獨立辨識、rotation、到期與撤銷的 credential，而 provider credentials、routing 與 deployment policy 仍由同一個 operator 控制。」
- 「讓 operator 透過和 public Web 分離的工具建立、管理並查詢自有 corpus、指定網站或 bounded domain；Groundlane 管理 corpus identity、source manifest、ACL、freshness、retention/deletion 與 citation provenance contract，索引與 ranking 可使用 Cloudflare managed service、外部 provider 或自架 backend。」

### 4.1 Search corpus 與 backend ownership boundary

Search 以兩個正交維度分類：

| Corpus contract | Public surface | 可用 backend ownership |
| --- | --- | --- |
| Public Web | 現有 `web_search` | 目前為內建 managed-provider adapters；未來可加入經 build/deploy registration 的 operator-hosted public metasearch adapter |
| Scoped/operator-owned corpus | 未來獨立 corpus lifecycle 與 `corpus_search` tool family（working names），不混入 `web_search` | Cloudflare managed index、外部 provider、operator-hosted enterprise/private search，或後續通過獨立 gate 的 Groundlane-native index adapter |

共同規則：

- Groundlane 負責 credential policy、endpoint allowlist、capability selection、health、quota、normalization、fallback/fusion 與 provenance，不擁有全網 index。
- 第一版 operator-hosted adapter 若進 roadmap，必須是 operator 在 build/deploy time 註冊的受控 adapter；不得接受 caller 在 tool input 提供任意 provider endpoint。
- Scoped search 只處理 operator-owned corpus、指定網站或 bounded domain，並使用獨立 tool family。Groundlane 擁有 corpus lifecycle control-plane contract：corpus identity、source manifest、enrollment/index-sync state、ACL、freshness、retention/deletion、tenant isolation 與 citation provenance；這些語意不能由 backend 私有 API 決定。
- Groundlane 不因擁有 corpus lifecycle contract 就必須自建 index 或 ranking engine。Cloudflare AI Search、Vectorize、外部 provider 與自架服務皆可作可替換 backend adapter；response 必須揭露 backend provenance，切換 backend 不得改變 corpus identity、ACL、deletion 或 citation contract，也不得把 scoped corpus 結果標示成 public Web search。

### 4.2 Provider extension model

Provider 擴充採兩條正式路徑：

1. **Built-in TypeScript adapter：**由 Groundlane repository 維護，直接實作 `SearchProvider`、`ContentProvider`、`ResearchProvider` 等既有 capability interface。新增或擴充 capability 必須通過官方 API mapping、authentication、normalization、URL safety、deadline/cancellation、quota/error、secret redaction 與 malformed-response contract tests。
2. **Operator-hosted HTTP bridge：**Groundlane 內建一個通用 protocol adapter；operator 在 build/deploy time 註冊固定 endpoint、capabilities 與 auth kind，自架服務實作版本化的 normalized HTTP protocol。Bearer credential 使用由 provider ID 推導的專用 deployment secret binding。Agent/caller 只看到已註冊 provider ID，不接觸 upstream endpoint、credential 或任意 headers。

第一版 operator-hosted protocol 命名為 `groundlane-provider-v1`，只支援 public Web search。它不要求 operator 的服務實作 MCP，也不自動取得 content、crawl、research 或 balance capability；後續 capability 必須各自有 request/response、billing 與 lifecycle gate。

Provider manifest 至少包含：

```json
{
  "id": "custom.internal-search",
  "protocol": "groundlane-provider-v1",
  "transport": "https",
  "baseUrl": "https://search.example.com",
  "auth": {
    "kind": "bearer"
  },
  "capabilities": {
    "search": {
      "domainFilter": "include-or-exclude",
      "maxDomains": 20,
      "timeRange": true
    }
  },
  "routing": {
    "enabled": true,
    "monthlyAttemptBudget": 100,
    "dailyAttemptBudget": 10
  }
}
```

Manifest 與 registry 規則：

- Provider ID 必須穩定並避免和 built-in ID 衝突；operator registration 第一版限定 anchored pattern `^custom\.[a-z0-9]+(?:-[a-z0-9]+)*$`，總長度最多 64 characters。`custom.` namespace 保留給 operator registrations，且不用冒號，避免和既有 `provider:budget` configuration delimiter 衝突。
- `baseUrl`、protocol、capabilities、routing 與 auth kind 只由 operator 在 build/deploy time 提供；manifest 不得包含 secret value 或任意 environment-variable name，tool input 不得覆寫 endpoint 或 auth。
- Bearer secret binding name 由 provider ID 決定，例如 `custom.internal-search` 固定對應專用的 `GROUNDLANE_CUSTOM_PROVIDER_CUSTOM_INTERNAL_SEARCH_TOKEN`；manifest 不能選擇其他 env name。`GROUNDLANE_AUTH_TOKEN`、built-in provider keys、browser/reader secrets 與其他非 custom-provider bindings 永遠不可作 extension credential。
- Cloudflare Worker 只把已註冊 custom provider ID 對應的專用 binding allowlist 傳進 Container；Container 的 generic adapter 只能從解析後的 custom-secret map 依自身 provider ID 取得單一 credential，不得任意讀取 `process.env`。
- Operator configuration 在 build/deploy time 產生一份不含 secrets 的 canonical serialized provider-manifest artifact，內含 schema version 與 digest。Worker 以該 artifact 建立 custom binding allowlist，Container 以同一 artifact 建立 runtime registry、tool schema、routing 與 budgets；兩邊不得各維護一份 ID-to-binding/catalog，version/digest 不一致時 deployment/readiness fail closed。
- Local manifest 是 capability authority；remote service 不得透過 discovery response 自行擴權。Groundlane 在 dispatch 前拒絕 manifest 未宣告的 filters/capabilities。
- `domainFilter` 第一版只接受 `none | include | exclude | include-or-exclude | combined`；`include-or-exclude` 拒絕同時提供 `domains` 與 `excludeDomains`，`combined` 才允許兩者並用，且各自受 `maxDomains` 與 deployment cap 中較小者限制。
- Custom provider 預設 `enabled=false`、daily/monthly attempt budget 均為 `0`；只有 manifest 明確 enable 並設定正數 budget 才可 dispatch。第一版不加入 `SEARCH_PROVIDER_ORDER`、`auto`、`balanced` 或 `deep`，只允許 explicit `provider=custom.*`，或在明確 `providers[]` 搭配 `strategy=fallback` 時使用，因此不需要宣告 provider family、fusion weight 或 priority。
- 統一 provider registry 是 catalog、composition、capability-specific routers、tool provider schemas、routing order/budgets 與 diagnostics 的 single source of truth，避免各層各自維護 provider 清單。
- Registry registration 包含 manifest 與零到多個 capability adapters；只有實際註冊 runtime adapter 的 capability 才能出現在 `provider_capabilities` 與 tool schema。
- Refactor registry 時，現有 built-in IDs、defaults、tool contracts 與 fake-based tests 必須保持相容；不能把 catalog refactor 宣稱成 operator-hosted support 已完成。

`groundlane-provider-v1` 的 `baseUrl` 第一版必須是沒有 path/query/fragment 的 HTTPS origin，並使用固定 `POST /v1/search`。Search request 使用 Groundlane normalized fields，例如 `query`、`maxResults`、`domains`、`excludeDomains` 與 `timeRange`；成功 response 只接受 strict、有界的 `results[]`，拒絕 unknown top-level/item fields，每筆包含 normalized `title`、`url`、`snippet`、選填 `publishedAt` 與 `score`。Authentication 由 manifest 決定，第一版支援 explicit `none` 或依 provider ID 取得專用 bearer secret binding；不得轉送 caller authorization。非 2xx response 只依 HTTP status 與 bounded sanitized metadata 映射 Groundlane error，不回傳 raw provider body。Groundlane 收到成功 response 後仍須本機驗證 schema、重新驗證所有 result URLs、套用 output bounds、deadline/cancellation 與 sanitized error mapping。

Cloudflare reference deployment 第一版由 Container 呼叫 operator allowlisted HTTPS endpoint；可使用 operator-controlled access token 等 authentication。只有未來 provider execution 進入 Worker、且完成 cross-runtime policy parity 後，才評估 Service Binding transport。第一版不為 Service Binding 新增 Worker bridge。

任意 runtime npm plugin 不進第一版。第三方程式碼若和 Container 共用 process，會同時取得 filesystem、network 與其他 provider secrets 的風險；只有在 isolation、permission、version compatibility、crash handling 與 supply-chain contract 成立後，才另案評估 package plugin SDK。

## 5. MVP 功能需求

### 5.1 Remote MCP surface

- 提供 authenticated `POST /mcp` Streamable HTTP endpoint。
- 提供 unauthenticated `GET /healthz` liveness endpoint，但不得洩漏設定。
- 提供 authenticated `GET /readyz` readiness endpoint，確認 Container reachability 與必要 service configuration；MVP 不用 live provider call 作 readiness probe。
- MVP tools 為 stateless；transport session identifier 不得當成 browser session。
- 每次 request 有 request ID、單一 deadline 與一致 public error envelope。

#### 5.1.1 V1 single-tenant、multi-credential authentication

- 一個 Groundlane deployment 第一版只有一個 operator trust domain。Provider credentials、provider routing、budgets 與 deployment policy 在 instance 內共用；caller 不得在 request、tool input 或 header 自行宣告 `tenantId`、`principalId` 或 policy override。
- Static bearer、managed API token 與 OAuth access token 驗證後都必須轉成 provider-neutral data-plane `AuthenticatedPrincipal`，至少包含 stable `principalId`、`credentialId`、`authMethod` 與 granted `scopes`。V1 內建 principal 是同一個 operator `owner`，由 `credentialId` 區分 client/installation；這不構成 user 或 tenant isolation。Credential 是可 rotation 的鑰匙，不等同 tenant；同一 principal 可先後持有多個 credential。Admin token走獨立 exact-secret route guard，不產生 `AuthenticatedPrincipal`，也不以 `owner` 或 scope判斷 admin權限。
- `GROUNDLANE_AUTH_TOKEN` 保留為 legacy、本機 minimal profile 與 backward-compatibility data-plane credential，可依既有 contract 呼叫 `/mcp`，但永遠不能取得 managed-credential administration 權限。第一版不再建立另一套 multi-static-secret registry，也不把多組 raw bearer secrets 放進 deploy-time array。
- `GROUNDLANE_ADMIN_TOKEN` 是新增、獨立的 operator-only deployment secret，只能存取 managed-credential admin surface，不能呼叫 `/mcp`、不能當 provider credential，也不保存於 D1。它負責首次建立 managed credential 與 recovery；遺失或疑似外洩時由 operator 透過 Cloudflare secret management rotation，不從 managed registry復原原值。
- Cloudflare managed profile 使用 D1-backed managed-token registry。Managed token 採 public credential ID 與高熵 secret 分離的格式；raw secret 只在建立時回傳一次，D1 只保存 verifier/digest、principal linkage、label、status、created/expiry/revoked metadata，以及 rotation lineage `rotatedFrom`/`rotatedTo` 與舊 credential 的 `validUntil`，不保存可直接重播的 bearer token。
- Managed credential lifecycle 至少包含 create、list metadata、rotate、revoke 與 expire。第一版提供 `POST /admin/credentials`、`GET /admin/credentials`、`POST /admin/credentials/:id/rotate` 與 `POST /admin/credentials/:id/revoke`，並由 `groundlane credentials create|list|rotate|revoke` operator CLI 包裝；CLI 不取得 D1 binding/database credential、不直接執行 SQL，也不得挪用 OAuth DCR `/register`。Revoke 保留 bounded metadata與 audit linkage，不以 `DELETE` 假裝 credential從未存在。
- 正常 rotate 每次建立新的 credential ID/record，不覆寫舊 verifier。API 的 `overlapSeconds` 預設為 `3600`，只接受 `0..86400` 的整數。舊 record更新、新 record插入與雙向 lineage 必須在單一 D1 transaction/conditional write完成：舊 record轉為`rotating`並寫入`validUntil=commitTime+overlapSeconds`/`rotatedTo`，新 record寫入`rotatedFrom`。新 record原樣繼承principal、scopes/policy與absolute `expiresAt`，rotation不能擴權或延長有效期；需要改權限/期限時另走explicit operation。新 raw token只在transaction成功後的首次response回傳一次。
- Rotation request需要bounded idempotency key。相同key在commit後重試不能建立第二個successor，也不能再次回傳raw token；只能回已建立的新credential ID與`secretAvailable=false`。Operator必須明確revoke該未知secret的record或從該active successor再做一次新rotation，不得由CLI盲目重送產生多條lineage。
- `revoke` 是針對指定 credential 的緊急、立即撤銷，不套用 overlap。D1 revoke commit後開始的新 request 必須拒絕；已完成 authentication並進入執行中的 request不承諾被中止。Credential record保留 `revokedAt` 與 lineage供 audit，不做 hard delete。
- Rotation expiry以 Worker server UTC time在每次authentication request判斷，不接受caller time，也不依賴scheduler、Queue、Workflow或Container背景工作。只有`status=active && now < expiresAt`，或`status=rotating && now < min(validUntil, expiresAt)`時可繼續驗證；revoked/disabled優先拒絕，`now == validUntil`即無效。Stored status不會因時間經過自行改寫，因此list需同時回stored status與derived bounded `effectiveStatus/usable`；後續清理只能處理已失效metadata，不能決定credential是否仍有效。
- Endpoint eligibility 必須明文化：`/mcp` 接受具有 `mcp` scope 的 legacy、managed 或 OAuth credential；`/readyz` 依既有 legacy auth或後續 operator-read scope驗證；OAuth DCR `/register` 維持 legacy `GROUNDLANE_AUTH_TOKEN` anti-abuse protection，但此 compatibility gate不授予 managed-token管理權限。`/admin/credentials` 只接受 `GROUNDLANE_ADMIN_TOKEN`；legacy data-plane、managed、OAuth與 internal-signing credential即使映射成 `owner` 或攜帶任意 scope，也不得存取 admin surface。Admin token 對 `/mcp`、`/readyz`、OAuth endpoints 與 `/register` 一律無效。
- `local_static` profile 只提供既有單一 static bearer。`worker_internal_context` profile 在 D1 尚未啟用的 backward-compatibility deployment 可繼續接受 Worker 驗證的 static bearer 與 OAuth，但必須明確回報 managed-token unavailable；Cloudflare managed profile 一旦啟用 D1 registry，registry failure即 fail closed，不得把 database failure 當成 token 有效，也不得自動回退成一般 static credential。
- Data-plane token 驗證在 Worker ingress 完成。外部 raw bearer、OAuth access token與 caller-supplied identity header 不得傳入 Container；Worker 必須先移除所有 caller-supplied internal-auth headers，再以獨立 signing secret 產生包含 issuer、audience、issued/expiry time、method/path、request ID、principal、credential、auth method 與 scopes 的 bounded internal principal context。Cloudflare Container mode 只接受驗證成功的 internal context，不得 fallback 接受 raw data-plane bearer；local/direct mode 才接受 `GROUNDLANE_AUTH_TOKEN`，兩種 mode 不得在同一 listener 同時開啟。Admin request 在 Worker完成 authorization與D1 operation，不轉送 Container。
- OAuth 保留給需要 discovery、consent、scope 與 refresh/revocation lifecycle 的互動 client。OAuth `clientId` 只代表 client application/installation，不直接等同 human principal、service principal 或 tenant；OAuth grant 必須顯式映射到 `AuthenticatedPrincipal`。
- KV 不作 managed-token registry 或 revoke truth。現有 OAuth library state 仍可保存於 KV，但文件與測試必須揭露其 [eventual-consistency boundary](https://developers.cloudflare.com/kv/concepts/how-kv-works/)，不得宣稱 OAuth revoke 立即在所有 edge 生效。D1 authentication lookup 不使用可能任意落後的 unconstrained read replica；若啟用 read replication，必須使用 [Sessions API](https://developers.cloudflare.com/d1/best-practices/read-replication/) 中能滿足 latest/sequential requirement 的 primary/session constraint，並以 contract tests 與 controlled smoke 證明 revoke 後的讀取語意。

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
- `provider`：`auto | tavily | exa | parallel | browserbase | brave | firecrawl | serpapi | searchapi | linkup | keenable | tinyfish | serper | you`。
- `providers`：選填、有界且有順序的 provider candidate allowlist；不可與 explicit `provider` 同時使用。
- `strategy`：`fallback | balanced | deep`；`auto` 預設為 `balanced`。

預期 output：

```text
query, provider, strategy,
providersSelected[], providersAttempted[], providersSucceeded[],
providerDetails?[{provider,backend,ownership,protocolVersion?}],
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
- `providerDetails` 是為 extensible registry 預留的 optional、backward-compatible provenance；built-in provider 可省略或回 `ownership=built-in`，operator-hosted provider 一旦啟用則必須回 stable provider ID、backend、ownership 與 protocol version。不得包含 endpoint、secret reference 或敏感 internal topology。
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
- `provider`：`auto | linkup | you | exa | tavily | firecrawl | tinyfish | keenable`。
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
- 第一批實作 provider 是 Linkup Fetch、You.com Contents、Exa Contents、Tavily Extract、Firecrawl Scrape、TinyFish Fetch 與 Keenable Fetch。

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
- `fields`：具名欄位陣列。`selector` engine 欄位含 `name`、`selector`、`value(text|html|attribute)`，attribute mode 另含 `attribute`，並可設定 `many`；`pattern` engine 欄位含 `name`、`pattern`、選填 `flags(i|m|u)`、`group` 與 `many`。
- 共用 `render`、`waitFor`、`timeoutMs`、`maxBytes` 與 `maxOutputChars` 控制。

預期 output：

```text
requestedUrl, finalUrl, data, engine, backend, missingFields[],
truncated, bytes, blockedSubrequests?, durationMs, warnings[], fallbackReason?
```

行為：

- 使用與 `web_fetch` 相同的 retrieval、安全與 deadline pipeline。
- 目前實作 engines 是 `selector` 與 `pattern`。`selector` 以 CSS selector 從固定 DOM 抽取資料；`pattern` 以 bounded regex 從 fetched HTML 抽取 deterministic text captures。
- 驗證 field name uniqueness、selector syntax/count、attribute requirement、per-field result count 與 total output size。
- 單值欄位找不到時在 `missingFields` 明確列出，不以空字串偽裝成功。
- `many=true` 固定回傳陣列；單值欄位固定回傳單值或明確缺失。
- 不呼叫 LLM；相同 DOM 與 input 應產生相同結果。

Extractor engine boundary：

- `selector`：已實作，deterministic DOM extraction；支援 `text`、`html`、`attribute`、`many`、missing fields 與 output cap。
- `pattern`：已實作，bounded deterministic regex extraction；支援 `i/m/u` flags、named 或 numbered capture group、`many`、missing fields、pattern length cap、input size cap、match count cap 與 output cap，並拒絕 backreference、lookaround、巢狀量詞等高風險 regex 語法。
- `schema`：未實作，未來可做 structured validation/normalization；不得自行發網路請求或隱藏呼叫 provider。
- `llm`：未實作，未來若加入必須 opt-in，回傳 engine/provider provenance、confidence 或 validation metadata，且不得標示為 deterministic。
- Selector 與 pattern baseline 由 `test/fixtures/extract` 固定；新增 engine 前需補 fixture 或 benchmark，證明未破壞現有 selector/pattern semantics。

### 5.9 `parse`

預期 input：

- `url` 或 `html` 二選一；`url` 必須是 HTTP(S)，`html` 模式必須提供 HTTP(S) `baseUrl` 供相對 URL 解析。
- `purpose`：`document | metadata | links | media | tables | all`，預設 `all`。
- URL 模式共用 `render`、`waitFor`、`timeoutMs`、`maxBytes` 與 `maxOutputChars` 控制。

預期 output：

```text
requestedUrl?, finalUrl?, purpose, title?, description?, author?, publishedAt?, canonicalUrl?,
content?, text?, metadata?, links?, images?, tables?, engine?, backend?,
truncated, bytes, durationMs, warnings[], fallbackReason?
```

行為：

- URL input 使用與 `web_fetch` 相同的 retrieval、安全與 deadline pipeline；raw HTML input 不連網。
- Parser layer 先由 Groundlane 自寫 deterministic engines 組成，參考開源專案的能力拆解與 benchmark 方法，不直接照搬大型 runtime dependency。
- 開源專案拆解軸線包括：fetch/render、DOM cleanup、正文候選 scoring、metadata extraction、link/media/table extraction、PDF/OCR/layout recovery、輸出 contract、錯誤分類與成本模型。
- 第一版支援 HTML document、metadata、links、media 與 tables；document parser 可沿用 Readability-style article heuristics，但輸出仍由 Groundlane contract 約束。
- 後續 Trafilatura、Crawl4AI、MarkItDown、anydoc、Docling、MinerU 或 OCR engine 只能作為明確 adapter/engine 加入，且必須通過同一 corpus、required spans、structure preservation、noise、metadata 與 latency/cost gate。
- `parse` 不呼叫 LLM；若未來加入 LLM parser，必須是明確 opt-in engine，且輸出不得假裝 deterministic。

### 5.10 Future file/document output contract

Future file/document processing 以 versioned、provider-neutral **canonical document envelope** 作 authoritative output。JSON 是第一版 wire serialization，不代表接受 provider raw JSON；adapter 必須在 `src/adapters/` 內正規化，caller contract 不得依賴 Docling、anydoc、OCR/VLM 或其他 engine 的私有 schema。

Future document MCP surface 採 **intent-level、跨格式、可動態縮窄的 hybrid direction**，但在 selection eval 通過前不把單一 tool 名稱或 signature 視為穩定 public contract：

- 不依 PDF、DOCX、XLSX、PPTX、HTML、image 等格式各拆一個 public tool；format/MIME detection、adapter 與 engine routing 留在 Groundlane。OCR、table、layout、formula 等先作 parsing capability／policy，除非成本、approval、風險或獨立結果 contract 證明需要單獨授權，否則不因 engine 名稱另建 tool。
- 同一意圖跨格式合併；結果形態、side effect、權限、風險或 lifecycle 不同的意圖保留邊界。Artifact upload/access/delete、async status/result/cancel 與 corpus lifecycle 不併入 document mega-tool。
- Phase 3 必須以相同 fake backend、tasks、結果與 policy，比較：A `document_process(operation, capabilities, output, source)`；B `document_parse`／`document_extract`／`document_transform` intent family；C 以 `document_process` 為預設入口，只有在 target client 支援 deferred loading/tool search 且任務或 policy 需要時揭露 specialist tools。這些名稱是 eval candidates，不是已承諾 API。
- Eval 必須分開記錄 correct first tool/intent、argument validity、selection recall、正確候選已出現時的 conditional choice accuracy、task success、unnecessary calls、clarification/recovery、tokens、latency、approvals、provenance 與 unsafe capability exposure；不能只以 tool 數量或 call 數決定 surface。
- 若 unified surface 未穩定提高 task success，或增加 argument error、approval ambiguity、權限混淆，則採 intent family 或 hybrid；若 specialist retrieval 漏掉正確能力，即使 conditional choice 較高也不得視為勝出。選定 surface 後才建立 schema snapshot、target-client fixtures 與 compatibility policy。

Canonical envelope 至少包含：

```text
schemaVersion, documentId, canonicalContentId,
source{kind, identity, version, contentHash, mimeType, byteSize},
status(success|partial|unsupported|failed), capabilities{},
blocks[{id,type,parentId?,order,text?,spans[],attributes{}}],
tables[], assets[], formulas[], metadata{}, citations[],
warnings[], errors[], provenance{engine,provider?,model?,versions,cost?,confidence?}
```

規則：

- `blocks` 使用同一 document 內 stable IDs 與明確 reading order；tables/cells、assets/figures、formulas、citations 可使用 typed records，並以 block/source IDs 建立關係，不強迫所有結構塞進 Markdown。
- Canonical envelope 分成可重用的 **canonical content core** 與本次 **source/invocation binding**。Core 包含由實際 bytes、解析／正規化 options、schema 與 engine versions 決定的 blocks/tables/assets/formulas 等內容，並有 `canonicalContentId`；它不包含 URL、filename、ArtifactRef、citation source identity、cache age 或本次 request metadata。Binding 依目前 ownership/source identity/version 重建 `documentId`、`source`、invocation/cache/billing provenance；`documentId` 對同一 ownership scope、source version、canonical content 與 contract version 穩定，不跨不同 source binding 共用。Projection 同時引用本次 `documentId` 與 `canonicalContentId`。
- Source span 依能力使用 typed page/bounding-box、character offset、sheet/cell range、slide/shape 或 media time range；每個 span 綁 source content hash 與 coordinate system/version。沒有可靠 span 時必須明確標示 capability state，不能捏造位置。
- Capability state 固定為 `available | unsupported | not_run | failed`。`available` 表示該 capability 成功執行，結果可以是空陣列；「要求的單一項目不存在」使用 typed result-level absence，不新增另一個 capability state。Top-level aggregation：所有 required requested capabilities 都 `available` 為 `success`；至少一項 required `available` 且另一項 required 非 available 為 `partial`；零項 available 且全部 required 為 `unsupported` 時是 `unsupported`；零項 available 且任一 required 為 `failed`／`not_run` 時是 `failed`。未 requested 的 optional capability 不影響 top-level status，但需保留 warnings/provenance。
- Caller 使用 `output=markdown | structured | text | all`，預設 `markdown`。Canonical envelope 仍先產生；Markdown/text 是從同一 envelope 產生的 versioned projections，不得由另一條 parser path 獨立生成，也不能由 Markdown 反推或覆蓋 canonical structure/spans。
- Projection 至少回 `projectionVersion`、`sourceDocumentId`、`lossy`、`omissions[]`、`warnings[]`，並在可行時保留 block/source references。Markdown 是第一優先 agent-facing projection；`all` 不是預設，避免無界 payload 與重複 token。
- Inline response 受 output cap。任何 canonical、Markdown、text、其他 projection 或 `all` 超過上限時，回 bounded summary/provenance 與 storage-neutral result `ArtifactRef`；caller 可明確選擇只取某個 projection，不因要求 Markdown 就必須下載完整 structured artifact。
- `ArtifactRef` 以 `artifactKind=source | canonical_document | projection`（或等價 typed metadata）區分。Server-generated canonical/projection result 必須 immutable write/finalize，綁 ownership、content hash、schema/projection kind/version、media type、created/expires、retention/deletion 與 provenance；它和 processing cache entry 是不同物件。`DocumentSource.artifact` 第一版只接受 `artifactKind=source`，canonical/projection result 不能未經明確轉換就重新作 input。
- Execution lifecycle 採**明確雙軌**。有界、可在單一 end-to-end deadline 內完成的 deterministic conversion/extraction 可使用同步 operation；大型文件、OCR、layout/VLM、audio transcription、provider-owned long-running job，或其他無法可靠落在同步 limits 內的工作，使用獨立且 caller 明確啟動的 async document job。兩軌共用相同 DocumentSource、canonical envelope、ArtifactRef、cache/provenance、policy 與 stable error family，不得形成兩套內容 contract。
- Server 不得因同步 request 接近 timeout、output 過大、queue 壅塞或選到較慢 engine，就未經 caller 同意 silent escalation 成 durable job。`ArtifactRef` 只解決輸出承載，不代表 async execution。同步 operation 遇到 async-only input/engine 時，應在發生昂貴工作前回 stable capability/limit error，並說明可用的 explicit async path；若未來提供 caller-authorized `execution=auto`，也必須在 contract 中明確 opt-in、回實際 lifecycle 與 job ownership，不得作為預設。
- Async contract 優先驗證 MCP Tasks 的 negotiation、create/poll/result/cancel 與斷線續查；target client 不支援時，才提供語意等價的 explicit start/status/result/cancel tools。Job 必須綁 caller ownership、verified source version/content hash、normalized options、engine/provider/model versions、credential/funding source、idempotency key、created/expires 與 billing provenance。Create 只有在原子驗證 source 並建立 job-owned bounded immutable snapshot 後才能 acknowledged；snapshot expiry 取原 source expiry、job expiry 與 policy hard cap 的最早值，response 回 effective snapshot/job expiry，不得 silent 延長原 source retention。原 source 自然到期或 owner explicit delete 時，snapshot access 立即撤銷，queued/running job 轉 terminal cancelled/deleted 並停止後續 dispatch，已完成但仍 transient 的 result `ArtifactRef` 與 derived cache binding 一併撤銷；physical cleanup 可非同步但需標記 pending。Result `ArtifactRef` TTL 從 immutable finalize 起算，且不得晚於 snapshot/source policy 允許的 expiry。取消需分開表達 caller 停止等待、Groundlane 停止後續 polling／dispatch，以及 upstream 實際取消；已發生的 provider/model usage 不得因本機取消而被描述成未計費。
- 現有 URL/raw-HTML `parse` schema 維持相容，視為現行 convenience/flat projection；新 file/document tool family 才以 canonical envelope 為 authority。後續若讓 `parse` convergence，必須以 additive/versioned fields、schema snapshot 與 target-client fixtures 證明不 breaking。

### 5.11 Provider diagnostics

`provider_capabilities` 目前回傳靜態 provider matrix，明確分開 vendor 自家功能、Groundlane 目前 expose 的 tools、filter support 與 balance support。這個工具不呼叫第三方 API。完成 provider registry refactor 後，內容改由已驗證 registrations 產生，但仍不得透過 live provider discovery 自行擴張 capability。

`provider_balance` 只呼叫已實作且官方文件明確的帳號餘額 API。已支援：

- You.com：`GET https://api.you.com/v1/billing/account_balance`，回傳 cents。
- Linkup：`GET https://api.linkup.so/v1/credits/balance`，回傳 credits。
- Firecrawl：`GET https://api.firecrawl.dev/v2/team/credit-usage`，回傳 remaining credits。
- SerpApi：`GET https://serpapi.com/account.json`，回傳 searches left。

沒有 key、沒有已實作 balance API、或 upstream 拒絕時，必須回傳 sanitized status，不得洩漏 secret、raw provider body 或 provider-specific error payload。它不是 durable billing ledger，也不取代 provider dashboard。

`provider_balance(provider=all)` 必須並行查詢所有已實作的 balance checkers，並在同一 response 中保留 unsupported / not-configured providers 的診斷狀態。

`provider_quota(provider=all)` 必須整合 `provider_balance` 類帳號餘額、Groundlane 本機 provider-dispatch attempt budgets、provider capabilities、filter support 與 `searchRouting` hints。它是操作時的第一層診斷視圖，但 response 必須明確分開 accountBalance、toolBudgets 與 routing hints，不能把本機 guardrail 說成 provider 帳務真相。

`search_budget_status(provider=all)` 回傳 Groundlane 當前 process 內的 provider dispatch attempt budget 快照，包括 daily/monthly period、limit、used、remaining、exhausted 與 resetAt。它不呼叫第三方 API，不代表 provider 帳務真相，也不能跨 Container instance 合併計數。當 provider-backed tool 耗盡本機 attempt 或 `web_search` 回傳 0 results 時，操作者應先檢查 tool response 的 `providersSelected/providersAttempted/warnings` 與 `search_budget_status`，再用 `provider_balance` 查 vendor account 狀態。

## 6. Cross-cutting requirements

### 6.1 Security

- MCP data-plane 強制 authentication；headless API token 不接受 query parameter，OAuth 與 optional Cloudflare Access 也必須經各自完整驗證後才能產生 `AuthenticatedPrincipal`。
- Raw API token 只在建立時顯示一次；logs、errors、snapshots、audit events 與 Container request 不得包含 raw token、token verifier/digest、authorization header 或 OAuth refresh token。
- Credential-management surface 必須和一般 MCP data-plane 分權；只有獨立 `GROUNDLANE_ADMIN_TOKEN` 可呼叫，legacy data-plane、managed、OAuth與 internal-signing credentials 均不得建立、列出、rotation 或撤銷其他 credentials。Admin token必須能獨立 rotation，且不得和 `GROUNDLANE_AUTH_TOKEN`、OAuth owner passphrase或 provider secret共用。
- URL 僅允許 HTTP(S)，拒絕 embedded credentials 與未 allowlist 的 port。
- 驗證每次 DNS resolution 與 redirect；拒絕 loopback、private、link-local、multicast、reserved 與 cloud metadata address。
- 使用 IP pinning 或等價 dispatcher，避免驗證後重新解析造成 TOCTOU。
- browser navigation、redirect、subresource、worker 與 WebSocket 都套用同一 destination policy。
- Container 只接收執行已啟用 adapter 所需的 allowlisted provider keys；Chromium page/context 不得取得這些 secrets，且 Container 不接收其他不必要 credentials。
- Operator-hosted provider endpoint 是 operator-controlled infrastructure destination，不是 caller URL，但第一版仍只接受 deploy-time allowlisted public HTTPS exact origin；不得用 custom provider manifest 繞過 private-address、metadata、redirect 或 arbitrary-port policy。Private/internal transport 需另定 network boundary。
- Operator-hosted adapter 不得載入 remote code，且不得將其他 provider credentials、Groundlane auth token、caller authorization/cookies 或完整 environment 傳給 upstream。

### 6.2 Bounds and cancellation

- 每個同步 request，以及 async create 在 durable commit/acknowledgement 前的工作，共用一個 AbortSignal/end-to-end deadline；fallback 不重設計時。Async job acknowledged 後改受建立時固定的 absolute execution deadline/expiry 與總 execution budget 約束，每個 attempt 另有較短 deadline，但 retry/fallback 必須消耗同一總 budget，poll/status request 不得重設或延長 job budget。
- 限制 redirect、response bytes、DOM/output、results、fields、per-field matches、concurrency 與 queue depth。
- 同步 request 或尚未 commit 的 async create 遇到 client disconnect/deadline，會取消可取消的 upstream work 並釋放 browser/page/resource。已 acknowledged 的 async job 不因 create connection、status poll 或 result wait 斷線／到期而取消；poll deadline 只結束本次等待，只有 owner 的 explicit cancel 或已揭露的 job deadline/expiry/policy transition 能改變 durable job lifecycle。

### 6.3 Observability and privacy

- 記錄 request ID、tool、hostname、provider/engine、status/error code、duration、bytes、truncation 與 fallback reason。
- Corpus lifecycle audit 只記錄 principal/project/corpus/source reference、action、status 與 backend identity 等 bounded metadata，不記錄 document body、embedding、完整 query 或 backend raw payload。
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
- Authentication configuration 必須明確選擇 `local_static` 或 `worker_internal_context` mode。Cloudflare managed profile 缺少 D1 binding 或獨立 internal-signing secret 時 managed-token data plane/readiness fail closed；缺少 `GROUNDLANE_ADMIN_TOKEN` 時只停用 admin surface並回明確 unavailable，不使既有 static/OAuth/managed data-plane request失效。Local minimal profile 不要求 D1/admin secret，但不能宣稱 managed-token capability available。
- Managed token 使用 indexed public credential ID 查單筆 record，再以 constant-time verifier comparison 驗證高熵 secret；`GROUNDLANE_ADMIN_TOKEN`、`GROUNDLANE_AUTH_TOKEN`、OAuth owner passphrase、internal-signing secret 與 provider credentials 必須全部不同。
- Provider manifest 在 startup 以 strict schema parse；duplicate/reserved ID、unknown protocol/transport、invalid capability 或 unsafe endpoint 使 registration fail closed。單一 operator-hosted provider 缺少其 auth secret 時只讓該 provider unavailable，不能使 fetch/parser 等無關 capability 一併失效。
- Manifest 可保存 provider ID、endpoint、capabilities 與 routing policy，但不能保存 secret value 或 environment-variable name；bearer secret 只能由 provider ID 推導的專用 deployment secret binding 取得。

### 6.5 Cloudflare reference deployment boundary

Cloudflare 是 operator-controlled reference deployment 的 execution platform，不是 public tool contract 或 provider taxonomy。下表明確區分目前 topology 與通過 demand gate 後的候選責任：

| 元件 | 目前責任 | Gate 後的候選責任 | 不應承擔 |
| --- | --- | --- | --- |
| Workers | MCP/OAuth ingress、authentication、request ID，將 MCP request proxy 到 named Container | V1 統一 `AuthenticatedPrincipal`、D1 managed-token validation、credential-management boundary 與 signed internal principal context；只有 benchmark 與 cross-runtime contract proof 成立後，才評估短 I/O fast path 或部分 provider routing | 大型 DOM parsing、Chromium、以 `waitUntil()` 偽裝 durable job lifecycle、保存大 payload、把 raw client credential 傳入 Container |
| Containers | Node MCP runtime、tool dispatch、URL/provider policy、Reader/parser、adapters 與 request-scoped local Chromium | Cloudflare mode 驗證 signed internal principal context；需要完整 filesystem/runtime 的新增 execution adapters | 接收 raw client/admin credential、在 Cloudflare mode fallback 接受 data-plane bearer、處理 admin API、durable task registry、跨 instance quota truth、長期 artifact store、以 process memory/disk 代表 browser session 或 job ownership |
| KV | OAuth clients、grants、tokens 與其他 OAuth state；其 revoke visibility 受 eventual consistency 限制 | 其他可接受 eventual consistency 的低頻 configuration/cache 必須另案評估 | managed-token registry/revoke truth、job lifecycle、quota ledger、大型內容或強一致 coordination；不得把 OAuth revoke 描述成跨 edge 即時生效 |
| Browser Run | 未實作 | 受管 rendered fetch/screenshot backend，以及 provider-owned crawl lifecycle adapter | 取代 HTTP-first retrieval、宣稱 CAPTCHA bypass、繞過 schema-extraction gate、直接把 upstream crawl job ID 當 Groundlane durable contract |
| Workflows | 未實作 | 通過各自 gate 後的長時間 research/crawl/document step lifecycle、sleep/poll/retry、event waiting 與 cancel orchestration | 一般同步 `web_fetch`/`parse`、大型 response/artifact storage、把非 idempotent provider call 無條件重試 |
| Queues | 未實作 | Groundlane 真正自行 fan-out per-page work 時，提供有界 buffer、batch、retry 與 dead-letter handling | job/status/result 的權威來源、exactly-once billing、傳遞大型 HTML/screenshot payload |
| Durable Objects | named Container lifecycle/routing 的平台基礎 | per-tenant/provider concurrency、atomic quota guard、job owner/cancel arbitration，以及未來 stateful session 的單一協調點 | 全域單一 hot object、blob/analytics store、parser 或 browser CPU workload |
| D1 | 未實作 | V1 managed-token verifier/metadata registry；後續可查詢的 job metadata、provider task mapping、status history、billing provenance、retention、artifact index，以及通過 gate 後的 corpus lifecycle metadata reference adapter | raw bearer token、大型頁面內容、hot concurrency lock、最新 quota 判斷的唯一同步機制、未受 session/primary constraint 保護的 authorization read；derived index 不得取代 corpus manifest/deletion truth |
| R2 | 未實作 | Cloudflare durable async path 的 raw/normalized content、corpus source artifacts、crawl results、screenshots/traces 與 benchmark artifacts | state machine、queue、distributed lock、quota counter、corpus identity/ACL truth；不得讓 public contract 依賴 R2 object key |
| Analytics Engine / Workers observability | Workers/Container 平台 metrics 與 deployment diagnostics | 高維度 request/provider/engine/latency/bytes/fallback/error metrics | response body、完整 query、cookie、secret、raw provider error payload 或 durable billing ledger |

導入原則：

- 不因元件可用就一次引入 Workflows、Queues、Durable Objects、D1 與 R2；每個 stateful primitive 必須由已核准的 lifecycle、volume、query 或 coordination 需求觸發。
- V1 managed-token lifecycle 已構成 D1 的獨立需求，但不因此一併核准 D1 job metadata、durable ledger 或其他 stateful responsibilities；不同資料用途需分表、分 migration 與分 acceptance gate。
- Provider-owned async job 的第一版只補 Groundlane ownership/status/result/cancel contract；只有需要跨 request retry、等待或 aggregation 時才加入 Workflow，只有 Groundlane 自行分派大量 page/document work 時才加入 Queue。Groundlane-owned long-running OCR/layout/VLM/audio/document execution 仍需獨立 durable-orchestration、volume、cost 與 isolation gate，不因雙軌 public contract 或 Cloudflare 元件可用就自動核准。
- Provider task 建立、付費 API call、crawl start 與 artifact write 必須有 idempotency/replay policy，避免 Workflow 或 Queue retry 造成重複工作與重複計費。
- 一般同步 tools 繼續回 bounded inline output。大型或私人 document source 與 Cloudflare durable async output 使用 storage-neutral `ArtifactRef`；Cloudflare reference deployment 以 R2 adapter 實作，本機或其他 deployment 可使用 filesystem/S3-compatible adapter。MCP control operation 建立 bounded upload intent，回傳 provisional `uploadIntentId` 與短效、單一 staging object/PUT 的 presigned URL；upload-capable client／CLI／dashboard 直接上傳 bytes。Caller 會在 presigned URL 中看到 scoped R2 endpoint/staging path，但它只作短效 transfer coordinate，不是 public identity，也不得進後續 tool arguments、logs、corpus manifest 或 durable metadata。Complete 驗證並將 bytes finalization 成舊 PUT URL 無法覆寫的 immutable object 後，才 mint `ArtifactRef` 供 processing。R2 credential 永不回傳。Workflow、Queue、Durable Object 與 D1 只保存小型 state、metadata 或 artifact reference。
- 「一個 endpoint」表示單一 Groundlane MCP control endpoint 與穩定 tools，不表示大型 bytes 必須穿過 JSON-RPC body；短效 R2 upload data path 是 scoped transfer capability，不是另一套 Groundlane REST data API。
- Artifact lifecycle 採可配置預設而非永久保存：upload intent 預設 15 分鐘；完成或過期的 staging object 在一小時 cleanup window 內移除；一般 verified `ArtifactRef` 預設保存 24 小時；document-processing cache 預設 24 小時。Caller 可分別調整 upload intent、artifact 與 cache TTL；staging cleanup window 只由 operator/storage policy 控制。每個 caller value 必須落在 deployment 公告 bounds 內，超界就回 stable validation error，不得 silent clamp 成更久或更短；effective expiry 另受 source expiry、plan/policy hard cap 與 explicit deletion 約束。上述 working defaults 可由 operator 調整，不能變成跨 deployment 的隱藏常數。
- 明確 corpus enrollment 才進入 corpus retention policy；corpus source 預設保存到 explicit remove/delete，但 corpus/project/operator 可設定 source 或 corpus expiry。Enrollment 不得悄悄延長原 transient artifact；必須建立受 corpus lifecycle 管理的 source reference/artifact，並保留 retention provenance。
- Document-processing cache 是 ownership-scoped content-addressed result cache，不是 public-Web response cache。可重用 parsed payload key 至少包含 ownership scope、actual content hash、engine/provider/model artifact ID 與 version、normalized processing options、schema/policy version；per-source result binding 另包含 source identity/version 與該次 requested/final URL、filename、artifact/corpus reference、fetch time、citation provenance。Cache hit 只重用 payload，response provenance 由目前 invocation/source binding 產生，不得沿用第一個相同 bytes source 的 identity。預設不跨 tenant/project/deployment 共用，且 cache entry 不得活得比其 live source binding、artifact 或 policy 允許時間更久。
- Caller 可使用 `uploadExpiresInSeconds`，以及互斥的 artifact `expiresInSeconds`／`expiresAt`、`cacheTtlSeconds` 與 bounded `cacheMode=use|refresh|bypass`；server UTC time 是 absolute-expiry truth。Default mode 是 `use`：hit 時讀取，miss 時執行並在 cache enabled 時寫入；`refresh` 不讀舊 entry、重新執行並在 enabled 時 replacement write；`bypass` 不讀也不寫。Operator 停用 cache 時 `use`/`refresh` 仍正常執行但回 `cached=false` 且不寫入，不能因 cache unavailable 讓 processing 失敗。Managed plan 可設定較低 hard cap，但不得在 caller 已接受的 effective expiry 或 explicit deletion 後繼續命中。
- Deployment 必須透過 provider-neutral、read-only document/artifact policy view 公告 cache enabled/default mode、upload/artifact/cache defaults 與 min/max、staging cleanup window、corpus retention defaults，以及目前 ownership-scope hard caps；working surface 名稱為 `document_policy`。Tool response 仍需回本次 effective values，避免 schema 固定但 deployment policy 不可觀測。
- 若未來增加 Worker fast path，它與 Container path 必須共享同一套 URL safety、deadline/cancellation、limits、error envelope 與 provenance contract；沒有 parity evidence 前，Worker 維持 ingress/proxy role。

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
| Revoked/expired/disabled managed token | D1 primary/latest lookup後拒絕；不得使用 KV 或 positive cache 延長有效期 |
| Planned rotation未指定 overlap | 建立新 credential；舊 credential維持有效 1 小時後依 request-time `validUntil` 判斷失效 |
| Rotation overlap不是整數、NaN、小於0或大於86400秒 | `INVALID_INPUT`；不建立新record、不修改舊credential |
| `now == validUntil` 或舊 `expiresAt` 先到 | 舊credential拒絕；有效期取`validUntil`與`expiresAt`較早者，rotation不能延長舊expiry |
| 同一 credential收到並行 rotate | 只有一個 atomic state transition成功；其他 request回穩定 conflict，不建立第二條 successor lineage |
| Rotation transaction失敗 | 整筆rollback且不回傳新raw token；不得留下orphan successor或沒有`rotatedTo`的rotating record |
| Rotate與revoke並行 | 依conditional write/commit order決定；revoke先commit則rotate conflict，rotate先commit後revoke old只讓old立即失效，不得把revoked狀態寫回rotating |
| Rotation commit成功但response遺失 | 同一idempotency key只回new credential ID與`secretAvailable=false`，不重播raw token、不建立第二個successor |
| Overlap期間 revoke舊 credential | 指定舊 credential立即失效；successor維持自身狀態，不因 lineage自動被撤銷 |
| D1 managed-token registry unavailable | Managed-token與admin registry operation fail closed；不得自動改走 legacy static credential |
| Caller 偽造 internal principal header | Worker 先移除後重簽；Container只接受有效、未過期且 request-bound 的 context |
| Cloudflare Container 收到 raw bearer | `worker_internal_context` mode 拒絕；只有獨立 `local_static` listener接受 legacy data-plane bearer |
| Legacy/managed/OAuth token呼叫 `/admin/credentials` | `403`；不查詢或修改 credential registry，也不把 token值寫入 log |
| Admin token呼叫 `/mcp` | `401` 或 `403`；admin credential不能當 data-plane credential |
| Caller 在 tool input 傳 custom provider URL/header/token | schema 拒絕；只允許選擇已註冊 provider ID |
| Operator manifest 使用 duplicate ID 或 unsafe HTTP/private endpoint | registration fail closed；不得建立 adapter |
| Operator-hosted response 回 private/unsafe result URL | 丟棄候選並回 bounded warning；不得因 endpoint 受信任而跳過 result URL policy |
| Operator-hosted provider 缺少 configured auth secret | 該 provider unavailable；其他 provider 與 fetch/parser 繼續服務 |
| Invalid CSS selector | `INVALID_INPUT`，不可變成 generic upstream error |
| Extract 單值 selector 命中多筆 | 採明文化的第一筆規則或 validation error；contract test 固定行為 |
| `many=true` 無命中 | 回空陣列並列入 `missingFields` |
| Client 取消 request | upstream/browser 中止並 cleanup |
| Queue 已滿 | 快速拒絕，不無限等待或建立更多 browser |
| 所有 search providers down | search unready；fetch/extract 仍可用 |

## 8. Acceptance criteria

### MCP 與工具契約

- [x] Phase 0/MVP client 可 initialize、list tools，且只看到已註冊的 Groundlane stateless tools 與 provider diagnostics；未來 stateful tool family 啟用時必須另有 capability/version gate 與 schema snapshot。
- [x] 每個工具至少有 success、invalid input、deadline、limit 與 upstream failure contract test。
- [x] MCP text content 與 `structuredContent` 表達同一結果，供不同 client 相容使用。
- [x] error codes 與 schema 由測試固定，raw exception 不外洩。

### Fetch 與 browser fallback

- [x] SSR fixture 走 `engine=http`。
- [x] Jina 啟用時，符合條件的 Markdown fallback 走 `engine=reader, backend=jina`。
- [x] JS/wait fixture 在 `render=auto` 以可觀測 reason 走 `engine=browser`。
- [x] `render=never` 在同一 fixture 不啟動 browser。
- [x] generic 4xx 不觸發 browser retry。
- [x] redirect、byte cap、output truncation、cancel 與 shared deadline 有測試；MVP `cached` 固定為 `false`。

### Search routing

- [x] Explicit provider、auto order、capability selection、missing key、provider-rejection fallback 與 explicit-provider no-fallback 有 deterministic fake-adapter tests。
- [x] 所有結果符合 normalized schema 並保留 selected provider。
- [x] 預設 CI 不呼叫真實 provider。

### Provider registry 與 operator-hosted bridge

- [x] Registry 是 built-in/operator registrations、tool provider schema、composition、capability matrix、routing order/budgets 與 diagnostics 的 single source of truth；新增 fake registration 後，各 surface 無需修改第二份 provider ID 清單即可同步。
- [x] Registry refactor 前後的 built-in provider IDs、default order/budgets、tool schemas、explicit/auto routing 與 provider diagnostics snapshot 保持相容。
- [x] Registration 拒絕 duplicate/reserved/invalid IDs、unknown protocol、沒有 runtime adapter 的 capability、空 endpoint、manifest 內 secret value/env name，以及 capability/config 不一致；`custom.` ID 到專用 secret binding 的推導與 reserved-name denylist 有 tests。
- [x] `groundlane-provider-v1` 第一版只 expose search；未宣告或尚未支援的 content/crawl/research/balance operation 在 dispatch 前回穩定 capability error，不呼叫 upstream。
- [x] Operator-hosted base URL 只從 build/deploy manifest 取得並通過 operator endpoint allowlist；caller 不能傳入或覆寫 provider endpoint、auth token、headers、redirect policy 或 transport。
- [x] HTTP bridge 不轉送 caller authorization/cookies/任意 headers；provider secret 只從 provider ID 推導的專用 binding 讀取，且不得出現在 logs、warnings、errors、snapshots 或 provenance。
- [x] Worker→Container 只轉送已註冊 `custom.` ID 對應的 `GROUNDLANE_CUSTOM_PROVIDER_*_TOKEN` bindings；generic adapter 只能依自身 provider ID 取得單一 secret，不能讀取 Groundlane auth、built-in provider、browser/reader secrets 或任意 `process.env` entry。
- [x] Worker binding allowlist 與 Container registry 由同一份 canonical manifest artifact 產生並驗證相同 schema version/digest；任何 mismatch、stale artifact 或第二份手寫 ID-to-binding mapping 都會使 deployment/readiness fail closed。
- [x] Bridge 共用 Groundlane deadline/AbortSignal、request/result/byte limits 與 sanitized errors；redirect 預設拒絕，若未來允許則至少限制 same-origin 並重新驗證目的地。
- [x] Custom provider 預設 disabled 且 daily/monthly budget 為 0；只有明確 enable 與正數 budget 才能 dispatch。第一版 explicit provider 與 explicit `providers[] + strategy=fallback` 有 success/exhausted tests，`auto`/`balanced`/`deep` 必須排除 custom provider。
- [x] `domainFilter` 五種模式、`maxDomains`、combined include/exclude、timeRange support 與 deployment cap precedence 有 deterministic validation tests；unsupported combination 在呼叫 upstream 前拒絕。
- [x] Malformed JSON、unknown fields rejection、missing required fields、oversized response、unsafe result URL、429/quota、5xx、timeout 與 cancellation 有 deterministic fake-server tests。
- [x] `web_search.providerDetails[]` 以 optional、backward-compatible schema 加入 contract versioning 與 schema snapshot；operator-hosted attempt 一旦啟用即必須包含 stable provider ID、`backend=http-compatible`、`ownership=operator-hosted` 與 protocol version，不得包含 endpoint/secret reference，也不得標示成 built-in provider。
- [x] 預設 CI 使用本機 fake HTTP service，不需要 live operator endpoint、Cloudflare account、provider key 或外網。

### Answer 與 research

- [x] `web_answer` 對 Linkup/You.com keyed paths 有 request mapping、source/citation normalization、unsupported filters、quota/rate-limit 與 malformed response tests。
- [x] `web_answer` 的 parallel fan-out 保留 provider attribution；fallback mode 只消耗第一個成功 provider，partial failure 以 sanitized warnings 呈現。
- [x] `web_research` 對 Linkup async task、You.com Research 與 Parallel Responses 有 fake-based polling、source controls、citation extraction、failed task 與 cancellation tests。
- [x] Research output 不做 hidden synthesis；deterministic citation/URL dedupe 不得改寫 provider report，多 provider 結果必須分開回傳，並保留 provider、status、sources、failed sources 與 warning provenance。
- [x] 短時間 research 與不支援 MCP Tasks 的 client 保持現有同步 `web_research` contract；不得為加入 async path 破壞既有 caller。
- [ ] MCP Tasks 或相容性 async tools 實作前，必須以可重跑的 target-client matrix 驗證 capability negotiation、create、poll、result、cancel 與斷線續查；不得只由 SDK types 推論 client 支援。
- [ ] Async lifecycle 必須定義 caller ownership、TTL/expiry、provider job mapping、credential binding、status/result、upstream cancel capability、billing provenance 與 sanitized errors，並區分 caller 停止等待、Groundlane 取消 polling 與 upstream job 真正取消。

### Provider content、map、crawl、news、images

- [x] `web_content` 對 Linkup、You.com、Exa、Tavily、Firecrawl、TinyFish、Keenable 的 endpoint shape、auth header、selector/filter support、malformed response 與 unsafe provider-returned URL 有 tests。
- [x] `web_map` 與 `web_crawl` 對 Firecrawl/Tavily 的 request mapping、page/result caps、dedupe、unsafe URL drop、polling/cancellation 與 quota errors 有 tests。
- [x] `web_news` 與 `web_images` 對 Brave、Serper、SerpApi 的 vertical endpoint、domain/time filters、image/source URL validation、dedupe 與 provider attribution 有 tests。
- [x] Provider-backed tools 的 `parallel`、`fallback` 與 explicit-provider behavior 必須各有 partial success、all-failed、non-retryable error 與 warning sanitization coverage。
- [ ] Durable crawl contract 若被啟用，必須提供 provider-neutral create/status/result/cancel、owner binding、credential binding、expiry、pagination、partial result、total page/byte/output budgets 與 upstream cancel evidence；owner mismatch、expired/unknown job 與 sanitized upstream failures 必須有 deterministic tests，不得只回裸露的 provider job ID。
- [ ] Caller cancellation、停止 Groundlane polling 與 upstream crawl cancellation 必須是不同狀態；沒有 provider acknowledgment 或等價證據時，不得回報 upstream job 已取消。

### Extraction

- [x] selector engine 的 text、HTML、attribute、many、missing、invalid selector、duplicate field name 與 total output limit 有 fixture tests。
- [x] pattern engine 的 named/numbered group、many、missing、invalid flags、invalid regex、高風險 regex 語法、input size cap、match cap 與 total output limit 有 tests。
- [x] 相同 fixture/input 的結果 deterministic。
- [x] extract 與 fetch 共用 URL policy、render control 與 deadline。
- [ ] Provider-backed schema extraction 第一版限單一已知 URL 與 caller-provided bounded schema，拒絕 remote `$ref`、無界 nested structures 與隱含 deterministic-to-model fallback；必須 explicit opt-in、在 Groundlane 本機驗證 output，回傳 missing/invalid fields 與 provider/model/source/billing provenance。
- [ ] Provider-backed schema extraction 進入 production routing 前，必須保存 machine-readable repeatability、field accuracy、missing/invalid correctness、latency、output size 與 billed-unit benchmark；provider product availability 本身不算 Groundlane user-demand proof。

### Parser 與 document processing

- [x] `parse` 的 URL mode 共用 `web_fetch` retrieval、安全、deadline 與 output caps；raw HTML mode 不連網，且必須要求 HTTP(S) `baseUrl`。
- [x] HTML parser 的 `document`、`metadata`、`links`、`media`、`tables`、`all` purposes 有 unit/contract tests，並固定 unsafe URL scheme drop、relative URL resolution、table bounds 與 title heuristic。
- [x] Parser benchmark 至少追蹤 required text、noise rejection、metadata、links、images、tables、latency 與 failures；新增 parser engine 前需補 corpus 或說明既有 corpus 足夠。
- [ ] PDF/OCR/Office document processing 仍未實作；實作前需先定義 input kind、byte/page/time limits、sandbox/file permission boundary、confidence/source spans、model artifact policy 與 fallback metadata。
- [ ] 現有 `parse` 與所有 document-processing operation 預設只回傳 normalized output 或 explicit artifact；只有 caller 明確呼叫 corpus enrollment operation，才可建立 persistent source membership 或觸發 index sync。未來 file/document tool family 可依公開 policy 使用 transient processing cache，但不得把 cache entry 標示成 durable ArtifactRef 或 corpus source。
- [ ] Portable `DocumentSource` 是 tagged union：`inline` 只接受 bounded bytes、declared MIME 與 filename metadata；`url` 只接受經既有 SSRF/DNS/redirect/deadline policy 驗證的 public HTTP(S) URL；`artifact` 只接受由目前 portable ownership scope 可讀的 Groundlane-issued opaque `ArtifactRef`。V1 ownership scope 是 deployment/default owner scope；Managed Cloud 才映射到 tenant/project，不能以 `credentialId` 冒充 owner/project。Remote schema 不接受 caller local path、任意 filesystem path、caller-selected bucket/object key、storage credential 或帶 credential URL。
- [ ] Cloudflare upload flow 分成 create intent、direct R2 PUT、complete/verify/finalize 與 process。Create intent 限制 content length、declared MIME、expiry、ownership scope、single staging object/PUT 與 optional expected digest；complete 必須驗證實際 size、MIME sniff、server-computed content hash、optional expected-digest match 與 object ownership，再 promote/copy 到舊 presigned URL 無法覆寫的 immutable final object並關閉 intent。過期、缺件、超限、digest/MIME mismatch、重放、finalized staging overwrite、跨 ownership-scope access 都有 deterministic tests。第一版只支援 single PUT，明確拒絕 multipart；multipart part/complete/abort/orphan lifecycle 另立 gate。
- [ ] `ArtifactRef` 只在 complete/verify/finalize 成功後產生，是 storage-neutral opaque identity，包含或可解析到 ownership scope、content hash、byte size、created/expiry、retention/deletion 與 verified status；`uploadIntentId` 或 provisional staging handle 不能進 document processing/corpus。Upload intent working default 是 15 分鐘、verified transient artifact working default 是 24 小時；caller 可要求 TTL，但 effective value 受 deployment-advertised min/max 與 operator/policy cap 約束並回傳 `expiresAt`。不得把 R2 object key、presigned URL、filesystem path 或 provider-native ID 當 public identity。Presigned URL 視為短效 bearer secret，不得寫入 log、error、snapshot 或 corpus manifest。
- [ ] Artifact processing 只讀 verified object；成功 processing 不自動延長 retention 或 enroll corpus。Cancel、failure、expiry、explicit delete 與 orphan cleanup 必須定義 source artifact、normalized output、multipart remnants 與 derived corpus/index state 的處理方式。
- [ ] Public URL processing output 至少保存 requested/final URL、fetch time、actual processed-byte content hash、validator（若有）、redirect/engine 與 truncation provenance；async/retry 不得重新抓取變動內容卻沿用舊 source identity，需先 snapshot 成 explicit artifact 或建立新的 processing attempt。
- [ ] Direct upload 只有在 target MCP client 能完成 upload-intent handoff 時才標示相容；Claude、Codex、Cursor 需逐一驗證 client/helper flow。無原生 upload handoff 的 client 由 Groundlane CLI 或 dashboard 讀取本機檔案並上傳，不能假設 remote MCP server 可直接讀 caller filesystem。
- [ ] Upload intent 完成、失敗或到期後，staging object working cleanup window 不超過一小時；cleanup 是可重試的 storage operation，status 必須區分 logically expired/deleted 與 physical cleanup pending。Caller explicit delete 立即撤銷 ArtifactRef access，不等待 lifecycle rule 才失效。
- [ ] Document-processing cache working default 是 24 小時；default `cacheMode=use`，`use` hit-read/miss-execute-and-write、`refresh` skip-read/re-execute-and-replace、`bypass` no-read/no-write。Caller 可用 bounded `cacheTtlSeconds` 調整；effective cache expiry 取 accepted requested/default、operator/policy max 與 source/artifact expiry 的最早時間。Operator disable 時 `use`/`refresh` 退化為正常 execution 且不寫 cache，回 `cached=false`；cache failure 不能使 processing fail。`refresh` 不延長 source retention。
- [ ] Reusable parsed-payload key 至少包含 ownership scope、actual content hash、engine/provider/model artifact ID/version、normalized options、schema/policy version；per-source binding key 另含 source identity/version。禁止只以 URL、filename、caller-declared MIME 或未驗證 digest 作 key，也不得把第一個來源的 URL/filename/citation provenance 回給另一個相同 bytes source。Cross-tenant/project/deployment cache reuse 預設禁止。
- [ ] Cache payload、source binding 與 live-reference set 分開管理。同一 scope 相同 hash 可共享 physical payload；刪除/到期一個 source 只撤銷該 binding，其他 live source 仍可合法命中自己的 binding。Deleted source 不得藉由 shared payload 恢復；physical payload 只有在無 live binding/reference 後才能保留到 bounded cleanup。
- [ ] Cache hit 必須回 `cached=true`、cache entry created/expires/age、source hash、engine/provider/model version 與原始 billing provenance；命中本身不得偽裝成新的 provider/model execution 或重複計費。Engine/model/schema/policy version 改變、對應 source/artifact delete/expiry、ownership/policy change與 explicit invalidation 都會 miss或撤銷該 binding。
- [ ] Corpus enrollment 預設保存到 explicit remove/delete，但允許 operator/project/corpus/source retention policy 設定 expiry。Effective expiry 取 caller request 與所有適用 hard caps 中最早者；低於可接受 bound 時拒絕，不 silent extend，重新 enroll/update 不會重設或延長 expiry，延長需 explicit authorized operation。Enrollment 不得只延長 transient ArtifactRef TTL；需建立 corpus-owned source lifecycle record。Corpus/source delete 應立即撤銷 access 並使相關 cache binding 不可命中，physical artifact/derived-index/backup cleanup 依已揭露政策完成。
- [ ] `document_policy` 或等價 provider-neutral read-only capability view 公告 cache enabled/default mode、upload/artifact/cache defaults/min/max、staging cleanup window、corpus retention defaults 與 ownership-scope hard caps；各 mutation/processing response 回 accepted request 與 effective absolute expiry。相對/絕對 expiry fields 互斥，使用 server UTC clock，超界回 stable validation error 而非 clamp。
- [ ] Processing cache 只屬未來 file/document tool family，不改變現有 `web_fetch.cached=false`、`web_extract` 或 URL/raw-HTML `parse` contract。未來 URL-backed document operation 每次仍先執行 URL/DNS/redirect 安全檢查並取得或 snapshot 實際 bytes，再以 content hash 查 parsed-payload cache；不得用 cache 跳過 network policy 或把舊 HTTP response 當新 fetch。
- [ ] Future file/document tool family 的 authoritative result 是 versioned Groundlane canonical document envelope；provider/engine raw JSON 不得越過 adapter boundary。Schema snapshot、backward-compatible evolution 與 migration tests 必須固定 `schemaVersion`、source-bound `documentId`、reusable `canonicalContentId`、stable block IDs、reading order、source identity/hash、status/capability states、warnings/errors 與 engine/model/version/cost/confidence provenance。
- [ ] Processing cache unit 是 canonical content core，不是完整 source-bound envelope。Core 排除 URL、filename、ArtifactRef、citation source identity、document ID、cache age 與 invocation metadata；cache hit 後必須由目前 source/version 重建 binding 與 source-bound `documentId`。相同 hash、不同 URL/filename/ArtifactRef fixtures 證明 block/content 可重用、source/citation provenance 不洩漏，projection 引用目前 `documentId`／`canonicalContentId`。
- [ ] Canonical envelope 對 blocks、tables/cells、assets/figures、formulas、metadata 與 citations 使用 typed records 與 references。Source spans 依格式可為 page/bbox、character offset、sheet/cell、slide/shape 或 media time range，並綁 content hash/coordinate version；capability state 只使用 `available | unsupported | not_run | failed`。`available` 可合法包含空結果；result-level absence 另以 typed result 表達。Top-level `success | partial | unsupported | failed` 依 required requested capabilities 的固定 aggregation table 產生。
- [ ] `output=markdown|structured|text|all` 預設 `markdown`；所有 projection 必須從相同 canonical envelope deterministic 產生，回 projection version、source document ID、`lossy`、`omissions[]` 與 warnings。Fixtures 證明 Markdown/text 不改寫 canonical ordering、table/citation references，且同一 envelope/version 的 projection 可重現。
- [ ] Canonical-core cache key 只包含影響 parsing/normalization 的 source content hash、engine/model/schema/policy versions 與 normalized parse options；`output` selection 不得改變此 key。若 projection 另行 cache，key 必須加入 `canonicalContentId`、projection kind/version/options；切換 Markdown/text/structured/all 不得重跑 canonical parser，projection 版本改變也不得命中舊 projection。
- [ ] Inline canonical/projection output 受 byte/character/block/table/asset bounds；任何 structured、Markdown、text、其他 projection或 `all` 超限時回 bounded summary/provenance 與 storage-neutral result `ArtifactRef`。`all` 不作預設，且不得因同時回 canonical與 projections 使 output、cache或 billing meter重複計算未揭露的工作量。
- [ ] Result `ArtifactRef` 使用 typed `artifactKind=canonical_document|projection`，包含 ownership、content hash、schema/projection kind/version、media type、created/expires、retention/deletion 與 provenance，並經 immutable write/finalize。它不是 cache entry；第一版 `DocumentSource.artifact` 只接受 `artifactKind=source`，generated result 不可直接遞迴 processing。Delete/expiry 與 24 小時 transient working default 沿用 artifact policy。
- [ ] Document processing 的 execution lifecycle 採明確雙軌：符合公開 byte/page/time/memory/engine limits 的 bounded deterministic operation 可同步完成；大型、OCR、layout/VLM、audio、provider-owned long-running operation 走 caller 明確建立的 async job。兩軌以相同 source fixture 產生相同 schema family、canonical content semantics、projection、provenance、cache 與 stable errors；不得維護另一套 async-only document schema。
- [ ] 同步 request 不得因 deadline、output size、queue pressure、fallback 或 engine selection silent 轉成 durable job。Async-only input/engine 必須在昂貴 dispatch 前回 stable capability/limit error 與可用 lifecycle；任何未來 `execution=auto` 都需 explicit opt-in。Oversized output 可以回 result `ArtifactRef`，但不得把這件事偽裝成 job creation 或重設 end-to-end deadline。
- [ ] Async document lifecycle 需通過 ownership、verified source snapshot/version、idempotent create、status monotonicity、result/partial result、expiry、disconnect/resume、retry、credential/funding binding、billing provenance 與 sanitized failure tests。Create acknowledgement 前需原子建立 job-owned bounded immutable snapshot；effective snapshot expiry 是 source expiry、job expiry 與 policy cap 的最早值並回給 caller。Fixtures 固定 create/delete race 的 privacy-conservative 結果：source expiry 或 owner delete 立即 revoke snapshot，queued/running job 轉 terminal cancelled/deleted 並停止 dispatch，completed transient result/cache binding 也 revoke，physical cleanup 可為 pending；不得 silent 延長 source。Result `ArtifactRef` TTL 從 immutable finalize 起算且不超過 effective snapshot expiry。Cancel tests 分開驗證停止 caller wait、停止 Groundlane polling/dispatch 與 upstream 真正 cancel，且不抹除已發生 usage/cost。先保存 MCP Tasks 對 Claude、Codex、Cursor 的 support matrix；支援不足時才採語意等價的 explicit start/status/result/cancel tools。
- [ ] Async deadline fixtures 分開同步/create request deadline、poll/result-wait deadline、job absolute execution deadline/expiry、per-attempt deadline 與總 execution budget。Job acknowledged 後的 disconnect/poll timeout 不取消 job；retry/fallback 不得重設總 budget，只有 explicit cancel 或已揭露的 deadline/expiry/policy transition 改變 durable lifecycle。
- [ ] 現有 URL/raw-HTML `parse` flat schema 保持相容；新 file/document family 先採 canonical envelope。任何 `parse` convergence 只可透過 additive/versioned fields，並通過既有 schema snapshot、tool list、HTML fixtures 與 Claude/Codex/Cursor compatibility tests。

### Diagnostics、budget 與 configuration

- [x] Phase 0 `provider_capabilities` static matrix 必須和 public schema、adapter registry、composition 與 docs 同步；registry refactor 後改由 registrations 產生並以 snapshot 固定，不呼叫 live provider discovery。
- [x] `provider_balance` 只呼叫已實作且有 credential 的官方 balance APIs；不得在 error/warning/log/test snapshot 洩漏 secrets 或 raw provider payload。
- [x] `provider_quota` 必須明確分開 account balance、Groundlane local attempt budgets、capability support、keyless availability 與 recommended next checks。
- [x] `search_budget_status` 必須標明 instance-local、UTC reset、非 provider billing truth；daily/monthly/minute budgets 有 deterministic reset/cap tests。

### Benchmark 與 compatibility

- [x] Reader benchmark、parser benchmark 與 extractor fixtures 都能在本機重跑，並輸出 machine-readable JSON 或 deterministic assertions。
- [x] 新增 provider、engine、parser backend、crawler policy 或 source-aware parser behavior 前，必須新增 fixture、benchmark case 或 contract test。
- [x] Benchmark 文件需記錄 corpus、revision、method、environment、限制與不可推論事項；不得把 fixture success 宣稱為 production success。

### Stateful resource gate

- [x] Monitoring、scheduled research、stateful browser sessions、Groundlane-owned orchestration、corpus lifecycle、explicit synthesis 與 generic model extraction 不得只因 provider/SDK 提供對應能力就進入 implementation；每項需有獨立 usage evidence 與 approved product contract。
- [ ] 每個 stateful resource 必須分別定義 owner、credential binding、TTL/retention、status/result/cancel、notification/webhook、abuse controls、quota/billing provenance、data deletion 與 deterministic lifecycle tests。
- [x] MCP transport session、Cloudflare Container instance memory 與單次 request lifecycle 不得被當成 durable ownership 或 storage boundary。
- [x] Authenticated browsing 必須維持獨立、explicit opt-in 的 tool family，不得改變 `web_fetch` 的 stateless public-Web contract。進入 implementation 前需有具體 target sites、使用頻率、session duration、MFA 模式、read-only/action boundary、provider custody 接受度與成本上限的 usage evidence。
- [ ] Authenticated session 第一版若獲核准，只接受 allowlisted domain、operator-authorized account、human-in-the-loop login/MFA、provider-owned opaque profile/context reference、principal/site/account binding、exclusive lease、idle/absolute TTL、explicit release/delete 與 read-only bounded navigation。不得保存 raw password、TOTP seed、passkey、可匯出的 cookie/storage snapshot，也不得承諾 CAPTCHA 或 managed-challenge bypass。

### Security 與 deployment

- [ ] Static bearer、D1 managed token 與 OAuth access token 都轉成同一個 `AuthenticatedPrincipal` contract；V1 `principalId=owner` 不被宣稱為 user/tenant isolation，OAuth `clientId` 只作 client/grant attribution；caller-provided principal/tenant/policy headers 被忽略或拒絕，不能覆寫驗證結果。
- [ ] `GROUNDLANE_AUTH_TOKEN` 只作 legacy/local/backward-compatible data-plane auth，不能存取 credential-management operation。新增 `GROUNDLANE_ADMIN_TOKEN` 只作 credential bootstrap/recovery/admin auth且不能呼叫 `/mcp`；兩者和 owner passphrase、internal-signing secret、provider secrets皆不得共用。
- [ ] `GROUNDLANE_ADMIN_TOKEN` 對 `/mcp`、`/readyz`、OAuth endpoints 與 `/register` 一律拒絕；`GROUNDLANE_AUTH_TOKEN`、D1 managed token與OAuth access token即使 `principalId=owner` 或帶任意 scope，對 `/admin/credentials` 也一律拒絕。Admin authorization使用exact secret route guard，不依賴一般 `AuthenticatedPrincipal`。
- [ ] Managed token create 產生至少 256-bit 高熵 secret，raw secret 只在 create/rotate 時回傳一次；D1 只保存有 indexed public ID 的 verifier/digest 與 bounded metadata。Lookup 先以 public ID 做 indexed single-row query，再 constant-time 比對 verifier；list/audit/log/error/snapshot 不回傳 raw token、verifier、authorization header 或 refresh token。
- [ ] Planned rotate的`overlapSeconds`預設3600並只接受整數`0..86400`；negative、overflow、fraction、NaN與錯誤型別在寫入前拒絕。每次建立新credential ID，舊update、新insert與`old.rotatedTo == new.id`/`new.rotatedFrom == old.id`在單一atomic transaction/conditional write完成；lineage維持一對一、無cycle，舊record/verifier不被覆寫或hard delete。
- [ ] 新credential原樣繼承principal、scopes/policy與absolute expiry；rotate不能擴權或延長expiry。Authentication只接受`active && now < expiresAt`或`rotating && now < min(validUntil, expiresAt)`，並先拒絕revoked/disabled；production只信任Worker server UTC time，clock boundary、`0` overlap、3600 default與86400 maximum有deterministic fake-clock tests。
- [ ] Rotation不需要scheduler/background cleanup；時間前進後，即使D1 stored status仍為`rotating`，下一個request也依`validUntil`拒絕。List output同時提供stored status與derived bounded `effectiveStatus/usable`，不得把已失效credential顯示成仍可用。
- [ ] `revoke` 永遠針對指定 credential立即生效並寫入`revokedAt`，不套用 rotation overlap，也不自動撤銷 successor/predecessor。Revoke commit後的新 request被拒絕；已進入執行中的 request不宣稱會被取消。
- [ ] Create、list metadata、rotate、revoke、expire、duplicate ID、malformed token、unknown token、disabled token 與 D1 unavailable 都有 deterministic tests；auth storage failure fail closed，不能自動改走一般 static bearer。
- [ ] 同一active credential的並行rotate只有一個atomic transition成功，其他request回stable conflict且不產生第二個successor；只有目前active successor可再rotate，舊rotating/revoked/expired record不可重複rotate。ID collision使用bounded retry且不破壞舊record。
- [ ] Rotate/revoke race由conditional write/serialization決定：revoke先commit則rotate conflict；rotate先commit後revoke old只撤銷指定old ID，successor不受影響；任何路徑都不得把revoked狀態改回rotating。Revoke具有idempotency，重複request不改寫首次`revokedAt`或產生矛盾lineage。
- [ ] Rotate mutation需要bounded idempotency key。Commit成功但response遺失時，相同key只回已建立的新credential ID與`secretAvailable=false`，不重播raw token、不建立第二個successor；CLI不得盲目用新key retry。Operator可明確revoke未知secret record或從該active successor再rotate。
- [ ] Rotation/revoke audit至少保存bounded operation ID、admin credential fingerprint/ID、old/new credential IDs、requested overlap、commit timestamp與result，不保存raw token/verifier；list有pagination/output bounds，record不因rotate/revoke hard delete。
- [ ] D1 managed-token lookup 不使用 unconstrained read replica；revoke commit 後的新 request 透過 primary/latest session 被拒絕，並有 contract test 與 controlled Cloudflare smoke；KV 不作 managed-token authorization或revocation truth。OAuth 若繼續使用 KV，文件不得宣稱 strong immediate revoke。
- [ ] Worker 先移除 caller-supplied internal-auth headers，再只傳 bounded、短效、有 issuer/audience/issued-expiry time、method/path、request ID 與完整性保護的 internal principal context；偽造、過期、錯誤 audience、錯誤 method/path/request binding 與缺少 context 都被 Container 拒絕，外部 raw credential 不跨此 boundary，signing secret 不和 admin/data-plane/provider secrets共用。
- [ ] Cloudflare `worker_internal_context` mode拒絕所有 raw bearer fallback；`local_static` mode才接受 legacy `GROUNDLANE_AUTH_TOKEN`，兩種 mode 不可在同一 listener 同時啟用。
- [ ] Managed credential 的 `/admin/credentials` API 只接受 `GROUNDLANE_ADMIN_TOKEN`，有 create/list metadata/rotate/revoke/expire contract、request/body bounds、sanitized errors、metadata-only audit 與 deterministic tests；不接受 browser cookie/session auth，不和 OAuth DCR `/register` 共用 route 或語意，也不轉送 Container。
- [ ] Admin token不存 D1、不由 admin API rotate；rotation與recovery走 Cloudflare/deployment secret lifecycle。缺少 admin token時 admin API fail closed/unavailable，但既有 data-plane依其 profile繼續服務。
- [ ] `groundlane credentials` CLI 只從 protected environment/secret helper讀取 admin token並呼叫 admin API，不持有 D1 binding、database ID/API token或直接執行 SQL；create/rotate raw token只輸出一次，list/revoke輸出不包含 raw token或 verifier。
- [ ] Auth matrix deterministic tests覆蓋 admin、legacy、managed、OAuth與缺少 credential對 `/admin/credentials`、`/mcp`、`/readyz`、OAuth endpoints及`/register` 的允許/拒絕結果；`/register` 的 legacy protection只作 OAuth DCR anti-abuse compatibility，不被解讀為 managed-token admin authorization。
- [ ] `local_static` profile 沒有 D1、只維持現有單一 static bearer；`worker_internal_context` 的 backward-compatibility deployment 可保留 Worker static/OAuth 驗證，但必須明確回報 managed-token capability unavailable；兩者都不得悄悄建立 multi-static-secret fallback。
- [x] direct/private、DNS-to-private、redirect-to-private、IPv4/IPv6 special ranges、metadata 與 browser subresource policy regression tests 通過。
- [x] unauthenticated `/mcp` 被拒絕，health response 不洩漏 secret。
- [x] `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 全部通過。
- [x] Cloudflare deployment 文件與實際 Wrangler/Container contract 一致，並完成 controlled-fixture smoke test。
- [x] 每次 user-visible tool/config/workflow 變更都同步更新 `README.md`、`README.zh-TW.md` 與相關 docs；若不需更新，final report 必須說明原因。
- [x] Browser diagnostics 預設只回 decision reason、stage timing、blocked-subrequest 與 bounded console/network failure metadata；screenshot、snapshot、trace 或 HAR 必須 explicit opt-in、受 byte/time/retention 限制，且不得回傳 headers、cookies、secrets 或 raw response body。
- [x] Cloudflare binding types、Workflows、Queues、Durable Objects、D1、R2、Browser Run 與 observability integrations 不得進入 provider-neutral runtime contract；core contract tests 不需 Cloudflare account 或 live bindings。
- [x] Worker 與 Container 若同時提供 retrieval/provider execution path，必須共用或以 contract tests 證明 URL policy、deadline/cancellation、limits、sanitized errors 與 provenance 語意一致。
- [ ] Durable job retry 對 provider task creation、付費 upstream call 與 artifact writes 有 idempotency/replay tests；沒有 provider acknowledgment 時不得宣稱 upstream cancel 成功。
- [ ] D1/DO/Workflow/Queue state 不保存大型內容；durable async `ArtifactRef` 必須 storage-neutral，並包含 tenant/owner binding、content hash、byte size、retention/expiry 與 deletion policy，Cloudflare reference deployment 才映射到 R2。
- [ ] Public Web 與 scoped corpus search 使用不同 tool family；兩者 output 都必須能辨識 source kind、provider/backend、corpus boundary 與 freshness provenance，scoped result 不得標示成全網搜尋結果。
- [ ] Corpus lifecycle contract 至少覆蓋 create、enroll source、update/resync、remove source、status、search 與 delete。Public corpus/source identity 不得使用 backend job/index ID；backend partial failure、reconciliation、reindex 與 delete propagation 必須映射成 stable state，未完成 derived-index/artifact deletion前不得宣稱刪除完成。
- [ ] Corpus manifest、source identity/hash、ACL、retention/deletion policy 與 lifecycle/citation/backend provenance 是 Groundlane contract truth；derived index 可重建且不得成為 identity、authorization、retention 或 deletion truth。
- [x] Operator-hosted search adapter 只允許 build/deploy-time registration 與 operator-controlled endpoint allowlist；caller 不得在 tool input 注入任意 provider endpoint。

## 9. Non-goals

MVP 明確不包含：

- 自建全網 search index、第一方 scoped-corpus index/ranking/storage engine 或 crawler fleet；Groundlane-owned corpus lifecycle 透過可替換 managed、external 或 self-hosted backend adapter 實作；
- residential proxy network、通用 CAPTCHA solving 或「undetectable」保證；
- persistent login profiles、stateful browser sessions、raw credential/cookie injection，以及登入後通用 action automation；
- crawl queue、scheduled monitoring、async batch jobs；
- Groundlane 自行執行的 LLM-based semantic extraction、answer synthesis 或 research agent；
- reranker model、knowledge graph、marketplace 或 site-specific scrapers；
- caller-provided arbitrary provider endpoint、remote code loading、runtime npm plugin marketplace 或未隔離的第三方 package execution；
- hosted multi-tenant control plane、per-tenant provider credentials/routing/billing isolation，或 caller-selected tenant/policy override（均不屬於 MVP，但 Managed Groundlane Cloud 已列入後續 roadmap）；
- 對 robots、網站條款或存取授權做法律判定。

Operator-owned corpus 或 bounded domain 的 scoped search 不屬於「自建全網 index」，但仍不在 MVP。Document processing 不會隱含 corpus enrollment；只有明確 enrollment 才建立持久 source membership。Corpus lifecycle contract、backend adapter conformance、retention/deletion、tenant isolation、freshness、source/citation provenance 與 evaluation corpus 通過獨立 demand gate 後，才能進入後續 phase；第一方 index/ranking/storage engine 不隨此方向自動納入。

Roadmap 中的 compatibility spike、contract design 與 provider evaluation 不代表上述 stateful 或 model-backed 能力已納入 MVP；只有通過各自 gate 的項目才能成為後續實作承諾。

## 10. 風險與 mitigation

| 風險 | 影響 | MVP mitigation |
| --- | --- | --- |
| SSRF / DNS rebinding / redirect bypass | 存取內部服務或 metadata | address validation、pinning、安全 proxy/dispatcher、subresource policy、egress firewall |
| Browser escape 或 process leak | Container/host compromise、資源耗盡 | isolated Container、least privilege、deadline、cleanup、memory/concurrency caps |
| Provider outage/rate limit | 搜尋失敗或 latency 上升 | health-aware routing、有限 fallback、明確 attribution/error |
| Admin credential 洩漏或 legacy data-plane token被意外升權 | 可建立/撤銷 managed tokens或擴大 blast radius | 獨立 `GROUNDLANE_ADMIN_TOKEN`、admin/data-plane route硬隔離、rotation、metadata-only audit、legacy token永不取得admin權限 |
| D1 auth outage、stale replica 或 internal context drift | 合法 client 被拒絕、已撤銷 token 暫時有效或 Worker/Container identity 不一致 | fail closed、primary/latest session、短 TTL、method/path/request binding、cross-runtime contract tests、controlled smoke |
| 成本失控 | provider、browser、egress 費用 | request/result/byte/time budgets、provider spend alerts、audit metadata |
| Anti-bot 宣稱過度 | 使用者期待落差與濫用 | 不承諾 universal bypass；browser 只作 fallback；記錄 engine/reason |
| Output/content injection | agent 接收惡意頁面指令 | 將內容標為不可信資料、固定結構、bounded output；不宣稱內容安全 |
| 網站與隱私合規 | 法律與信任風險 | self-controlled deployment、metadata-only logs、operator responsibility、retention minimization |
| Tool contract 過早膨脹 | 相容性與維護成本 | 將 tool surface 維持在明確 contract；parser、session、crawl、research 與 provider diagnostics 分階段設計 |
| Cloudflare primitive 滲入 core contract | 自架路徑失去可替換性、測試依賴 live account | operator-controlled Cloudflare reference deployment、provider-neutral runtime contracts、bindings/adapters 邊界與 fake-based contract tests |
| Retry 造成重複 provider 計費 | provider task、crawl 或 model call 重複建立 | idempotency key、replay policy、provider task mapping、billing provenance 與人工可診斷狀態 |
| 單一 named Container 成為容量／故障集中點 | 冷啟動、排隊或 instance failure 擴大影響 | bounded queue/concurrency、readiness、instance routing strategy；不把 process-local counters 當 durable truth |
| Operator-hosted adapter 擴大 SSRF／secret／supply-chain 風險 | 任意 endpoint、credential 外洩、第三方 code 取得 process 權限 | deploy-time public HTTPS exact-origin allowlist、provider-ID-derived dedicated secret binding、normalized HTTP bridge；第一版不載入 runtime plugin code |

## 11. Design influences

本輪重新依 `docs/research/open-source-references.md` 核對後，PRD 不再把所有候選來源都稱為
primary references。Reference shortlist 以「能力互補、維護訊號、近期活躍、授權邊界、可被
Groundlane contract 隔離」為主，不以 GitHub stars 單點排序。

- Primary architecture references：Steel、Playwright MCP、Stagehand、Crawlee、Scrapy。Browserless、Lightpanda、Firecrawl、HyperAgent、Browser Use、browser-harness、Chrome DevTools MCP、BrowserMCP、PageAgent 與 Kuri 因授權、runtime 或相容性邊界，只能先作設計／實驗／discovery 參考，不能直接變成 dependency。
- Primary reader/parser references：Mozilla Readability、htmlparser2、parse5、Metascraper、Postlight Parser、Trafilatura、Crawl4AI。這些用來拆 Reader、metadata、DOM parsing、正文抽取、Markdown 與 extraction UX 的能力線，不代表要引入第二套 Python runtime。
- Document processing references：MarkItDown、anydoc、Pandoc、Mammoth、SheetJS、Apache POI、Docling、Unstructured、GROBID、pdf.js、pdfminer.six、PaddleOCR、RapidOCR、EasyOCR、docTR、Surya、Layout Parser、OLMOCR、OCRmyPDF、Tesseract、Apache Tika、PyMuPDF、pdfplumber、pypdf、Camelot、Tabula。QuidProQuo 的[文件解析實戰系列](https://quidproquo.cc/series/document-parsing/)提供 conversion／deterministic extraction／model-assisted parsing 三層 taxonomy、scanned-PDF 小型實測與 license/runtime checklist；它是設計與 fixture seed，不是 universal format、accuracy 或 latency 證據。這些 references 在 document-processing threat model 完成前只作 adapter 設計與 benchmark 參考。
- Watchlist/reference projects：Scrapling、AutoScraper、Katana、Browsertrix Crawler、SearXNG、Apache Nutch、Chrome DevTools MCP、BrowserMCP、browser-harness、PageAgent、Kuri、webclaw、crw、searcharvester、YaCy、Marginalia Search、MinerU、Marker。這些先用來補 taxonomy、fixtures、failure semantics、特殊格式能力或長期產品邊界，不列為 adapter/runtime 優先候選。
- Discovery-only sources：GitHub Topics、GitHub Trending、OSSInsight、Ecosyste.ms、LibHunt、MCP Registry/mcpservers.org、package registries、Zyte Open Source、awesome lists、vendor annual lists、document/OCR benchmark lists。這些只用來發現候選、補分類與重查來源；任何候選進 PRD roadmap 前，都必須回官方 repository/docs、LICENSE/NOTICE、release notes、dependency graph 與 Groundlane bounded fixtures 驗證。
- Provider docs / market references：Tavily、Exa、Jina、Firecrawl hosted docs、SerpApi、SearchAPI.io、TinyFish、Parallel、Linkup、You.com、Keenable、Cloudflare Containers。這些不是開源 runtime references；只能用來校準 provider adapter、hosted capability、deployment 或產品邊界。

Selenium 保留為 negative/boundary reference：它提供跨瀏覽器 automation 經驗，但 Groundlane 已以 Playwright 作 Chromium backend，不新增第二套 driver，也不把 WebDriver 說成 anti-bot 或 CAPTCHA 能力。

| 分類 | 參考來源 | 採用的影響 | 明確不採用／延後 | 證據 |
| --- | --- | --- | --- | --- |
| Primary architecture | Steel | browser lifecycle port、stateless 與 stateful surface 分離、可自架思路 | 不 fork 完整 UI/session platform；MVP 不公開 session handles | [Steel](https://github.com/steel-dev/steel-browser) |
| Primary architecture | Playwright MCP | Streamable HTTP、tool registration、client isolation、accessibility/DOM-first、output bounds | 不把 origin allow/block flags當成 SSRF security boundary | [Playwright MCP](https://github.com/microsoft/playwright-mcp) |
| Primary architecture | Stagehand | 未來 schema validation 與 agent-friendly extract/observe API 參考 | MVP 不引入 LLM act/observe/extract 或 self-healing action | [Stagehand](https://github.com/browserbase/stagehand) |
| Primary pattern | Scrapy | spider/crawler lifecycle、request/response middleware、item pipeline 與 retry policy 參考 | 不引入 Python crawler runtime；不把 batch crawl 變成預設 web_fetch 行為 | [Scrapy](https://github.com/scrapy/scrapy) |
| Primary future candidate | Crawlee | 未來 crawl queue、retry、session pool、autoscaling 參考 | 單頁 MVP 不加入 crawler framework | [Crawlee](https://github.com/apify/crawlee) |
| Design reference, license-gated | Browserless | Container/browser operations、queue、crash recovery、同 API 跨部署的參考 | 不依賴或複製 SSPL/commercial code；不承諾其 proxy/CAPTCHA breadth | [Browserless](https://github.com/browserless/browserless) |
| Experimental reference, license-gated | Lightpanda | 低記憶體 headless browser、CDP server、Markdown dump 與 HTTP MCP session isolation 參考 | 不替換 Chromium/Playwright；非 Chromium 相容性、AGPL/commercial 授權與 anti-bot 邊界需實測／審查 | [Lightpanda](https://github.com/lightpanda-io/browser) |
| Browser/session watchlist | Browser Use / browser-harness / HyperAgent / Chrome DevTools MCP / BrowserMCP / PageAgent / Kuri | browser agent task loop、AI action/extract API、self-healing harness、DevTools diagnostics、user-owned browser control、in-page GUI agent、CDP snapshot、HAR/fetcher 與 mobile automation discovery | Browser Use/browser-harness 偏 Python agent reasoning/task harness；HyperAgent 有 AGPL 邊界；Chrome DevTools MCP 偏 debugging/tooling；BrowserMCP 偏 local browser extension；PageAgent 偏 in-page action；Kuri 維護史短且 license metadata 非標準 | [Browser Use](https://github.com/browser-use/browser-use), [browser-harness](https://github.com/browser-use/browser-harness), [HyperAgent](https://github.com/hyperbrowserai/HyperAgent), [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp), [BrowserMCP](https://github.com/BrowserMCP/mcp), [PageAgent](https://github.com/alibaba/page-agent), [Kuri](https://github.com/justrach/kuri) |
| Primary reader/parser | Mozilla Readability | article candidate scoring、boilerplate removal、selector-less Reader fallback | 不把 Reader heuristics 當成 deterministic DOM extraction；selector extraction 維持 DOM semantics | [Readability](https://github.com/mozilla/readability) |
| Primary reader/parser | htmlparser2 / parse5 | TS/JS HTML parsing substrate、forgiving parser 與 spec-compliant parser 的取捨、selector engine 邊界 | parser substrate 只作低階 DOM/AST；不得取代 Groundlane 的 URL policy、output bounds 或 extraction contract | [htmlparser2](https://github.com/fb55/htmlparser2), [parse5](https://github.com/inikulin/parse5) |
| Primary reader/parser | Metascraper / Postlight Parser | metadata fallback、domain-specific parser、author/date/lead image extraction 與 corpus benchmark 參考 | 不把 domain-specific extractors 變成隱性 scraping marketplace；需控制 dependency/output 膨脹 | [Metascraper](https://github.com/microlinkhq/metascraper), [Postlight Parser](https://github.com/postlight/parser) |
| Primary reader/parser | Trafilatura | text/metadata/comment extraction、multi-format output、crawl/download/extract 分層 | 不引入 Python runtime；先拆能力與 fixtures，再評估 adapter | [Trafilatura](https://github.com/adbar/trafilatura) |
| Primary reader/parser | Crawl4AI | LLM-friendly crawling、Markdown output、structured extraction 與 crawl policy 參考 | 不把 LLM extraction 併入 deterministic parser；不複製 crawler/runtime stack | [Crawl4AI](https://github.com/unclecode/crawl4ai) |
| Watchlist extractor | Scrapling / AutoScraper | resilient selector、pattern-based scraping、example-driven extraction 參考 | 不先承諾 self-healing selector；pattern/schema engine 需獨立 contract 與 fixtures | [Scrapling](https://github.com/D4Vinci/Scrapling), [AutoScraper](https://github.com/alirezamika/autoscraper) |
| Watchlist crawl/security | Katana / Browsertrix Crawler | URL frontier、JS endpoint discovery、scope/duration caps、high-fidelity browser archival與 WARC 思路 | Katana 是 Go security crawler；Browsertrix 偏 preservation 且 AGPL，兩者都不作 Node MVP dependency | [Katana](https://github.com/projectdiscovery/katana), [Browsertrix Crawler](https://github.com/webrecorder/browsertrix-crawler) |
| Platform watchlist, license-gated | Firecrawl server | open-source search/scrape/crawl/extract platform、MCP、queue/orchestration 與 Markdown output 參考 | AGPL server 與 hosted service 能力需分開；不複製 runtime stack 或把 hosted anti-bot 能力寫成開源能力 | [Firecrawl](https://github.com/firecrawl/firecrawl) |
| Watchlist search/index | SearXNG / Apache Nutch | metasearch provider categories、privacy-first routing、大規模 index ingestion 與 plugin pipeline | 不自架公開 metasearch service；不在 MVP 自建全網 index；Groundlane adapters 仍以 operator-configured providers 為界 | [SearXNG](https://github.com/searxng/searxng), [Apache Nutch](https://github.com/apache/nutch) |
| Watchlist search/index | searcharvester / YaCy / Marginalia Search | 搜尋來源聚合、self-hosted search/index 邊界、alternative index 思路 | 維護訊號與產品邊界需重查，只作 provider taxonomy 與 future self-hosted index 研究 | [searcharvester](https://github.com/StevenBlack/searcharvester), [YaCy](https://github.com/yacy/yacy_search_server), [Marginalia Search](https://github.com/MarginaliaSearch/MarginaliaSearch) |
| Discovery extraction/crawl | webclaw / crw | Rust local-first extraction/crawl/MCP server、Firecrawl/Tavily-compatible API、HTML-to-Markdown 與 lightweight server 方向 | 新專案；license、benchmark、runtime 與 security boundary 需完整審查 | [webclaw](https://github.com/0xMassi/webclaw), [crw](https://github.com/us/crw) |
| Discovery, source tracking | GitHub Topics / GitHub Trending / OSSInsight | 持續追蹤 `web-scraping`、`web-crawler`、`html-parser`、`search-engine`、`metasearch-engine`、`document-parsing`、`pdf-parser`、`pdf-text-extraction`、`ocr` 等 topic，以及短期活躍 browser tooling/MCP/document conversion 候選 | topic/trending 排名只當候選來源；OSSInsight 2026-08-30 抓取時 star-based ranking 暫停，AI trending growth figures 受 GitHub public events incomplete 影響；採用前仍需逐一做 license/security/dependency review 與 bounded fixture 驗證 | [web-scraping](https://github.com/topics/web-scraping), [web-crawler](https://github.com/topics/web-crawler), [html-parser](https://github.com/topics/html-parser), [search-engine](https://github.com/topics/search-engine), [metasearch-engine](https://github.com/topics/metasearch-engine), [document-parsing](https://github.com/topics/document-parsing), [pdf-parser](https://github.com/topics/pdf-parser), [pdf-text-extraction](https://github.com/topics/pdf-text-extraction), [ocr](https://github.com/topics/ocr), [GitHub Trending](https://github.com/trending), [OSSInsight Trending](https://ossinsight.io/trending) |
| Discovery, external catalogs | Ecosyste.ms / LibHunt / MCP Registry / mcpservers.org / awesome lists / package registries / Zyte Open Source / document-OCR benchmark lists | 補 GitHub topic 之外的 package metadata、curated lists、MCP server catalogs、Scrapy ecosystem references、document/OCR datasets 與 benchmark corpus | catalog、ranking、vendor blog 與 package registry metadata 只能作 discovery seed；採用前必須回官方 repository、release notes、LICENSE/NOTICE、dependency graph 與 Groundlane bounded fixtures 驗證 | [Ecosyste.ms Packages](https://packages.ecosyste.ms/), [LibHunt Web Crawling](https://www.libhunt.com/topic/web-crawling), [MCP Registry](https://github.com/modelcontextprotocol/registry), [mcpservers.org](https://mcpservers.org/), [awesome.ecosyste.ms](https://awesome.ecosyste.ms/), [Zyte Open Source](https://www.zyte.com/open-source/) |
| Document ingestion | MarkItDown / anydoc / Pandoc | Office/PDF/HTML/image/audio 等多格式轉 Markdown、Rust/Node/Python document conversion、universal markup conversion、LLM ingestion output 參考 | 不讓本機檔案轉換繼承任意 process 權限；遠端 URL 與 local file ingestion 必須分開 threat model；anydoc 不做 scanned/image-only PDF OCR；Pandoc 有 GPL/Haskell/process boundary | [MarkItDown](https://github.com/microsoft/markitdown), [anydoc](https://github.com/firecrawl/anydoc), [Pandoc](https://github.com/jgm/pandoc) |
| Document ingestion | Docling / Unstructured | document conversion pipeline、layout-aware parsing、partition/chunk/enrich、table/figure handling、GenAI-ready output 參考 | 不先引入 heavyweight model/runtime 或 enterprise workflow assumptions；PDF/OCR/layout backends 需 opt-in 且 bounded | [Docling](https://github.com/docling-project/docling), [Unstructured](https://github.com/Unstructured-IO/unstructured) |
| Document ingestion | GROBID | scholarly PDF header、citation、reference、bibliography 與 full-text structure extraction | Java service/runtime、模型與 service lifecycle 需隔離 | [GROBID](https://github.com/grobidOrg/grobid) |
| Document ingestion | Mammoth / SheetJS / Apache POI | DOCX-to-HTML、spreadsheet data extraction、Microsoft Office document APIs | Mammoth/SheetJS 較貼近 JS adapter；POI 是 Java runtime；SheetJS canonical source 需重查 | [Mammoth](https://github.com/mwilliamson/mammoth.js), [SheetJS](https://github.com/SheetJS/sheetjs), [Apache POI](https://github.com/apache/poi) |
| Document ingestion | pdf.js / pdfminer.six / PyMuPDF / pypdf | PDF rendering/text layer、low-level text/layout extraction、page range、metadata 與 PDF primitives | 文字順序、table 與 semantic structure 需額外處理；Python/native dependency boundary 需隔離 | [pdf.js](https://github.com/mozilla/pdf.js), [pdfminer.six](https://github.com/pdfminer/pdfminer.six), [PyMuPDF](https://github.com/pymupdf/PyMuPDF), [pypdf](https://github.com/py-pdf/pypdf) |
| Document ingestion | pdfplumber / Camelot / Tabula | PDF table extraction、line/cell detection、stream/lattice 類 table heuristics | 多針對 text-based PDFs；scanned PDF fallback、Java/native dependency 與 table confidence 需定義 | [pdfplumber](https://github.com/jsvine/pdfplumber), [Camelot](https://github.com/camelot-dev/camelot), [Tabula](https://github.com/tabulapdf/tabula-java) |
| Document ingestion | PaddleOCR / RapidOCR / EasyOCR / docTR / Surya | OCR、layout analysis、reading order、table recognition、多語辨識、PDF/image 到 Markdown/JSON 的能力參考；RapidOCR 提供多 runtime backend 方向 | 不把 OCR/model inference 當預設 parser；需明確 runtime backend、cost、latency、confidence、model artifact 與 fallback metadata | [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR), [RapidOCR](https://github.com/RapidAI/RapidOCR), [EasyOCR](https://github.com/JaidedAI/EasyOCR), [docTR](https://github.com/mindee/doctr), [Surya](https://github.com/datalab-to/surya) |
| Watchlist document ingestion | Layout Parser / OLMOCR | document image layout analysis、PDF linearization for LLM datasets/training | model-assisted output 不能混成 deterministic parser；維護度、模型與 deployment boundary 需重查 | [Layout Parser](https://github.com/Layout-Parser/layout-parser), [OLMOCR](https://github.com/allenai/olmocr) |
| Document ingestion | OCRmyPDF / Tesseract | scanned PDF OCR layer、searchable PDF、OCR engine packaging 與 deterministic preprocessing 參考 | 不直接處理本機檔案或寫回文件；OCR 必須受 byte/page/time limits 與 sandbox policy 約束 | [OCRmyPDF](https://github.com/ocrmypdf/OCRmyPDF), [Tesseract](https://github.com/tesseract-ocr/tesseract) |
| Watchlist document ingestion | MinerU / Marker / Dolphin | PDF layout recovery、OCR、formula/table extraction、document image parsing 與 benchmark corpus 參考 | 不列為第一批 runtime candidate；需重查維護度、模型重量、license 與 deployment boundary | [MinerU](https://github.com/opendatalab/MinerU), [Marker](https://github.com/VikParuchuri/marker), [Dolphin](https://github.com/bytedance/Dolphin) |
| Document ingestion | Apache Tika | MIME detection、多格式 text extraction、metadata extraction 與 server mode | Java service/runtime；format coverage 廣但 output contract 需收斂 | [Apache Tika](https://github.com/apache/tika) |
| Discovery document routing | opendataloader-pdf / pdf-inspector / anytomd-rs / FileToMarkdown / any2md | PDF accessibility、tagged-PDF、scanned vs text-based classification、routing hints、file-to-Markdown experiments | 新專案／scope narrow；需驗證 license、quality 與 maintenance | [opendataloader-pdf](https://github.com/opendataloader-project/opendataloader-pdf), [pdf-inspector](https://github.com/firecrawl/pdf-inspector), [anytomd-rs](https://github.com/developer0hye/anytomd-rs), [FileToMarkdown](https://github.com/jojomondag/FileToMarkdown), [any2md](https://github.com/rocklambros/any2md) |
| Provider docs / market | Tavily / Exa / Jina / Firecrawl hosted docs / SerpApi / SearchAPI.io / TinyFish | Search/contents/reader/rerank 能力拆分、provider adapter 與 normalized contract | 不是開源 runtime references；不複製其 index；MVP 不做 rerank/research synthesis | [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search), [Exa Search](https://docs.exa.ai/reference/search), [Jina Reader](https://jina.ai/reader/), [Firecrawl Search](https://docs.firecrawl.dev/api-reference/endpoint/search), [SerpApi Google Search](https://serpapi.com/search-api), [SearchAPI.io Google Search](https://www.searchapi.io/docs/google), [TinyFish Search API](https://docs.tinyfish.ai/search-api/reference) |
| Provider docs / market | Parallel / Linkup / You.com / Keenable | vendor-neutral web intelligence control-plane 願景、structured/cited result、research API、independent index 或 retrieval workflow 方向 | 不是開源 runtime references；MVP 可轉接 provider research API，但不做自家 deep-research agent、monitor、FindAll 或自己的 web index | [Parallel](https://parallel.ai/), [Linkup](https://docs.linkup.so/), [You.com API](https://documentation.you.com/), [Keenable](https://docs.keenable.ai/) |
| Deployment platform | Cloudflare Workers / Containers | Worker ingress/control plane + isolated Node/Playwright execution plane、self-controlled deployment | 不是開源 runtime reference；core contracts 不依賴 Cloudflare；不把 Container instance/process/disk 當 durable task、quota 或 browser session truth | [Cloudflare Workers](https://developers.cloudflare.com/workers/), [Cloudflare Containers](https://developers.cloudflare.com/containers/) |
| Managed browser adapter | Cloudflare Browser Run | rendered content、screenshot 與 provider-owned crawl lifecycle | 保持 explicit backend/provenance；structured extraction 仍走獨立 schema-extraction gate；不取代 HTTP-first retrieval、不宣稱 CAPTCHA bypass、不把 upstream retention 當 Groundlane retention | [Browser Run Quick Actions](https://developers.cloudflare.com/browser-run/quick-actions/) |
| Durable execution/storage | Cloudflare Workflows / Queues / Durable Objects / D1 / R2 | 長任務 lifecycle、per-page buffer、coordination、queryable metadata 與大型 artifacts 的責任拆分 | 逐項 demand gate；retry 必須 idempotent；不把 Queue/Workflow/DO/D1 當 blob store，也不把 R2 當 state machine | [Workflows](https://developers.cloudflare.com/workflows/), [Queues](https://developers.cloudflare.com/queues/), [Durable Objects](https://developers.cloudflare.com/durable-objects/), [D1](https://developers.cloudflare.com/d1/), [R2](https://developers.cloudflare.com/r2/) |
| Scoped search backend | Cloudflare AI Search / Vectorize | operator-owned corpus 或 bounded domain 的 managed indexing/search candidate | 和 public Web provider routing 分開；不得因使用 managed index 就省略 corpus、freshness、model/backend 與 citation provenance | [Cloudflare AI Search](https://developers.cloudflare.com/ai-search/), [Vectorize](https://developers.cloudflare.com/vectorize/) |

授權與功能會變動；採用第三方 code 前必須鎖定版本、閱讀完整 LICENSE/NOTICE 並完成 dependency review。上表只描述設計影響，不表示包含對方程式碼。

候選專案進入 reference table 前需通過基本維護度檢查。GitHub stars、forks、近期 release、最近 commit、issue/PR 回應、CI/test 狀態、文件完整度與 dependency 重量都要一起看；stars 高但邊界不合、license 不清或 security posture 差，不能直接採用。反過來，stars 少且近期更新少的專案只能當歷史或概念參考，不應列為 adapter/runtime 優先候選，除非它提供獨特演算法、格式支援或可重用 benchmark corpus，且 Groundlane 能用小型 deterministic fixtures 驗證其價值。

## 12. Roadmap

### OSS V1 Stable Release boundary

OSS V1 Stable Release 不是純 Web release，也不以「所有文件格式都完整支援」作無法驗證的承諾。它必須交付可由單一 operator 自架的 stable Web + document data plane；每項 document capability 依自身 maturity 宣告 `stable`、`experimental` 或 `unsupported`，不能因共用一個 tool/envelope 就暗示品質、成本或執行路徑相同。Roadmap phase 編號是工作線，不代表 Phase 2 的所有項目都要早於 V1 document slice 完成；以下 boundary 才是 V1 release blocker 的 authority。

V1 release blockers：

- 現有 Phase 0 Web/HTML data plane、built-in provider routing/provenance/diagnostics、URL/security/deadline/output contracts，以及 Phase 1 的 contract/release hardening、single-tenant multi-credential Cloudflare managed profile 與 controlled deployment smoke。
- Future file/document family 的共用基礎：versioned `DocumentSource`、preflight/MIME classification、canonical document envelope、Markdown/structured projections、partial/unsupported semantics、engine/version/source provenance、bounded synchronous deterministic execution，以及 inline/public-URL/verified `ArtifactRef` inputs。Cloudflare reference profile 必須提供經 verify/finalize 的 R2 upload handoff；self-host 可替換 artifact backend。
- V1 stable format profiles：text-based PDF；DOCX、XLSX、PPTX；CSV、TXT、Markdown、JSON、XML、HTML；以及 bounded ODF、RTF、EPUB、EML。ODF/RTF 只承諾通過 fixtures 的基本文字、段落與表格；EPUB 只承諾無 DRM/script/network 的 bounded text/TOC；EML 只承諾 bounded MIME depth 的 headers 與 text/HTML body。Encrypted content、external/embedded active content、nested archives 與未宣告的 fidelity 必須明確拒絕或回 omissions，不能 silent degrade。
- Stable profiles 都需具每格式 fixtures、malformed/large/encrypted cases、source spans 或明確 unavailable state、sandbox/process limits、cancellation、canonical output snapshots、target-client tool selection 與 Cloudflare controlled smoke。任一列為 stable 的 profile 未過自身 gate，就不能在 V1 capability matrix 標示 stable。

V1 可隨 release 提供但不構成 stable release blocker 的 opt-in experimental engines：scanned-PDF/image OCR、legacy DOC/XLS/PPT conversion、complex layout/table/formula/figure recovery、GROBID-style scholarly extraction 與 bounded audio transcription。Experimental capability 必須沿用相同安全、limits、canonical envelope 與 provenance，明示 engine/model、confidence、cost/latency、omissions 與 unavailable/partial semantics；不得 hidden fallback，也不得用 experimental engine success 宣稱該 input kind 已獲 stable support。

V1 明確不承諾 video processing、universal document fidelity、Groundlane-owned long-running model execution、corpus enrollment/index、operator-hosted custom provider runtime、durable crawl/research lifecycle、stateful authenticated browser或 Managed Groundlane Cloud。這些維持各自後續 gate。V1 的「可替換／混合 provider」只指當版已實作並通過 contract tests 的 built-in adapters；`groundlane-provider-v1` operator-hosted search bridge 仍在 registry parity 後另行交付。

### Capability completeness matrix

| 能力線 | 目前狀態 | 下一步 | Gate |
| --- | --- | --- | --- |
| MCP/control plane | 已有 single static bearer、single-owner OAuth、health/readiness、Worker/Container routing、tool registry | single-tenant multi-credential `AuthenticatedPrincipal`、D1 managed-token lifecycle、signed internal principal context、contract versioning、schema snapshot、release checklist | static/OAuth/D1 auth matrix、token lifecycle/revoke consistency、identity spoofing、list-tools、structuredContent、readiness、container failure tests |
| URL retrieval / Reader | 已有 HTTP-first、Readability/linkedom Reader、source-aware docs、Jina/browser fallback | 擴 multilingual/bad HTML/large docs corpus，保存 benchmark artifacts | URL policy、redirect/private DNS、byte/output/deadline、Reader benchmark |
| Browser/render | 已有 local/browserless fallback、render mode、wait selector、subresource policy | stateless metadata-first diagnostics、browser time budget、explicit snapshot/screenshot provenance | render never/auto/always、challenge detection、sensitive-data redaction、browser disabled/enabled smoke |
| Search aggregation | 已有 multi-provider routing、RRF、canonical dedupe、provider budgets | query planning、freshness policy、vertical routing diagnostics | provider fake tests、budget reset/cap、warning sanitization、no live provider in CI |
| Search ownership | public Web routing 已有 provider provenance；corpus lifecycle control-plane ownership 已核准，但尚無 scoped corpus runtime surface | 定義 build/deploy-time operator-hosted adapter contract、backend-neutral corpus lifecycle contract 與 scoped search demand/eval gate | corpus identity、source manifest、ACL、enrollment/index-sync state、freshness、retention/deletion、tenant isolation、citation/backend provenance、backend portability |
| Provider extension | 目前 catalog/config/tool schema/composition 為 built-in closed set | 先重構 single-source registry，再評估 search-only `groundlane-provider-v1` HTTP bridge | built-in parity、strict manifest、no caller endpoint、URL/secret/deadline/error/provenance tests |
| Provider answer/research/content | 已有 answer/research/content fan-out/fallback 與 provider attribution | MCP Tasks/target-client compatibility spike；短 research 維持同步 | endpoint/auth mapping、citations/sources、malformed response、quota/error mapping、reproducible client matrix |
| Map/crawl | 已有 provider-backed map/crawl with caps/dedupe | provider-neutral durable crawl contract、robots、per-site budget、upstream cancel semantics | create/status/result/cancel、owner/expiry、page/byte caps、unsafe URL drop、provider attribution |
| News/images | 已有 Brave/Serper/SerpApi vertical adapters | richer filters、image/license metadata、freshness diagnostics | URL validation、dedupe、vertical endpoint mapping、partial failure |
| Extractor | 已有 selector 與 bounded pattern engines | deterministic schema validation、benchmark:extractor、single-URL provider-backed schema extraction evaluation | selector/pattern fixtures、ReDoS guard、missing/invalid fields、repeatability、provenance、output cap |
| Parser | 已有 HTML document/metadata/links/media/tables 與 parser benchmark | source spans、table normalization、document-processing threat model、future document tool-surface selection eval | parser unit/contract tests、benchmark corpus、unsafe URL drop、title/date heuristics、cross-client surface A/B/C |
| Diagnostics/quota | 已有 provider capabilities、balance、quota、local budget status | durable ledger 評估、provider economics docs automation | capability registry parity、secret redaction、local-vs-billing wording |
| Security/privacy | 已有 SSRF/DNS/redirect/private range、auth、secret redaction tests | outbound policy guidance、retention policy、production smoke | regression tests、no raw provider payloads、README/docs sync |
| Cloudflare reference deployment | 已有 Worker ingress、OAuth/KV 與 named Container runtime | D1 managed-token registry；Browser Run adapter evaluation；其他 stateful slice 才逐項引入 Workflow/DO/R2/Queue 或擴大 D1 responsibility | core 不依賴 live bindings、credential fail-closed/revoke consistency、cross-runtime policy parity、idempotency、artifact retention/deletion |
| Managed Groundlane Cloud | 已確認為商業化 roadmap；計費採 Hybrid，技術交付順序為 BYOK first，但個人方案正式公開時需同時有 hard-capped Managed Starter；目前尚無 hosted runtime、帳號系統或 billing | 在 OSS contracts 穩定後設計 tenant-aware managed control plane、BYOK onboarding、no-card bounded trial、固定月費 Solo BYOK、月費含 managed allowance 的 Solo Managed、usage/billing 與 operations | tenant/secret isolation、各資金來源 cost attribution、trial/managed hard cap、禁止 silent funding switch、data lifecycle/residency、abuse controls、SLO/support、OSS portability |
| Open-source references | 已分 primary/watchlist/discovery，並補上 GitHub 外部 discovery source | 定期重查 stars/activity/license/security posture/source availability/catalog drift | official repo verification、license/dependency review、bounded fixture before adoption |

### Phase 0：已完成 baseline

- Remote MCP：Streamable HTTP MCP、authentication、OAuth discovery flow、health/readiness 與 Worker/Container routing 已有 deterministic tests。
- Retrieval：`web_fetch` 支援 HTTP-first、Reader fallback、browser fallback、selector/wait control、single deadline、byte/output bounds 與 URL policy。
- Search/provider adapters：`web_search`、`web_answer`、`web_research`、`web_content`、`web_map`、`web_crawl`、`web_news`、`web_images` 已有 fake-based provider mapping 與 router tests。
- Extraction/parser：`web_extract` 已有 selector 與 bounded pattern engines；`parse` 已有 HTML document/metadata/links/media/tables parser。
- Diagnostics：`provider_balance`、`provider_capabilities`、`provider_quota`、`search_budget_status` 已暴露 provider capability、account-balance 與 local budget views。
- Benchmarks/fixtures：Reader benchmark、parser benchmark、extractor fixtures 已納入 repo，可在本機重跑或由 CI 驗證。

### Phase 1：Contract、release 與 reference deployment hardening

- Single-tenant multi-credential authentication：不新增 multi-static-secret registry；先定義 `AuthenticatedPrincipal`、互斥的 `local_static`/`worker_internal_context` modes 與 Worker→Container signed context。`GROUNDLANE_AUTH_TOKEN` 保留為 legacy/local/backward-compatible data-plane credential，新增 admin-only `GROUNDLANE_ADMIN_TOKEN`；再以 D1 實作 `/admin/credentials` 與 managed token create/list metadata/rotate/revoke/expire，並提供只包裝該 API、不直接讀寫 D1 的 `groundlane credentials` CLI。Planned rotation建立新 credential lineage、預設 overlap 1 小時且上限24小時；emergency revoke立即生效，expiry由request-time server clock判斷，不新增scheduler。OAuth 繼續服務互動 client並映射到相同 principal；KV 不作 managed-token revoke truth，但既有 OAuth/KV eventual revocation boundary 必須揭露。D1 read consistency、transaction race、storage failure與secret redaction必須有 deterministic tests及 controlled smoke。
- 工具 contract versioning：定義 breaking-change policy、schema snapshot、error-code stability 與 release note 格式；optional、backward-compatible 的 `web_search.providerDetails[]` provenance schema 已核准，Phase 1 剩餘工作是納入 contract versioning、schema snapshot 與 deterministic contract tests，並在 operator-hosted bridge 啟用前完成驗證。
- Provider registry refactor：將現有 provider catalog、composition、capability-specific IDs、tool provider schemas、routing order/budgets 與 diagnostics 收斂到一個 runtime registry；先只註冊既有 built-ins，以 schema snapshots 與 router/diagnostics tests 證明外部行為不變。此項完成不代表已支援 custom provider。
- Compatibility fixtures：擴充 `web_fetch`、`web_extract`、`parse`、provider routers 的 fixture corpus，覆蓋 multilingual pages、bad HTML、large pages、table-heavy pages、login/challenge detection 與 provider malformed responses。
- Benchmark artifacts：將 parser/extractor benchmark output 保存到 `docs/research/artifacts/`，每次 engine 調整需更新 method 或 artifact。
- README/docs sync gate：把 README/README.zh-TW/PRD/config/deployment 的同步檢查寫進 release checklist 或 test。
- Controlled deployment smoke：在 operator-owned Cloudflare account 驗證 auth、fetch、extract、parse、provider diagnostics、Container unavailable/cold-start 與 browser disabled/enabled paths；本機 build 或 Wrangler dry-run 不等於 production evidence。

### Phase 2：既有 lifecycle gap、browser diagnostics 與 client compatibility

- Durable crawl contract：在現有 provider-backed `web_map`/`web_crawl` 之外，先定義 provider-neutral create/status/result/cancel、ownership、expiry、pagination、partial results、depth、dedupe、robots、concurrency、deadline、upstream cancel 與 per-site/page/byte budget；第一版代理 provider-owned jobs，不承諾 crawler fleet，batch crawl 必須 opt-in。
- MCP Tasks compatibility spike 與 conditional provider slice：以目前 SDK 建立最小 experimental task fixture，對 target clients 驗證 negotiation、create、poll、result、cancel 與斷線續查，保存可重跑 support matrix。短 research 維持同步；若 client support gate 通過，Phase 2 立即以一個 provider-owned task 實作第一個 async research slice，補齊 ownership、expiry、status/result、cancel capability、credential binding 與 billing provenance；若支援不足，才設計相容性的 start/status/result/cancel tools。
- Browser diagnostics：擴充 `render=auto|never|always` 的 decision telemetry、wait strategy、browser time budget、subresource policy 與 challenge boundary。Login wall、MFA/step-up 與 managed challenge 應回穩定、可追蹤的 `login_required`、`reauthentication_required` 或 `challenge_required` 類別，不自動注入 credential/cookie，也不宣稱繞過。Diagnostics 預設只回 bounded metadata；screenshot、snapshot、trace、HAR 必須 explicit opt-in 並有 provenance、redaction 與 retention policy，不開 persistent profile。
- Cloudflare Browser Run adapter evaluation：Phase 2 只評估 rendered fetch、screenshot 與 provider-owned crawl lifecycle mapping，和 Container local browser 使用同一 URL/deadline/error/provenance contract；先以 controlled fixtures 比較成功率、latency、browser time、output bounds 與失敗語意，再決定是否進 production routing。Structured extraction 留在 Phase 3 provider-backed schema extraction gate。
- Operational telemetry：只記 metadata，不記 secrets、authorization headers、cookies、response bodies、完整 query 或 provider raw error payload。

### Phase 3：Extractor 與 parser 品質擴充

- Schema extraction layer：在 selector/pattern 抽出的 raw values 上做 deterministic validation/normalization，支援 string、number、boolean、url、date 與 array；回傳 invalidFields，不靜默轉空值。
- `benchmark:extractor`：把 selector、pattern、schema fixtures 轉成 machine-readable metrics，追蹤 field accuracy、missing/invalid correctness、latency 與 output size。
- Parser engines：擴大 HTML parser corpus，補 metadata/title/date、table normalization、source spans、link/media classification；新 engine 必須有 adapter boundary 與 benchmark comparison。
- Document processing 是完整產品能力線，不限於 text PDF、DOCX 或 spreadsheet。目標 scope 包含 OOXML 與 legacy Office、ODF/RTF、CSV/JSON/XML/HTML、EPUB/email、text/scanned/complex-layout PDF、images、audio，以及其中的 tables、spreadsheets、formulas、figures、metadata、citations 與 source references；每個 input kind 只有在對應 contract/fixture gate 通過後才能標示 supported，不承諾「任何檔案」或完美還原，也不隱含 corpus enrollment。
- Document tool-surface selection eval：在不改 backend behavior 的 fake-based harness 中，比較 unified、intent-family 與 deferred hybrid 三種候選；至少覆蓋 PDF、scanned PDF、DOCX、XLSX、HTML、image，以及正文、table、schema extraction、OCR、large output、async、cancel、out-of-scope 與 clarification tasks。以 Claude、Codex、Cursor 等 target clients 重複採樣，分開報 selection recall、conditional choice 與 end-to-end task success；eval 完成前不承諾 `document_process` 或 specialist names 為 stable contract。
- Document routing 採三層架構：結構已存在的格式走 **conversion**；有文字但語義結構需由規則還原的文件走 **deterministic extraction**；掃描、複雜版面、公式或視覺結構才走 explicit **model-assisted parsing**。Preflight classification 與 caller policy 決定 engine；unsupported、empty、partial、malformed 與 escalation reason 必須可見，不能 hidden fallback 到 OCR/VLM。
- 三層都使用同一 normalized document envelope 與 provenance family，但能力需分開宣告：document blocks、tables/spreadsheets、assets、formula/layout、scholarly citations、OCR/transcription 與 confidence 不用單一 `document parsing` boolean 混成一項支援。
- Canonical document envelope 是 authoritative product contract；JSON 只是第一版 wire serialization，provider raw JSON 留在 adapter boundary。Cache 重用 canonical content core，source-bound `documentId`／provenance 依本次 binding 重建。Markdown 是預設 agent-facing projection，text/structured/all 為 caller options；每個 projection 都需 version、lossiness/omissions 與 canonical block/source references，任何超限 document output 改回 typed result `ArtifactRef`。現有 HTML `parse` 保持相容，新的 file/document family 先採此 contract。
- Document execution 採明確雙軌：第一個交付 slice 先提供能在單一 deadline 內完成的 bounded deterministic synchronous processing；async 的第一個可交付 slice 只代理 provider-owned long-running document jobs。兩軌共用 canonical envelope 與 policy，不 silent escalation；Phase 2 MCP Tasks spike 先驗證 target-client lifecycle，支援不足才採 explicit start/status/result/cancel compatibility tools。Groundlane-owned 大型 OCR、layout/VLM、audio 或其他 long-running execution 仍需另過 durable-orchestration、volume、cost 與 isolation gate，再選 Workflow/Queue 或其他可替換 execution adapter；雙軌 contract 不代表這些本機長任務已核准實作。
- Document source contract 採 tagged hybrid：小型內容可用 bounded inline bytes、公開文件可用受既有 URL policy 保護的 HTTP(S) URL、大型或私人文件使用 Groundlane-issued opaque `ArtifactRef`。Cloudflare reference flow 由 MCP 建立 provisional upload intent，upload-capable client／Groundlane CLI／dashboard 以短效 presigned PUT 直傳 R2 staging object，Groundlane 驗證並 immutable finalization 後才 mint `ArtifactRef` 供 processing；self-host 可替換 filesystem/S3-compatible artifact adapter。Caller 會看到短效 R2 transfer URL/staging path，但不能自行指定 storage coordinate，且 remote MCP 不接受 caller local path。
- DocumentSource contract 與 Cloudflare R2 reference adapter 均已列入 document-processing roadmap，但仍未實作；large/private document upload 的已核准需求構成 R2 adapter 的專屬 adoption gate，不因此核准 R2 承擔 corpus truth、state machine 或其他 stateful responsibilities。
- Artifact retention 與 processing cache 採 tiered defaults：upload intent 15 分鐘、staging cleanup window 一小時、transient `ArtifactRef` 24 小時、processing cache 24 小時；caller 可在 deployment-advertised bounds 內調整，operator 可改 defaults/max 或停用 cache。Corpus enrollment 預設保留到 explicit remove/delete，也可由 corpus/source policy 設 expiry。這些是 roadmap working defaults，需在實作前以成本、cleanup reliability、target-client retry 與 privacy fixtures 驗證。
- 在加入任一 file engine 前，先定義各 `DocumentSource` kind、upload/artifact lifecycle、MIME sniffing、encrypted/macro/archive/embedded-object behavior、page/sheet/slide/byte/time/memory/concurrency limits、sandbox/temp-file/network policy、cancellation、model artifact/license policy、source hash/spans、confidence 與 engine/version/cost provenance。再以相同 machine-readable corpus 評估 MarkItDown、anydoc、Pandoc、Mammoth、SheetJS、Apache POI、Docling、Unstructured、GROBID、pdf.js、pdfminer.six、PaddleOCR、RapidOCR、EasyOCR、docTR、Surya、Layout Parser、OLMOCR、OCRmyPDF、Apache Tika、PyMuPDF、pdfplumber、pypdf、Camelot、Tabula 及後續 adapters。
- 交付採分階段、完整 scope 不縮水：先建立 input envelope、classification 與跨層 fixtures，再逐一加入 deterministic conversion/extraction adapters，接著加入明確 opt-in 的 OCR/layout/model engines；spreadsheet/table、scholarly citation、formula/figure、audio/image 等 capability 可以各自達成 production gate，不必等所有格式同時完成。
- Provider-backed schema extraction：只先評估單一已知 URL、caller-provided bounded schema 的 explicit operation；Groundlane 必須本機驗證 provider output，保留 missing/invalid fields、provider/model/source/billing provenance 與 warning sanitization，不得從 deterministic extractor 自動 fallback。

### Phase 4：Search ownership 與 provider depth

- Search aggregation：補 query planning、provider capability matrix、freshness policy、vertical routing、host diversity 與 result-quality diagnostics；不自建全網 index。
- Search ownership contract：維持 `web_search` 為 public Web provider routing；定義 build/deploy-time operator-hosted public metasearch adapter requirements，以及獨立 corpus lifecycle／scoped-search tool family 的 corpus identity、source kind、source manifest、ACL、enrollment/index-sync state、freshness、retention/deletion、tenant isolation、citation/backend provenance、backend migration 與 evaluation gate。Groundlane 擁有這套 control-plane contract，但此階段不承諾建立 runtime surface、index 或 ranking engine。
- Operator-hosted search slice：registry parity gate 通過後，才實作 search-only `groundlane-provider-v1` generic HTTP adapter、strict deploy-time manifest 與一個 local fake provider。Cloudflare reference deployment 第一版只走 allowlisted public HTTPS；不增加 arbitrary caller endpoint、runtime npm plugin 或 Service Binding bridge。
- Stateless change comparison：評估由 caller 同時提供 baseline/current 的 bounded deterministic diff，回傳 normalization method version、changed fields 與 truncation；不在此階段加入 scheduler、notification 或 snapshot retention。
- Provider economics：把 account balance、free tier eligibility、one-time credits、monthly pools、PAYG/top-up、local budgets 分開記錄；任何自動路由不得隱含啟用 PAYG。

### Phase 5：獨立 stateful resources（逐項 demand gate）

- Cited synthesis：目前維持 provider-separated output，由 caller／上層 agent 比較、裁決與寫作；Groundlane 只先做 deterministic citation/URL dedupe 與 evidence aggregation。只有 usage evidence 與 claim-level citation eval corpus 成立後，才評估獨立、explicit opt-in 的 synthesis tool。
- Provider monitoring 與 scheduled research/alerts：它們是有 ownership、retention、notification、webhook security、abuse 與 spend boundary 的 stateful resources；需求成立後另設 tool family 與 durable orchestration，不放入 Container memory，也不塞進 `web_search` 或 `web_research`。
- Authenticated/stateful browser sessions：保留 long-term roadmap，不併入 stateless `web_fetch`。若 target-site usage evidence 通過 demand gate，第一個 slice 優先串接 provider-owned opaque `profileId`/`contextId`，由使用者透過短效 live view 完成 login/MFA；Groundlane 只保存 owner、provider、opaque reference、site/account binding、TTL 與 provenance。第一版限 allowlisted domain、read-only bounded navigation、單一 exclusive lease，並具 explicit release/delete、orphan cleanup、audit、reauthentication/challenge handoff、quota/billing 與 deterministic isolation tests；不保存 raw password、TOTP/passkey 或可匯出的 cookie/profile，不提供購買、刪除、發文等通用 action，也不承諾 CAPTCHA bypass。Cloudflare Browser Run 可先評估 short-lived execution/reconnect；跨 session durable profile vault 若需以 R2/DO/D1 自建，視為另一個獨立 demand gate，不因採用 Cloudflare stack 自動核准。
- Generic semantic/LLM extraction：schema-less、multi-page/agentic、Groundlane-owned model inference 或 automatic deterministic-to-LLM fallback 全部延後；若未來實作，必須使用獨立 explicit contract 與 demand/eval gate。
- Groundlane-owned durable orchestration：只有 provider-owned tasks 無法滿足 replay/retry/aggregate lifecycle 且具實際需求時才實作。第 6.5 節的 Cloudflare 元件責任表是 candidate mapping，不代表整套元件已核准；每次只加入解決當下 lifecycle、query、artifact 或 coordination gap 的最小 primitive。所有 provider credits、browser time、storage/operation units 與 runtime cost 必須分開，retry path 必須具 idempotency 與 billing provenance。
- Durable usage ledger：只有需要跨 Container instance 合併 quota/usage 時才設計；在此之前所有 attempt counters 都保持 instance-local 並清楚標示，D1 或 Durable Objects 的選擇需由 query pattern、atomicity 與 hot-key 測試決定。
- Groundlane-owned corpus lifecycle：operator-owned knowledge access 與 corpus control-plane ownership 已確認屬於 Groundlane 的產品方向，working surface 包含 corpus create/enroll/update/remove/status/delete 與 `corpus_search`，但不代表 runtime implementation 已核准。Groundlane 負責 corpus identity、source manifest、ACL、enrollment/index-sync state、freshness、retention/deletion、tenant isolation、citation 與 backend provenance contract；Cloudflare AI Search、Vectorize、外部 provider 或自架 index 只作可替換 backend adapter，不得接管 public contract，也不改變 public Web `web_search` 的語意。只有具體需求、evaluation corpus、backend portability/deletion proof 與 isolation gates 成立後才實作第一個 adapter-backed slice；Groundlane-native index/ranking engine 需另立需求與品質 gate，不隨 control plane 自動納入。

### Phase 6：Managed Groundlane Cloud（商業化 roadmap）

Managed Groundlane Cloud 已確認進入 roadmap，服務不想自行部署、管理 Cloudflare resources 或維護 provider integrations 的 platform operator 與 agent developer。它使用和 OSS 相同的 MCP tool contracts、provider-neutral errors 與 provenance；不得以 hosted-only schema、封閉 provider ID 或不可匯出的設定製造 lock-in。

發布順序為 **OSS V1 Stable Release → Cloud Internal Alpha → Invite-only Beta → Managed Cloud Public Launch**。Internal Alpha 先以 project-owned clients dogfood hosted endpoint；Invite-only Beta 納入少量個人 AI-tool users 與小型團隊，取得首次連線、provider 成本、常用能力與 support load 的真實證據。Managed Cloud Public Launch 與免綁卡 trial 只有在 tenant/secret isolation、allowance hard stop、abuse/rate-limit controls、Claude/Codex/Cursor compatibility、provider cost attribution、token revoke、project deletion 與基本 incident handling 通過 release gate 後才開放。

#### 初始付費客群與使用角色

Managed Cloud 的初始客群分成兩個並列入口，不把個人使用者降為團隊產品的附帶 sandbox：

| 客群 | 主要需求 | Groundlane Cloud 的第一個價值 |
| --- | --- | --- |
| 個人 AI-tool user／agent developer | 會操作 AI 工具，但不熟部署、Cloudflare、provider 設定或維運；希望快速把 Web 能力接進現有工具 | 自助註冊後直接取得 hosted MCP endpoint 與 client token；提供可複製的連線設定、用途導向 presets、明確額度與安全預設，不要求先理解 Groundlane infrastructure |
| 小型 AI／platform team | 需要讓多個 agent/client 共用受控 Web access，又不想自行維護 runtime 與 provider integrations | platform operator 作為 buyer/admin，管理 project、credentials、routing、budgets 與 usage；agent developer 作為日常 user，只依穩定契約接入工具 |

大型 enterprise 的 SSO/SCIM、複雜 RBAC、private networking、data residency、採購與客製 SLA 保留為後續擴張，不作為初始 launch blocker。

#### 個人 onboarding 與團隊升級

- 個人註冊完成後自動取得 `Personal Workspace` 與 `Default Project`，不要求先建立 organization、選 environment、理解 tenant model 或設定 Cloudflare resources。
- Default Project 立即提供 hosted MCP endpoint 與一組可撤銷 client token；onboarding 先讓使用者選擇 Claude、Codex、Cursor 或其他 target client，再提供可複製的 secret-safe 設定、token 保存提醒與連線測試。
- 第一次成功路徑使用 bounded managed trial 完成至少一次 search 或 fetch，並顯示實際 provider/engine、remaining allowance 與下一步。Provider keys、routing、budgets、billing 與進階 policy 在首次連線後再逐步揭露。
- 個人主介面優先呈現 `Connect AI Tool`、`Web Usage`、`Provider Setup`、`Tokens` 與 `Billing`；organization、environment、cross-project policy、audit 等管理概念放入 Advanced 或團隊升級流程，不阻擋首次使用。
- Personal Workspace 可原地升級為 Organization，保留 project、endpoint、tokens、provider settings、policies 與可攜 metadata；升級後才加入成員邀請、roles、additional tokens 與 team governance，不要求重新設定既有 AI clients。
- Public endpoint 與 data-plane identity 綁定不可變 project identifier，不綁 mutable workspace/project display name。Workspace 改名、personal-to-organization conversion 或 billing-plan change 不得改變 endpoint；只有明確 project migration/deletion 才能走受控 replacement lifecycle。

#### 最小 Cloud launch slice

- Launch surface 以 hosted Remote MCP endpoint 為主要產品入口、Web dashboard 為管理入口；Claude、Codex、Cursor 是首批正式 compatibility targets，其他支援 remote MCP 的 clients 採 best-effort compatibility。
- Launch 不建立獨立 AI chat client、desktop app、browser extension、多語言 SDK 或通用 public REST data API。Control-plane API 只支撐 dashboard 與未來 CLI；若後續啟用 document capability，可由 MCP 建立 scoped upload intent，讓相容 client／CLI／dashboard 以短效 presigned PUT 直接上傳 R2。這是 bounded document-ingress data path，不提供通用 object listing/download 或 REST tool parity，也不是 Cloud minimum launch requirement；啟用前需保存 target-client upload handoff compatibility matrix。
- 個人使用者可建立一個 project，立即取得 hosted MCP endpoint 與可撤銷 client token；介面提供 Claude、Codex、Cursor 等 target clients 的可複製設定與連線檢查，不要求使用者自行部署 Worker/Container。
- Onboarding 以「想讓 AI 搜尋、讀頁或抽資料」等用途選擇 presets，再展開 provider、routing 與 budget 細節；安全上限、失敗原因與費用來源仍須可見，不以簡化 UI 隱藏 provenance 或資金來源。
- 小型團隊支援 organization/project、至少兩種角色邊界（admin/operator 與 developer/member）、多個可獨立撤銷的 Groundlane client tokens、BYOK provider secret custody、routing 與 hard budgets。
- Dashboard 提供 usage、failure、實際 engine/provider provenance 與 billing-source attribution；預設不保存完整 query、response body 或 secrets。
- Hosted MCP endpoint 是主要 data-plane 入口；管理介面與 API 共用相同 control-plane contracts，日後 CLI 只能作 automation wrapper，不能成為非工程使用者完成 onboarding 的前提。
- 個人 onboarding 提供免綁卡 trial，並同時受有效期限與用量 hard cap 約束；額度用完即停止，不自動扣款、續用或切換資金來源。
- 付費個人方案提供兩條固定月費路徑：`Solo BYOK` 收取較低的平台/runtime 月費，由使用者自備 provider credentials；`Solo Managed` 月費包含每期 managed usage allowance 與不可超出的 currency hard cap，不提供無上限 PAYG。
- BYOK-first 是技術交付順序，不是個人方案唯一的 commercial launch path。面向不熟 provider 設定的個人客群正式公開時，必須已有可付費的 hard-capped Managed Starter；trial、BYOK 與 Managed 之間只能由使用者明確切換。
- 個人 dashboard 優先以可理解的工作量單位呈現剩餘用量，例如可用搜尋、讀頁或 browser capacity；同時保留實際 requests、credits、provider、runtime units 與 billing-source 明細，避免用簡化數字混淆不同成本。

#### Plan capability boundary

- `Solo BYOK` 與 `Solo Managed` 對所有已穩定 capability 使用相同 MCP tools、schemas、stable errors、citations/provenance、安全政策與 output-quality contract。不得把較好的搜尋結果、完整 citations、SSRF/deadline/cancellation protections 或必要 diagnostics 作為 Managed-only upgrade。
- 兩個 Solo 方案的差異只來自 funding、onboarding 與 capacity：BYOK 由使用者設定並支付 provider；Managed 由 Groundlane 提供 preset routing、secret custody 與 managed provider capacity。實際 provider coverage 或結果可能因使用者配置與 provider availability 不同，但不能由 Groundlane 人工降低 BYOK 的 tool contract 或結果品質。
- Free Trial 必須足以完成 `web_search`、`web_fetch`、`web_extract` 與 `parse` 的首次端到端驗證，並保留正常 provenance、安全與錯誤語意。Research、crawl、browser 等高成本能力可使用較小 allowance、result/page bounds、browser time 與 concurrency；若某項能力不在 trial，onboarding 必須在執行前明示，不能以模糊錯誤假裝 provider failure。
- 未來 team plan 的付費價值集中在 organization/projects、多成員、角色與 token 管理、集中 policy/budget、跨 project usage/audit、identity/network/data controls、SLO 與 support，不用更好的公開 Web 結果製造升級壓力。

#### Managed provider experience

- `Solo Managed` 採 preset-first automatic routing：一般使用者選擇快速、平衡、深入等用途，不必先理解或選擇 provider；每次結果仍揭露實際 provider、engine、fallback path 與 funding source。
- Advanced 設定可鎖定或排除 provider。Managed launch 只納入已通過 capability、品質、成本與失敗語意驗證的 curated provider pool，不承諾每個 OSS adapter 都有 Groundlane-paid capacity。
- `Solo BYOK` 可使用該 project 已設定且 Groundlane 支援的 providers。Managed routing 只能在同一 managed funding pool 內 fallback；provider 不可用時不得偷偷切換到 BYOK、trial 或其他資金來源。

#### Usage metering 與額度呈現

- Groundlane 不發行或販售自有虛擬 `Groundlane Credits`。不同 provider 的 request、成功請求、result/page multiplier、credits、currency、tokens、browser time、bandwidth、storage、concurrency 與 operation units 不得未經驗證互換。
- Billing truth 使用真實貨幣與原生 meter：每次執行至少保存 funding source、Groundlane platform/runtime meter、provider-native meter、可取得的實際 charge/balance、engine/provider provenance 與 rate-card version；估算值和已確認帳務值必須分欄。
- 個人介面可以依目前 preset 與 rate card 顯示「約可再完成幾次一般搜尋、讀頁、研究或多少 browser time」，但必須標示為 estimate、計算時間與主要假設；provider 調價或工作內容改變時可更新，不把估算寫成 entitlement。
- `Solo Managed` 以訂閱內含的月度 managed usage allowance 與 currency hard cap 作 enforcement truth；到達 hard cap 即停止，使用者只能手動升級方案。Launch 不提供 prepaid wallet、stored balance、rollover、add-on packs、silent overage、無上限 PAYG 或 automatic top-up。
- `Solo BYOK` 只對 Groundlane platform/runtime 設定可保證的 hard cap。Provider 原生費用由使用者的 provider 帳號收取；Groundlane 可顯示 local attempts、provider diagnostics 與官方 API 可取得的 balance，但不得宣稱這些等於 provider 最終 bill 或能完全阻止 provider-side overage。
- Trial、Solo BYOK 與 Solo Managed 使用不同 ledger/funding-source state；未用完或已用完的 allowance 不自動轉換、合併或 rollover。任何方案或資金來源切換皆由使用者明確確認。
- Prepaid wallet 與手動 add-on packs 延後到已觀察實際用量分布、退款需求、付款失敗及會計處理後再評估；若未來加入，必須明定購買確認、有效期限、退款、餘額查詢、hard cap 與不得自動續購。

商業邊界採 **contract parity，不要求 operational feature parity**：OSS 與 Cloud 對相同 capability 使用相同 tool schema、stable errors、provider IDs、security semantics 與 provenance；Cloud 可以額外提供 multi-tenant control plane、managed capacity、organization governance 與服務保證。Groundlane 維持 Apache-2.0；本 roadmap 不採 SSPL/FSL/source-available 方式限制第三方商業使用。若未來有具體 competing-host free-riding 證據，license 或商標政策必須另開相容性、社群與 migration 決策，不能作為 pricing toggle。

#### OSS core 保證

- Provider-neutral MCP tools、schemas、stable errors、provenance，以及 built-in/operator-hosted adapter interfaces 保持 OSS；Cloud 新增 capability 時，若它是通用 data-plane primitive，也必須先有 provider-neutral public contract。
- URL/SSRF、redirect/DNS、deadline/cancellation、output bounds、secret non-disclosure、sanitized errors 與安全修復不得成為付費牆。
- Self-hosted Groundlane 不需要 Groundlane Cloud 帳號、license server、activation check 或 mandatory phone-home；Cloud dashboard 不得成為 authentication、provider routing、安全修復或核心 diagnostics 的 runtime dependency。
- 未來若加入 telemetry，必須預設關閉、由 operator 明確 opt in，並公開收集欄位與 retention。Update check 必須可關閉，且無法連線官方服務時不得影響 data plane。
- 單一 operator 的 authentication/credential lifecycle、provider routing/budgets、diagnostics、Cloudflare reference deployment、fixtures、benchmarks 與可攜 config/artifact formats 維持可獨立運作；不得用 artificial concurrency/volume limit 故意讓 OSS 失去 production 能力，實際容量由 operator infrastructure 與 provider quotas 決定。
- Managed Cloud、self-host 與未來 private deployment 應能沿用相同 client integration；export/import 不必搬移不可匯出的 secrets 或 vendor-native derived index，但 policy、provider manifest、corpus manifest、source identity/hash、ACL/retention policy、bounded metadata 與 lifecycle/citation provenance format 應可攜。把 OSS config 匯入 Cloud 是 optional migration path，不是 self-host 使用條件。

#### Paid managed operations 與 enterprise value

- 免部署、升級、health monitoring、backup/recovery、incident handling，以及 managed browser/provider/proxy capacity。
- Organization/project/environment、team RBAC、SSO/SCIM、central secrets、cross-project policy 與 tenant isolation。
- 長期 audit/retention/export、compliance evidence、data residency、dedicated region、private networking 或 supported private deployment。
- SLO、priority support、onboarding、migration assistance 與 managed provider allowance。這些差異來自實際營運與組織責任，不改變 core tool contract。

- Managed control plane：建立 organization/project/environment ownership、tenant-aware principal、credential lifecycle、roles 與 metadata-only audit；V1 的 single-operator `owner` 不能直接冒充 multi-tenant isolation 已完成。
- Tenant isolation：provider secrets、requests、artifacts、browser/corpus state、logs、budgets 與 admin operations 必須按 tenant/project fail closed 隔離，並以 deterministic cross-tenant tests 和 controlled deployment smoke 驗證。
- Provider 與計費模式：採 Hybrid roadmap，技術實作先完成 BYOK，但個人方案 commercial launch 必須同時具備 no-card bounded trial、固定月費 `Solo BYOK` 與月費含 managed usage allowance 的 hard-capped `Solo Managed`。Trial 同時受期限與用量限制；Solo Managed 當期 allowance 用完即停止，只能手動升級。Launch 不提供 prepaid wallet、rollover、add-on packs、無上限 PAYG 或 automatic top-up。Groundlane 不建立自有 credits；每次執行明確區分 trial allowance、BYOK provider usage、Groundlane-managed usage、Groundlane platform usage 與 Cloudflare/runtime cost，並將 requests、successful requests、credits、currency、tokens、browser time、bandwidth、storage、concurrency 與 operation units 分開記錄。不得在 trial、BYOK 與 Managed 間自動切換；任何 funding source change 都必須由使用者明確操作並受 hard stop。
- Data lifecycle：在 launch 前定義資料區域、retention、deletion/export、backup/recovery、subprocessor 與 incident handling；tool output 預設仍保持最小保存，不能因 hosted deployment 就自動保存 query 或 response body。Document capability 使用公開的 upload-intent、transient-artifact、processing-cache 與 corpus defaults/max，UI/API 顯示 effective `expiresAt` 並允許 bounded 調整。未來啟用 corpus capability 時，project/corpus/source deletion 必須立即撤銷 access、停止 cache hit並明確傳播至 source artifacts 與 derived indexes，另揭露 physical cleanup 與 backup retention exception。
- Operations：必須具備 tenant-safe rate limit、abuse controls、cost hard stop、status/incident communication、SLO 與 support boundary；本機 tests、Wrangler deploy 或單一內部帳號 smoke 不構成 multi-tenant production evidence。
- OSS portability：deployment config、provider manifest、policy 與可匯出 metadata 應維持可攜；Managed Cloud 可以提供更低維運成本，但不能成為核心 tool contract 或安全修復的唯一取得方式。

Phase 6 是已核准的產品與商業化方向；個人 AI-tool user 與小型 AI／platform team 是初始客群，hosted Remote MCP + Web dashboard 是 launch surface，Claude、Codex、Cursor 是首批 compatibility targets。Automatic Personal Workspace/Default Project、first-success onboarding、stable project endpoint、preset-first transparent routing，以及以上 token、usage/provenance 與團隊管理構成 working minimum launch slice；`corpus_search` 與 corpus lifecycle 不是 Cloud minimum launch requirement，仍依 Phase 5 gate 獨立驗收。Hybrid billing、BYOK-first 技術順序、Solo capability parity，以及 commercial launch 同時提供 no-card trial、固定月費 Solo BYOK 與月費含 allowance 的 hard-capped Solo Managed 已確認；Cloud 依 Internal Alpha、Invite-only Beta、Managed Cloud Public Launch 漸進發布，prepaid wallet、rollover 與 add-on packs 不進 launch scope。但 launch date、price points、SLA、trial/plan 額度與每項 hosted capability 尚未確定。進入 implementation 前仍需核准 tenant model、billing meters/rates、data handling policy 與 Managed Starter 的 provider capacity economics，並把 working slice 拆成可驗收 milestone。

## 13. English glossary

| Term | Groundlane 中的意義 |
| --- | --- |
| trusted content access layer | Groundlane 的整體產品定位：以統一 contract 取得、解析並追蹤 Web 與文件內容；目前 runtime 以 Web/HTML 為主，file/document processing 依 roadmap 逐項加入 |
| document processing | 將 URL、HTML 或 file 轉成 bounded normalized document/artifact；不自動建立 durable `ArtifactRef`、corpus membership 或 index，但未來 file/document family 可依公開 policy 使用 bounded transient artifact 與 processing cache |
| canonical document envelope | Groundlane versioned、provider-neutral 的 authoritative document model；由 reusable canonical content core 與 per-source/invocation binding 組成，包含 source-bound `documentId`、`canonicalContentId`、ordered stable blocks、typed tables/assets/formulas/citations、capability states、source spans、warnings/errors 與 engine/model provenance，第一版以 JSON serialization 傳輸 |
| projection | 從 canonical envelope 產生的 versioned agent/user-facing view，例如 Markdown 或 text；必須揭露 `lossy`、omissions 與 source document reference，不能成為 canonical truth |
| `DocumentSource` | Document-processing input 的 tagged contract；可為 bounded inline bytes、經 URL policy 驗證的 public HTTP(S) URL，或 Groundlane-issued `ArtifactRef`，不接受 portable caller local path |
| upload intent | 由 MCP control operation 建立、綁定 portable ownership scope、declared MIME/size、optional expected digest、single staging object/PUT 與短效期限的 provisional 上傳授權；不是 verified artifact，Cloudflare reference implementation 回傳 presigned R2 PUT URL |
| `ArtifactRef` | Complete/verify/immutable-finalize 後才 mint 的 Groundlane-issued、storage-neutral、opaque artifact identity；綁定 ownership scope、content hash、size、retention/deletion 與 verified status，不等於 upload intent、R2 key、filesystem path 或 presigned URL |
| processing cache | 由 content-addressed reusable parsed payload、per-source provenance binding 與 live-reference set 組成的 ownership-scoped bounded cache；有公開 default/effective expiry、mode、cache provenance 與 invalidation，不等於 Web response cache 或永久 artifact storage |
| retention default | 未提供 expiry 時使用的 deployment policy；working defaults 為 upload intent 15 分鐘、transient artifact 24 小時、processing cache 24 小時，caller可在 operator公告 bounds內調整 |
| corpus | 由 operator 擁有、具有 stable Groundlane identity、source manifest、ACL、freshness、retention/deletion 與 provenance 的 bounded content collection |
| corpus enrollment | caller 明確要求將 normalized document/artifact 註冊為 corpus source membership，並觸發 backend index sync；不同於 document processing |
| corpus lifecycle | Groundlane 擁有的 create/enroll/update/remove/status/search/delete contract 與 identity、ACL、retention、deletion、citation/backend provenance semantics |
| index backend / derived index | 可替換的 indexing/query/ranking 執行層；其 index 可由 corpus manifest 重建，不擁有 public corpus identity、ACL、retention 或 deletion truth |
| web access control plane | agent 與多種 Web/search/browser providers 間的統一政策、routing 與 provenance 層 |
| control plane | authentication、routing、policy、limits 與 orchestration 所在層 |
| `AuthenticatedPrincipal` | Groundlane 驗證 credential 後得到的 provider-neutral caller identity；V1 內建值為單一 operator `owner`，不由 caller 自行宣告，也不代表 user/tenant isolation |
| credential | 可獨立建立、rotation、到期與撤銷的驗證材料；同一 principal 可先後持有多個 credential |
| rotation overlap | planned rotation後新舊 credential可同時有效的有界交接時間；預設1小時、可設0到24小時，不適用emergency revoke |
| admin credential | 只用於 managed credential首次建立、管理與 recovery 的獨立 operator secret；不具 MCP data-plane權限 |
| legacy data-plane credential | 既有 `GROUNDLANE_AUTH_TOKEN`；只供 local/backward-compatible MCP與既有保護路徑使用，不具 managed-credential admin權限 |
| internal principal context | Worker 驗證外部 credential 後簽發給 Container 的短效、request-bound identity context；不包含 raw client credential |
| contract parity | OSS、Managed Cloud 與 private deployment 對相同 capability 使用相同 tools、errors、provider identity、安全語意與 provenance；不代表所有代管、組織或 SLO 功能都必須出現在單一 operator OSS |
| Groundlane Browser | 僅供內部 fallback 使用的 Playwright/Chromium engine |
| deterministic extraction | 不依賴 LLM、由 DOM selector 與固定規則決定結果的抽取 |
| provider routing | 依能力、設定順序、健康狀態與錯誤類型選擇 search adapter |
| provider registry | provider manifest、runtime capability adapters、tool schema、routing、budgets 與 diagnostics 的 single source of truth |
| operator-hosted provider | operator 在 build/deploy time 註冊並營運、由 Groundlane 透過受控 adapter 呼叫的服務；不是 caller-provided endpoint |
| `groundlane-provider-v1` | 第一版 search-only normalized HTTP bridge protocol；operator service 不需要實作 MCP |
| billing truth | 可供 hard-cap enforcement 與帳務對帳的真實貨幣、provider-native meters、funding source、rate-card version 與已確認 charge；不包含只供介面理解的工作量估算 |
| usage estimate | 依 preset、rate card 與主要假設推算的剩餘搜尋／讀頁／研究／browser 工作量；不是可兌換 credit、帳單或 entitlement |
| fallback | 前一路徑發生明確、可支援原因時，使用剩餘 deadline 升級到另一路徑 |
| bounded output | 具 byte、character、result 與 field-count 上限的回應 |
| readiness | process 存活之外，對設定與依賴 capability 是否可服務的判斷 |
