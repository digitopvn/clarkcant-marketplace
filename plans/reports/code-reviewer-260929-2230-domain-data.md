# Code review: domain logic and data (dev @ 80c122c)

Date: 2026-09-29 (Asia/Saigon). Mode: review-only, no source edits.
Scope: `migrations/`, `packages/db`, `packages/marketplace` (pages, idempotency, indexing, search, collections, media, seo),
`packages/page-engine`, `packages/markdown`, `packages/media`, `apps/jobs`.

Checks run:
- `vitest run packages/{page-engine,markdown,media,marketplace}`: 19 files passed, 1 skipped (live npm). 156 tests passed, 3 skipped.
- Schema drift: ran `drizzle-kit generate` against a temporary copy of `migrations/`. Result: "No schema changes". Drizzle and SQL are consistent. The immutability trigger (0003) and the FTS5 table (0001) are correct as written.
- Markdown cost probe (temporary test, since deleted): 200 KB of `[a](b) ` rendered to 2,685,774 bytes of HTML in 7.3 s. 1 MB of the same input took about 80 s. 1 MB of plain prose took 1.7 s.
- D1 limits checked against the Cloudflare docs: at most 100 bound parameters per query, 1000 queries per invocation (Paid plan), and 2 MB per row.

No blocking issues. XSS escaping in the page engine is sound: every interpolation goes through `escapeHtml`/`safeHref`/`jsonForScript`, and enum props are schema-bound. The Markdown sanitizer is sound too: raw HTML is dropped and the protocol allow-list runs before the URL rewrite. FTS query building is safe (terms are quoted, alphanumeric only, and parameterized). Integrity cannot be skipped: sha512 is required and checked before the archive is parsed, and the tarball origin is pinned.

## Major

### M1. Discovery re-submits rejected packages every 6 hours, indefinitely (confidence: high)
- Where: `packages/marketplace/src/indexing/discovery.ts:51-79`, cron `17 */6 * * *` in `apps/jobs/wrangler.jsonc`.
- Evidence: the skip checks only look for (a) an indexed version and (b) a submission with status `queued`/`indexing`. A submission that ended `failed` (for example `manifest_missing`, `integrity_mismatch` or `manifest_invalid`) matches neither, so it is recreated on every run.
- Impact: any npm package with the `clarkcant` keyword but a bad manifest gets a new `package_submissions` row, an audit event, a Workflow instance and a 25 MB tarball download 4 times a day, forever. Anyone can publish such a package, so this is unbounded table growth and outbound traffic.
- Fix: also skip when the latest submission for (name, version) is `failed` with a rejection code, since rejections are deterministic for an immutable version. Keep retrying only transient `index_failed` results, with backoff. Add a `(package_name, version, status)` index.

### M2. Discovery makes 2+ D1 queries per candidate and will hit the 1000-queries-per-invocation limit (confidence: high)
- Where: `discovery.ts:50-80`, called from `apps/jobs/src/index.ts:102-108`.
- Evidence: there can be up to 2000 hits (1000 per keyword). Each costs 2 SELECTs, plus a batch and a queue send when new. That is at least 1000 queries once about 500 packages carry the keyword.
- Impact: the cron throws partway through on every run. Hits are processed in the same order each time, so packages past the cutoff are never discovered, and M1's waste uses up the query budget first.
- Fix: load the indexed pairs and open or rejected submissions in bulk. Use `inArray` in chunks of 90 or fewer (see M4), or enqueue a `discover` message per page of hits.

