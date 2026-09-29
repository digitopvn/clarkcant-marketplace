import { collectionItems, collections } from "@marketplace/db";
import { beforeEach, describe, expect, it } from "vitest";

import { getCategory, getCollection, listCategories, listCollections } from "../src";
import { resetDatabase, seedPackage, testDeps } from "./support/seed";

const deps = testDeps();

beforeEach(async () => {
  await resetDatabase(deps);
});

describe("categories", () => {
  it("returns the seeded categories in order with public package counts", async () => {
    await seedPackage(deps, { name: "chart", categorySlug: "data" });
    await seedPackage(deps, { name: "table", categorySlug: "data" });
    await seedPackage(deps, { name: "secret", categorySlug: "data", curationStatus: "hidden" });

    const list = await listCategories(deps);
    expect(list.map((category) => category.slug)).toEqual([
      "widgets",
      "dashboards",
      "productivity",
      "data",
      "media",
      "developer-tools",
    ]);
    expect(list.find((category) => category.slug === "data")?.packageCount).toBe(2);
    expect(list.find((category) => category.slug === "media")?.packageCount).toBe(0);
    expect((await getCategory(deps, "data")).name).toBe("Data");
    await expect(getCategory(deps, "nope")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("collections", () => {
  it("lists published collections and returns their public packages in curated order", async () => {
    const first = await seedPackage(deps, { name: "first-widget" });
    const second = await seedPackage(deps, { name: "second-widget" });
    const hidden = await seedPackage(deps, { name: "hidden-widget", curationStatus: "hidden" });
    await deps.db.insert(collections).values([
      { id: "col_a", slug: "starter-kit", title: "Starter kit", published: true, position: 1 },
      { id: "col_b", slug: "drafts", title: "Drafts", published: false, position: 2 },
    ]);
    await deps.db.insert(collectionItems).values([
      { collectionId: "col_a", packageId: second, position: 1 },
      { collectionId: "col_a", packageId: first, position: 2 },
      { collectionId: "col_a", packageId: hidden, position: 3 },
    ]);

    expect((await listCollections(deps)).map((collection) => collection.slug)).toEqual(["starter-kit"]);
    const detail = await getCollection(deps, "starter-kit");
    expect(detail.packages.map((item) => item.name)).toEqual(["second-widget", "first-widget"]);
    await expect(getCollection(deps, "drafts")).rejects.toMatchObject({ code: "not_found" });
  });
});
