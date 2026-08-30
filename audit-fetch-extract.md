# Gap Audit — web_fetch (5.2) / web_extract (5.8) / parse (5.9)

> Read-only audit. Evidence lines point to repo HEAD at audit time.

## Scope

- **PRD sections:** `docs/product/prd.md` §5.2 web_fetch, §5.8 web_extract, §5.9 parse (+ cross-cutting §6.1/6.2 referenced)
- **Implementation files:**
  - `src/tools/web-fetch.ts`
  - `src/tools/web-extract.ts`
  - `src/tools/parse.ts`
  - `src/core/fetch-pipeline.ts`
  - `src/core/normalize-document.ts`
  - `src/core/readable-document.ts`
  - `src/core/extract-fields.ts`
  - `src/core/parse-document.ts`
  - `src/core/source-aware-docs.ts`
  - `src/core/contracts.ts`
  - `src/core/limits.ts`

---

## Summary Verdict

| Area | Verdict |
|------|---------|
| web_fetch 5.2 | **Covered** with 2 minor divergences (extra `blockedSubrequests`, generic `backend` typing, undocumented source-aware expansion) |
| web_extract 5.8 | **Partially covered** — selector/pattern deterministic engines match; 1 behavioral deviation on `maxOutputChars` fetch vs extract split and truncated-vs-throw semantics |
| parse 5.9 | **Partially covered** — HTML document/metadata/links/media/tables deterministic pipeline implemented; strict PRD contract technically diverges on `maxOutputChars *2` cap, `render`/`waitFor` acceptance for raw-`html` mode, and source-aware unreachable due to hardcoded `format:html` |

---

## 1. web_fetch (PRD 5.2) — Covered vs Gaps

### 1.1 Input Fields

| PRD expectation | Implementation | Gap |
|---|---|---|
| `url` required HTTP(S) | `src/tools/web-fetch.ts:7-10` `z.url().refine(protocol http/https)` | ✅ |
| `format` `markdown|text|html` default `markdown` | `src/tools/web-fetch.ts:11` `z.enum(...).default("markdown")` | ✅ |
| `selector`,`waitFor` optional 1–500 chars | `src/tools/web-fetch.ts:12-13` `trim().min1.max500` | ✅ |
| `timeoutMs` 1k–120k, `maxBytes` 1k–20M, `maxOutputChars` 1k–500k bounded, deployment-capped | `src/tools/web-fetch.ts:14-16` + `src/tools/web-fetch.ts:68-77` `Math.min(input.* ?? options.*, options.*)` | ✅ (fixed `maxRedirects:5` not exposed as input is intentional; PRD says HTTP path must limit redirect — `src/tools/web-fetch.ts:79` hardcodes `5`) |
| `render` `auto|never|always` default `auto` | `src/tools/web-fetch.ts:14` | ✅ |

### 1.2 Output Fields

PRD expected (5.2 block lines 39-44):

```
requestedUrl, finalUrl, status, contentType, title?, description?, author?, publishedAt?, content, format,
engine(http|reader|browser), backend, cached, truncated, bytes, durationMs, warnings[], fallbackReason?
```

Implementation `src/tools/web-fetch.ts:17-33` `fetchDataSchema`:

