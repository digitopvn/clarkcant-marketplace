import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { packageManifestSchema, readClarkcantManifest } from "../src";

/**
 * The cross-repository contract check (`pnpm contract:check`). `fixtures/upstream/clarkcant/` holds manifests copied
 * from ClarkCant at the commit `UPSTREAM.json` records; this test proves the files are exactly those copies and that
 * the marketplace's mirror accepts every one of them. Refresh with `scripts/sync-clarkcant-fixtures.mjs` when ClarkCant
 * changes its contract (see docs/extending-indexers.md).
 */

const UPSTREAM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/upstream/clarkcant");

const upstreamSchema = z.strictObject({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  commit: z.string().regex(/^[0-9a-f]{40}$/, { error: "must be a full commit SHA" }),
  note: z.string(),
  files: z
    .array(
      z.strictObject({
        path: z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+\/clarkcant\.json$/),
        source: z.string().min(1),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .min(1),
  contractSources: z.array(z.strictObject({ source: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).min(1),
});

const upstream = upstreamSchema.parse(JSON.parse(readFileSync(path.join(UPSTREAM_DIR, "UPSTREAM.json"), "utf8")));

function vendoredFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    const relative = prefix ? `${prefix}/${entry}` : entry;
    return statSync(full).isDirectory() ? vendoredFiles(full, relative) : [relative];
  });
}

function read(relative: string): string {
  // Hashes are recorded over LF text, so a CRLF checkout of this repository still matches.
  return readFileSync(path.join(UPSTREAM_DIR, ...relative.split("/")), "utf8").replace(/\r\n/g, "\n");
}

describe(`ClarkCant manifests pinned at ${upstream.repository}@${upstream.commit.slice(0, 12)}`, () => {
  it("vendors exactly the files UPSTREAM.json records, byte for byte", () => {
    const recorded = upstream.files.map((file) => file.path).sort();
    expect(vendoredFiles(UPSTREAM_DIR).filter((file) => file !== "UPSTREAM.json").sort()).toEqual(recorded);
    for (const file of upstream.files) {
      const digest = createHash("sha256").update(read(file.path), "utf8").digest("hex");
      expect(digest, `${file.path} was edited after it was synced from ${file.source}`).toBe(file.sha256);
    }
  });

  it("covers every reference app and the CLI's blank template", () => {
    expect(upstream.files.some((file) => file.path === "templates/blank/clarkcant.json")).toBe(true);
    expect(upstream.files.filter((file) => file.path.startsWith("reference-apps/")).length).toBeGreaterThanOrEqual(5);
  });

  it.each(upstream.files.map((file) => [file.path] as const))("%s is accepted as a canonical manifest", (file) => {
    const json: unknown = JSON.parse(read(file));
    const result = readClarkcantManifest(json);
    expect(result.ok ? [] : result.issues).toEqual([]);
    // Every current ClarkCant manifest is schemaVersion 2; a v1 file here would mean the fixtures went stale.
    expect(packageManifestSchema.safeParse(json).success).toBe(true);
  });
});
