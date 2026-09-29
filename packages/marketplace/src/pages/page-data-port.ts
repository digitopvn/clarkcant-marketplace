import { PUBLIC_CURATION_STATUSES, isMarketplaceError } from "@marketplace/contracts";
import { categories, media, packages, publishers } from "@marketplace/db";
import type { PageDataPort } from "@marketplace/page-engine";
import { count, eq, inArray } from "drizzle-orm";

import { getCollection } from "../collections/collection-queries";
import type { MarketplaceDeps } from "../deps";
import { getPackage, listFeaturedPackages, listPackages } from "../packages/package-queries";
import { getPublisher } from "../publishers/publisher-service";

/**
 * The page engine's read port over the public application queries. Blocks therefore see exactly what the public
 * API shows (listed/featured packages, published collections) and nothing an anonymous visitor could not.
 */
export function createPageDataPort(deps: MarketplaceDeps): PageDataPort {
  return {
    listPackages: async ({ category, sort, limit }) => (await listPackages(deps, { category, sort, limit })).items,
    listFeaturedPackages: (limit) => listFeaturedPackages(deps, limit),
    getPackage: (name) => orNull(getPackage(deps, name)),
    getCollection: (slug) => orNull(getCollection(deps, slug)),
    getPublisher: async (slug, packageLimit) => {
      const publisher = await orNull(getPublisher(deps, slug));
      if (!publisher || publisher.slug !== slug) return null;
      const listed = packageLimit > 0 ? (await listPackages(deps, { publisher: slug, limit: packageLimit })).items : [];
      return { slug: publisher.slug, name: publisher.name, kind: publisher.kind, verified: publisher.verifiedAt !== null, packages: listed };
    },
    getMedia: async (id) => {
      const [row] = await deps.db
        .select({ id: media.id, r2Key: media.r2Key, contentType: media.contentType, width: media.width, height: media.height })
        .from(media)
        .where(eq(media.id, id))
        .limit(1);
      if (!row) return null;
      return {
        id: row.id,
        url: `/media/${row.r2Key.split("/").map(encodeURIComponent).join("/")}`,
        contentType: row.contentType,
        width: row.width,
        height: row.height,
      };
    },
    getMarketplaceStats: async () => {
      const [packageCount, publisherCount, categoryCount] = await deps.db.batch([
        deps.db.select({ value: count() }).from(packages).where(inArray(packages.curationStatus, [...PUBLIC_CURATION_STATUSES])),
        deps.db.select({ value: count() }).from(publishers),
        deps.db.select({ value: count() }).from(categories),
      ]);
      return {
        packages: packageCount[0]?.value ?? 0,
        publishers: publisherCount[0]?.value ?? 0,
        categories: categoryCount[0]?.value ?? 0,
      };
    },
  };
}

/** Missing data renders as an empty/diagnostic state; any other failure still propagates. */
async function orNull<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (error) {
    if (isMarketplaceError(error) && (error.code === "not_found" || error.code === "validation_failed")) return null;
    throw error;
  }
}