| Field | Present | Notes |
|---|---|---|
| `requestedUrl` | ✅ `src/tools/web-fetch.ts:18,65` | |
| `finalUrl` | ✅ `src/tools/web-fetch.ts:19,66` | from `result.raw.finalUrl` |
| `status` | ✅ `src/tools/web-fetch.ts:20,67` | |
| `contentType` | ✅ `src/tools/web-fetch.ts:21,68` | |
| `title?,description?,author?,publishedAt?` | ✅ `src/tools/web-fetch.ts:22-25,69-74` optional spread | from `normalizeDocument` via `readable-document.ts` + `normalize-document.ts` |
| `content` | ✅ `src/tools/web-fetch.ts:26,75` | |
| `format` | ✅ `src/tools/web-fetch.ts:27,76` | echoes `result.format` |
| `engine` | ✅ `src/tools/web-fetch.ts:28,77` enum `http|reader|browser` (`src/core/contracts.ts:7`) | `raw.engine` |
| `backend` | ✅ `src/tools/web-fetch.ts:29,78` `z.string()` | **GAP-MINOR**: PRD requires revealing `direct|jina|local|browserless` actual source. Type is generic `string` not literal union; value correctness depends on adapter wiring (`src/core/contracts.ts:14` `backend:string`, `src/core/fetch-pipeline.ts:124-151` `readerFetch` sets `raw.backend` via `ReaderBackend`, `browserFetch` via `BrowserBackend`). No compile-time enforcement. |
| `cached` | ✅ `src/tools/web-fetch.ts:30,89` hardcoded `cached:false` | PRD MVP "cached fixed false, reserved" explicitly satisfied. |
| `truncated` | ✅ `src/tools/web-fetch.ts:31,90` from `result.truncated` (`normalize-document.ts:60-68` `truncateUnicode`) | |
| `bytes` | ✅ `src/tools/web-fetch.ts:32,91` `raw.body.byteLength` | |
| `durationMs` | ✅ `src/tools/web-fetch.ts:34,94` `Math.round(performance.now()-started)` | |
| `warnings[]` | ✅ `src/tools/web-fetch.ts:35,95` | includes truncation + login-redirect warning (`normalize-document.ts:8-22`) |
| `fallbackReason?` | ✅ `src/tools/web-fetch.ts:36,96-98` from `result.fallbackReason` | |
| `blockedSubrequests?` | ➕ EXTRA | `src/tools/web-fetch.ts:33,92-93` exposes `raw.blockedSubrequests`. **Not in PRD 5.2 output list** (only in 5.8). Harmless optional divergence; PRD `parse` output also lacks it per design, so web_fetch extra should be documented or removed for strict contract parity. |

### 1.3 Behavior Bullets

| PRD bullet | Evidence | Verdict |
|---|---|---|
| MVP `cached` fixed `false` | `src/tools/web-fetch.ts:89` | ✅ |
| HTTP path limits redirect/bytes/deadline | `src/tools/web-fetch.ts:79` `maxRedirects:5`, `src/tools/web-fetch.ts:68-73` clamping, `src/core/fetch-pipeline.ts:60` `http.fetch({maxBytes,maxRedirects,deadline})`, `src/core/limits.ts:4-18` `Deadline` | ✅ |
| `render=never` must not start browser | `src/core/fetch-pipeline.ts:45` early `if render=="always" return browserFetch`, `src/core/fetch-pipeline.ts:70` `if render!=="auto" throw` (retrieval failure path), `src/core/fetch-pipeline.ts:79-88` `if error.stage==selector && render==auto` only, `src/core/fetch-pipeline.ts:91` `if render==auto && (reason\|\|waitFor)` only | ✅ `never` never reaches `browserFetch` nor `readerFetch` (reader also gated by `canUseReader` but even if, `never` returns early on failure). |
| `render=always` direct browser but still URL policy+deadline | `src/core/fetch-pipeline.ts:45,138-151` `browserFetch` passes `url,maxBytes,deadline,selector,waitFor` + `backendBudget` check | ✅ Policy assumed in `BrowserBackend.fetch` (cross-cutting §6.1 not audited here). Line shows same `deadline`/`maxBytes` propagation. |
| `render=auto` only JS-empty, selector/wait unmet, known challenge, or HTTP unsupported | `src/core/fetch-pipeline.ts:15-28` `fallbackReason()` checks `403/429/503 + detectChallenge` (`browser-policy.ts`) and `content.trim<80 && /<script/` (js_empty), `src/core/fetch-pipeline.ts:79-88` selector-unmet branch, `src/core/fetch-pipeline.ts:91-101` `reason\|\|waitFor` branch + `readerFetch`/`browserFetch` fallback | ✅ covers enumerated conditions. **Nuance**: challenge limited to 3 status codes, not exhaustive set PRD implies. |
| Jina Reader only as markdown fallback without selector/wait; HTML/deterministic extraction must not fake via Reader | `src/core/fetch-pipeline.ts:104-112` `canUseReader = reader!==undef && format=="markdown" && selector==undef && waitFor==undef` | ✅ `web_extract` forces `format:"html"` (`src/tools/web-extract.ts:68`) so never via Reader — compliant for deterministic extraction. |
| backend reveals `direct|jina|local|browserless` | `src/core/fetch-pipeline.ts:125-136` `raw.backend` from reader (`jina`), `src/core/fetch-pipeline.ts:138-151` browser (`local`/`browserless` per config) — string passthrough | ⚠️ **PARTIAL**: values emitted but no literal enforcement in schema (see above). |
| generic 4xx not auto browser retry | `src/core/fetch-pipeline.ts:114-119` `isRetryableRetrievalFailure` only `PROVIDER_UNAVAILABLE|RATE_LIMITED|UPSTREAM_ERROR`; `fallbackReason` only for 403/429/503 challenge | ✅ 404/insufficient-content 404 path returns normalized HTML, not browser retry (Acceptance table line "render=auto 遇到普通 404 不啟動 browser" satisfied). |
| output truncation with `truncated=true` | `src/core/normalize-document.ts:60` `truncateUnicode(content,maxChars)` + warnings, `src/core/parse-document.ts:274-276` similar | ✅ |
| no-selector Markdown/text via built-in Groundlane Reader: chrome removal, relative URL resolve, bounded metadata | `src/core/readable-document.ts:10-35` `removableSelectors`, `candidateSelectors`, scoring (+P/N bonuses), `sanitizeDocumentUrls` + `absoluteHttpUrl`, `src/core/normalize-document.ts:32-48` selector-less branch uses `extractReadableDocument` | ✅ deterministic normalization without altering `raw` provenance (`raw.backend` preserved). |
| **Undocumented expansion — Source-aware docs** | `src/core/fetch-pipeline.ts:46-53` proactive `sourceResolver.resolveProactively` for `isLikelyDocumentationUrl` + `canUseSourceAwareDocs`, `src/core/fetch-pipeline.ts:65-77` `OUTPUT_LIMIT` → `resolveManifests`/`resolve` fallback, `src/core/source-aware-docs.ts:321-332` `canUseSourceAwareDocs = render!==always && !selector && !waitFor && (format==markdown\|\|text)` | ⚠️ **EXTRA beyond PRD 5.2**. Roadmap phase 3 (§12) describes `llms.txt`/`index.md` source-aware parser as future opt-in; current `FetchPipeline` adds up to N extra `http.fetch` calls (markdown candidates, `llms.txt`, sliced content) before/beside normal fetch. Not prohibited but not required by 5.2, adds network surface, deadline pressure, and divergence from " HTTP fast path first" narrative. Should be feature-flagged or documented as intentional preview. `SourceAwareDocsResolver.fetchMarkdown` correctly sets `accept: text/markdown` (`src/core/source-aware-docs.ts:405-414`). |

