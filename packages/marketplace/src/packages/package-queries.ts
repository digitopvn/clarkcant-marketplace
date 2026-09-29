import {
  MarketplaceError,
  decodeOffsetCursor,
  encodeOffsetCursor,
  listPackagesQuerySchema,
  packageNameSchema,
  type ListPackagesQueryInput,
  type Page,
  type PackageDetail,
  type PackageSummary,
} from "@marketplace/contracts";
import { packageFacets, packagePermissions, packageVersions, packages, publishers } from "@marketplace/db";
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";

import type { MarketplaceDeps } from "../deps";
import { parseInput } from "../validation";
import { isPubliclyVisible, packageSummaryColumns, toPackageSummary } from "./package-rows";

const MAX_VERSIONS_LISTED = 50;

/** Resolves a page cursor or rejects it; a silently reset cursor would make clients loop forever. */
export function offsetFromCursor(cursor: string | undefined): number {
  const offset = decodeOffsetCursor(cursor);
  if (offset === null) throw new MarketplaceError("validation_failed", "cursor is malformed", { details: { cursor } });
  return offset;
}

/** Fetches `limit + 1` rows so the next cursor is only issued when another page really exists. */
export function toPage<T>(rows: T[], limit: number, offset: number): Page<T> {
  const hasMore = rows.length > limit;
  return { items: hasMore ? rows.slice(0, limit) : rows, nextCursor: hasMore ? encodeOffsetCursor(offset + limit) : null };
}

export const latestFirst = [sql`${packages.indexedAt} is null`, desc(packages.indexedAt), asc(packages.name)];

export async function listPackages(
  deps: MarketplaceDeps,
  input: ListPackagesQueryInput = {},
): Promise<Page<PackageSummary>> {
  const query = parseInput(listPackagesQuerySchema, input);
  const offset = offsetFromCursor(query.cursor);
  const filters: SQL[] = [isPubliclyVisible()];
  if (query.category) filters.push(eq(packages.categorySlug, query.category));

  const rows = await deps.db
    .select(packageSummaryColumns)
    .from(packages)
    .leftJoin(publishers, eq(publishers.id, packages.publisherId))
    .where(and(...filters))
    .orderBy(...(query.sort === "name" ? [asc(packages.name)] : latestFirst))
    .limit(query.limit + 1)
    .offset(offset);

  return toPage(rows.map(toPackageSummary), query.limit, offset);
}

export async function listFeaturedPackages(deps: MarketplaceDeps, limit = 6): Promise<PackageSummary[]> {
  const rows = await deps.db
    .select(packageSummaryColumns)
    .from(packages)
    .leftJoin(publishers, eq(publishers.id, packages.publisherId))
    .where(eq(packages.curationStatus, "featured"))
    .orderBy(desc(packages.updatedAt), asc(packages.name))
    .limit(clampLimit(limit));
  return rows.map(toPackageSummary);
}

export async function listLatestPackages(deps: MarketplaceDeps, limit = 12): Promise<PackageSummary[]> {
  const rows = await deps.db
    .select(packageSummaryColumns)
    .from(packages)
    .leftJoin(publishers, eq(publishers.id, packages.publisherId))
    .where(isPubliclyVisible())
    .orderBy(...latestFirst)
    .limit(clampLimit(limit));
  return rows.map(toPackageSummary);
}

/** Full public detail for one package. Hidden, rejected and unreviewed packages are indistinguishable from absent. */
export async function getPackage(deps: MarketplaceDeps, rawName: unknown): Promise<PackageDetail> {
  const name = parseInput(packageNameSchema, rawName);
  const [row] = await deps.db
    .select({
      ...packageSummaryColumns,
      homepage: packages.homepage,
      repositoryUrl: packages.repositoryUrl,
      license: packages.license,
    })
    .from(packages)
    .leftJoin(publishers, eq(publishers.id, packages.publisherId))
    .where(and(eq(packages.name, name), isPubliclyVisible()))
    .limit(1);
  if (!row) throw new MarketplaceError("not_found", `package "${name}" was not found`);

  const versions = await deps.db
    .select({
      id: packageVersions.id,
      version: packageVersions.version,
      publishedAt: packageVersions.publishedAt,
    })
    .from(packageVersions)
    .where(eq(packageVersions.packageId, row.id))
    .orderBy(desc(packageVersions.publishedAt))
    .limit(MAX_VERSIONS_LISTED);

  return {
    ...toPackageSummary(row),
    homepage: row.homepage,
    repositoryUrl: row.repositoryUrl,
    license: row.license,
    latest: row.latestVersion ? await getVersionDetail(deps, row.id, row.latestVersion) : null,
    versions: versions.map((version) => ({ version: version.version, publishedAt: version.publishedAt.toISOString() })),
  };
}

async function getVersionDetail(
  deps: MarketplaceDeps,
  packageId: string,
  version: string,
): Promise<PackageDetail["latest"]> {
  const [row] = await deps.db
    .select()
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.version, version)))
    .limit(1);
  if (!row) return null;

  const [facets, permissions] = await Promise.all([
    deps.db
      .select({
        kind: packageFacets.kind,
        isolation: packageFacets.isolation,
        renderer: packageFacets.renderer,
        entry: packageFacets.entry,
        widgetId: packageFacets.widgetId,
      })
      .from(packageFacets)
      .where(eq(packageFacets.packageVersionId, row.id))
      .orderBy(asc(packageFacets.kind), asc(packageFacets.entry)),
    deps.db
      .select({ kind: packagePermissions.kind, value: packagePermissions.value, access: packagePermissions.access })
      .from(packagePermissions)
      .where(eq(packagePermissions.packageVersionId, row.id))
      .orderBy(asc(packagePermissions.kind), asc(packagePermissions.value)),
  ]);

  return {
    version: row.version,
    publishedAt: row.publishedAt.toISOString(),
    indexedAt: row.indexedAt.toISOString(),
    npmIntegrity: row.npmIntegrity,
    tarballSha512Verified: row.tarballSha512Verified,
    hasProvenance: row.provenance !== null && row.provenance !== undefined,
    readmeHtml: row.readmeHtml,
    facets,
    permissions,
  };
}

function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit) || 1, 1), 50);
}
