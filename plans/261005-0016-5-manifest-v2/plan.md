# Accept ClarkCant manifest v2 and pin the cross-repo contract (GitHub issue #5)

Status: implemented, in review (2026-10-05) · Branch: `fix/5-manifest-v2` → `dev` · Source: https://github.com/digitopvn/clarkcant-marketplace/issues/5
Related: digitopvn/clarkcant#194 (community launch), digitopvn/clarkcant#220, digitopvn/clarkcant#449 (package.json convention), #1 (bootstrap).

## Brainstorm contract

### Outcome
The indexer accepts the canonical `schemaVersion: 2` manifest ClarkCant writes today, keeps reading the two older
dialects, shows every authority-related declaration (service capabilities, egress, secrets, account connection,
resource profile, browser tokens) on the package page, its Markdown twin and the API, and a pinned set of upstream
fixtures fails CI when the mirror drifts from ClarkCant's contract.

### Constraints
- Marketplace describes, never grants. Strict objects stay strict; no validation is loosened to make fixtures pass.
- Mirror upstream `packages/contracts/src/install.ts` (field names, bounds, enums) and the cross-field rules of
  `manifestProblems`, which ClarkCant's reader applies before accepting a manifest.
- `package_versions` rows immutable; storage changes additive only. Real D1 in tests, no mocks, no new dependencies.

### Non-goals
- Executing or inspecting package code; checking widget definitions or fixtures inside the archive.
- Rewriting already-published builder pages on live environments (default pages never overwrite).

### Acceptance criteria (issue #5)
1. v2 accepted; schemaVersion 1 widget manifests keep parsing. The schemaVersion-less draft is refused for new
   versions (ClarkCant no longer reads it; decided in review) and stays readable for stored rows.
2. Service capabilities, resources, egress/secrets, connection scopes/endpoints persisted and displayed (page, twin, API).
3. Five reference manifests and a fresh `clark widget init --template blank` manifest validate and index through the
   real pipeline from `npm pack` tarballs against real D1.
4. Invalid v2 manifests are refused with actionable errors (unknown field, bad schemaVersion, lane mismatch, bad ref,
   cross-field problems).
5. `fixtures/upstream/clarkcant/` + `UPSTREAM.json` (repo, commit, sources, sha256), a refresh script and
   `pnpm contract:check`, run by `pnpm test` in CI.
6. Publisher guide and docs describe v2, package.json keywords/version rules and v1 compatibility accurately.

## Steps
1. Contracts: v2 schema + sub-schemas + `manifestProblems`; v1 upgraded to v2 and held to the same checks (as ClarkCant
   does); legacy draft kept; `NormalizedManifest` carries services, resources, browser tokens. Tests first.
2. Upstream fixtures: sync script, `UPSTREAM.json`, contract test (hashes + validation), `contract:check` script.
3. Indexing: `validateManifest` reports `manifestProblems`; new permission kinds; facet ids; kind filter treats
   `widget` and `ui` alike. Pipeline tests index every upstream fixture from real tarballs.
4. Read side: `PackageVersionDetail` gains `services`, `resources`, `browserTokens` (derived from the stored immutable
   manifest); permissions enum extended; OpenAPI/SDK regenerated; MCP/WebMCP tools return them.
5. UI: permissions panel and Markdown twin describe services, egress, secrets, connections and resources.
6. Docs: publisher guide default page, README, `docs/architecture.md`, `docs/extending-indexers.md`, contract refresh
   runbook.

## Progress
Steps 1-6 done. Review follow-up (`plans/reports/code-review-pr6.md`) done: two-way drift check (hostile-variant
verdicts from ClarkCant's `parseManifest`, `--check`/`--accept`, weekly workflow), chunked permission inserts with a
2048-row limit, inline-code escaping in the Markdown twin, the draft refused at ingest, tolerant stored-manifest
reads, guide and docs corrections. Upstream pinned at digitopvn/clarkcant@4368e5ed3631645424cc74d0d76aceaf00dca520. No migration needed (`pnpm migrations:check` clean). Report: `plans/reports/fullstack-261005-manifest-v2.md`.

## Validation
Focused vitest projects, then `pnpm verify`, `pnpm migrations:check`, `pnpm build`, relevant e2e.

## Risk and rollback
- Stored manifests that no longer parse under the stricter mirror: the read side degrades to "no service details"
  rather than failing the page. Rollback is a revert; no migration is required by this change.
