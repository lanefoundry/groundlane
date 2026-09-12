# Arena UI Redesign — Codex Brief

## 目標

目前 UI 全部手寫 inline Tailwind，沒有用 shadcn 元件，看起來很粗糙。需要全面翻修成跟 offernow / aiexamprep 同等品質。

## 參考專案

1. `/Users/vincent/Work/study/offernow` — Happy Hues Palette 5, Plus Jakarta Sans + Inter, shadcn new-york style
2. `/Users/vincent/Work/study/aiexamprep` — Happy Hues Palette 2, Fraunces + Manrope, shadcn 元件（badge, button, card, checkbox, progress, radio-group, skeleton）

兩個專案共同點：
- 用 Happy Hues 調色盤（不是預設灰階）
- CSS custom properties 做 design tokens
- shadcn/ui 元件 (new-york style)
- Tailwind CSS v4 + `@theme` / `@custom-variant`
- 完整 dark mode

## 需要做的事

### 1. 安裝 shadcn 元件

在 arena/ 目錄跑：
```bash
npx shadcn@latest add button card table badge tabs separator
```

### 2. 重新設計 styles.css

- 選一個適合 Arena 的 Happy Hues 調色盤（建議 Palette 11 或 14 — 中性、評測氛圍）
- 用 `@theme` directive 定義 font-sans
- 完整的 shadcn CSS token mapping（跟 offernow 一樣的結構）
- 完整 dark mode（用 `@custom-variant dark` + `.dark` class）

### 3. 重寫所有頁面用 shadcn 元件

需要改的檔案：
- `src/routes/__root.tsx` — Header/Footer 用 shadcn Button, Separator
- `src/routes/index.tsx` — Landing, 用 Card, Button, Badge
- `src/routes/match.tsx` — 投票頁面, 用 Card, Button (4 vote buttons 要有明確視覺區分)
- `src/routes/leaderboard.tsx` — 用 shadcn Table, Tabs, Badge (provisional badge)
- `src/routes/benchmark.tsx` — 用 Table, Badge (regression flag), Button
- `src/routes/about.tsx` — 用 Card, Separator, Badge
- `src/components/Sparkline.tsx` — 保持 inline SVG 但確保顏色用 token

### 4. 設計方向

Arena 是一個中立的評測平台，視覺應該是：
- 乾淨、專業、不花俏
- 投票區的 A vs B 要有明確的色彩對比（藍 vs 紫）
- Leaderboard 要像一個正式的排行榜，數字用 tabular-nums
- Provisional badge 用 warning 色
- Regression flag 用 destructive 色
- 整體 spacing 要一致（用 shadcn 的預設 spacing）

### 5. 驗收標準

- `pnpm typecheck` 通過
- `pnpm build` 通過
- 所有頁面（/, /match, /leaderboard, /benchmark, /about）都正常渲染
- Light + dark mode 都好看
- 手機寬度（400px）可用
