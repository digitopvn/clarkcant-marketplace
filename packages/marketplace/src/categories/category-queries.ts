import { MarketplaceError, categorySlugSchema, type Category } from "@marketplace/contracts";
import { categories, packages } from "@marketplace/db";
import { and, asc, count, eq } from "drizzle-orm";

import type { MarketplaceDeps } from "../deps";
import { isPubliclyVisible } from "../packages/package-rows";
import { parseInput } from "../validation";

/** All categories in display order, each with the number of publicly visible packages it holds. */
export async function listCategories(deps: MarketplaceDeps): Promise<Category[]> {
  const rows = await deps.db
    .select({
      slug: categories.slug,
      name: categories.name,
      description: categories.description,
      packageCount: count(packages.id),
    })
    .from(categories)
    .leftJoin(packages, and(eq(packages.categorySlug, categories.slug), isPubliclyVisible()))
    .groupBy(categories.slug)
    .orderBy(asc(categories.position), asc(categories.name));
  return rows;
}

export async function getCategory(deps: MarketplaceDeps, rawSlug: unknown): Promise<Category> {
  const slug = parseInput(categorySlugSchema, rawSlug);
  const found = (await listCategories(deps)).find((category) => category.slug === slug);
  if (!found) throw new MarketplaceError("not_found", `category "${slug}" was not found`);
  return found;
}