---

## 2. web_extract (PRD 5.8) — Partial Gaps

### 2.1 Input Fields

| PRD expectation (5.8 lines 158-173) | Implementation | Gap |
|---|---|---|
| `url` required HTTP(S) | `src/tools/web-extract.ts:15-17` | ✅ |
| `fields` named array; **selector engine** `name,selector,value(text|html|attribute)`, attribute mode `attribute`, `many` | `src/tools/web-extract.ts:7-18` `selectorFieldSchema`: `engine:selector` default, `name` regex `^[A-Za-z][A-Za-z0-9_]{0,63}$`, `selector` trim 1–500, `value` enum, `attribute` trim 1–128 optional + refine `attribute required when value==attribute`, `many` default false | ✅ name regex stricter than plain identifier (adds length 1–64, leading letter) aligns with PRD "unique". |
| **pattern engine** `name,pattern,flags(i|m|u),group,many` | `src/tools/web-extract.ts:20-25` `patternFieldSchema`: `engine:pattern` literal, `name` same regex, `pattern` 1–500, `flags` `^[imu]*$`, `group` `string(1-128)`| `number(0-100)`, `many` false | ✅ |
| total fields min1 max50 | `src/tools/web-extract.ts:27` `z.array(fieldSchema).min1.max50` | ✅ |
| shared `render,waitFor,timeoutMs,maxBytes,maxOutputChars` (no top-level `selector`/`format`) | `src/tools/web-extract.ts:28-32` has `waitFor,render,timeoutMs,maxBytes,maxOutputChars` and **no** top-level `selector`/`format` | ✅ PRD "共用 render、waitFor、timeoutMs、maxBytes 與 maxOutputChars 控制" matched. |
| `render`/`waitFor`/`timeoutMs`/`maxBytes`/`maxOutputChars` bounds | `src/tools/web-extract.ts:28-32` `waitFor 1-500`, `render auto default`, `timeout 1k-120k`, `maxBytes 1k-20M`, `maxOutputChars 1k-500k` + clamp in handler `src/tools/web-extract.ts:69-70,82-85` | ✅ |

### 2.2 Output Fields

PRD expected (5.8 block line 174):

```
requestedUrl, finalUrl, data, engine, backend, missingFields[], truncated, bytes, blockedSubrequests?, durationMs, warnings[], fallbackReason?
```

Implementation `src/tools/web-extract.ts:37-49` `extractDataSchema`:

