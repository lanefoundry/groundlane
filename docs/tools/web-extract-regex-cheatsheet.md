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
- Errors now carry a `hint` string telling you which input to adjust.

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

| Limit | Where enforced | Hint on overflow |
|---|---|---|
| Pattern length ≤ 500 chars | `compilePattern` | `Shorten the pattern or split across two fields.` |
| `many: true` returns ≤ 100 matches per field | `extractPatternValues` | `Lower maxValuesPerField on the request, or split into narrower patterns.` |
| Input HTML ≤ 1,000,000 chars | `extractPatternValues` | `Lower maxBytes on the request, or switch to a narrower selector field.` |
| Total extracted output ≤ `maxOutputChars` | `extractFields` | `Lower maxOutputChars on the request, or reduce the number of fields.` |

## Error envelope

Both `INVALID_INPUT` and `OUTPUT_LIMIT` now surface a `hint` string alongside
the existing `code`, `stage`, `message`, and `retryable` fields:

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_INPUT",
    "stage": "extract",
    "message": "Invalid pattern for field prices",
    "retryable": false,
    "hint": "Check the regex with a local engine (regex101.com) — common causes: unbalanced groups, bad escape sequences, or incompatible flag combinations."
  }
}
```

`hint` is the operator-facing remediation. Read it before retrying.

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