# Groundlane parser benchmark

測試日期：2026-08-30。這是 Groundlane parser contract 的小型 regression
benchmark，不是對所有網站或文件格式的品質保證。

## 目標

`parse` 需要比單純 Reader 多一層可重用結構：document text、metadata、
links、media 與 tables。這份 benchmark 用 repo 內建 fixtures 固定目前行為，
讓後續拆解 Trafilatura、Crawl4AI、MarkItDown、anydoc、Docling、
Unstructured、GROBID、pdf.js、pdfminer.six、PaddleOCR、RapidOCR、EasyOCR、
docTR、Surya、Layout Parser、OLMOCR、OCRmyPDF、Apache Tika、PyMuPDF、
pdfplumber、pypdf、Camelot、Tabula 等 open-source references 時，有同一組
deterministic gate 可以比較。

## 可重跑方法

- Corpus：repo 內建 [`test/fixtures/parser`](../../test/fixtures/parser)。
- 每組 fixture 包含 `source.html` 與 `expected.json`。
- Repo 內的 [`scripts/benchmark-parser.mts`](../../scripts/benchmark-parser.mts)
  會呼叫 `parseDocument(..., { purpose: "all" })`，並輸出 machine-readable JSON。
- Benchmark 不發出網路請求；URL 解析只使用 fixture 的 `baseUrl`。

```bash
pnpm benchmark:parser -- test/fixtures/parser local-fixtures
```

## 目前 Groundlane 實作

環境：Node v25.6.1、Darwin 25.5.0 arm64、Apple M3 Pro。這是本地一次執行的
baseline；latency 只代表這台機器上的 local run。

| Fixtures | Required text | Rejected text | Metadata | Links | Images | Tables | Median | p95 | Failures |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 4 | 6 / 6 | 3 / 3 | 12 / 12 | 4 / 4 | 2 / 2 | 1 / 1 | 3.30 ms | 19.74 ms | 0 |

Title heuristic 的目前 contract 是：優先使用 `og:title` 或 `twitter:title`；
若 `<title>` 明顯是 `Article Title - Site` 這類 site suffix 且與 `h1` 相符，使用
`h1`；否則保留清理後的 `<title>`。這避免 article fixture 把 site suffix 當成文章標題，
也避免 documentation/table 頁面被較短的 `h1` 覆寫。

## Fixture 覆蓋

- `article`：正文、metadata、canonical URL、relative link、navigation/footer noise。
- `docs`：documentation-style main content、code block、fragment URL、external link。
- `table`：caption、headers、rows 與 provider limit 類表格。
- `media`：relative image、`srcset`、alt/title、unsafe link scheme rejection。

## 限制

- Corpus 很小，只能作 regression gate，不能代表真實網路分布。
- Benchmark 只測 HTML parser，不測 URL retrieval、rendering、login/challenge、PDF 或 OCR。
- Links、images 與 tables 目前採 exact match；未來若加入 source spans、confidence、
  row/column normalization 或 multi-engine fallback，需要同步升級 metrics schema。