| Field | Present | Notes |
|---|---|---|
| `requestedUrl` | ✅ | |
| `finalUrl` | ✅ from `page.raw.finalUrl` |
| `data` | ✅ `z.record(string, union(string,array(string),null))` | `null` encodes single-missing (see behavior) |
| `engine` | ✅ enum `http|reader|browser` | actual retrieval engine, not extraction engine (PRD confusingly reuses `engine` name) |
| `backend` | ✅ string | same literal-union gap as fetch |
| `missingFields` | ✅ | from `extractFields` |
| `truncated` | ✅ `page.truncated \|\| extracted.truncated` (`src/tools/web-extract.ts:100`) | but `extracted.truncated` always `false` — see behavior gap |
| `bytes` | ✅ `page.bytes` | |
| `blockedSubrequests` | ✅ optional | correct per PRD 5.8 (fetch 5.2 omits; extract includes) |
| `durationMs` | ✅ | |
| `warnings` | ✅ currently `page.warnings` only (`src/tools/web-extract.ts:104`) — `extractFields` has no warnings channel | ✅ PRD warns extraction not supposed to inject LLM warnings |
| `fallbackReason` | ✅ optional | |

### 2.3 Behavior Bullets

| PRD bullet | Evidence | Verdict |
|---|---|---|
| same retrieval/security/deadline pipeline as `web_fetch` | `src/tools/web-extract.ts:64-72` `pipeline.fetch({format:"html", render, maxBytes, maxOutputChars: options.maxResponseBytes, maxRedirects:5, deadline, waitFor})` | ⚠️ **PARTIAL** — `maxOutputChars` passed to pipeline is `options.maxResponseBytes` (`src/tools/web-extract.ts:70`), **not** `min(input.maxOutputChars ?? options.maxOutputChars, options.maxOutputChars)` (which is applied only to `extractFields` at line 82-85). PRD says shared `maxOutputChars` control; implementation splits: fetch uses deployment maxResponseBytes, extraction output uses user maxOutputChars. Prevents premature HTML truncation before DOM/pattern extraction (arguably correct), but diverges from literal "shared controls" wording and makes HTTP HTML potentially larger than output limit before extraction. |
| engines implemented: `selector` + `pattern`; `schema`/`llm` not implemented | `src/core/extract-fields.ts:85-108` selector branch + `src/core/extract-fields.ts:37-64` pattern branch; `contracts.ts:500-512` only those two field types; `fieldSchema` union only these | ✅ |
| validates field name uniqueness, selector syntax/count, attribute requirement, per-field count, total output size | `src/core/extract-fields.ts:6-11` `validateFieldName` uniqueness+regex, `src/core/extract-fields.ts:95` `try {$(selector)} catch INVALID_INPUT`, `src/core/extract-fields.ts:93` attribute-required throw, `src/core/extract-fields.ts:96` `slice(0, many?maxValuesPerField:1)` per-field cap, `src/core/extract-fields.ts:75-76` `JSON.stringify(data).length > maxOutputChars throw OUTPUT_LIMIT` total-size guard | ✅ but **per-field count is silent truncate not error**: `many` slices to `maxValuesPerField:100` (`src/tools/web-extract.ts:83` + `src/core/extract-fields.ts:44,96`) rather than validating+erroring when selector hits >100. PRD says "驗證 ... per-field result count 與 total output size" — silent truncation may hide excess matches vs explicit validation error; edge-case contract worth documenting. |
| single missing → `missingFields` explicit, not empty-string fake | `src/core/extract-fields.ts:50-53` pattern: `if values.length==0 push missing; data[name]= many?values : values[0]??null`, selector `src/core/extract-fields.ts:104-105` same | ✅ `null` for single missing, `[]` for `many` missing per PRD bullet "many=true 固定回陣列" + edge table "many=true 無命中 回空陣列並列入 missingFields". |
| `many=true` always array; single always scalar or explicit missing | same lines | ✅ |
| no LLM; same DOM+input → same result | `src/core/extract-fields.ts:88` `load(html)` deterministic cheerio, `compilePattern` deterministic RegExp with `g` flag (`src/core/extract-fields.ts:33`) | ✅ |
| Engine boundary: selector deterministic, pattern bounded, schema/llm not implemented | `src/core/extract-fields.ts:85-108` selector path + `compilePattern` rejections | ✅ |
| Pattern: flags `i/m/u`, named/numbered capture group, `many`, missing, pattern length cap 500, input size cap, match count cap, output cap, reject backref/lookaround/nested quantifier | `src/tools/web-extract.ts:23-24` flags regex + `src/core/extract-fields.ts:24` `Set(flags).size` duplicate check, `src/core/extract-fields.ts:12-18` `if pattern.length>500` + `\\[1-9]`, `\(\?<?[=!]`, `\([^)]*[+*][^)]*\)[+*{]` rejections, `src/core/extract-fields.ts:40-42` `Array.from(html).length>1_000_000 throw OUTPUT_LIMIT`, `src/core/extract-fields.ts:44` match-count cap, `src/core/extract-fields.ts:75` output JSON cap | ✅ duplicate-flag check (`Set` size) actually **stricter** than PRD: PRD allows any subset of `imu` but doesn't say unique required; implementation rejects `"ii"` (correct defensive). |
| Extraction total output exceeds limit → error vs truncated flag | `src/core/extract-fields.ts:75-76` throws `OUTPUT_LIMIT` if serialized `>maxOutputChars`; `src/core/extract-fields.ts:77` returns `truncated:false` always | ⚠️ **Semantic divergence**: PRD output structure includes `truncated` boolean, implying extraction truncation could be flagged. Currently `extracted.truncated` is never `true`; oversize instead throws stable error via `toolError` → `OUTPUT_LIMIT` (desired for limits per §6.2). This matches "驗證... total output size" if exceed is error, but contradicts expectation that `truncated` might become true. Document that `truncated` in web_extract only reflects `page.truncated` (HTTP truncation), not extraction output truncation (which is error). `src/tools/web-extract.ts:100` merges accordingly. |
| Warnings not include extraction synthetic field warnings | Only page warnings merged (`src/tools/web-extract.ts:104`) | ✅ |

