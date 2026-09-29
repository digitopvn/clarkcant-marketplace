# Phase 06 implementation report: SEO/GEO, sharing, hardening, legal, docs

## Executed phase
- Phase: phase-06-seo-hardening-legal
- Plan: plans/260929-1909-gh1-marketplace-bootstrap
- Status: completed (phase file Status line updated)

## Outcome
Every public page now has a canonical URL, Open Graph and Twitter tags, validated JSON-LD, a share bar and, where
the content has one, a Markdown twin. robots.txt, a segmented sitemap, llms.txt and llms-full.txt are served. The
site sends a hashed CSP with frame-ancestors, HSTS and the other security headers, rate limits four request buckets,
and writes structured JSON logs keyed by request id. Cookie consent gates the only optional storage (the theme).
Legal pages are seeded as drafts. The docs set, AGENTS.md and README are written.
`pnpm verify`, the full production build and `migrations:check` all pass. Tests: 283 passed, 3 skipped. The
Playwright SEO/a11y and smoke specs pass against a production build (20/20 with `E2E_BUILT=1`) and against the dev
server (18 passed, 2 build-only checks skipped).

## Files (phase 06 work; phase 05 files untouched)
New:
- packages/seo/**: meta, JSON-LD builders and validator, sitemap, robots, llms, share adapters, Markdown twins, tests.
- apps/web/src/middleware/{security-headers,rate-limit,request-log}.ts, apps/web/test/request-policies.test.ts,
  apps/web/vitest.config.ts.
- apps/web/src/server/{csp,seo,responses,site-index,route-params}.ts.
- Routes: index.md, [...slug].md, packages/[...name].md, categories/[slug].md, collections/[slug].md, robots.txt,
  sitemap.xml, sitemap-[segment].xml, llms.txt, llms-full.txt.
- Components: seo/SeoHead.astro, share/ShareBar.astro, consent/{consent.ts,ConsentBanner.astro},
  ThemeToggle.astro (replaces ThemeToggle.tsx), admin/canvas-document.ts.
- apps/web/public/og-default.png (1200x630 default card).
- packages/marketplace/src/pages/legal-pages.ts, packages/marketplace/src/seo/site-index.ts.
- packages/page-engine/test/share-image.test.ts, e2e/seo-a11y.spec.ts.
- docs/{security-boundaries,extending-blocks,extending-api,extending-indexers,deployment,operations}.md, AGENTS.md.

Modified:
- BaseLayout.astro, SiteHeader.astro, SiteFooter.astro, global.css, middleware.ts, request-context.ts.
- Pages: index, [...slug], packages/[...name], packages/index, categories/[slug], collections/[slug],
  collections/index, admin/pages/[id].
- package/PackageCard.astro. components/PackageCard.astro was deleted and the home page now uses the package card.
- astro.config.ts (security.csp), wrangler.jsonc (ratelimits, observability), worker-configuration.d.ts.
- Contracts, page-engine and editor for the optional `meta.image`: backward compatible, existing documents validate
  unchanged. Page-engine block-styles.ts gets tables that scroll at 640px and below.
- Default pages and their tests, api pages test, and the root vitest.config.ts project list (adds apps/web).
- docs/architecture.md, README.md.

## Tasks
- [x] packages/seo; Markdown twins equal to renderMarkdown; robots; sitemap index and segments; llms.txt and llms-full.txt (first-party only)
- [x] BaseLayout SEO props: canonical, Markdown alternate, OG/Twitter, JSON-LD, og:image; noindex for error and filtered pages
- [x] Share bar: Copy URL, Copy as Markdown, Share, ChatGPT/Claude prefill, Gemini opens after copying the prompt, manual fallback
- [x] Cookie consent with real gating (`cc_consent`, theme storage only after consent)
- [x] Security headers: hashed CSP, frame-ancestors none except /preview (self), HSTS, nosniff, Referrer-Policy, Permissions-Policy, COOP
- [x] Rate limits: auth, API, publish, search (Workers rate-limit bindings, 429 with the API error body)
- [x] Observability: JSON request logs with x-request-id; Workers Logs enabled
- [x] Performance and a11y budgets: axe finds no serious violations and nothing overflows at 375px on home, package, builder page and policy page; public-page JS budget of 120 KB
- [x] Legal seeds (terms, privacy, cookies, refunds, gdpr, security, subprocessors) marked draft with [TO BE CONFIRMED]
- [x] SiteHeader auth links and a 375px disclosure menu; home page uses package/PackageCard
- [x] meta.image in the contract, operations and editor
- [~] resvg PNG cards: not implemented; the limitation is documented (see Deviations)
- [x] Docs, AGENTS.md, README (links docs/mcp.md and docs/cli.md)

## Tests
- Unit/integration: seo surfaces (sitemap, robots, llms, JSON-LD validity, twins, share URL encoding), request
  policies (headers, CSP merge, rate buckets and keys, 429, request id, consent codec), share image, default and
  legal pages.
- E2E (e2e/seo-a11y.spec.ts): headers and request id, CSP present with no violations on a built site, robots,
  sitemap, llms, twins equal to the API `?format=md`, package head and JSON-LD, share bar clipboard and encoding,
  consent flow, axe and 375px layout, JS budget.

## Fixes in the final pass (evidence)
- A CSP violation on built pages: on Astro 7.3.5 a runtime `Astro.csp.insertStyleHash` never reached the emitted
  header (confirmed by comparing the header against the rendered `<style>` hashes); script inserts do reach it.
  Fixed inline styles (block styles, builder canvas CSS) are now hashed at build time in astro.config.ts; runtime
  hashing is kept for scripts only.
- The policy page was 21px too wide at 375px because of a prose table. Tables now scroll inside the block below
  640px.
- The JS budget was 224 KB against 120 KB, entirely the React runtime hydrated for the theme toggle. The toggle is
  now an Astro component with a small script, so public pages load no React.
- Lint: `console.log` became `console.info` in the request log. Typecheck: added a DOM lib reference to the e2e spec
  and a complete OperationContext in the share-image test.

## Deviations and decisions
- **Consent categories.** The spec listed necessary, analytics and preferences. There is no analytics or tracking
  code, so an analytics switch would gate nothing. The banner offers only essential and preferences, and the
  cookies page says so. docs/security-boundaries.md states that adding tracking requires a new category first.
- **resvg PNG cards: not done.** resvg-wasm adds a large WASM module to the Worker, and the project ships no TTF
  fonts (fontsource provides woff2 only). og:image uses a raster package card or page `meta.image` when one exists,
  otherwise /og-default.png. SVG cards are never advertised. Documented in docs/architecture.md.
- **Rate-limit bindings.** Decision A11 says auth is rate limited by Better Auth's D1 table with "no wrangler
  rate-limit binding used". This phase adds Workers ratelimits bindings for API, search, publish and a coarse auth
  bucket, on top of A11 (Better Auth's limiter is unchanged). Namespace ids are 1001-1004 (local), 2001-2004
  (staging) and 3001-3004 (production). Missing bindings fail open and log at error level.
- **Legal pages.** "Create default pages" creates *and publishes* them, the existing default-pages behaviour, with
  draft wording and placeholders. Local D1 was seeded through the real service, and no fake data was added.
- **Edits outside the "Owns" list,** all required by the controller-added sections: BaseLayout and page wiring,
  SiteHeader, the meta.image contract and page-engine changes, the root vitest.config.ts (phase 05 also edited it;
  both entries are present), and page-engine block-styles.ts (the table overflow fix).

## Phase 05 observations (not edited)
- Lint warning: an unused eslint-disable directive in packages/sdk/src/generated/openapi.ts.
- Earlier dev runs showed a Vite error overlay because `@marketplace/sdk` did not resolve from WebMCP components.
  Axe excludes dev tooling, and the latest dev run no longer showed it.

## Processes
Every dev and preview server started on port 4326 was stopped, and the port is free. A python.exe (PID 35320) is
still running. I did not start it knowingly and left it alone.

## Next steps
- Phase 07: run `E2E_BUILT=1` Playwright against staging after deploy. Check the admin builder canvas under the
  production CSP with a signed-in admin, because the style hash is covered by config but not by e2e (it needs a
  login).
- Before production, legal review replaces the `[TO BE CONFIRMED]` placeholders.

## Unresolved questions
- Should an analytics consent category exist before any analytics is chosen? Current answer: no.
- Should the legal pages be published while they are drafts (the current behaviour), or created unpublished?

Status: DONE_WITH_CONCERNS
Summary: Phase 06 is delivered. verify, the build and migrations:check are green, and the SEO/a11y e2e specs pass on dev and built.
Concerns: resvg PNG cards were not implemented (documented); the consent has no analytics category because there is no analytics; rate-limit bindings are added on top of A11; legal drafts are published by the existing default-pages flow.
