import { describe, expect, it } from "vitest";

import recorded from "../../../fixtures/upstream/clarkcant-directory/content-digests.json";
import { computeRuntimeContentDigest } from "../src";
import { contentDigestArchives } from "./support/indexing-fixtures";
import { buildTar, gzip, paxRecord, type TarInput } from "./support/tar-builder";

/**
 * The runtime content digest is pinned to ClarkCant's own `inspectNpmTarball`: `content-digests.json` records what
 * ClarkCant computed (or refused) for every committed archive, and the marketplace must reach the same answer, in
 * workerd, without a filesystem.
 */

interface RecordedDigest {
  archive: string;
  ok: boolean;
  digest?: string;
  sizeBytes?: number;
  fileCount?: number;
}

const archives = contentDigestArchives();
const digests = (recorded as { digests: RecordedDigest[] }).digests;

async function archiveOf(entries: TarInput[]): Promise<Uint8Array> {
  return gzip(buildTar(entries));
}

describe("runtime content digest, pinned to ClarkCant", () => {
  it("covers every committed archive", () => {
    expect(digests.map((entry) => entry.archive).sort()).toEqual([...archives.keys()].sort());
    expect(digests.filter((entry) => entry.ok).length).toBeGreaterThanOrEqual(4);
  });

  it.each(digests.map((entry) => [entry.archive, entry] as const))("%s matches ClarkCant", async (name, expected) => {
    const bytes = archives.get(name);
    if (!bytes) throw new Error(`archive ${name} was not provided`);
    const result = await computeRuntimeContentDigest(bytes);
    if (expected.ok) {
      expect(result).toEqual({ ok: true, digest: expected.digest, sizeBytes: expected.sizeBytes, fileCount: expected.fileCount });
    } else {
      expect(result.ok).toBe(false);
    }
  });

  it("gives the same digest when files must be reordered over several reads", async () => {
    for (const expected of digests.filter((entry) => entry.ok)) {
      const bytes = archives.get(expected.archive);
      if (!bytes) throw new Error(`archive ${expected.archive} was not provided`);
      const result = await computeRuntimeContentDigest(bytes, { reorderBudgetBytes: 0, maxPasses: 64 });
      expect(result, expected.archive).toMatchObject({ ok: true, digest: expected.digest });
    }
  });

  it("declines an archive too far out of order for its read budget", async () => {
    const bytes = archives.get("unsorted-tree.tgz");
    if (!bytes) throw new Error("unsorted-tree.tgz was not provided");
    const result = await computeRuntimeContentDigest(bytes, { reorderBudgetBytes: 0, maxPasses: 1 });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("out of order") as string });
  });
});

describe("archives whose digest would depend on the platform", () => {
  it("declines names that differ only by letter case", async () => {
    const result = await computeRuntimeContentDigest(
      await archiveOf([
        { path: "package/README.md", content: "one" },
        { path: "package/readme.md", content: "two" },
      ]),
    );
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("case-insensitive") as string });
  });

  it("declines names that differ only by Unicode normalisation", async () => {
    const result = await computeRuntimeContentDigest(
      await archiveOf([
        { path: "package/café.txt", content: "composed" },
        { path: "package/café.txt", content: "decomposed" },
      ]),
    );
    expect(result.ok).toBe(false);
  });

  it.each(["package/a:b.txt", "package/con.txt", "package/trailing.", "package/back\\slash.txt"])(
    "declines %s, which Windows cannot hold",
    async (name) => {
      const result = await computeRuntimeContentDigest(await archiveOf([{ path: name, content: "x" }]));
      expect(result).toEqual({ ok: false, reason: expect.stringContaining("depends on the platform") as string });
    },
  );

  it("reads a pax path the way ClarkCant does and digests it", async () => {
    const name = `package/${"deep/".repeat(25)}file.txt`;
    const result = await computeRuntimeContentDigest(
      await archiveOf([
        { path: "PaxHeader", type: "x", content: paxRecord("path", name) },
        { path: "ignored", content: "long" },
      ]),
    );
    expect(result).toMatchObject({ ok: true, sizeBytes: 4, fileCount: 1 });
  });

  it("declines bytes that are not a gzip archive", async () => {
    const result = await computeRuntimeContentDigest(new TextEncoder().encode("not a tarball"));
    expect(result.ok).toBe(false);
  });
});