---

## 3. parse (PRD 5.9) — Partial Gaps

### 3.1 Input Fields

| PRD expectation | Implementation | Gap |
|---|---|---|
| `url` OR `html` exactly one; `url` HTTP(S), `html` mode must supply HTTP(S) `baseUrl` for relative URL | `src/tools/parse.ts:9-30` `url` optional url+http/https refine, `html` optional string min1 max2_000_000, `baseUrl` optional same, `superRefine` line 18-28 enforcing XOR + baseUrl-required | ✅ |
| `purpose` `document|metadata|links|media|tables|all` default `all` | `src/tools/parse.ts:8,12` | ✅ |
| URL mode shares `render,waitFor,timeoutMs,maxBytes,maxOutputChars` | `src/tools/parse.ts:13-16` line 13-16 includes all; note `waitFor`/`render` always present in schema even for `html` mode (see behavior gap) | ⚠️ lenient — PRD says "URL 模式共用..." implying html mode should not need them; implementation permits them for html but ignores them (no validation error). |
| `render`/`waitFor`/`timeoutMs`/`maxBytes`/`maxOutputChars` bounds | `src/tools/parse.ts:13-16` same as fetch | ✅ |
| `maxRedirects` / `purpose` | not input-exposed; fixed `maxRedirects:5` internal (`src/tools/parse.ts:68`) | ✅ per PRD (not listed as input) |

### 3.2 Output Fields

PRD expected snippet (5.9 lines 184-189):

```
requestedUrl?, finalUrl?, purpose, title?, description?, author?, publishedAt?, canonicalUrl?,
content?, text?, metadata?, links?, images?, tables?, engine?, backend?,
truncated, bytes, durationMs, warnings[], fallbackReason?
```

Implementation `src/tools/parse.ts:34-55` `parseDataSchema`:

