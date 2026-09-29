import { PUBLIC_CURATION_STATUSES, type PageDocument, type PageKind } from "@marketplace/contracts";
import { collections, packages, pagePublications, pageRevisions, pages } from "@marketplace/db";
import { and, asc, count, eq, inArray, isNotNull, max } from "drizzle-orm";

import type { MarketplaceDeps } from "../deps";
import { HOME_PAGE_SLUG } from "../pages/page-schemas";

/*
 * Read models for the machine-readable site index (sitemaps, llms.txt, llms-full.txt). They expose only what is
 * already public: published page revisions, publicly visible packages and published collections.
 */

export interface PublishedPageEntry {
  slug: string;
  kind: PageKind;
  /** Public path (`/` for the landing page). */
  path: string;
  document: PageDocument;
  /** ISO time the live revision was last made live. */
  publishedAt: string;
}

/** Every published page with its live document, ordered by slug. Includes `noindex` pages; callers filter. */
export async function listPublishedPages(deps: MarketplaceDeps): Promise<PublishedPageEntry[]> {
  const rows = await deps.db
    .select({ id: pages.id, slug: pages.slug, kind: pages.kind, updatedAt: pages.updatedAt, document: pageRevisions.document })
    .from(pages)
    .innerJoin(pageRevisions, eq(pageRevisions.id, pages.publishedRevisionId))
    .where(isNotNull(pages.publishedRevisionId))
    .orderBy(asc(pages.slug));
  if (rows.length === 0) return [];

  const published = await deps.db
    .select({ pageId: pagePublications.pageId, publishedAt: max(pagePublications.publishedAt) })
    .from(pagePublications)
    .where(inArray(pagePublications.pageId, rows.map((row) => row.id)))
    .groupBy(pagePublications.pageId);
  // `max()` over a timestamp column comes back as the raw integer; normalise it to a Date.
  const times = new Map(published.map((row) => [row.pageId, row.publishedAt === null ? null : new Date(row.publishedAt as unknown as number | Date)]));

  return rows.map((row) => ({
    slug: row.slug,
    kind: row.kind,
    path: row.slug === HOME_PAGE_SLUG ? "/" : `/${row.slug}`,
    document: row.document as PageDocument,
    publishedAt: (times.get(row.id) ?? row.updatedAt).toISOString(),
  }));
}

/** Publicly visible packages that have at least one indexed version (the ones with a detail page worth indexing). */
const isIndexable = () => and(inArray(packages.curationStatus, [...PUBLIC_CURATION_STATUSES]), isNotNull(packages.latestVersion));

export async function countPublicPackages(deps: MarketplaceDeps): Promise<number> {
  const [row] = await deps.db.select({ value: count() }).from(packages).where(isIndexable());
  return row?.value ?? 0;
}

export interface PackageIndexEntry {
  name: string;
  displayName: string;
  updatedAt: string;
}

/** One stable, name-ordered slice of the public catalogue (for a sitemap segment). */
export async function listPublicPackageIndex(
  deps: MarketplaceDeps,
  range: { offset: number; limit: number },
): Promise<PackageIndexEntry[]> {
  const rows = await deps.db
    .select({ name: packages.name, displayName: packages.displayName, updatedAt: packages.updatedAt })
    .from(packages)
    .where(isIndexable())
    .orderBy(asc(packages.name))
    .limit(range.limit)
    .offset(range.offset);
  return rows.map((row) => ({ name: row.name, displayName: row.displayName, updatedAt: row.updatedAt.toISOString() }));
}

export interface CollectionIndexEntry {
  slug: string;
  title: string;
  description: string;
  updatedAt: string;
}

export async function listPublishedCollectionIndex(deps: MarketplaceDeps): Promise<CollectionIndexEntry[]> {
  const rows = await deps.db
    .select({ slug: collections.slug, title: collections.title, description: collections.description, updatedAt: collections.updatedAt })
    .from(collections)
    .where(eq(collections.published, true))
    .orderBy(asc(collections.position), asc(collections.title));
  return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
}
