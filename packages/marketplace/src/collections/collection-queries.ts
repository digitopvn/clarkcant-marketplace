import { MarketplaceError, slugSchema, type CollectionDetail, type CollectionSummary } from "@marketplace/contracts";
import { collectionItems, collections, packages, publishers } from "@marketplace/db";
import { and, asc, eq } from "drizzle-orm";

import type { MarketplaceDeps } from "../deps";
import { isPubliclyVisible, packageSummaryColumns, toPackageSummary } from "../packages/package-rows";
import { parseInput } from "../validation";

/** Published collections in editorial order. Unpublished collections are admin-only. */
export async function listCollections(deps: MarketplaceDeps): Promise<CollectionSummary[]> {
  return deps.db
    .select({ slug: collections.slug, title: collections.title, description: collections.description })
    .from(collections)
    .where(eq(collections.published, true))
    .orderBy(asc(collections.position), asc(collections.title));
}

/** One published collection with its publicly visible packages in the curator's order. */
export async function getCollection(deps: MarketplaceDeps, rawSlug: unknown): Promise<CollectionDetail> {
  const slug = parseInput(slugSchema, rawSlug);
  const [collection] = await deps.db
    .select({ id: collections.id, slug: collections.slug, title: collections.title, description: collections.description })
    .from(collections)
    .where(and(eq(collections.slug, slug), eq(collections.published, true)))
    .limit(1);
  if (!collection) throw new MarketplaceError("not_found", `collection "${slug}" was not found`);

  const rows = await deps.db
    .select(packageSummaryColumns)
    .from(collectionItems)
    .innerJoin(packages, eq(packages.id, collectionItems.packageId))
    .leftJoin(publishers, eq(publishers.id, packages.publisherId))
    .where(and(eq(collectionItems.collectionId, collection.id), isPubliclyVisible()))
    .orderBy(asc(collectionItems.position), asc(packages.name));

  return {
    slug: collection.slug,
    title: collection.title,
    description: collection.description,
    packages: rows.map(toPackageSummary),
  };
}
