import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildDirectoryEntry, canonicalManifestOf, type DirectoryListingFacts } from "../src";

const LISTING: DirectoryListingFacts = {
  npmName: "@acme/widget",
  npmVersion: "1.0.0",
  digest: `sha256:${"a".repeat(64)}`,
  sizeBytes: 12,
  preview: {},
};

/** ClarkCant's blank template, as its CLI writes it (vendored by `pnpm contract:sync`). */
const MANIFEST = JSON.parse(
  readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/upstream/clarkcant/templates/blank/clarkcant.json"),
    "utf8",
  ),
) as Record<string, unknown> & { id: string };

describe("buildDirectoryEntry", () => {
  it("builds an entry for a manifest ClarkCant reads", () => {
    const built = buildDirectoryEntry(MANIFEST, LISTING);
    expect(built).toMatchObject({ ok: true, entry: { packageId: MANIFEST.id, riskTier: "isolated-ui", source: { kind: "npm" } } });
  });

  it("refuses a manifest without a publisher, because an entry names who a package comes from", () => {
    const { publisher: _publisher, ...anonymous } = MANIFEST;
    expect(buildDirectoryEntry(anonymous, LISTING)).toEqual({ ok: false, reason: expect.stringContaining("publisher") as string });
  });

  it("refuses a manifest ClarkCant does not read, including the schemaVersion-less draft", () => {
    const { schemaVersion: _schemaVersion, ...draft } = MANIFEST;
    expect(canonicalManifestOf(draft)).toBeNull();
    expect(buildDirectoryEntry(draft, LISTING).ok).toBe(false);
    expect(buildDirectoryEntry("not a manifest", LISTING).ok).toBe(false);
  });

  it("refuses an entry ClarkCant's schema would refuse, instead of serving a feed ClarkCant rejects", () => {
    const built = buildDirectoryEntry(MANIFEST, { ...LISTING, digest: "" });
    expect(built).toEqual({ ok: false, reason: expect.stringContaining("digest") as string });
  });
});
