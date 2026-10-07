# ClarkCant directory feed

`GET /api/v1/directory` is the feed ClarkCant's official directory source reads
(`clarkcant/packages/core/src/marketplace-directory.ts`). It lists packages in ClarkCant's own `DirectoryEntry`
shape, so ClarkCant can show them before anything is downloaded. Every entry is a discovery claim: ClarkCant
re-resolves the npm version, checks npm's integrity and the entry's `digest` against the bytes it fetched, reads the
downloaded `clarkcant.json` and applies its own policy. Nothing in the feed grants anything.

Code: `packages/marketplace/src/directory/`, the route in `packages/api/src/routes/directory.ts`, the shapes in
`packages/contracts/src/directory.ts`.

## Shape

```json
{ "format": "clarkcant-directory@1", "entries": [DirectoryEntry, ...], "nextCursor": "v1.pv_..." }
```

- `format` is always `clarkcant-directory@1`.
- `entries` holds one entry per publicly visible (`listed` or `featured`), measured version whose package holds its
  ClarkCant package id (below). Every version is listed, not only the latest. ClarkCant refuses a whole feed when one
  entry does not match its schema, so an entry is built and validated against the mirrored `directoryEntrySchema`
  before it is served, and a version that does not validate is left out.
- `nextCursor` is null on the last page; otherwise pass it back as `?cursor=`. A cursor is opaque, at most 200
  characters, and stays valid: paging is a keyset over the time-ordered version id, so versions indexed, hidden or
  relisted between requests never shift a page, and new versions arrive on later pages. A cursor the feed did not
  issue is a `400 validation_failed`.
- `limit` defaults to and is capped at 250 entries. A page also stops at about 4 MiB of entries (ClarkCant refuses a
  page over 8 MiB, and reads at most 20 pages and 5,000 entries), and considers at most 1,000 versions per request.
- Anonymous responses carry `Cache-Control: public, max-age=300, s-maxage=300`; a request with credentials keeps
  `private, no-store`.

## What an entry is built from

The mapping is `clark widget publish`'s (`directoryEntryOf` in `packages/contracts/src/directory.ts`), from the
stored `clarkcant.json` as ClarkCant reads it (`schemaVersion` 1 upgraded, so a v1 `widget` facet is a `ui` facet):
id, version, names, publisher, facets, per-facet isolations, platforms, `hostApi`, the permission summary,
`declaredReach` and `resources` when they say anything, and `riskTier` from the strongest isolation. The listing adds:

| Field | Source |
| --- | --- |
| `source` | `{ kind: "npm", name, version }`, the indexed npm coordinate |
| `digest`, `sizeBytes` | The runtime content digest and the total bytes of the archive's regular files, measured at index time (below) |
| `preview.imageUrl` | The first stored preview image, as an absolute URL on `PUBLIC_SITE_URL` |

A version is left out, with the reason shown on the package page (`latest.directory` on `GET /api/v1/packages/{name}`),
when its manifest names no `publisher`, when its archive has no digest, or when another package holds its id.

## Runtime content digest

`packages/marketplace/src/indexing/runtime-content-digest.ts` computes, in the Worker and without a filesystem, the
digest ClarkCant computes after fetching an npm version (`inspectNpmTarball` in `clarkcant/packages/core/src/package-fetch.ts`):
one sha256 over every regular file, sorted by path, as `<path>\0<length>\0<bytes>`, written `sha256:<hex>`. It
replays ClarkCant's tar reader (ustar magic required, pax and GNU long names, first path component stripped) and the
effect the writes have on disk (`.` segments, later writes replacing earlier ones, file/folder conflicts).

Its answer is ClarkCant's digest or none, never a different one. An archive ClarkCant refuses (links, devices, path
traversal, duplicate names, a pax size override) gets none, and so does one whose extracted tree would depend on the
platform: names equal except for letter case or Unicode normalisation, or names Windows cannot hold.

It is pinned to ClarkCant's code: `fixtures/upstream/clarkcant-directory/archives/` holds archives built by
`scripts/build-content-digest-fixtures.mjs` (one real `npm pack`, the rest written byte by byte to reach every reader
rule), `content-digests.json` records what ClarkCant's `inspectNpmTarball` returned for each, and
`packages/marketplace/test/runtime-content-digest.test.ts` requires the same answer in workerd. Likewise
`directory-entries.json` records the entry ClarkCant builds for every manifest it ships, and
`packages/contracts/test/upstream-contract-directory.test.ts` requires byte-equal entries. Both are recorded by
`pnpm contract:sync` ([how](extending-indexers.md#keeping-the-manifest-mirror-in-sync-with-clarkcant)).

## Package id collisions

npm names are unique; the `id` in `clarkcant.json` is not, and ClarkCant installs by that id. When several public
packages have a measured version declaring the same id, one holds it (`package-id-owners.ts`):

1. a package with a verified publisher wins over one without;
2. then the package that claimed the id first (its earliest indexed version declaring it);
3. then the npm name in byte order.

Only the holder's versions are in the feed. The others stay listed on the marketplace, and their package page names
the holder. Hiding the holder hands the id to the next claimant, which gives curators the way to resolve a dispute.
The rule decides discovery only; ClarkCant decides what an install of that id may do.

## Storage and backfill

`package_version_artifacts` holds one row per version: the manifest id, the digest, size and file count, or the
reason there is no digest. The ingest stage writes it in the same batch as the version, from the integrity-verified
tarball. A version indexed before the table existed gets its row:

- when it is indexed again (the pipeline re-downloads it only for this, checks it against the stored integrity, and
  never rewrites the version), or
- from `backfillVersionArtifacts`, which the jobs Worker runs on every cron tick for up to 5 versions, oldest first.
  A tarball npm no longer serves, or serves with other bytes, is recorded without a digest; a transient failure is
  logged and retried on a later tick.

PackageDetail (`latest.directory`) and the install coordinate (`packageId`, `contentDigest`, `sizeBytes`) expose
the same facts. A version not measured yet has `directory: null`.
