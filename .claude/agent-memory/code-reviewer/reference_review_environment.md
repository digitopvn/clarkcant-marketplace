---
name: review-environment
description: How to run checks in clarkcant-marketplace reviews (fnm, blocked node_modules, test commands)
metadata:
  type: reference
---

- Bash needs `eval "$(fnm env --shell bash)"` before node/pnpm; the fnm "can't find environment variables" stderr line is harmless noise.
- A scout hook blocks reading anything under `node_modules` (e.g. wrangler internals); note such questions as unresolved instead.
- Focused tests: `pnpm vitest run packages/seo packages/webmcp packages/sdk` (~20 s, no dev server needed).
- Review reports go to `plans/reports/code-reviewer-<yymmdd-hhmm>-<slug>.md` when the lead asks for a file.
- Avoid `cd` in Bash (the fnm profile hook fails and exits 1; later calls can go silent). Use `git -C <repo>` and absolute paths; run `pnpm vitest` in one `eval fnm ... ; cd repo && ...` call and do quick Node probes before that call, not after.
- 2026-09-30: Bash returned no output at all (even `echo`), and the hook blocks reading `.git`. Git history is then unreachable; review the working tree and say so.
- The sanitized README/rich-text HTML (rehype-stringify) does NOT escape `<` inside attribute values (`title` and `alt` are allowed). Any regex post-processing of the stored HTML can open markup injection.
- Recurring risk areas seen 2026-09-29: prefix-only redirect sanitizers (TAB/LF bypass), e2e specs that `test.skip` on unset env vars in CI, docs vs workflow `secrets.`/`vars.` drift.
