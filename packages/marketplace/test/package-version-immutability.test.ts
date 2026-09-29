import { packageVersions } from "@marketplace/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { resetDatabase, seedPackage, testDeps } from "./support/seed";

const deps = testDeps();

async function versionOf(packageId: string) {
  const [row] = await deps.db.select().from(packageVersions).where(eq(packageVersions.packageId, packageId));
  if (!row) throw new Error("seeded version missing");
  return row;
}

/** Drizzle wraps driver errors ("Failed query: ..."); the SQLite trigger message sits on `cause`. */
function errorChainMessages(error: unknown): string {
  const messages: string[] = [];
  for (let current = error; current instanceof Error; current = current.cause) messages.push(current.message);
  return messages.join(" | ");
}

beforeEach(async () => {
  await resetDatabase(deps);
});

describe("package_versions immutability", () => {
  it.each([
    ["version", { version: "9.9.9" }],
    ["manifest", { manifest: { id: "tampered", version: "1.0.0" } }],
    ["readme source", { readmeMd: "# rewritten" }],
    ["npm integrity", { npmIntegrity: "sha512-other" }],
    ["publish time", { publishedAt: new Date("2020-01-01T00:00:00Z") }],
  ] as const)("rejects changing the %s", async (_label, change) => {
    const version = await versionOf(await seedPackage(deps, { name: "frozen-widget" }));
    const error = await deps.db
      .update(packageVersions)
      .set(change)
      .where(eq(packageVersions.id, version.id))
      .then(() => null, (caught: unknown) => caught);
    expect(errorChainMessages(error)).toMatch(/package_versions rows are immutable/);
    expect(await versionOf(version.packageId)).toEqual(version);
  });

  it("allows refreshing derived columns", async () => {
    const version = await versionOf(await seedPackage(deps, { name: "refreshed-widget" }));
    const indexedAt = new Date("2026-09-20T00:00:00Z");
    await deps.db
      .update(packageVersions)
      .set({ readmeHtml: "<p>clean</p>", tarballSha512Verified: true, indexedAt })
      .where(eq(packageVersions.id, version.id));

    const after = await versionOf(version.packageId);
    expect(after).toMatchObject({ readmeHtml: "<p>clean</p>", tarballSha512Verified: true, indexedAt });
    expect(after.manifest).toEqual(version.manifest);
  });

  it("allows deleting a version", async () => {
    const version = await versionOf(await seedPackage(deps, { name: "removed-widget" }));
    await deps.db.delete(packageVersions).where(eq(packageVersions.id, version.id));
    expect(await deps.db.select().from(packageVersions).where(eq(packageVersions.id, version.id))).toEqual([]);
  });
});
