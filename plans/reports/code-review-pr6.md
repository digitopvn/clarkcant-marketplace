# Code review: digitopvn/clarkcant-marketplace#6 (fix/5-manifest-v2 -> dev)

Head reviewed: `4261ff1` (2 commits over `origin/dev`). Issue: #5. Read-only review.

## Scope

- 39 files, +2941/-167. Core: `packages/contracts/src/manifest.ts`, `packages/marketplace/src/indexing/manifest-validation.ts`,
  `packages/marketplace/src/packages/package-queries.ts`, `packages/seo/src/{package-labels,markdown-twins}.ts`,
  `apps/web/src/components/package/PermissionsPanel.astro`, `fixtures/upstream/clarkcant/**`,
  `scripts/sync-clarkcant-fixtures.mjs`, `packages/contracts/test/upstream-contract.test.ts`, docs, publish guide.
- Upstream compared: `clarkcant` `packages/contracts/src/{install,primitives,grants,network-origin,browser-token,service-egress,service-connection,service-artifacts,resource-profiles}.ts`
  and `packages/core/src/widget-package.ts` (`parseManifest`, `widgetManifestV1Schema`, `upgradeWidgetManifestV1`).

## Evidence gathered

- **Field-for-field fidelity: verified empirically, not just by reading.** I ran the mirror's `readClarkcantManifest`
  and upstream's real `parseManifest` (imported from the clarkcant worktree) on a differential mutation corpus. The
  corpus took all 21 `clarkcant.json` files at `4368e5ed` (reference apps, themes, e2e v1 and v2 fixtures) and
  replaced or deleted each JSON path with 33 adversarial values (path escapes, drive letters, URLs, non-canonical
  origins, foreign or reserved refs, forbidden headers, bad types, schemaVersion 1/2/3, and so on). That gave
  **29,469 cases with 0 verdict divergences** (schemaVersion-less inputs excluded, because the mirror accepts them on
  purpose). Every upstream manifest at the pin is accepted, including the 2 themes and 4 v1 e2e fixtures that are
  not vendored.
