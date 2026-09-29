# Fix domain/data review findings

Source review: `plans/reports/code-reviewer-260929-2230-domain-data.md`. Branch `dev`; nothing was committed, pushed or deployed, and no migration was added.

## Result

All eight major findings, three of the four minor findings and the staging default-pages request are fixed. `gates.sh` is green: verify (lint, typecheck and tests) passed with 320 tests passing and 3 skipped, and build and migrations:check both passed. Minor finding m2 (full FTS scan on sync) is deferred; see Concerns.

## Fixes by finding

- **M1 discovery skips terminal failures.** `indexing/discovery.ts` treats a version as handled when it is already indexed or has a submission in queued, indexing or failed state. An explicit `submitPackage` still creates a new submission for that version.
- **M2 discovery batching and cap.** Lookups use chunked IN lists of at most 90 values (`d1-limits.ts`). `MAX_QUEUED_PER_RUN=100`, and the result now includes `pending`, which counts the candidates left for the next run. The jobs log prints it.
- **M3 draft race.** `appendRevision` numbers the new revision base + 1 and sets its parent to the base. It uses the revision the client expected, so the unique index `(page_id, number)` returns 409 to the losing save.
- **M4 IN lists and site index.**
  - `page-service` chunks the publication lookup.
  - `seo/site-index.listPublishedPages` pages by keyset in batches of 100, returns at most 2000 pages, and accepts `afterSlug` and `limit`. `lastPublishedAt` comes from a correlated subquery, so no id list is bound.
  - The collection index is limited to 2000 rows.
- **M5 README caps.**
  - README input is capped at 256 KB and rendered HTML at 512 KB.
  - When a README is too large, the version is still indexed with the README omitted, and a `readme` warn check records the reason. This is a permanent result, not a retry.
  - HTML over the cap keeps the Markdown and drops only the HTML.
- **M6 tar memory.**
  - The stream reader now uses a chunk queue, so reading is linear rather than quadratic.
  - A new `maxKeptBytes` budget (archive budget = 2x manifest + 2x README + 16 MiB of previews) limits retained bytes.
  - Duplicate paths are skipped, and the first copy wins.
  - Previews are limited to the cover plus 7 others, and the archive records `readmeOmitted`.
- **M7 media on account deletion.** `deleteMediaIfUnreferenced` deletes only if no `page_revisions.document` contains the quoted media id, and it checks this in the same statement as the delete. Referenced media keeps its object and has only its owner cleared.
- **M8 forward-only latest.**
  - A new `semver-order.ts` holds the semver precedence rules.
  - Finalize moves `latestVersion` only to a strictly newer version.
  - It uses a compare-and-set on the value it read. A lost race raises a transient error, so the step retries.
- **Minor findings.**
  - Package search text is refreshed after an approved publisher claim, and for the affected packages after an account deletion.
  - A malformed tarball URL now gives `invalid_packument`, which is permanent.
  - A concurrent duplicate collection create returns 409 (`db-errors.isConstraintViolation`).
- **Staging default pages.**
  - The jobs Worker's `scheduled` handler runs `ensureDefaultPagesAsSystem` on every tick. A `*/10 * * * *` cron was added to the top-level, staging and production configs.
  - Discovery now runs only on its own cron, `17 */6 * * *`.
  - Pages are created and published through the page services as the system actor `jobs.default-pages`, with an audit event and a null `publishedBy`.
  - Existing and edited pages are never overwritten. An unfinished earlier run (revision 1 with no author and no publication) is completed.
  - The legal draft banner and placeholders are unchanged.
- **Docs.** `docs/architecture.md` covers the cron table, D1 limits, draft numbering and the media rule. `docs/extending-indexers.md` covers discovery rules, forward-only finalize, the resource limits table and the malformed URL case.

## Tests

- **`test/support/instrumented-d1.ts` (new).** A D1 proxy that fails when a statement binds more than 100 params, records the executed SQL and can inject a hook before execution.
- **`test/pages/page-concurrency-and-limits.test.ts` (new).**
  - Checks `chunked` and the 101-parameter guard.
  - Runs a draft race in which the loser gets 409.
  - Lists 130 revisions and 230 published pages with bound params ≤100, and checks paging.
- **`test/indexing-hardening.test.ts` (new).**
  - Discovery skips failed versions, and an explicit submit still works.
  - 2000 hits give 100 queued and 1900 pending, in fewer than 500 queries.
  - Semver order, and a stale run that does not lower `latestVersion`.
  - README input and HTML caps.
  - Preview, duplicate and kept-byte caps.
  - A malformed tarball URL.
- **`test/account-deletion-media.test.ts` (new).** Referenced media is kept with its owner cleared, unused media is deleted, and the removed publisher's name drops from search.
- **`packages/media/test/media.test.ts`.** Media referenced by a page revision is kept, and is deleted once the reference is gone.
- **Changed tests.**
  - `default-pages.test.ts`: system seeding, recovery and no republish after an edit.
  - `curation-and-submissions.test.ts`: collection create race.
  - `publishers.test.ts`: search text is refreshed after a claim.
  - `indexing-pipeline.test.ts`: expectations include `pending`.

## Concerns

1. **m2 is not fixed.** Search sync still scans the whole FTS table. Fixing it safely needs a package-to-FTS rowid mapping table and a migration, because `packages.rowid` can change on VACUUM. That is left for a separate change.
2. **Web site index caller.** `apps/web/src/server/site-index.ts` is owned by another agent and still calls `listPublishedPages(deps)`. It now gets up to 2000 pages safely. If there can be more pages than that, the sitemap needs to page with `afterSlug`.
3. **Missing label for the new `readme` check.** `packages/seo/src/package-labels.ts` is not in my ownership and has no label for it, so the UI falls back to the raw id "readme".
4. **Security doc is out of date.** `docs/security-boundaries.md` is not in my ownership and still describes default pages as an admin-only action. It does not mention the system actor in the jobs Worker.
5. **README render CPU.** Rendering a 256 KB link-dense README can take several seconds of CPU locally. The Worker's CPU limit (`cpu_ms`) should be confirmed for the jobs and workflow Worker.

Status: DONE_WITH_CONCERNS
Summary: The eight major findings, three of the four minor findings and staging default-page seeding are fixed with tests, and gates.sh is green (320 passed, 3 skipped).
Concerns/Blockers: m2 (full FTS scan) is deferred because it needs a migration. The web sitemap caller should adopt paging, and the seo check label and security doc are outside my ownership.
