# Phase 03 — npm indexing, packages, media: implementation report

Phase: `plans/260929-1909-gh1-marketplace-bootstrap/phase-03-package-indexing.md` · Status: completed · 2026-09-29

## Outcome
The npm indexing pipeline now runs end to end on a real `npm pack` tarball. It covers integrity, untar, manifest
validation, sanitized README, previews in R2, the social card, FTS, audit and immutable versions. Around it are the
submission, read, install and curation APIs, and the package, category and collection web pages.

Checks run: `pnpm verify` (lint, typecheck, 194 tests passed, 3 live tests skipped), `pnpm build` and
`pnpm migrations:check`. All three passed.

`pnpm index:local` indexed the fixture into local D1/R2. `astro dev --port 4323` then served it:
- `/packages/@clarkcant/example-frame-widget` returned 200 with the install panel, the isolation lane, previews and
  the README image resolved to jsDelivr.
- `GET /api/v1/packages/%40clarkcant%2Fexample-frame-widget`, `/install`, `/versions` and `/search?q=frame` all
  returned 200.
- `/media/sha256/...png` returned 200 with immutable caching, nosniff and a sandboxed CSP.
- Unknown package, category and collection pages returned 404; bad filters returned 400.

I stopped the dev server afterwards and port 4323 is free. No new migration was needed.

## What was built
- **`@marketplace/markdown`**: `renderMarkdownToSafeHtml(md, {baseUrl, linkRel, maxLength})` renders through
  remark-gfm and a strict rehype-sanitize. Raw HTML is never parsed. Links are http(s)/mailto and images https
  only. Relative URLs resolve against the npm CDN. External links get `rel="nofollow ugc noopener noreferrer"`.
- **`@marketplace/media`**: content-addressed R2 storage (`sha256/ab/cd/<digest>.<ext>`). Image type is detected
  from the file's own bytes (PNG/JPEG/GIF/WebP, never SVG from users), with a 5 MiB cap and deduplication.
  `serveMediaObject` validates keys, supports ETag/304 and sets an immutable, nosniff, sandboxed-CSP response.
- **Indexing** (`packages/marketplace/src/indexing/`):
  - A streaming ustar reader (pax and GNU long names, checksum, entry and size limits, DecompressionStream).
  - sha512 SRI verification (sha1 alone is never trusted).
  - A registry client with capped reads and a same-origin tarball rule.
  - Manifest validation. Union errors are reported per field, e.g. `facets.0.isolation`.
  - Permission rows, previews and the SVG social card.
  - `indexPackage`, split into stages: start → resolve → ingest (one atomic batch) → social card → finalize.
    Finalize moves the latest pointer only forward, syncs FTS and writes the audit.
  - Rejections are recorded with a code and reason.
- **Submissions and discovery**:
  - `submitPackage` (`packages:submit`) dedupes open submissions and honours `Idempotency-Key`. If enqueueing
    fails, the submission is marked failed. It works without a queue when given `enqueue:false`.
  - `getSubmission` is visible to the submitter and to curators.
  - `discoverNpmPackages` searches for `keywords:clarkcant` and `clarkcant-widget`. `handleIngestMessage` handles
    queue messages.
- **Jobs Worker**: each stage is a durable `step.do` with 4 retries and exponential backoff. Rejections come back as
  step data, so they are never retried. There is one Workflow instance per submission id, so a redelivered message
  is harmless. The cron runs discovery.
- **Curation** (`packages:curate`): `setCurationStatus`, `featurePackage` and `manageCollection`
  (create/update/add_item/remove_item/reorder). Each writes its change and audit in one batch and supports
  idempotency keys.
- **API** (OpenAPI-documented):
  - `GET /packages` filters on q, category, kind, isolation, platform, publisher and curation, with a cursor.
  - `GET /packages/{name}/versions`.
  - `GET /packages/{name}/install?version=` returns `{package, version, source:"npm", integrity,
    openInClarkCant, cliCommand}`.
  - `POST /publish/submit` answers 202; `GET /publish/submissions/{id}`.
  - `POST /curation/packages/{name}/status`, `POST .../featured`, and `GET`/`POST /curation/collections/{slug}`.
- **Web**:
  - `/packages` has search plus five filters.
  - `/packages/<name>` shows the install coordinate with copy buttons, the proposed deep link, facets and
    platforms, the permissions with labelled risk lanes, the integrity and provenance facts, the versions, the
    sanitized README and the previews.
  - `/categories/<slug>`, `/collections` and `/collections/<slug>`, plus `/media/...`.
  - Every page has an honest empty state and a 404 page, and uses the brand tokens only.
- **Fixture**: `fixtures/widgets/example-frame-widget/` is a real widget package with a real 600×315 PNG cover.
  - Vitest globalSetup `npm pack`s it, plus three variants: next version, missing manifest and invalid manifest.
  - Tests serve those exact bytes from `createLocalRegistryFetch`.
- **Dev path**: `pnpm index:local <name>@<version> --tarball <path>` (`scripts/index-local.mjs`) indexes into the
  local D1/R2 of `apps/web` through the same pipeline.

## File map
- `packages/markdown/**` (11 tests), `packages/media/**` (7 tests; media gained a `drizzle-orm` dependency)
- `packages/marketplace/src/indexing/*`: tar-reader, integrity, npm-registry, package-archive, manifest-validation,
  social-card, index-package, submissions, discovery, local-registry, indexing-errors, index
- `packages/marketplace/src/packages/{package-queries,package-rows,curation-command,curation-commands}.ts`,
  `src/search/search-packages.ts`, `src/collections/collection-commands.ts`
