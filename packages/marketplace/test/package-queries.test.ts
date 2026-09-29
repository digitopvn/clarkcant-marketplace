import { MarketplaceError } from "@marketplace/contracts";
import { packagePermissions, packageVersions } from "@marketplace/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { checkHealth, getPackage, listFeaturedPackages, listLatestPackages, listPackages } from "../src";
import { resetDatabase, seedPackage, testDeps } from "./support/seed";

const deps = testDeps();

beforeEach(async () => {
  await resetDatabase(deps);
});

describe("package queries", () => {
  it("lists only publicly visible packages, newest first", async () => {
    await seedPackage(deps, { name: "old-widget", indexedAt: new Date("2026-01-01T00:00:00Z") });
    await seedPackage(deps, { name: "new-widget", indexedAt: new Date("2026-09-01T00:00:00Z"), curationStatus: "featured" });
    await seedPackage(deps, { name: "hidden-widget", curationStatus: "hidden" });
    await seedPackage(deps, { name: "pending-widget", curationStatus: "unreviewed" });

    const page = await listPackages(deps);
    expect(page.items.map((item) => item.name)).toEqual(["new-widget", "old-widget"]);
    expect(page.nextCursor).toBeNull();
  });

  it("paginates with an opaque cursor and rejects a malformed one", async () => {
    for (const name of ["a-widget", "b-widget", "c-widget"]) await seedPackage(deps, { name });

    const first = await listPackages(deps, { sort: "name", limit: 2 });
    expect(first.items.map((item) => item.name)).toEqual(["a-widget", "b-widget"]);
    expect(first.nextCursor).not.toBeNull();

    const second = await listPackages(deps, { sort: "name", limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items.map((item) => item.name)).toEqual(["c-widget"]);
    expect(second.nextCursor).toBeNull();

    await expect(listPackages(deps, { cursor: "not-a-cursor" })).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("filters by category and validates the filter", async () => {
    await seedPackage(deps, { name: "chart", categorySlug: "data" });
    await seedPackage(deps, { name: "notes", categorySlug: "productivity" });

    const page = await listPackages(deps, { category: "data" });
    expect(page.items.map((item) => item.name)).toEqual(["chart"]);
    await expect(listPackages(deps, { category: "Not A Slug" })).rejects.toBeInstanceOf(MarketplaceError);
  });

  it("returns featured and latest rails", async () => {
    await seedPackage(deps, { name: "star", curationStatus: "featured" });
    await seedPackage(deps, { name: "plain" });

    expect((await listFeaturedPackages(deps)).map((item) => item.name)).toEqual(["star"]);
    expect((await listLatestPackages(deps)).map((item) => item.name).sort()).toEqual(["plain", "star"]);
  });

  it("returns package detail with publisher, facets, permissions and versions", async () => {
    const packageId = await seedPackage(deps, {
      name: "@acme/frame-widget",
      displayName: "Frame widget",
      publisher: { slug: "acme", name: "Acme" },
      facets: [{ kind: "widget", isolation: "isolated-ui" }],
    });
    const [version] = await deps.db.select().from(packageVersions).where(eq(packageVersions.packageId, packageId));
    await deps.db.insert(packagePermissions).values({
      id: deps.ids("pp"),
      packageVersionId: version!.id,
      kind: "network",
      value: "https://api.example.com",
      access: null,
    });

    const detail = await getPackage(deps, "@acme/frame-widget");
    expect(detail.displayName).toBe("Frame widget");
    expect(detail.publisher).toEqual({ slug: "acme", name: "Acme", verified: false });
    expect(detail.latest?.version).toBe("1.0.0");
    expect(detail.latest?.facets).toEqual([
      { kind: "widget", isolation: "isolated-ui", renderer: null, entry: "widgets/main/index.html", widgetId: null },
    ]);
    expect(detail.latest?.permissions).toEqual([{ kind: "network", value: "https://api.example.com", access: null }]);
    expect(detail.versions).toEqual([{ version: "1.0.0", publishedAt: "2026-09-01T00:00:00.000Z" }]);
  });

  it("treats non-public packages as not found and rejects invalid names", async () => {
    await seedPackage(deps, { name: "secret", curationStatus: "rejected" });
    await expect(getPackage(deps, "secret")).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(getPackage(deps, "missing")).rejects.toMatchObject({ code: "not_found" });
    await expect(getPackage(deps, "Bad Name!")).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("reports database health from a real query", async () => {
    const report = await checkHealth(deps);
    expect(report).toMatchObject({ status: "ok", checks: { database: "ok" } });
  });
});
