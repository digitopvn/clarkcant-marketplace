import { packages } from "@marketplace/db";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { removePackageSearchDocument, searchPackages, syncPackageSearchDocument, toFtsQuery } from "../src";
import { resetDatabase, seedPackage, testDeps } from "./support/seed";

const deps = testDeps();

beforeEach(async () => {
  await resetDatabase(deps);
  await seedPackage(deps, {
    name: "@acme/chart-widget",
    displayName: "Chart",
    description: "Line and bar charts for dashboards",
    keywords: ["clarkcant", "charts"],
    categorySlug: "data",
    publisher: { slug: "acme", name: "Acme Labs" },
  });
  await seedPackage(deps, {
    name: "focus-timer",
    displayName: "Focus timer",
    description: "A pomodoro timer",
    categorySlug: "productivity",
    facets: [{ kind: "tools", isolation: "service", entry: "dist/tool.js" }],
  });
  await seedPackage(deps, { name: "hidden-chart", description: "charts", curationStatus: "hidden" });
});

describe("toFtsQuery", () => {
  it("quotes and prefix-matches terms so FTS syntax in user input is inert", () => {
    expect(toFtsQuery('chart OR "x" NEAR(')).toBe('"chart"* "or"* "x"* "near"*');
    expect(toFtsQuery("  ***  ")).toBeNull();
    expect(toFtsQuery("Café")).toBe('"café"*');
  });
});

describe("searchPackages (FTS5)", () => {
  it("matches name parts, description, keywords and publisher with prefix search", async () => {
    for (const q of ["chart", "dash", "acme labs", "charts clarkcant"]) {
      const result = await searchPackages(deps, { q });
      expect(result.items.map((item) => item.name), q).toEqual(["@acme/chart-widget"]);
    }
  });

  it("never returns packages that are not publicly visible", async () => {
    const result = await searchPackages(deps, { q: "charts" });
    expect(result.items.map((item) => item.name)).not.toContain("hidden-chart");
  });

  it("filters by category, facet kind and isolation lane", async () => {
    expect((await searchPackages(deps, { category: "productivity" })).items.map((item) => item.name)).toEqual([
      "focus-timer",
    ]);
    expect((await searchPackages(deps, { kind: "tools" })).items.map((item) => item.name)).toEqual(["focus-timer"]);
    expect((await searchPackages(deps, { q: "chart", isolation: "service" })).items).toEqual([]);
  });

  it("browses by recency when the query is empty or has no searchable terms", async () => {
    const empty = await searchPackages(deps, { q: "" });
    const punctuation = await searchPackages(deps, { q: "!!!" });
    expect(empty.items).toHaveLength(2);
    expect(punctuation.items).toHaveLength(2);
  });

  it("keeps the index in sync with write-through updates and removals", async () => {
    const [row] = await deps.db.select().from(packages).where(eq(packages.name, "focus-timer"));
    await deps.db.update(packages).set({ description: "Deep work sessions" }).where(eq(packages.id, row!.id));
    await syncPackageSearchDocument(deps, row!.id);

    expect((await searchPackages(deps, { q: "pomodoro" })).items).toEqual([]);
    expect((await searchPackages(deps, { q: "deep work" })).items.map((item) => item.name)).toEqual(["focus-timer"]);

    const count = async () =>
      (await deps.db.get<{ n: number }>(sql`select count(*) as n from packages_fts where package_id = ${row!.id}`))?.n;
    expect(await count()).toBe(1);
    await removePackageSearchDocument(deps, row!.id);
    expect(await count()).toBe(0);
  });

  it("rejects over-long queries at the service boundary", async () => {
    await expect(searchPackages(deps, { q: "x".repeat(201) })).rejects.toMatchObject({ code: "validation_failed" });
  });
});
