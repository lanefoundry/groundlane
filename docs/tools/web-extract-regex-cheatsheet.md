# web_extract pattern engine — regex cheatsheet

`web_extract` ships a bounded deterministic pattern engine that maps a regex
over fetched HTML and returns matches. This cheatsheet records what the engine
accepts, what it rejects, and how to write patterns that survive the constraints
without surprises.

## TL;DR

- `flags`: pick from `i`, `m`, `s`, `u` — any combination, no duplicates.
- Cross-line matching: use `s` flag (or inline `(?s)`) or write `[\s\S]` instead of `.`.
- The engine peels off an inline `(?...)` modifier so `(?is)line.+KEY=(\d+)` works.
- Backrefs, lookaround, and nested quantifiers are rejected up-front — rewrite
  the pattern or split it across two fields.
- Errors carry a structured `hint` object: a stable machine-readable `code` plus
  a `text` field. Consumers provide their own i18n via `localized` if they need
  another language.

## Supported flag set

| Flag | Meaning | Notes |
|---|---|---|
| `i` | Case-insensitive matching | |
| `m` | `^` and `$` match line boundaries inside the input | |
| `s` | `.` matches newlines (`dotAll`) | This is the cross-line knob |
| `u` | Unicode mode | Enables `\p{...}`, surrogate-aware `.`, etc. |
| `g` | **Not exposed** | Always appended internally; do not pass it |

The `flags` field accepts any unique subset of `i`, `m`, `s`, `u`. Combinations
like `"is"`, `"su"`, `"imu"` are valid. `"ii"`, `"g"`, `"xy"` are rejected.

### Inline flag modifier

The pattern source may begin with an inline modifier `(?i)` / `(?s)` / `(?m)` /
`(?u)` or any combination such as `(?is)`. The engine peels it off and merges
it with the `flags` field. Anything outside `[imus]` throws `INVALID_INPUT`
with a hint pointing at `[\s\S]`.

```ts
// All three match the same pattern:
{ pattern: "line.+KEY=(\\d+)", flags: "s" }
{ pattern: "(?s)line.+KEY=(\\d+)" }
{ pattern: "(?i)line.+KEY=(\\d+)", flags: "s" }   // merged to "is"
```

## Cross-line matching — three equivalent forms

```ts
// 1. Explicit s flag
{ pattern: "line.+\\sKEY=(\\d+)", flags: "s", group: 1 }

// 2. Inline (?s) modifier
{ pattern: "(?s)line.+\\sKEY=(\\d+)", group: 1 }

// 3. [\s\S] in place of .
{ pattern: "line[\\s\\S]+\\sKEY=(\\d+)", group: 1 }
```

Form 1 and 2 are preferred — they make cross-line intent explicit. Form 3 is
the legacy workaround and stays valid.

## Hard rejections (always)

These constructs throw `INVALID_INPUT` regardless of how they are written:

| Construct | Why | Rewrite strategy |
|---|---|---|
| `\\1`, `\\2`, ... backreferences | Catastrophic backtracking risk | Capture into a named/numbered group and post-process |
| `(?=...)`, `(?!...)`, `(?<=...)`, `(?<!...)` lookaround | Not supported by JS regex engine on the level we expose | Split into two patterns or use `match`/named capture |
| `(a+)+`, `(a*)*`, `(a+){m,n}` nested quantifiers | Same risk | Anchor or refactor with non-nested quantifiers |
| Inline flags outside `[imus]` | Unpredictable JS engine behavior | Stick to `i`/`m`/`s`/`u` |
| Pattern longer than 500 chars | Bound to keep the engine cheap | Split across fields or pre-process |
| Input HTML larger than 1,000,000 chars | OUTPUT_LIMIT | Lower `maxBytes`, or rely on `selector` for HTML-only fields |

## Capture groups

- `group: number` selects that capture (1-based, like JS regex indices).
- `group: "name"` selects a named capture group (e.g. `(?<plan>...)`).
- `group` omitted defaults to the first capture group if present, otherwise
  the whole match (`match[0]`).

## Common recipes

### Find every price on a pricing page

```ts
{
  name: "prices",
  pattern: "\\$\\s?(\\d+(?:\\.\\d{2})?)",
  group: 1,
  many: true,
}
```

### Capture link text + URL from `<a>` tags

Use a `selector` field instead — the pattern engine works on raw HTML and does
not parse DOM. Two `selector` fields (text + attribute) are simpler:

```ts
{ name: "links", selector: "a[href]", value: "attribute", attribute: "href", many: true }
{ name: "linkText", selector: "a[href]", value: "text", many: true }
```

