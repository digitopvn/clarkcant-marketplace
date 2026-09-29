import { PUBLIC_CURATION_STATUSES, type PageDocument, type PageKind } from "@marketplace/contracts";
import { collections, packages, pagePublications, pageRevisions, pages } from "@marketplace/db";
import { and, asc, count, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";

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

/** Rows fetched per query while listing published pages; each row carries a whole page document. */
export const PUBLISHED_PAGES_BATCH = 100;
/**
 * Default upper bound for {@link listPublishedPages}: far above the site's own pages, and it keeps one sitemap segment
 * well under the 50,000-URL sitemap limit and one invocation's memory bounded.
 */
export const MAX_PUBLISHED_PAGES_LISTED = 2000;

export interface ListPublishedPagesOptions {
  /** Return pages whose slug sorts after this one (keyset pagination). */
  afterSlug?: string;
  /** Maximum pages returned. Defaults to {@link MAX_PUBLISHED_PAGES_LISTED}. */
  limit?: number;
}

/**
 * Published pages with their live documents, ordered by slug. Includes `noindex` pages; callers filter. Rows are read
 * in keyset-paginated batches and the last-published time comes from a correlated subquery, so no statement binds an
 * id list (D1 allows at most 100 bound parameters) however many pages are published.
 */
export async function listPublishedPages(
  deps: MarketplaceDeps,
  options: ListPublishedPagesOptions = {},
): Promise<PublishedPageEntry[]> {
  const limit = Math.max(0, Math.min(options.limit ?? MAX_PUBLISHED_PAGES_LISTED, MAX_PUBLISHED_PAGES_LISTED));
  const lastPublishedAt = sql<number | null>`(select max(${pagePublications.publishedAt}) from ${pagePublications} where ${pagePublications.pageId} = ${pages.id})`;
  const entries: PublishedPageEntry[] = [];
  let after = options.afterSlug;
  while (entries.length < limit) {
    const rows = await deps.db
      .select({
        slug: pages.slug,
        kind: pages.kind,
        updatedAt: pages.updatedAt,
        document: pageRevisions.document,
        lastPublishedAt,
      })
      .from(pages)
      .innerJoin(pageRevisions, eq(pageRevisions.id, pages.publishedRevisionId))
      .where(and(isNotNull(pages.publishedRevisionId), after === undefined ? undefined : gt(pages.slug, after)))
      .orderBy(asc(pages.slug))
      .limit(Math.min(PUBLISHED_PAGES_BATCH, limit - entries.length));
    for (const row of rows) {
      entries.push({
        slug: row.slug,
        kind: row.kind,
        path: row.slug === HOME_PAGE_SLUG ? "/" : `/${row.slug}`,
        document: row.document as PageDocument,
        // The subquery yields the raw integer timestamp; fall back to the page's own update time.
        publishedAt: (row.lastPublishedAt === null ? row.updatedAt : new Date(Number(row.lastPublishedAt))).toISOString(),
      });
    }
    const last = rows.at(-1);
    if (!last || rows.length < PUBLISHED_PAGES_BATCH) break;
    after = last.slug;
  }
  return entries;
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
    .orderBy(asc(collections.position), asc(collections.title))
    .limit(MAX_PUBLISHED_PAGES_LISTED);
  return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
}
