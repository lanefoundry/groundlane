# Groundlane Reader benchmark

測試日期：2026-08-22。這是選擇正文抽取實作的工程 benchmark，不是對所有網站品質的保證。

## 結論

Groundlane Reader 採用 [`@mozilla/readability`](https://github.com/mozilla/readability) 搭配 [`linkedom`](https://github.com/WebReflection/linkedom) 作主要正文抽取器，並保留原本的有界 heuristic 作解析失敗時的 fallback。Groundlane 仍負責網址清理、輸出上限與 selector 語意；第三方 parser 不會繞過既有安全邊界。

## 可重跑方法

- Corpus：Mozilla Readability repository revision `ab4027a` 的 130 組官方 test fixtures。
- 每組 fixture 以官方 `source.html` 為輸入、`expected.html` 與 `expected-metadata.json` 為期望值。
- Repo 內的 [`scripts/benchmark-reader.mts`](../../scripts/benchmark-reader.mts) 以 Unicode letter/number token multiset 做 micro-averaged precision、recall、F1，metadata 則比較非 null 的 `title`、`byline`、`excerpt`、`publishedTime` 經空白正規化後是否完全相等。
- 每個 fixture 執行一次，不先 warm up。Latency 只代表這台機器上的本次 local run，不代表 production latency。

```bash
git clone https://github.com/mozilla/readability.git /tmp/readability
git -C /tmp/readability checkout ab4027a
pnpm benchmark:reader -- /tmp/readability/test/test-pages ab4027a
```

## 目前 Groundlane 實作

環境：Node v25.6.1、Darwin 25.5.0 arm64、Apple M3 Pro。完整 machine-readable output 見 [`reader-benchmark-2026-08-22.json`](artifacts/reader-benchmark-2026-08-22.json)。

| Fixtures | Precision | Recall | F1 | Metadata exact | Median | p95 | Empty／failure |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 130 | 0.999497 | 0.985370 | 0.992383 | 363 / 367 | 8.58 ms | 44.38 ms | 0 / 0 |

## 採用前探索比較

以下是同一天、同 corpus 的一次性候選比較；它使用較早的實驗 script，未保留 raw artifact，因此只能視為選型紀錄，不能和上方可重跑結果混為同一組方法。

| 實作 | Precision | Recall | F1 | Metadata exact | Median | p95 | Empty／failure |
|---|---:|---:|---:|---:|---:|---:|---:|
| Groundlane 原 heuristic | 0.861383 | 0.978460 | 0.893898 | 210 / 364 | 6 ms | 37 ms | 0 / 0 |
| Readability + jsdom | 0.997766 | 0.995419 | 0.996557 | 364 / 364 | 50 ms | 206 ms | 0 / 0 |
| Readability + linkedom | 0.997766 | 0.995419 | 0.996557 | 364 / 364 | 9.85 ms | 41.79 ms | 0 / 0 |

探索比較中，Readability + linkedom 在這份官方 corpus 上與 jsdom 得到相同內容與 metadata 品質，但延遲接近原 heuristic；可重跑的目前實作也維持 0 empty／failure 與 0.99 以上 F1。因此 linkedom 比引入 jsdom 更符合 Groundlane 的 Node/Container runtime；原 heuristic 留作 null、空內容或 parser error 時的本機 fallback。

本次安裝後，以 `du -sh node_modules/.pnpm/@mozilla+readability@0.6.0 node_modules/.pnpm/linkedom@0.18.13` 量得 pnpm store-linked package 目錄約為 Readability 188 KB、linkedom 2.5 MB；`pnpm build:container` 的 `tsup` entry bundle 由約 93.1 KB 增至 94.7 KB。Node dependencies 維持 external，因此 container image 仍會包含完整 production dependencies。

## 限制

- Corpus 來自 Readability 自己的 regression fixtures，對該實作有先天偏向；仍需另建 Groundlane 的真實網站 corpus。
- 測試不涵蓋 JavaScript rendering、登入頁、Cloudflare challenge、CAPTCHA 或住宅 proxy，這些屬 retrieval/browser layer，不是 Reader 能力。
- benchmark 沒有發出網路請求；反爬成功率不能由這份結果推論。
