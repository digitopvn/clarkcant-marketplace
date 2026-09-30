# ClarkCant Marketplace bootstrap released (issue #1)

Date: 2026-09-30 · Branches: `dev` → staging, `main` → production · Release: `release-20260929-1841`

## What shipped
The marketplace now runs on Cloudflare Workers in both environments. It serves one package and page model through the web app, REST/OpenAPI, MCP, WebMCP and the `clark-market` CLI. Staging deploys on every push to `dev`, and production deploys on every push to `main` with a release tag. Production passed its smoke checks: health, OpenAPI, the six MCP tools, the SEO surfaces and three viewports with no overflow and no console errors.

## Lessons worth keeping
- **CSP hashes must be computed at build time.** Astro 7 sends `security.csp` as a header. Calling `Astro.csp.insert*Hash` from a layout at runtime never reaches that header. The staging e2e run caught this through the theme script. Inline scripts and styles are now fixed strings hashed in `apps/web/astro.config.ts`.
- **Shift README headings on the sanitized tree, not with regex.** A regex heading rewrite let crafted READMEs inject markup. The heading shift now runs on the hast tree (`packages/markdown/src/shift-headings.ts`) at index time.
- **New cron triggers can lag.** A freshly created jobs worker listed its schedules through the API but did not fire for more than 20 minutes. Default pages seed from cron, so `/about` and `/terms` return 404 until the first tick. Check `workersInvocationsScheduled` analytics before debugging the code.
- **Wrangler migrations need `--config wrangler.jsonc`.** Without it, wrangler follows the `.wrangler/deploy/config.json` redirect that the Astro build writes.

## Open items
- DoD #6 needs a real ClarkCant widget published to npm.
- The PR preview workflow should use its own environment with reviewers and a narrow token.
- Legal pages are published drafts with `[TO BE CONFIRMED]` placeholders and need legal review.