- Pins are accurate. All 10 `contractSources` hashes and 5 reference-app hashes in `UPSTREAM.json` match
  `git show 4368e5ed:<path>`, `HEAD` (#465 branch) and `origin/main`. Upstream has not drifted yet.
- `pnpm exec vitest run --project contracts --project seo`: 5 files, 69 tests pass. CI on the PR head is green.
- D1: no migration. `package_permissions.kind` is `text NOT NULL` with no CHECK (`migrations/0000_init.sql:414`).
  `ingestVersion` returns early for an existing version (`index-package.ts:157-158`), so `package_versions` rows
  stay immutable. Detail fields are derived at read time from the stored manifest. The change is additive.
- Requested permissions are never treated as granted. No code path derives a grant, trust tier or curation state
  from manifest content. Every surface (panel, twin, MCP `get_widget_permissions`, WebMCP `inspect_permissions`)
  labels the data as requests. The Astro panel renders only `{}` expressions, which Astro escapes, with no `set:html`.

## Critical

None found.

## Important

### I1. `contract:check` cannot detect upstream drift; it only re-verifies local bytes against a local hash
`packages/contracts/test/upstream-contract.test.ts:54-75`, `scripts/sync-clarkcant-fixtures.mjs:143-151`

- The byte check compares vendored files with hashes that the same script wrote into the same repo. It only fails
  when someone edits a fixture by hand. It never reads ClarkCant.
- The `contractSources` hashes are recorded but **nothing in CI checks them**. Only `contract:sync` compares them,
  and when they differ it only `console.warn`s and then overwrites `UPSTREAM.json` with the new hashes. The warning
  is lost after one run.
- The semantic assertion is one-way: "the mirror accepts upstream's positive examples". There is no assertion that
  the mirror rejects what upstream rejects.
- **Failure scenario:** ClarkCant tightens a rule. For example, `manifestProblems` starts refusing a `ui` facet whose
  `definition` is not `.json`, or `platformSchema` drops `web`. Every vendored example still passes. CI on the
  marketplace stays green indefinitely. If someone runs `contract:sync`, the hashes are rewritten, the warning
  scrolls by, and `contract:check` is still green. Meanwhile the marketplace lists packages that ClarkCant refuses
  to load. That is the exact drift #5 asks to prevent.
- The reverse case (upstream adds a field) is caught only after a manual sync.
- **Fix, either or both:**
  - (a) A scheduled CI job (daily, or on `repository_dispatch` from clarkcant) that fetches the contract sources
    from `digitopvn/clarkcant@main` with `gh api` or a shallow checkout and **fails** (or opens an issue) when any
    `contractSources` sha256 differs from `UPSTREAM.json`.
  - (b) Make `contract:sync` record upstream **verdicts**, not only positive bytes. Run upstream's `parseManifest`
    over a mutation corpus like the one used above and write `{input, ok}` pairs to `fixtures/upstream/clarkcant/verdicts.json`.
    `contract:check` then asserts that `readClarkcantManifest(input).ok === ok` for every pair. That makes the check
    bidirectional.
  - (c) Make a contract-source hash change fail the sync unless a flag such as `--ack-contract-change` is passed.

### I2. The permission-row fan-out can exceed D1's documented 1000-queries-per-invocation limit
`packages/marketplace/src/indexing/manifest-validation.ts:69-95`, `packages/marketplace/src/indexing/index-package.ts:239-261`

- Each permission row is a separate `INSERT` in one `db.batch`.
- Before this PR the worst case was about 290 rows: 128 capabilities, 64 origins, 64 paths, 32 scripts and 2
  devices. The v2 contract allows 64 `tools` facets, each with 64 capabilities, 16 egress origins, 8 secrets and so
  on, which is thousands of rows.
- Under the 256 KiB manifest cap (`package-archive.ts:9`), a minimal capability entry is about 70 bytes, so roughly
  3,000 or more `service-capability` rows fit.
- **Failure scenario:** a large or hostile v2 package produces more than 1000 statements. The batch fails with a D1
  limit error (`docs/architecture.md:137`), which is not an `IndexingRejectedError`. The workflow step retries, the
  message goes to the DLQ, and the submission fails with an opaque reason instead of a clear `manifest_invalid`.
  This was not reproduced against remote D1; local SQLite does not enforce the limit, which is the trap the
  architecture doc warns about.
- **Fix:** bound the number of rows. Either reject with `IndexingRejectedError("manifest_too_large", ...)` when
  `facets + permissionRows + previews + checks` exceeds a budget such as 900, or insert rows as multi-row `VALUES`
  chunks within the 100-bound-parameter limit (5 columns gives 19 rows per statement). Add a test with a manifest
  at the bound.

### I3. The Markdown twin interpolates connection scopes into inline code without escaping, so a scope can break out
`packages/seo/src/markdown-twins.ts:126`

- `connectionScopeSchema` (`manifest.ts:247-249`, identical upstream) allows every printable character except space,
  `"` and `\`. That includes the backtick, `[`, `]`, `(`, `)`, `<` and `>`.
- I verified that the scope ``x`[Install&nbsp;fix](https://evil.example/p)`<img/src=x/onerror=alert(1)>`` is
  accepted by the mirror.
- It renders as `` - Scope `x`[Install&nbsp;fix](https://evil.example/p)`<img…>`: … ``. The result is a live link
  and raw HTML injected into the agent-facing `.md` twin, under the trusted "Requested permissions" heading.
- The HTML page is safe because Astro escapes. The twin is the surface the repo promises agents (`AGENTS.md`,
  `/llms.txt`), and every other untrusted string in the twin goes through `escapeMarkdown`.
- The other backtick interpolations in this block (`capability.detail`, `reach.origin`, `secret.name`, endpoints)
  are safe today only because their regexes happen to exclude the backtick.
- **Fix:** add a `mdInlineCode(value)` helper to `page-engine` that uses a backtick fence longer than any run in the
  value, padded with spaces (CommonMark rule). Use it for every inline-code interpolation, or fall back to
  `escapeMarkdown(scope.scope)`. Add a twin test with a hostile scope.

### I4. New publications in the schemaVersion-less draft are still accepted, although ClarkCant can never load them
`packages/contracts/src/manifest.ts:873-888`; justification in `docs/architecture.md:156-157` and the PR body

- The stated reason is "so versions indexed under the old rule keep their meaning". Old rows are immutable and are
  read through `normalizeStoredManifest` (shape only), so keeping their meaning does **not** require the
  *ingest* path to keep accepting new draft manifests.
- The draft path also skips every `manifestProblems` rule and allows any `isolation` for any `kind`.
- **Failure scenario:** a publisher ships a draft manifest with `{ "kind": "tools", "isolation": "declarative", "entry": "../../x" }`.
  It is indexed and `listed`. The package page shows the low-risk "declarative" lane for an executable service. The
  isolation filter puts it among data-only packages. The install command is offered, but ClarkCant refuses the
  manifest (`parseManifest` returns "schemaVersion must be 2"). That is a listing with misleading trust data for an
  uninstallable package.
- **Fix:** reject schemaVersion-less manifests at ingest with a clear issue ("ClarkCant no longer reads manifests
  without schemaVersion; use 2"). Keep `legacyInstallManifestSchema` in `clarkcantManifestSchema` for reading stored
  rows only. This is a product decision; if the allowance is deliberate, state that in the guide and mark such
  listings as "not installable by current ClarkCant".

### I5. The REVIEW.md gate is unmet: no screenshots at 1440/768/375 for a public UI change
`apps/web/src/components/package/PermissionsPanel.astro`

- `AGENTS.md` and `REVIEW.md` require screenshots to be attached to any PR that changes public UI. The PR body asks
  the reviewer to take them.
- `plans/reports/screenshots-261005-manifest-v2/` exists locally but is untracked and not attached.
- **Fix:** attach them to the PR (as PR comment images, not committed) before merging.

## Minor

- **M1. The publish guide is wrong about driver/voice isolation.** `packages/marketplace/src/pages/default-pages.ts:206`
  says "`driver` and `voice` are `trusted-native`". Upstream `nativeFacetSchema` allows
  `isolation: "service" | "trusted-native"` (`install.ts:165-170`, mirrored at `manifest.ts:407-412`). Change it
  to "`service` or `trusted-native`".
- **M2. The architecture doc names the wrong upstream file and overclaims.** `docs/architecture.md:147` says
  "`parseManifest` in `clarkcant/packages/contracts/src/install.ts`". `parseManifest` lives in
  `clarkcant/packages/core/src/widget-package.ts:159`; `install.ts` holds `packageManifestSchema` and
  `manifestProblems`. Line 154 says "a v1 file is listed exactly when ClarkCant would load it", and the PR body says
  the same. ClarkCant's `readPackage` also refuses a package whose widget definition id disagrees with the facet
  id, or whose `propsSchema` has an unsafe pattern (`widget-package.ts:202-226`). The marketplace checks neither.
  Change it to "listed exactly when ClarkCant's manifest reader accepts the manifest".
- **M3. The guide says `clark widget pack` already does this.** `default-pages.ts:223` says "ClarkCant is adopting this
  convention in `clark widget pack`, which checks the rules and writes the tarball …". digitopvn/clarkcant#465 is
  OPEN and #449 is OPEN, and the live `clark widget pack` does not write `dist/<file>.tgz` yet. Use future tense
  ("will check … once digitopvn/clarkcant#449 lands") so it does not document unshipped behavior as shipped. The
  guide's rule list is also a subset of #465's: it omits `prepack`/`postpack`, `optionalDependencies`/`bundleDependencies`
  and the `license` == `publisher.license` rule. Either list them all or link the canonical source.
- **M4. Strict re-parse of stored manifests in workflow steps.** `index-package.ts:361` and `:410` call
  `clarkcantManifestSchema.parse(row.manifest)`. The v1 member now validates `networkOrigins` with
  `networkOriginSchema`, where the old mirror accepted any string. A workflow that ingested a v1 version under the
  old code and resumes `social card` or `finalize` after deploy, with a non-canonical origin such as
  `https://x.example/`, throws forever, and that submission never finalizes. It is a narrow window but avoidable:
  use the tolerant `normalizeStoredManifest` and fall back to `resolved.*` fields when it returns null.
- **M5. Not all upstream manifests are vendored.** `examples/themes/*/clarkcant.json` (declarative facets), the
  `clark theme init` template and the upstream v1 e2e fixtures are not vendored, so the declarative and v1 paths
  have no pinned real-world coverage. They pass today (verified above). Add them to `sync-clarkcant-fixtures.mjs`.
- **M6. `FACET_KEYWORDS` is duplicated.** `packages/marketplace/fixture-tarballs.setup.ts` duplicates the map from
  upstream `npm-package.ts`. If that map is meant to be contract, pin it through the sync, as with the manifests.
- **M7. The panel omits browser-token detail.** `PermissionsPanel.astro` does not show browser-token `purpose`
  (it only appears as a flat "Scoped browser token" row with no purpose), even though `browserTokens` is in the detail
  payload.
- **M8. Older strict API clients could break.** The `packagePermissionSchema.kind` enum gained 7 values. Any external
  client that validates responses against the old closed enum (an older `clark-market` CLI, if it does) will fail
  on v2 packages. Note this in the API changelog if one exists.

## Edge cases checked and found fine

- v1 `hostApi` gains a min<=max check only through the upgrade, as upstream does. A v1 `version` that is not
  semver is refused, as upstream does. A v1 file is stored as shipped.
- `ws`/`wss` origins are accepted by the shape check and then refused by `serviceEgressProblems` and
  `serviceConnectionProblems` for egress and endpoints, matching upstream.
- `problemIssue` maps `facet X:` problems to path `facets`, and issues are capped at 8.
- Two services that declare the same secret dedupe to one row, and the panel still shows each service's own list.
- `KIND_OPTIONS` drops `widget`, but `?kind=widget` still works through `WIDGET_KINDS` (`search-packages.ts:96`).
- JSON Schema name `clarkcant-install-manifest` still means the draft, so it is not a silent semantic change for
  external consumers. `clarkcant-package-manifest` is new.

## Recommended actions (priority order)

1. I3: escape scope interpolation in the twin and add a hostile-scope test. This is small and closes an injection.
2. I2: bound or chunk the permission inserts and add a test at the limit.
3. I1: add the scheduled upstream-hash job and a verdict corpus, so `contract:check` is bidirectional and detects drift.
4. I4: decide on draft acceptance (product call); I recommend refusing it at ingest.
5. I5: attach screenshots.
6. M1-M4: doc and guide corrections, and the tolerant stored-manifest read.

## Metrics

- Type coverage: strict TS; no `any` added in the reviewed diff.
- Tests: contracts and seo 69/69 locally; CI green (PR reports 376 passed, 3 skipped).
- Lint: no new issues reported by CI.

## Unresolved questions

- Is accepting new schemaVersion-less manifests a deliberate product choice (I4)?
- Does D1 count each statement of a single `db.batch` toward the 1000-query limit in the deployed plan? The
  repo's docs assume it does; I did not verify this against remote D1.
- Is there an external `clark-market` CLI release that validates `permission.kind` strictly (M8)?

Status: DONE_WITH_CONCERNS
Summary: The mirror matches ClarkCant exactly (0 divergences across 29,469 differential cases, pins verified) and D1 changes are additive. Not mergeable as-is: the drift check is one-way and cannot detect upstream changes, connection scopes can inject into the Markdown twin, the permission-row fan-out can exceed D1's 1000-query limit, and new draft manifests ClarkCant cannot load are still listed.
