import { packageFacets, packageVersions, packages, packagesFts, publishers } from "@marketplace/db";
import { and, eq } from "drizzle-orm";

import type { MarketplaceDeps } from "../deps";

/**
 * Write-through maintenance of `packages_fts`. Commands that change a package's searchable text (indexing, an
 * approved publisher claim, account deletion removing a publisher) call this after their write; there are no
 * triggers, because the document joins text from three tables.
 *
 * The delete and insert run in one D1 batch, which D1 executes atomically, so a reader never sees a package missing
 * from the index or listed twice.
 */
export async function syncPackageSearchDocument(deps: MarketplaceDeps, packageId: string): Promise<void> {
  const [row] = await deps.db
    .select({
      id: packages.id,
      name: packages.name,
      displayName: packages.displayName,
      description: packages.description,
      keywords: packages.keywords,
      latestVersion: packages.latestVersion,
      publisherName: publishers.name,
      publisherSlug: publishers.slug,
    })
    .from(packages)
    .leftJoin(publishers, eq(publishers.id, packages.publisherId))
    .where(eq(packages.id, packageId))
    .limit(1);

  if (!row) {
    await removePackageSearchDocument(deps, packageId);
    return;
  }

  const facetRows = row.latestVersion
    ? await deps.db
        .select({ kind: packageFacets.kind, isolation: packageFacets.isolation })
        .from(packageFacets)
        .innerJoin(packageVersions, eq(packageVersions.id, packageFacets.packageVersionId))
        .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.version, row.latestVersion)))
    : [];

  const facets = [...new Set(facetRows.flatMap((facet) => [facet.kind, facet.isolation]))].join(" ");
  const keywords = Array.isArray(row.keywords) ? row.keywords.join(" ") : "";
  const publisher = [row.publisherName, row.publisherSlug].filter(Boolean).join(" ");

  await deps.db.batch([
    deps.db.delete(packagesFts).where(eq(packagesFts.packageId, packageId)),
    deps.db.insert(packagesFts).values({
      packageId: row.id,
      name: searchableName(row.name),
      displayName: row.displayName,
      description: row.description,
      keywords,
      publisher,
      facets,
    }),
  ]);
}

/**
 * Re-syncs search documents after a command's own write has already committed. The command has succeeded by then, so
 * a sync failure must not turn it into an error the caller would retry against a changed state (a deleted account, an
 * approved claim). Failures are logged at error level instead; the search document is derived from the tables and is
 * corrected by the package's next re-sync (for example its next indexing).
 */
export async function syncPackageSearchDocumentsAfterCommit(
  deps: MarketplaceDeps,
  packageIds: readonly string[],
  context: string,
): Promise<void> {
  for (const packageId of packageIds) {
    try {
      await syncPackageSearchDocument(deps, packageId);
    } catch (error) {
      console.error(`search: re-sync of ${packageId} after ${context} failed; its search document is stale`, error);
    }
  }
}

/** Removes a package from search (e.g. when it is deleted). Curation changes should re-sync instead. */
export async function removePackageSearchDocument(deps: MarketplaceDeps, packageId: string): Promise<void> {
  await deps.db.delete(packagesFts).where(eq(packagesFts.packageId, packageId));
}

/**
 * Indexes an npm name both verbatim and split on its punctuation, so `@acme/chart-widget` matches `chart`,
 * `widget` and `acme`.
 */
function searchableName(name: string): string {
  const parts = name.split(/[@/._~-]+/).filter(Boolean);
  return [name, ...parts].join(" ");
}
