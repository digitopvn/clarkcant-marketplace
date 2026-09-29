# Phase 03 — npm indexing, packages, media (M3)

Status: implemented (verify + build green, 2026-09-29) · Wave 2 (parallel with 02, 04) · Depends on 01. Report: `plans/reports/fullstack-developer-260929-2015-phase-03-package-indexing.md`.

## Owns (only these files)
- `packages/marketplace/src/packages/**`, `src/indexing/**`, `src/collections/**`, `src/search/**` (+ tests)
- `packages/media/**` (new): content-addressed R2 storage (`sha256/ab/cd/<digest>.<ext>`), metadata rows, image type sniffing.
- `packages/markdown/**` (new): README → sanitized HTML (unified: remark-parse → remark-gfm → remark-rehype → rehype-sanitize
  (strict schema, no iframes/scripts/style, rel=nofollow ugc on links, relative image URLs rewritten to npm CDN-safe or dropped) → rehype-stringify).
  Also exported for the page-engine rich-text block.
- `apps/jobs/**` (queue consumer, `IndexPackageWorkflow`, cron discovery).
- `packages/api/src/routes/{packages,search,catalog,publish}.ts`
- `apps/web/src/pages/packages/**`, `apps/web/src/pages/categories/**`, `apps/web/src/pages/collections/**`,
  `apps/web/src/pages/media/[...key].ts` (serve R2 with immutable caching), `apps/web/src/components/package/**`.

## Requirements
- Indexing pipeline (issue): submission or discovery → Queue → Workflow steps (each a `step.do` with retries):
  fetch packument (registry.npmjs.org) → resolve exact version (requested or dist-tags.latest) → fetch tarball →
  verify `dist.integrity` (sha512 SRI) against the bytes → record provenance/attestations facts if present →
  untar (gzip via DecompressionStream + minimal tar reader, size limits) → read `package/clarkcant.json` and README →
  validate manifest with contracts schema (reject with a recorded reason if missing/invalid) → sanitize README →
  normalize facets/permissions → upsert package + insert immutable version snapshot (never overwrite an existing
  version row) → update FTS → ingest preview images declared in `previews/` (copy tarball image bytes to R2 media,
  never execute code) → generate social card (SVG; PNG via resvg-wasm in the jobs worker if bundle size allows) → store in R2 → audit event.
- Discovery: cron polls npm search `keywords:clarkcant` (+ `clarkcant-widget`) and enqueues unseen versions.
- Explicit submission: `POST /api/v1/publish/submit { name, version? }` (auth + `packages:submit`, idempotent) creates
  `package_submissions` and enqueues; `GET /api/v1/publish/submissions/:id` status.
  The actual domain function must be callable directly (tests, CLI dev path) without a queue.
- Reads: `GET /api/v1/packages` (filters: q, category, facet kind, isolation, platform, publisher, curation; cursor
  pagination), `/packages/:name` (scoped names URL-encoded), `/packages/:name/versions`, `/search`, `/categories`,
  `/collections`, `/collections/:slug`. Response DTOs from contracts. Security facts (permissions, isolation lanes,
  integrity verified, provenance present) are distinct from curation status. "Verified publisher" has one narrow
  documented meaning (publisher controls the npm scope/repo claim) and never implies code safety.
- Curation commands (admin, `packages:curate`): feature_package, set_curation_status, manage_collection
  (create/update/add/remove/reorder items). Audit + idempotency like phase 02.
- Coordinate / ClarkCant integration: `GET /api/v1/packages/:name/install` returns `{ package, version, source:"npm",
  integrity }` and an `openInClarkCant` deep link `clarkcant://install?source=npm&package=…&version=…` documented as
  a proposed contract (ClarkCant has no scheme yet) plus copyable CLI command fallback.
- Web: `/packages` (search + filters), `/packages/<name>` (detail: install coordinate + copy, facets, capabilities &
  permissions with risk lanes labelled plainly, integrity/provenance facts, versions, sanitized README, previews),
  `/categories/<slug>`, `/collections/<slug>`. Honest empty states. Brand tokens from phase 01.
- Test fixture: build a real example widget package (mirror ClarkCant fixture `frame-widget` layout) under
  `fixtures/widgets/example-frame-widget/` and produce its tarball with `npm pack` in the test setup; the fetcher is
  injectable (registry base URL) so tests serve the real tarball + a packument derived from it. Also a live-network
  test (opt-in `LIVE_NPM=1`) that fetches a real npm packument and verifies integrity of a real tarball.
- Dev path: `pnpm index:local <name>@<version> --tarball <path>` to index into local D1 through the same service.

## Acceptance
- Unit/integration tests: tar reader, integrity verification (pass + tamper fail), manifest validation failures,
  sanitizer strips scripts/iframes/on* attrs/javascript: URLs, immutable versions, FTS results, curation commands.
- After indexing the fixture locally: package visible at `/packages/<name>` and `GET /api/v1/packages/<name>`.
- `pnpm verify && pnpm build` green.