### M3. Concurrent draft saves can silently lose an edit (lost update) (confidence: high)
- Where: `packages/marketplace/src/pages/page-service.ts:192-195`, `213-231`, `507-512`.
- Evidence: `assertCurrentDraft` checks a `page` row read earlier. `appendRevision` then reads `max(number)` in a separate query. Suppose B saves r2 (#2) after A's `loadPage` but before A's `max()`. A then computes #3, has no uniqueness conflict, and writes r3 with parent r1 as the current draft. B's edit disappears from the draft lineage. The code comment ("the unique index lets only one win") holds only when both reads happen before either write.
- Fix: derive `number` from the expected base revision (`base.number + 1`) instead of `max()`. The draft is always the newest revision, since no path moves the draft pointer backwards. The unique `(page_id, number)` index then enforces the precondition. Alternatively, add `current_draft_revision_id = expected` as a precondition using the insert-select/NOT NULL trick from `movePublishedPointer`. Add a test that interleaves the two saves.

### M4. Queries exceed D1's 100-bound-parameter limit (confidence: high)
- `page-service.ts:85-91` + `596-602`: `listPageRevisions` passes up to 100 revision ids plus `pageId`, which is 101 parameters. A page with 100 or more revisions will fail to list its history once deployed on D1. The tests pass because the local SQLite limit is higher.
- `packages/marketplace/src/seo/site-index.ts:33-37`: `listPublishedPages` passes every published page id to `inArray`. Once there are more than 100 published pages, the sitemap and llms.txt fail. The query is also unbounded, so it loads every published document into memory.
- Fix: make `MAX_REVISIONS_LISTED` at most 98, or use a join/subquery instead of `inArray`. For `site-index`, aggregate with a join/GROUP BY over `pages` (no id list) and paginate.

### M5. A malicious README costs minutes of CPU and can exceed D1's 2 MB row limit (confidence: high for the measurements, medium for Workers behavior)
- Where: `packages/marketplace/src/indexing/index-package.ts:162-165`, `package-archive.ts:11` (`MAX_README_BYTES = 1 MiB`), `packages/markdown/src/index.ts:62-75`.
- Evidence: link-dense Markdown expands about 13x (200 KB in, 2.68 MB of HTML out, 7.3 s), and a 1 MB input takes about 80 s. The `package_versions` row stores `readme_md` + `readme_html` + `manifest`.
- Impact: the insert fails on row size, or the step runs out of CPU. Neither is an `IndexingRejectedError`, so each attempt is retried 5 times, then marked `failed after retries`. With M1 this repeats every 6 hours. Real "awesome-list" READMEs of 150 KB or more also trip the row limit, so legitimate packages fail too.
- Fix: cap the README at about 256 KB, check `readmeHtml` size after rendering, and turn both into a rejection or a `warn` audit with `readme_html = null`. Consider rendering on read, with caching.

### M6. Kept tar entries are not capped in total, so a gzip bomb can exhaust Worker memory (confidence: medium-high)
- Where: `packages/marketplace/src/indexing/tar-reader.ts:192-201`, `package-archive.ts:41-47`, `94-98`.
- Evidence: `maxTotalBytes = 128 MiB` limits bytes read, not bytes kept. Every entry matching `previews/*.png` (up to 5 MiB) or a README pattern is copied into `entries`, including duplicate paths. `MAX_PREVIEWS` is applied only after the whole archive is buffered. For example, about 25 zero-filled "previews" gzip to under 1 MB, pass the 25 MB tarball cap, and keep about 125 MB in memory. The Worker isolate limit is 128 MB. In addition, `StreamReader.fill` re-copies the whole buffer on every chunk, which is quadratic for a 5 MiB entry.
- Impact: the isolate is killed by out-of-memory. Workflows retry the step, and the package can never be rejected cleanly.
- Fix: stop selecting previews once `MAX_PREVIEWS` are kept, skip duplicate paths inside `selectorFor` (make the selector stateful), and add a `maxKeptBytes` limit (for example 32 MiB) that throws `TarFormatError`. Collect chunks in a list and concatenate once instead of re-merging.

### M7. Account deletion deletes media that published pages still use (confidence: high)
- Where: `packages/marketplace/src/accounts/account-deletion.ts:39-51` → `packages/media/src/media-store.ts:135-148`.
- Evidence: "unreferenced" is detected only through FK `restrict`, and only `package_previews.media_id` has an FK (`packages/db/src/schema/packages.ts:111-113`). Page documents refer to media by id inside JSON: the `media` block, `logo-cloud` and `meta.image`. Uploads are also de-duplicated by sha256 and keep the first uploader as owner, so another editor's later upload of the same image points at the same row.
- Impact: when an editor deletes their account, the R2 objects and rows behind live pages are removed. The pages show broken images, and `publishPage` then refuses to republish them because of the diagnostics.
- Fix: before deleting media, check for references in `page_revisions.document` (published and draft revisions). A `json_tree`/LIKE search on the media id works at the current scale. A better option is a `page_media_refs` table maintained in the `appendRevision` batch. Otherwise, orphan the row (`owner_user_id = null`) instead of deleting it.

### M8. A stale Workflow result can move `latestVersion` backwards (confidence: medium)
- Where: `index-package.ts:341`.
- Evidence: `becomesLatest` compares against `resolved.latestTag`, which Workflows persist from the "resolve version" step. A run that resolved while 1.0 was `latest` and whose ingest step then retries for minutes can finish after 1.1 was indexed, and it sets `latestVersion` back to 1.0. Discovery then sees 1.1 as already indexed and never corrects it. This contradicts the comment ("never moves it backwards").
- Fix: in `finalize`, update only when `current.latestVersion` is null or `semver.gt(resolved.version, current.latestVersion)`. Alternatively, re-read dist-tags in `finalize`.

## Minor

- m1. Search text goes stale after a publisher claim or account deletion (confidence: high). `package-claims.ts:72-79` sets `packages.publisherId`, and `account-deletion.ts:142` deletes publishers, but neither calls `syncPackageSearchDocument`. The only caller is `index-package.ts:381`. The `search-index.ts:7-9` comment says curation and publisher changes re-sync, which is false. Searching by a new publisher misses the package, and a deleted publisher's name still matches. Fix: call sync after those batches.
- m2. The FTS sync deletes by the `UNINDEXED` column `package_id` (`search-index.ts:49`), which scans the whole FTS table on every sync. Use `rowid` mapped to a numeric key, or keep a side mapping.
- m3. `ensureSocialCard` is check-then-insert (`index-package.ts:288-323`). Two workflows for the same version can create duplicate `social_card` rows, for example a user submission with version=null plus a discovery submission with an explicit version. There is no unique index on `(package_version_id, kind)` for social cards.
- m4. The idempotency lease is 60 s (`idempotency-store.ts:17,58`). If a command runs longer, a retry reclaims the key and runs it again. The first caller's `complete` (`85-90`, which filters only on `status_code IS NULL`) then writes its response onto the second caller's reservation. Match `created_at` (or a reservation token) in both `complete` and `release`.
- m5. Collection `create` checks and then inserts (`collection-commands.ts:95-101`). A concurrent duplicate hits `collections_slug_uidx` and surfaces as a 500 instead of `conflict`. Map the constraint error the same way `createPage` does.
- m6. `fetchTarball` calls `new URL(url)` (`npm-registry.ts`), which throws `TypeError` on a malformed `dist.tarball`. That error is treated as transient and retried 5 times instead of being rejected as `invalid_packument`.

## Positive observations (for calibration)
- Publish/rollback preconditions are genuinely atomic: the insert-select sets NOT NULL `revision_id` to NULL when the precondition fails, which aborts the batch.
- The idempotency hash uses canonical JSON and is scoped per principal and command, and a different payload for the same key returns `mismatch`. Package versions are immutable in both application code and a DB trigger.

## Recommended order
M3, M4, M7 (data correctness), then M1+M2 (the cron runs unattended), then M5+M6 (indexer DoS), M8, and the minor items.

## Unresolved questions
- What `limits.cpu_ms` do the jobs Worker and Workflow steps have? This decides whether M5 appears as a CPU kill or as a D1 row-size error.
- Is keeping pages' media alive after the uploader deletes their account intended (the privacy page says "media ... that nothing else uses")? M7's fix depends on that product decision.

Status: DONE_WITH_CONCERNS
Summary: No blocking issues. There are 8 verified major defects: a lost-update race on draft saves, D1 100-parameter overflows in revision listing and the sitemap, account deletion wiping media used by pages, unbounded discovery re-submission plus N+1 queries, README and tar memory/CPU DoS in the indexer, and a stale `latestVersion` regression. Tests pass and the schema has no drift.
