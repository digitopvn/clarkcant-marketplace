# Indexing pipeline and extending it

Indexing turns an npm package version into an immutable `package_versions` row, a public listing and search entry.
The code lives in `packages/marketplace/src/indexing`; the jobs Worker (`apps/jobs`) runs it durably.

## How packages arrive

| Source | Path |
| --- | --- |
| Discovery cron (`17 */6 * * *` in `apps/jobs/wrangler.jsonc`) | `discoverNpmPackages` searches npm for the keywords in `DISCOVERY_KEYWORDS` (`clarkcant`, `clarkcant-widget`) and creates a system submission for each unseen `name@latest` (see below) |
| Publisher submission | `POST /api/v1/publish/submit` (scope `packages:submit`), the CLI or MCP |
| Local development | `pnpm index:local <name>@<version> --tarball <file.tgz>` (below) |

Discovery skips a `name@version` that is already indexed, has a submission in flight (`queued`, `indexing`), or has a
`failed` submission. A version is immutable, so a failure (a rejection, or retries exhausted) would only repeat;
after fixing the cause (for example a transient npm outage), resubmit explicitly through the publish API, CLI or MCP.
Lookups are batched in `IN` lists of at most 90 names (`d1-limits.ts`; D1 binds at most 100 parameters per
statement), and one run queues at most `MAX_QUEUED_PER_RUN` (100) new submissions; the rest are picked up by the next
run. That keeps a run far below D1's 1000-queries-per-invocation limit.

Each submission becomes an `index-package` message on the ingest queue. `handleIngestMessage` starts an
`IndexPackageWorkflow` instance keyed by the submission id; failed messages retry and then land in the
dead-letter queue (`*-ingest-*-dlq`).

## Stages

`indexPackage` (`index-package.ts`) runs each stage through a `StepRunner`: Workflow steps in the jobs Worker
(durable and retried per step), inline in tests and `index:local`.

1. **resolve**: fetch the packument and pin the exact version (`npm-registry.ts`). Tarball URLs must point at the
   configured registry (`untrusted_tarball_url` otherwise).
2. **ingest**: download the tarball (size-capped), verify the registry's sha512 `integrity`
   (`integrity.ts`), untar in memory (`tar-reader.ts`), find and validate the ClarkCant manifest
   (`manifest-validation.ts`; `schemaVersion` 2, 1 and the unversioned draft), sanitize the README, store preview images in R2, and write the
   immutable version row.
3. **social card**: render the package card (`social-card.ts`, SVG).
4. **finalize**: move the latest pointer, refresh the FTS index, close the submission, write the audit record. The
   pointer follows npm's `latest` dist-tag but only moves forward in semver order, with a compare-and-set on the
   value it read, so a stale Workflow run that finishes late never rolls it back.

Resource limits in the ingest stage (`package-archive.ts`, `tar-reader.ts`, `index-package.ts`):

| Limit | Value | When exceeded |
| --- | --- | --- |
| Tarball download | 25 MiB | rejected, `tarball_too_large` |
| Uncompressed archive read | 128 MiB, 20,000 entries | rejected, `invalid_tarball` |
| Bytes kept in memory (manifests, READMEs, previews) | about 17 MiB | rejected, `invalid_tarball` |
| Previews | first `cover.*` plus 7 others, 5 MiB each, 16 MiB total, first copy of a path wins | extra previews are skipped |
| README source | 256 KiB | README omitted; `readme` warn check records why |
| Rendered README HTML | 512 KiB | HTML omitted (source kept); `readme` warn check |

README limits never fail the version: the README is a deterministic fact of an immutable version, so retrying
could only repeat the result. The HTML cap keeps the version row well under D1's 2 MB row limit.

A package that fails a check is rejected with an `IndexingRejectedError` code (`indexing-errors.ts`:
`package_not_found`, `integrity_mismatch`, `manifest_invalid`, `tarball_too_large`, `invalid_packument` for a
malformed tarball URL, …) recorded on the submission; nothing is published.

## What indexing establishes, and what it does not

A newly indexed package is `listed`: it **passed automated checks** (manifest and integrity) and was **not reviewed
by a person**. `featured` is set by curators; `hidden` and `rejected` remove a package from every public surface.
npm provenance (attestations, signature key ids) is **recorded when present, not verified** by the marketplace. See
[security boundaries](security-boundaries.md#curation-and-trust).

## `pnpm index:local`

```sh
pnpm db:migrate:local
pnpm index:local @scope/widget@1.2.0 --tarball ./widget-1.2.0.tgz
```

`scripts/index-local.mjs` runs the same pipeline against the **local** D1 and R2 (the state `pnpm dev` uses), with an
in-process npm-compatible registry built from the tarball itself. It never contacts npm or remote resources. Create
the tarball with `npm pack` in the package's directory.

## Keeping the manifest mirror in sync with ClarkCant

`packages/contracts/src/manifest.ts` copies ClarkCant's manifest contract rather than importing it, so the two can
drift. `fixtures/upstream/clarkcant/` holds real manifests from ClarkCant: every
`examples/reference-apps/*/clarkcant.json` and the manifest `clark widget init --template blank` writes.
`UPSTREAM.json` records the repository, the full commit SHA, each file's source path and sha256, and the sha256 of
the ClarkCant contract sources the mirror follows.

- `pnpm contract:check` proves the vendored files are byte-for-byte what `UPSTREAM.json` records and that the mirror
  accepts every one. It is part of `pnpm test`, so `pnpm verify` and CI run it.
- `packages/marketplace/test/indexing-upstream-manifests.test.ts` packs each fixture with `npm pack` and indexes it
  through the real pipeline against D1.

To refresh, with a clean ClarkCant checkout at the commit to pin and its dependencies installed (`pnpm install`):

```sh
pnpm contract:sync --from ../clarkcant
pnpm contract:check
```

The script reads the manifests from the checkout's `HEAD`, runs the checkout's own CLI for the blank template, and
refuses when the CLI or contract packages have uncommitted changes. It warns when a contract source hash changed:
read that diff in ClarkCant (`install.ts`, `primitives.ts`, `grants.ts`, the `service-*` modules,
`resource-profiles.ts`, `widget-package.ts`), port it to `manifest.ts` with a test, and run `pnpm verify`. Never edit
the vendored files by hand; the check fails on any change.

## Extending

- **A new check**: add it to the ingest stage, throw `IndexingRejectedError` with a new code (extend
  `IndexingRejectionCode`), and cover it in `packages/marketplace/test` with a real tarball fixture. Checks must be
  deterministic: Workflow steps are retried, so a step must produce the same result on replay.
- **A new source** (another registry, a webhook): produce submissions with `createSystemSubmission` and
  `enqueueIngest` (`submissions.ts`) instead of indexing directly, so retries, audit and idempotency stay in one
  place. Treat every external response as untrusted input and validate it with contracts.
- **New derived data**: keep stage results small JSON values (Workflows persist them); store blobs in R2 via
  `packages/media`. Never mutate an existing `package_versions` row; a new version is a new row.