- `packages/marketplace/test/`:
  - `tar-and-integrity` (10 tests), `indexing-pipeline` (14), `curation-and-submissions` (13), `social-card` (1)
  - `npm-live` (3, run only with `LIVE_NPM=1`; passed against registry.npmjs.org)
  - `support/{indexing-fixtures,tar-builder}.ts`
- `packages/marketplace/fixture-tarballs.setup.ts`, `fixtures/widgets/example-frame-widget/**`
- `packages/api/src/routes/{packages,publish,curation}.ts`, `catalog.ts` (mounts curation) and
  `test/packages-publish-curation.test.ts` (6 tests, real Better Auth sessions)
- `apps/jobs/src/index.ts`, `scripts/index-local.mjs`
- `apps/web/src/pages/packages/{index,[...name]}.astro`, `pages/categories/[slug].astro`,
  `pages/collections/{index,[slug]}.astro` and `pages/media/[...key].ts`
- `apps/web/src/components/package/*`: `PackageCard`, `PackageGrid`, `PackageFilters`, `InstallPanel`,
  `PermissionsPanel`, `SecurityFacts`, `PackageReadme`, `package-labels.ts`

**Shared files with minimal edits (please review):**
- `packages/contracts/src/{packages,search,submissions,json-schema}.ts`: filter shape, install, curation and
  collection schemas. The submit input field is renamed `packageName` → `name`, per the spec.
- `packages/marketplace/src/index.ts`: exports.
- `packages/marketplace/{package.json,vitest.config.ts}`.
- `vitest.d1.ts`: `r2Buckets: ["MEDIA"]` and an optional `globalSetup`.
- `test/d1/env.d.ts`: `MEDIA`.
- Root `package.json`: the `index:local` script and the `tsx@4.23.15` devDependency (already in the lockfile
  transitively).

## How to add an indexer step
1. Write the stage as an `async` function in `src/indexing/index-package.ts` that takes `deps` plus small
   identifiers such as `versionId`. It must be idempotent: check for existing rows or media first, the way
   `ensureSocialCard` does, because Workflows retry a stage after partial success.
2. Call it inside `indexPackage` with `await step("<stable name>", () => yourStage(...))`, between "social card"
   and "finalize". Do not rename existing stage names, because in-flight Workflow instances replay by name.
3. Return only small JSON (ids, flags). Never return bytes, because Workflows persist step results.
4. For a permanent artifact problem, throw `IndexingRejectedError(code, message)` and add the code to
   `indexing-errors.ts`. It is recorded once and never retried. Any other error is retried by the Workflow and
   then recorded as `package.index_failed`.
5. Record facts as `package_audits` checks (pass/warn/fail) with a label in `components/package/package-labels.ts`.
   Never change curation from a check.
6. Cover the stage in `test/indexing-pipeline.test.ts` through `fixtureRegistry(...)`, which uses real tarballs.

## Deviations and decisions
- **Initial curation status (policy, needs sign-off):** `INITIAL_CURATION_STATUS = "listed"`. A package that
  passes the automated checks is public immediately; curators hide or reject afterwards. With `unreviewed`,
  nothing would appear until an admin acted. Re-indexing never changes curation.
- **Social card is SVG, not PNG:** resvg-wasm is not bundled. The card is served from `/media` and linked on the
  page, but it is not an `og:image`, because `BaseLayout` (not mine) has no head slot for one. Many social
  crawlers ignore SVG.
- **Provenance is recorded, not verified:** attestations URL, predicate type and registry signature key ids are
  stored and labelled "not verified". Sigstore verification is a gap.
- **Deep link:** `clarkcant://install?source=npm&package=…&version=…` is documented as PROPOSED in the contract
  and in the UI. The CLI fallback is `npm pack <name>@<version>`, because there is no ClarkCant install CLI yet.
- **README URLs:** relative README links and images resolve to `https://cdn.jsdelivr.net/npm/<name>@<version>/`,
  never to our origin. README preview images are not copied to R2; only `previews/*` files are.
- **Curation routes** live in `routes/curation.ts`, mounted from the catalog router, so `app.ts` is untouched.
  OpenAPI tags `publish` and `curation` are used but not described in `app.ts`'s tag list.
- **`listPackages` input:** it accepts raw query-string records and validates them itself.
- **Reuse:** discovery and the CLI share `createSystemSubmission` (system-actor submission plus audit in one
  batch).

## Gaps and follow-ups
- A PNG social card and `og:image` meta, which need the `BaseLayout` owner.
- Sigstore provenance verification.
- The home page still uses `components/PackageCard.astro`, which links to npm. It should switch to
  `components/package/PackageCard.astro`, which links to the detail page.
- Docs: `index:local` and the new API routes are not yet in README/docs; the docs owner should add them. The
  OpenAPI document is complete.
- There is no admin UI for curation yet; it is API only.
- Discovery caps at 1000 hits per keyword per cron run.

## Unresolved questions
1. Is `listed` the right initial curation status, or should indexed packages start `unreviewed`?
2. Should `packages/api/src/app.ts` gain `publish` and `curation` tag descriptions? That file is shared and was
   not edited.

Status: DONE_WITH_CONCERNS
Summary: The Phase 03 pipeline, APIs, web pages, fixture and local indexing CLI are implemented; `pnpm verify`, `pnpm build` and `migrations:check` pass, and the fixture was indexed locally and served on port 4323.
Concerns/Blockers: Packages are auto-listed on indexing (policy needs sign-off); the social card is SVG only, with no og:image; provenance is recorded but not verified.