| Field | Present | Notes |
|---|---|---|
| `requestedUrl?` | ✅ optional `src/tools/parse.ts:35` set only when `input.url` present (`src/tools/parse.ts:92`) | |
| `finalUrl?` | ✅ optional `src/tools/parse.ts:36` from `page.raw.finalUrl` (`src/tools/parse.ts:93`) | |
| `purpose` | ✅ required (`src/tools/parse.ts:37`, `src/core/parse-document.ts:9-10`) echoed |
| `title?,description?,author?,publishedAt?,canonicalUrl?` | ✅ `src/tools/parse.ts:38-42` from `parseDocument` (`src/core/parse-document.ts:138-185`) | |
| `content?,text?` | ✅ `src/tools/parse.ts:43-44` — `document`/`all` purpose yields `content` (html) + `text` (plain) via `extractReadableDocument` (`src/core/parse-document.ts:238-246`) | |
| `metadata?` | ✅ `src/tools/parse.ts:45` `record<string,string|string[]>` from `parseMetadata` (`src/core/parse-document.ts:119-137`) | |
| `links?` (`ParsedLink[]`) | ✅ `src/tools/parse.ts:46` `linkSchema` with `url,text?,rel?,internal` (`src/core/parse-document.ts:188-206` capped `maxLinks 500`) | |
| `images?` (PRD `media`) | ✅ `src/tools/parse.ts:47` `imageSchema(url,alt?,title?)` named `images` (`src/core/parse-document.ts:208-227` cap `maxImages 300`) — naming gap minimal (PRD says `media`; code uses `images`). |
| `tables?` | ✅ `src/tools/parse.ts:48` (`src/core/parse-document.ts:229-260` cap `maxTables 50`, `maxRowsPerTable 200`, `maxCellsPerRow 50`) | |
| `engine?,backend?` | ✅ optional `src/tools/parse.ts:49-50` from `page.raw` only when url mode (`src/tools/parse.ts:94-95`); absent for `html` mode ✔ PRD expectation |
| `truncated` | ✅ `src/tools/parse.ts:51` merged `content/text truncated` (`src/core/parse-document.ts:240-242`) |
| `bytes` | ✅ `src/tools/parse.ts:52` `page.bytes` for url else `byteLength(input.html)` (`src/tools/parse.ts:96`) |
| `durationMs` | ✅ `src/tools/parse.ts:53,97` |
| `warnings[]` | ✅ `src/tools/parse.ts:54,98-101` merges `parsed.warnings + page.warnings` |
| `fallbackReason?` | ✅ `src/tools/parse.ts:55,102-103` from `page.fallbackReason` |
| `blockedSubrequests?` | ❌ absent | ✅ matches PRD (parse does **not** list it, unlike fetch/extract). Raw `page.raw.blockedSubrequests` is intentionally not surfaced for parse — compliant. |

### 3.3 Behavior Bullets

| PRD bullet | Evidence | Verdict |
|---|---|---|
| URL input uses same retrieval/security/deadline pipeline as web_fetch; raw html no network | `src/tools/parse.ts:56-82` `if input.url` → `pipeline.fetch({format:"html", render, maxBytes, maxOutputChars: options.maxResponseBytes, deadline, waitFor})` + `parseDocument(page.content,{purpose,baseUrl:page.raw.finalUrl,...})` ; `else` directly `parseDocument(html,{baseUrl})` — no pipeline | ✅ deadline created `new Deadline(input.timeoutMs ?? options.requestTimeoutMs)` line 61 applies even to html mode (timing still measured) but no network. |
| Parser layer deterministic engines, reference open-source capability breakdown but maintain self parser; adapters only via explicit boundary | `src/core/parse-document.ts:1-3` cheerio Readability (`@mozilla/readability` + `linkedom`) with `extractReadableDocument` fallback scoring | ✅ deterministic, no LLM (`src/core/parse-document.ts:138-260` no model call) |
| First version supports HTML document, metadata, links, media, tables; document parser may reuse Readability heuristics but contract-constrained | `src/core/parse-document.ts:264-300` purpose-gated branches set `content/text`, `metadata`, `links`, `images`, `tables` | ✅ |
| Subsequent engines (Trafilatura etc) only as explicit adapter/engine, must pass corpus gates | Not implemented — code reserves no extra engines | ✅ not violated |
| `parse` does not call LLM; future LLM parser opt-in distinct engine not pretending deterministic | No LLM import | ✅ |
| `purpose=all` vs selective; `all` populates all sections | `src/core/parse-document.ts:238-257` explicit `if purpose==document\|\|all ...`, etc. | ✅ |
| URL mode `maxOutputChars` handling — **GAP** | `src/tools/parse.ts:67` fetch passes `maxOutputChars: options.maxResponseBytes` (deployment max), **not** `Math.min(input.maxOutputChars ?? options.maxOutputChars, options.maxOutputChars)` which is only passed to `parseDocument` (line 71). So fetch HTML can exceed user `maxOutputChars` before parsing. Then `parseDocument` truncates `content`/`text` individually via `truncateUnicode(..., maxOutputChars)` (`src/core/parse-document.ts:240-241`), but final output-length guard is `if JSON.stringify(result).length > maxOutputChars*2 throw OUTPUT_LIMIT` (`src/core/parse-document.ts:262-263`). PRD cross-cutting 6.2 says limit DOM/output; `*2` multiplier is **undocumented** divergence from single `maxOutputChars` cap. For fetch, PRD says output truncation with `truncated=true`; for parse, the *2 throw vs truncate semantics differ. | ⚠️ **PARTIAL** — behavior works but contract diverges: exceeding `maxOutputChars*2` throws rather than truncate-flag; within limit, truncation is per-field not total serialized truncation. |
| Raw-html `baseUrl` required for relative URL resolution | `src/core/parse-document.ts:25-42` `httpUrl(value,baseUrl)` + `isInternalUrl` use `new URL(value,baseUrl)`; `parseLinks`/`parseImages` resolve relative via `httpUrl` | ✅ |
| Expected purpose-specific omission: `content`/`text` only when `document`/`all`, etc. | As above | ✅ |
| Source-aware docs not reachable for parse | `src/core/source-aware-docs.ts:323-328` `canUseSourceAwareDocs = render!==always && !selector && !waitFor && (format==markdown\|\|text)` ; `src/tools/parse.ts:63` `format:"html"` hard-coded → always `canUseSourceAwareDocs==false` (`src/core/fetch-pipeline.ts:48`). PRD phase 3 roadmap envisions “source-aware documentation parser: prefer llms.txt/markdown endpoints...不要靠提高整頁 HTML output limit” — `parse` exists to solve large generated docs but currently **cannot** use the source-aware optimization because it always fetches HTML. To align, parse URL mode should optionally fetch markdown via source-aware when `isLikelyDocumentationUrl` and purpose permits, or be documented as intentional html-only. | ⚠️ Design gap (future priority). |
| Raw-html mode accepts but ignores `render`/`waitFor`/`timeout`-derived deadline for network | `src/tools/parse.ts:12-13` schema allows `render`/`waitFor` even when `html` supplied; handler branch `else` (line 76) does `parseDocument(input.html...)` ignoring `input.render/waitFor`. PRD says those controls are "URL 模式共用" — implies html mode shouldn't carry them (or should error). Silently ignoring is lenient but could mislead callers into thinking `waitFor` affects local parse. | ⚠️ minor schema leniency |

