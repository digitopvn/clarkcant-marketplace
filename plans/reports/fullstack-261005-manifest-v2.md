# Fullstack report: accept ClarkCant manifest v2 (#5)

- **Date:** 2026-10-05
- **Branch:** `fix/5-manifest-v2`, targeting `dev`
- **PR:** https://github.com/digitopvn/clarkcant-marketplace/pull/6
- **Plan:** `plans/261005-0016-5-manifest-v2/plan.md`
- **Status:** implemented and PR open, not merged

## Outcome

The indexer now accepts ClarkCant's canonical `schemaVersion: 2` manifest. It is mirrored strictly from the pinned `install.ts` and includes the `manifestProblems` cross-field rules. Both older dialects still parse:

- **v1** is upgraded and then held to the canonical rules, as ClarkCant does.
- **The draft without a `schemaVersion`** is accepted as before.

Service capabilities, egress origins and secrets, connection scopes and endpoints, browser tokens and resource profiles are all handled the same way:

- They are persisted as `package_permissions` rows. The new kinds need no migration.
- They appear as structured `services`, `browserTokens`, `resources` and `manifestSchemaVersion` on the API, SDK, MCP and WebMCP. These fields are derived from the immutable stored manifest.
- They are shown on the package page and its Markdown twin, worded as requests.

Upstream is pinned at `digitopvn/clarkcant@4368e5ed3631645424cc74d0d76aceaf00dca520`:

- `fixtures/upstream/clarkcant/` holds 5 reference apps plus the real `clark widget init --template blank` output.
- `UPSTREAM.json` records the source paths and sha256 of the manifests and of 10 contract sources.
- `pnpm contract:sync` and `pnpm contract:check` refresh and check them. The check runs inside `pnpm test`, so CI runs it.

## Acceptance criteria

1. **v2 accepted; v1 and the draft keep parsing.** Done. Covered in `packages/contracts/test/manifest.test.ts`.
2. **Authority metadata persisted and displayed.** Done. The page panel and the Markdown twin show it, and the API, OpenAPI, SDK, MCP and WebMCP return it. The SDK was regenerated.
3. **Five reference apps and the blank template index from `npm pack` tarballs against real D1.** Done in `packages/marketplace/test/indexing-upstream-manifests.test.ts`.
4. **Actionable refusals.** Done. The `manifest_invalid` reason lists `path: message` issues, with v2 negative tests in contracts and in the pipeline.
5. **Cross-repo contract check.** Done. The pieces are the fixtures, `UPSTREAM.json`, `scripts/sync-clarkcant-fixtures.mjs`, `pnpm contract:check`, and a runbook in `docs/extending-indexers.md`.
6. **Publisher guide and docs.** Done. The `/publish` default page, README, `docs/architecture.md`, `docs/extending-indexers.md` and `docs/mcp.md` are updated. The `package.json` convention from ClarkCant #449 is described as being adopted, not as shipped.

## Verification

- `pnpm verify` exits 0:
  - lint: 0 errors, plus 1 warning in the generated SDK that was already there;
  - typecheck: clean;
  - tests: 376 passed and 3 skipped across 43 files.
- `pnpm contract:check`: 8 of 8 passed.
- `pnpm migrations:check`: schema and migrations in sync.
- `pnpm build`: exits 0.
- `pnpm test:e2e` against the local dev server, with three reference apps and the example widget indexed by `pnpm index:local`: 23 passed and 8 skipped. The skips need admin credentials, published builder pages, or a production build.
- Screenshots of the permissions panel at 1440, 768 and 375 px are in `plans/reports/screenshots-261005-manifest-v2/`. They are local only and not committed, following repository convention. No horizontal overflow was found.

## Concerns

- Default pages never overwrite an existing page. The live `/publish` page on staging and production keeps the old text until an admin updates it in the page builder.
- The draft without a `schemaVersion` is a marketplace-only allowance; ClarkCant no longer reads it. Removing it later is a product decision.
- `packages/contracts/tsconfig.json` now uses `types: ["node"]`. The tests need Node APIs, and the mirror needs the `URL` global that every runtime here provides.
- The publisher guide describes `clark widget pack` keyword enforcement as being adopted (ClarkCant #449). Update the guide once that ships.
