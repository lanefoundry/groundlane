# Secret configuration UX patterns

Date: 2026-08-22

## Question

How do comparable deployment platforms make multi-provider API-key setup safer
and friendlier, and which patterns should Groundlane adopt on Cloudflare?

## Source coverage

| Source | Read level | Groundlane result | Limitation |
| --- | --- | --- | --- |
| Cloudflare Wrangler `secret bulk --help` | Primary, complete local CLI help | Local Groundlane research environment | CLI contract only; cloud account was not authenticated |
| [Vercel environment CLI](https://vercel.com/docs/cli/env) | Primary, full page | `engine=http`, `backend=direct` | Product-specific environment types |
| [Fly secrets import](https://fly.io/docs/flyctl/secrets-import/) | Primary, full page | `engine=http`, `backend=direct` | Command reference is intentionally short |
| [Railway variables](https://docs.railway.com/guides/variables) | Primary, full page | Redirected to current `/variables`; direct fetch | Dashboard behavior may evolve independently of CLI |
| [Supabase secrets CLI](https://supabase.com/docs/reference/cli/supabase-secrets-set) | Primary, relevant command section | Direct fetch of combined CLI reference | Only the secrets section was extracted from a long reference page |
| [Render environment variables](https://render.com/docs/configure-environment-variables) | Primary, full relevant page | `engine=http`, `backend=direct` | Render deploy semantics are not Cloudflare semantics |

All public pages above were fetched through the current Groundlane checkout's
local MCP `web_fetch`; no third-party search provider key was used.

## Observed patterns

| Pattern | Examples | Product effect |
| --- | --- | --- |
| Bulk import through stdin or a file | Cloudflare accepts JSON or `.env`; Fly reads `NAME=VALUE` from stdin; Supabase accepts multiple pairs or `--env-file` | Avoids one command per key |
| Raw editor or `.env` paste in the dashboard | Railway accepts `.env` or JSON; Render offers “Add from .env” | Friendly for non-CLI operators |
| Explicit environment scope | Vercel separates development, preview, production, custom environments; Railway and Render scope variables to environments/services | Reduces accidental production writes |
| Write-only or sealed values | Vercel sensitive variables cannot be viewed later; Railway sealed variables cannot be retrieved through UI/API | Makes secret status name-based, not value-based |
| Stage changes before deploy | Railway stages variable changes; Fly supports `--stage`; Render offers save-only, save-and-deploy, or rebuild-and-deploy | Separates configuration mutation from rollout |
| Run locally without persisting values | Vercel `env run`; Railway `run` and `shell` | Improves local parity without `.env` drift |
| Discover expected variable names | Railway detects `.env.example` and suggests variables | Turns setup into filling a manifest rather than remembering names |

## Cross-source conclusion

The common UX is not a custom application page that owns cloud credentials.
It is a declarative list of expected names plus a bulk, environment-scoped,
write-only update flow with a preview before rollout.

Building a Groundlane admin page that writes Cloudflare secrets would require a
Cloudflare management token inside Groundlane and materially expand the attack
surface. A local setup CLI can provide the same usability without giving the
runtime control-plane credentials.

## Recommended Groundlane flow

Add two repository commands:

1. `pnpm secrets:setup`
   - Reads supported secret names from a typed provider/config manifest.
   - Shows provider capability, recurring allowance type, and whether the
     currently deployed code recognizes the key.
   - Prompts with hidden input; blank values mean “leave unchanged”.
   - Defaults to production only after an explicit environment selection.
   - Shows a name-only diff, asks for confirmation, then sends one Wrangler
     `secret bulk` request through stdin.
   - Does not deploy code automatically; offers a separate confirmed deploy
     step only when configuration variables or code changed.

2. `pnpm secrets:status`
   - Lists expected names versus Cloudflare secret names.
   - Never retrieves or prints values.
   - Reports missing required auth, enabled provider keys, provider order, and
     zero/exhaustible local attempt caps.
   - Warns when the worktree supports a key that the deployed version has not
     been proven to support.

Optional follow-ups:

- Add `pnpm groundlane:run -- <command>` later to inject selected development
  secrets without writing `.env`, following Vercel/Railway's local-run pattern.
- Generate a Dashboard-compatible `.env` template containing names only, but do
  not store populated values in the repository.

## Decision

For Groundlane, the best immediate design is an interactive local setup script
backed by Wrangler `secret bulk`, not repeated `secret put` calls and not a
cloud-management screen inside the MCP server.