---

## 4. Cross-cutting Gaps Touching These Tools

| Topic | Gap | Files |
|---|---|---|
| Browser budget guard | `FetchPipeline` checks `backendBudget.remaining("browserless")==0` for browser (`src/core/fetch-pipeline.ts:138`) and `remaining("jina")!==0` for reader (`src/core/fetch-pipeline.ts:110`). Correct per §6.4 monthly budgets instance-local disclosure requirement. No gap. | `src/core/fetch-pipeline.ts:104-112,138` |
| Deadline sharing | `Deadline` constructed once per tool call (`src/tools/web-fetch.ts:64`, `src/tools/web-extract.ts:61`, `src/tools/parse.ts:61`) and threaded through `withConcurrency` + `pipeline.fetch` via `deadline.remainingMs` / `deadline.signal`. Correct per §6.2 shared deadline, fallback does not reset timer. | `src/core/limits.ts:4-18` |
| Hardcoded `maxRedirects:5` | Consistent across all three tools (`web-fetch 79`, `web-extract 71`, `parse 68`). PRD says HTTP path must limit redirect but not value; should be documented as deployment cap. | `src/tools/web-fetch.ts:79` etc. |

---

## 5. Next Priority (Fix or Document)

| P | Gap | Severity | Action |
|---|---|---|---|
| P0 | **Parse source-aware unreachable** — `parse` URL mode `format:html` prevents `SourceAwareDocsResolver` (gated to `markdown|text`). Large generated docs will hit `OUTPUT_LIMIT` or `maxOutputChars*2` throw instead of `llms.txt`/`index.md` optimization promised in §12 phase 3. | Medium — blocks roadmap goal | Decide: either (a) allow `parse` to fetch `text/markdown` for documentation URLs (expose `format` or auto-detect) and route through source-aware, or (b) explicitly document `parse` as HTML-only and require callers to use `web_fetch` with markdown+RAG for docs. Update `src/tools/parse.ts:63` and `src/core/source-aware-docs.ts:323` or add `canUseSourceAwareDocs` exception for parse. |
| P1 | **Parse output cap `*2`** — `src/core/parse-document.ts:262-263` `serializedLength > maxOutputChars*2 throw` vs PRD expectation of single-limit truncation/error. Document as intentional (html+text double budget) or correct to `>maxOutputChars` and report `truncated:true` + `OUTPUT_LIMIT` consistently with fetch. | Low-Med | Clarify contract in PRD or code comment; add test for boundary at 1.0× vs 2.0×. |
| P1 | **`web_extract` fetch ignores user `maxOutputChars`** — `src/tools/web-extract.ts:70` passes `options.maxResponseBytes` not clamped user value. Users expecting `maxOutputChars` to bound network HTML may fetch larger HTML than expected; extraction output limit is separate. Either document intentional split (network vs extraction budget) or apply `Math.min(input.maxOutputChars ?? …, options.maxOutputChars)` to `pipeline.fetch` `maxOutputChars` like fetch does. | Low | Document or align. |
| P2 | **Raw-HTML mode accepts `render`/`waitFor`** — `src/tools/parse.ts:13,76` silently ignores. Add `superRefine` to reject `render!==auto`/`waitFor` when `html` present, or explicitly strip and warn. | Low | Schema refinement. |
| P2 | **`backend` literal union** — `src/tools/web-fetch.ts:29`, `src/tools/web-extract.ts:43`, `src/tools/parse.ts:50` use `z.string()` not `z.enum(["direct","jina","local","browserless"])` plus `source:accept-markdown` etc for source-aware. PRD mandates revealing actual source; stronger typing prevents typo backends and enables contract tests. | Low | Optionally narrow `backend` to literal enum mirroring `contracts.ts` extensions (`source:accept-markdown`, `source:index.md`, `source:llms.txt`, `source:openapi-*`). |
| P2 | **`blockedSubrequests` contract for `web_fetch`** — `src/tools/web-fetch.ts:33` extra optional not in PRD 5.2 list. Align PRD text (add optional) or hide for strict 5.2 parity. | Info | Doc update. |
| P3 | **Extraction per-field `>maxValuesPerField` silent slice vs validation error** — `src/core/extract-fields.ts:96,44` slice without `OUTPUT_LIMIT`. Contracts tests should lock whether N=101 selector hits truncates or errors; PRD wording "驗證 ... per-field result count" suggests validation. | Info | Lock contract test. |