### Multi-line log line extraction

```ts
{
  name: "errors",
  pattern: "(?m)^ERROR\\s+(?<msg>.+)$",
  group: "msg",
  many: true,
}
```

### Cross-line JSON-ish blob

```ts
{
  name: "blob",
  pattern: "BEGIN[\\s\\S]+?value\\s*=\\s*\"(?<v>[^\"]+)\"[\\s\\S]+?END",
  flags: "s",
  group: "v",
}
```

## Limits

| Limit | Where enforced | Hint code on overflow |
|---|---|---|
| Pattern length ≤ 500 chars | `compilePattern` | (no specific code) |
| `many: true` returns ≤ 100 matches per field | `extractPatternValues` | (truncates silently today) |
| Input HTML ≤ 1,000,000 chars | `extractPatternValues` | `extract.pattern.input_too_large` |
| Total extracted output ≤ `maxOutputChars` | `extractFields` | `extract.output_too_large` |

Other `extract.pattern.*` codes:

- `extract.pattern.invalid_inline_modifier` — `(?x)` or other inline flag not in `[imus]`.
- `extract.pattern.invalid_flags` — explicit `flags` rejected by the schema or duplicate.
- `extract.pattern.compile_failed` — pattern parsed by JS regex engine as malformed.

Other `web_*.output_too_large` codes (one per tool, all share the same shape):

- `search.output_too_large`
- `web_crawl.output_too_large`
- `web_images.output_too_large`
- `web_news.output_too_large`
- `web_research.output_too_large`
- `web_map.output_too_large`
- `web_answer.output_too_large`
- `web_content.output_too_large` (and the related `web_content.binary_url` for PDF/image early-reject)

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_INPUT",
    "stage": "extract",
    "message": "Pattern flags must be unique i, s, m, or u flags",
    "retryable": false,
    "hint": {
      "code": "extract.pattern.invalid_flags",
      "text": "Allowed: i (case-insensitive), s (dotAll / cross-line '.'), m (multiline), u (unicode). For cross-line matching use 's' or the (?s) inline modifier."
    }
  }
}
```

### `hint` field shape

| Field | Type | Meaning |
|---|---|---|
| `code` | string | Stable machine-readable identifier. Use this for branching, telemetry, or i18n lookup. |
| `text` | string | Default (en-US) human-readable explanation. Treat as fallback when no `localized` match. |
| `localized` | object? | Optional map of BCP-47 locale tag to translated message. Populated by the operator (e.g. README translation, hosted dashboard) — not by Groundlane itself. |

### Localization

Groundlane ships only the en-US `text` field. To render a different language:

1. Take the `hint.code` from the error.
2. Look it up in your own translation table.
3. If the table has a match for the active locale, use it.
4. Otherwise fall back to `hint.text`.

This keeps the protocol small and lets each consumer pick its own language
without Groundlane having to bundle a translation runtime.

```ts
function renderHint(hint: { code: string; text: string; localized?: Record<string, string> }, locale: string): string {
  return hint.localized?.[locale] ?? hint.text;
}
```

## Debugging tips

1. Test the pattern locally first with `regex101.com` (flag set `g` + any of
   `i`, `m`, `s`, `u`).
2. If a pattern compiles but returns no matches, switch to `selector` and
   inspect the actual DOM — the pattern engine is regex on raw HTML, not on a
   parsed tree.
3. If a pattern matches once but stops, remember that the `g` flag is appended
   internally; the second match continues from after the first end, not from
   the beginning. Rewrite greediness or use `many: true` with a non-greedy
   pattern.
4. If you see `OUTPUT_LIMIT` for pattern input, the HTML body was too large —
   use `selector` fields to narrow what arrives at the pattern engine, or
   lower `maxBytes` on the request.
5. If the error envelope shows a `hint.code`, look it up in this cheatsheet
   first. The code is more stable than `text` and is the right key for
   automated branching.

## What the engine does NOT do

- No DOM awareness (no `<a>` / `<img>` resolution, no XPath, no jQuery-style
  selectors). For that, use the `selector` engine.
- No LLM inference. `pattern` is deterministic.
- No streaming. The whole matched string is returned, capped by the per-field
  and total-output limits.
- No automatic retry on transient errors. If the upstream page changes
  format, the pattern keeps failing — fix the pattern.

## See also

- `src/core/extract-fields.ts` — pattern compilation and limits.
- `src/tools/web-extract.ts` — zod schema, input bounds.
- `test/unit/document.test.ts` — examples of accepted and rejected patterns.