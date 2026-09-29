# Phase 06 — SEO/GEO, sharing, security hardening, legal, docs (M5 + M6)

Status: completed (2026-09-29) · Wave 3 (parallel with 05) · Depends on 02, 03, 04. Report: plans/reports/fullstack-developer-260929-2115-phase-06-seo-hardening.md

## Owns (only these files)
- `packages/seo/**` (new): canonical/meta builder, JSON-LD builders (SoftwareSourceCode/SoftwareApplication,
  ItemList, BreadcrumbList, Organization/Person, TechArticle, FAQPage only from faq blocks), sitemap + segmented
  sitemap index, robots, llms.txt, llms-full.txt, share-target adapters (ChatGPT, Claude, Gemini URL formats behind one adapter module + copy fallback).
- `apps/web/src/pages/{robots.txt,sitemap.xml,sitemap-*.xml,llms.txt,llms-full.txt}.ts`, all `*.md` twin routes
  (`/packages/<name>.md`, `/categories/<slug>.md`, `/collections/<slug>.md`, `/<page-slug>.md`, `/index.md`),
  `apps/web/src/components/seo/**`, `apps/web/src/components/share/**`, `apps/web/src/components/consent/**`.
- `apps/web/src/middleware/security-headers.ts` (+ compose into middleware.ts in coordination: add one import/call only),
  rate-limit wiring for API/publish/search.
- Legal page seeds (PageDocuments via page-engine services): `/terms`, `/privacy`, `/cookies`, `/refunds`, `/gdpr`,
  `/security`, `/subprocessors` — marked "Draft — requires legal review before production launch". Refund page states
  there are no paid transactions. Security page states the narrow meaning of "verified" and the boundary.
- `docs/**` (architecture, security-boundaries, extending-blocks, extending-api, extending-indexers, deployment,
  operations: migrations discipline, backup/recovery via D1 time travel + R2, monitoring/logging), `AGENTS.md`, `README.md`.

## Requirements
- Every public page (home, package detail, category, collection, custom/legal pages): `<link rel=canonical>`,
  `<link rel=alternate type=text/markdown href=…md>`, title/description, OG/Twitter meta with social card image from R2
  (generated at index/publish time; site default card otherwise), JSON-LD from canonical data (no hand duplication).
- Markdown twins render from PageDocument/package data (page-engine renderMarkdown + package markdown template), with
  `Content-Type: text/markdown; charset=utf-8`, cache headers.
- llms.txt: curated navigation map; llms-full.txt: first-party marketplace/docs content only (no third-party READMEs).
- Share bar on every public page: Copy URL, Copy as Markdown, Share (navigator.share fallback), Send to ChatGPT/Claude/
  Gemini via adapters, fallback copies canonical URL + Markdown URL.
- Cookie consent: categories necessary (always) / analytics / preferences; default decline non-essential; consent
  actually gates any non-essential script or cookie (there may be none yet — then the banner must say so honestly and
  still persist the choice).
- Security headers: strict CSP (nonce or hashed inline scripts that Astro emits), frame-ancestors none (except preview
  iframe same-origin), HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy. Rate limits on auth/API/
  publish/search (Cloudflare rate limiting binding declared per env in wrangler if supported; else documented fallback).
- Performance/accessibility budgets documented and checked (Lighthouse CI config or Playwright axe check on key pages).
- Observability: `observability.enabled` in wrangler, structured JSON logs with request id.

## Acceptance
- Tests: sitemap/robots/llms contents, JSON-LD validity for each type, markdown twin equals renderMarkdown output,
  share adapters URL encoding, CSP header present, axe-core no serious violations on home/package/page routes.
- `pnpm verify && pnpm build` green.

## Added by controller after phase 04
- `SiteHeader.astro`: add Sign in / Account links (session-aware via `Astro.locals.actor`) and an Admin link for admins.
- docs/operations: staging/production admin bootstrap — admin requires a verified email; until an email sender exists, an
  admin signs in with GitHub (when configured) or an operator marks `user.email_verified` via a documented
  `wrangler d1 execute` command. Document required secrets: BETTER_AUTH_SECRET, ADMIN_EMAILS, optional GITHUB_CLIENT_ID/SECRET.

## Added by controller after phase 03
- Add a head slot/props to `BaseLayout` for canonical, alternate markdown, OG/Twitter, JSON-LD; wire `og:image` to the
  package social card from R2. Social cards are SVG today — produce PNG (resvg-wasm in apps/jobs if it fits the Worker
  size limit; otherwise document the limitation and keep the site default PNG card for og:image).
- Home page: switch to `components/package/PackageCard.astro` (links to detail page) and delete the old
  `components/PackageCard.astro`.
- Docs: `index:local`, indexing pipeline, curation status meanings (A10 in plan.md), provenance recorded-not-verified.

## Added by controller after phase 02
- `SiteHeader.astro` overflows ~42px at 375px when signed in — fix responsive nav (menu/disclosure) and extend the e2e width check to the whole page.
- PageDocument SEO fields are named `meta` and have no share-image field: add an optional `meta.image` (media id) to the
  contract + editor SEO panel so page social cards/og:image can be set; default to generated/site card otherwise.
- Legal pages are seeded through the page services (`ensureDefaultPages` pattern in packages/marketplace/src/pages).
