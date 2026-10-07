import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  DIRECTORY_FEED_FORMAT,
  buildDirectoryEntry,
  directoryEntrySchema,
  directoryFeedPageSchema,
  type DirectoryListingFacts,
} from "../src";

/**
 * The directory half of `pnpm contract:check`. `fixtures/upstream/clarkcant-directory/directory-entries.json` holds the
 * entry ClarkCant's `clark widget publish` mapping builds for every manifest ClarkCant ships, checked by ClarkCant's
 * own `directoryEntrySchema` (recorded by `scripts/sync-clarkcant-fixtures.mjs`). The marketplace must build exactly
 * those entries from the same manifests and listing facts, so its feed says what ClarkCant itself would say.
 * `content-digests.json` is proven by the marketplace's workerd tests (`runtime-content-digest.test.ts`).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/upstream");

const recordedSchema = z.strictObject({
  note: z.string(),
  repository: z.string(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  listing: z.strictObject({
    npmName: z.string(),
    digest: z.string(),
    sizeBytes: z.int().nonnegative(),
    preview: z.strictObject({ imageUrl: z.string().optional(), videoUrl: z.string().optional() }),
  }),
  entries: z
    .array(
      z.strictObject({
        path: z.string(),
        accepted: z.boolean(),
        entry: z.unknown().optional(),
        problem: z.string().optional(),
      }),
    )
    .min(1),
});

const recorded = recordedSchema.parse(
  JSON.parse(readFileSync(path.join(ROOT, "clarkcant-directory", "directory-entries.json"), "utf8")),
);
const upstream = z
  .object({ commit: z.string(), files: z.array(z.object({ path: z.string() })) })
  .parse(JSON.parse(readFileSync(path.join(ROOT, "clarkcant", "UPSTREAM.json"), "utf8")));

function vendoredManifest(relative: string): unknown {
  return JSON.parse(readFileSync(path.join(ROOT, "clarkcant", ...relative.split("/")), "utf8"));
}

describe("directory entries pinned to ClarkCant", () => {
  it("were recorded at the pinned commit, for every vendored manifest", () => {
    expect(recorded.commit).toBe(upstream.commit);
    expect(recorded.entries.map((entry) => entry.path).sort()).toEqual(upstream.files.map((file) => file.path).sort());
    expect(recorded.entries.some((entry) => entry.entry)).toBe(true);
  });

  it.each(recorded.entries.filter((entry) => entry.accepted).map((entry) => [entry.path, entry] as const))(
    "%s builds the entry ClarkCant builds",
    (manifestPath, expected) => {
      const manifest = vendoredManifest(manifestPath) as { version: string };
      const listing: DirectoryListingFacts = {
        npmName: recorded.listing.npmName,
        npmVersion: manifest.version,
        digest: recorded.listing.digest,
        sizeBytes: recorded.listing.sizeBytes,
        preview: recorded.listing.preview,
      };
      const built = buildDirectoryEntry(manifest, listing);
      if (expected.entry) {
        expect(built).toEqual({ ok: true, entry: expected.entry });
        // Key order too: ClarkCant hashes nothing over an entry today, but a byte-equal entry leaves nothing to argue.
        expect(JSON.stringify(built.ok ? built.entry : null)).toBe(JSON.stringify(expected.entry));
      } else {
        expect(built.ok).toBe(false);
      }
    },
  );

  it("serves pages ClarkCant's feed reader accepts", () => {
    const entries = recorded.entries.flatMap((entry) => (entry.entry ? [directoryEntrySchema.parse(entry.entry)] : []));
    expect(directoryFeedPageSchema.parse({ format: DIRECTORY_FEED_FORMAT, entries, nextCursor: null }).entries).toHaveLength(
      entries.length,
    );
  });

  it("keeps the committed archives in step with the recorded digests", () => {
    const archives = readdirSync(path.join(ROOT, "clarkcant-directory", "archives")).sort();
    const digests = z
      .object({ commit: z.string(), digests: z.array(z.object({ archive: z.string() })) })
      .parse(JSON.parse(readFileSync(path.join(ROOT, "clarkcant-directory", "content-digests.json"), "utf8")));
    expect(digests.commit).toBe(upstream.commit);
    expect(digests.digests.map((entry) => entry.archive)).toEqual(archives);
  });
});
