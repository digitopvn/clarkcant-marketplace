import {
  searchQuerySchema,
  type Page,
  type PackageSort,
  type PackageSummary,
  type SearchQuery,
  type SearchQueryInput,
  type SearchResult,
} from "@marketplace/contracts";
import { packageFacets, packageVersions, packages, packagesFts, publishers } from "@marketplace/db";
import { and, asc, eq, exists, sql, type SQL } from "drizzle-orm";

import type { MarketplaceDeps } from "../deps";
import {
  isPubliclyVisible,
  latestFirst,
  offsetFromCursor,
  packageSummaryColumns,
  toPackageSummary,
  toPage,
} from "../packages/package-rows";
import { parseInput } from "../validation";

const MAX_TERMS = 8;

/**
 * BM25 column weights, in `packages_fts` column order:
 * package_id (unindexed), name, display_name, description, keywords, publisher, facets.
 */
const RANK = sql`bm25(packages_fts, 0.0, 10.0, 8.0, 3.0, 5.0, 2.0, 1.0)`;

/**
 * Turns free text into a safe FTS5 query: every term is quoted (so FTS operators and punctuation in user input are
 * inert) and prefix-matched, and all terms must match. Returns `null` when nothing searchable remains.
 */
export function toFtsQuery(text: string): string | null {
  const terms = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_TERMS);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term}"*`).join(" ");
}

/**
 * The one query behind `GET /packages`, `GET /search` and the web listing pages: public visibility, the shared
 * filters, optional full-text match and a sort. Without an explicit sort, a text query ranks by relevance and an
 * empty one browses newest first.
 */
export async function findPackages(
  deps: MarketplaceDeps,
  query: SearchQuery,
  sort: PackageSort | undefined,
): Promise<Page<PackageSummary>> {
  const offset = offsetFromCursor(query.cursor);
  const match = toFtsQuery(query.q);

  const filters: SQL[] = [isPubliclyVisible()];
  if (query.category) filters.push(eq(packages.categorySlug, query.category));
  if (query.curation) filters.push(eq(packages.curationStatus, query.curation));
  if (query.publisher) filters.push(eq(publishers.slug, query.publisher));
  if (query.kind || query.isolation) filters.push(latestVersionHasFacet(deps, query.kind, query.isolation));
  if (query.platform) filters.push(latestVersionSupportsPlatform(query.platform));

  const base = deps.db
    .select(packageSummaryColumns)
    .from(packages)
    .leftJoin(publishers, eq(publishers.id, packages.publisherId))
    .$dynamic();

  const order = sort === "name" ? [asc(packages.name)] : sort === "latest" || !match ? latestFirst : [RANK, asc(packages.name)];
  const rows = match
    ? await base
        .innerJoin(packagesFts, eq(packagesFts.packageId, packages.id))
        .where(and(sql`packages_fts match ${match}`, ...filters))
        .orderBy(...order)
        .limit(query.limit + 1)
        .offset(offset)
    : await base
        .where(and(...filters))
        .orderBy(...order)
        .limit(query.limit + 1)
        .offset(offset);

  return toPage(rows.map(toPackageSummary), query.limit, offset);
}

/**
 * Searches public listings. An empty or punctuation-only query browses by recency, so the same endpoint backs both
 * the search box and filtered browsing.
 */
export async function searchPackages(deps: MarketplaceDeps, input: SearchQueryInput = {}): Promise<SearchResult> {
  const query = parseInput(searchQuerySchema, input);
  const page = await findPackages(deps, query, undefined);
  return { query: query.q, items: page.items, nextCursor: page.nextCursor };
}

function latestVersionHasFacet(deps: MarketplaceDeps, kind: string | undefined, isolation: string | undefined): SQL {
  const conditions: SQL[] = [
    eq(packageVersions.packageId, packages.id),
    sql`${packageVersions.version} = ${packages.latestVersion}`,
  ];
  if (kind) conditions.push(eq(packageFacets.kind, kind));
  if (isolation) conditions.push(eq(packageFacets.isolation, isolation));
  return exists(
    deps.db
      .select({ one: sql`1` })
      .from(packageFacets)
      .innerJoin(packageVersions, eq(packageVersions.id, packageFacets.packageVersionId))
      .where(and(...conditions)),
  );
}

/** Platforms live only in the immutable manifest JSON, so the filter reads them with SQLite's `json_each`. */
function latestVersionSupportsPlatform(platform: string): SQL {
  return sql`exists (select 1 from package_versions pv, json_each(pv.manifest, '$.platforms') platform
    where pv.package_id = ${packages.id} and pv.version = ${packages.latestVersion} and platform.value = ${platform})`;
}
