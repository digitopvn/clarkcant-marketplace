# Fullstack report: accept ClarkCant manifest v2 (#5)

- **Date:** 2026-10-05
- **Branch:** `fix/5-manifest-v2`, targeting `dev`
- **PR:** https://github.com/digitopvn/clarkcant-marketplace/pull/6
- **Plan:** `plans/261005-0016-5-manifest-v2/plan.md`
- **Status:** implemented, review findings addressed, PR open, not merged

## Outcome

The indexer accepts ClarkCant's canonical `schemaVersion: 2` manifest, mirrored strictly from ClarkCant's reader
(`parseManifest` in `packages/core/src/widget-package.ts`), including the `manifestProblems` cross-field rules.

- **v1** is upgraded and then held to the canonical rules, as ClarkCant does.
- **A manifest without `schemaVersion`** is rejected at ingest, because ClarkCant no longer reads it. Versions stored
  before that rule stay readable through `normalizeStoredManifest`.

Service capabilities, egress origins and secrets, connection scopes and endpoints, browser tokens and resource
profiles are all handled the same way:

- They are persisted as `package_permissions` rows, written as multi-row inserts sized to D1's 100-parameter limit.
  The new kinds need no migration. A version may store at most 2048 rows; past that it is rejected as
  `manifest_too_large`.
- They appear as structured `services`, `browserTokens`, `resources` and `manifestSchemaVersion` on the API, SDK, MCP
  and WebMCP. These fields are derived from the immutable stored manifest.
- They are shown on the package page and its Markdown twin, worded as requests. Every manifest-derived string in the
  twin is either escaped or placed in an inline code span whose fence cannot be closed by the value (`mdInlineCode`).

Upstream is pinned at `digitopvn/clarkcant@4368e5ed3631645424cc74d0d76aceaf00dca520`, in both directions:

- `fixtures/upstream/clarkcant/` holds 22 shipped manifests (5 reference apps, 2 themes, 14 e2e fixtures including v1
  widgets, and the `clark widget init --template blank` output), each with ClarkCant's verdict.
- `verdicts.json` holds 2039 hostile variants (471 accepted and 1568 rejected by ClarkCant's real `parseManifest`).
- `pnpm contract:check` replays all of them against the mirror. `pnpm contract:sync` refuses to overwrite when a
  contract source hash or verdict changed, or a contract source is gone, unless `--accept` is passed. `--check`
  compares without writing and still writes its report when it cannot run.
- `.github/workflows/upstream-contract.yml` runs that check against ClarkCant `main` weekly and on demand, from the
  default branch only, and opens or updates one tracking issue on drift or when the check cannot run. No checkout
  keeps the job token.

## Acceptance criteria

1. **v2 accepted; v1 keeps parsing; the draft is refused for new versions and readable when stored.** Done. Covered in
   `packages/contracts/test/manifest.test.ts`.
2. **Authority metadata persisted and displayed.** Done. The page panel and the Markdown twin show it, and the API,
   OpenAPI, SDK, MCP and WebMCP return it.
3. **Reference apps and the blank template index from `npm pack` tarballs against real D1.** Done in
   `packages/marketplace/test/indexing-upstream-manifests.test.ts`. The same file indexes a manifest at the
   2048-row limit through a D1 wrapper that enforces the parameter limit, and refuses one at 2049.
4. **Actionable refusals.** Done. The `manifest_invalid` reason lists `path: message` issues.
5. **Cross-repo contract check, both directions.** Done, as described above.
6. **Publisher guide and docs.** Done. The `/publish` guide describes what the marketplace checks and, separately,
   the full `clark widget pack` convention, as pending in digitopvn/clarkcant#465.

## Verification

- `pnpm verify` exits 0:
  - lint: 0 errors, plus 1 warning in the generated SDK that was already there;
  - typecheck: clean;
  - tests: 397 passed and 3 skipped across 44 files.
- `pnpm contract:check`: 25 of 25 passed. Temporarily disabling the cross-field rules made the corpus test report 68
  disagreements, so the corpus detects drift.
- `pnpm contract:sync --from <clone> --check` against the pin and against ClarkCant `main` (both 4368e5ed): no drift.
  A tampered contract hash made the sync exit 1 without writing. A check against a missing checkout exits 1 and
  still writes its report with the reason.
- `pnpm migrations:check`: schema and migrations in sync; no migration files differ from `origin/dev`.
- `pnpm build`: exits 0.
- Screenshots of the permissions panel at 1440, 768 and 375 px for connected-app, image-generator and media-render
  are in `plans/reports/screenshots-261005-manifest-v2/`. They were checked and show no horizontal overflow. They are
  local only and not committed, following repository convention.

## Concerns

- Default pages never overwrite an existing page. The live `/publish` page on staging and production keeps the old
  text until an admin updates it in the page builder.
- The 2048-row limit is the marketplace's own. ClarkCant's per-list limits allow more, so an extreme manifest that
  ClarkCant reads can be refused here, by name.
- The guide describes `clark widget pack` as pending in digitopvn/clarkcant#465. Update it once that ships.
- The facet keyword map (`NPM_FACET_KEYWORDS`) cannot be pinned to ClarkCant until #465 lands, because that is where
  ClarkCant's map lives.