---

## 6. Covered Checklist (for implementers reusing without re-read)

- [x] `web_fetch` I/O schema exactly lists PRD fields (minus optional `blockedSubrequests` extra)
- [x] `web_extract` selector + pattern engines deterministic, attribute handling, `many`, `missingFields`→`null`/`[]`, flags/match/count/output caps enforced (`src/core/extract-fields.ts:6-77`)
- [x] `parse` `document|metadata|links|media|tables|all` purpose gating, bounded caps (`maxLinks 500` etc), no LLM
- [x] Shared `Deadline` + `ConcurrencyLimiter` threading, `render=always/never/auto` branching, challenge/js_empty/selector_unsatisfied/`waitFor` fallback reasons
- [x] Reader gated to `markdown && !selector && !waitFor` so deterministic extraction never faked (`src/core/fetch-pipeline.ts:104-112`)

---

## 7. Evidence Index (file:line anchors)

- PRD source: `docs/product/prd.md:39-84` (5.2), `158-200` (5.8), `184-230` (5.9)
- `src/tools/web-fetch.ts:7-16` input, `17-33` output, `64-105` handler
- `src/tools/web-extract.ts:7-32` input, `37-49` output, `64-108` handler
- `src/tools/parse.ts:8-28` input, `34-55` output, `56-102` handler
- `src/core/fetch-pipeline.ts:15-28` fallbackReason, `44-101` fetch branching, `104-112` canUseReader, `114-119` retryable
- `src/core/extract-fields.ts:6-11` name uniqueness, `12-18,22-33` pattern rejections & flags duplicate, `40-42` input size cap, `44,96` per-field cap, `75-77` total output cap
- `src/core/normalize-document.ts:8-22` login warning, `32-60` selector vs readable branching, `60-68` truncation
- `src/core/readable-document.ts:10-114` removable/candidate selectors, scoring, sanitize
- `src/core/parse-document.ts:16-20` caps, `119-185` metadata, `188-260` links/media/tables, `238-268` purpose gating & `*2` cap
- `src/core/source-aware-docs.ts:320-328` canUseSourceAwareDocs, `406-414` fetchMarkdown accept header
- `src/core/contracts.ts:7-14` Engine/RawDocument, `500-512` ExtractionField types
- `src/core/limits.ts:4-18` Deadline

---

*Generated read-only — no files edited. Markdown stored at `local://audit-fetch-extract.md` (also written to `audit-fetch-extract.md` in workspace root for convenience).*
