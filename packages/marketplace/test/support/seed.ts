import type { CurationStatus } from "@marketplace/contracts";
import {
  auditEvents,
  categories,
  collectionItems,
  collections,
  idempotencyKeys,
  packageFacets,
  packagePermissions,
  packageVersions,
  packages,
  packagesFts,
  publishers,
} from "@marketplace/db";
import { sql } from "drizzle-orm";
import { env } from "cloudflare:workers";

import { createMarketplaceDeps, syncPackageSearchDocument, type MarketplaceDeps } from "../../src";

/** Real D1 deps for a test, with an optionally frozen clock. */
export function testDeps(now?: () => Date): MarketplaceDeps {
  const deps = createMarketplaceDeps({ d1: env.DB });
  return now ? { ...deps, now } : deps;
}

/** Empties every table the tests write, leaving migrations and seeded categories intact. */
export async function resetDatabase(deps: MarketplaceDeps): Promise<void> {
  await deps.db.batch([
    deps.db.delete(packagesFts),
    deps.db.delete(collectionItems),
    deps.db.delete(collections),
    deps.db.delete(packagePermissions),
    deps.db.delete(packageFacets),
    deps.db.delete(packageVersions),
    deps.db.delete(packages),
    deps.db.delete(publishers),
    deps.db.delete(auditEvents),
    deps.db.delete(idempotencyKeys),
    deps.db.delete(categories).where(sql`${categories.slug} like 'test-%'`),
  ]);
}

export interface SeedPackage {
  name: string;
  displayName?: string;
  description?: string;
  keywords?: string[];
  curationStatus?: CurationStatus;
  categorySlug?: string | null;
  publisher?: { slug: string; name: string } | null;
  version?: string;
  facets?: { kind: string; isolation: string; entry?: string }[];
  indexedAt?: Date;
}

/** Inserts a package the way the indexer will (package, publisher, version, facets) and syncs its search row. */
export async function seedPackage(deps: MarketplaceDeps, input: SeedPackage): Promise<string> {
  const packageId = deps.ids("pkg");
  const versionId = deps.ids("pv");
  const version = input.version ?? "1.0.0";
  const indexedAt = input.indexedAt ?? new Date("2026-09-01T00:00:00.000Z");

  let publisherId: string | null = null;
  if (input.publisher) {
    publisherId = deps.ids("pub");
    await deps.db
      .insert(publishers)
      .values({ id: publisherId, slug: input.publisher.slug, name: input.publisher.name, kind: "org" });
  }

  await deps.db.insert(packages).values({
    id: packageId,
    name: input.name,
    publisherId,
    displayName: input.displayName ?? input.name,
    description: input.description ?? "",
    latestVersion: version,
    keywords: input.keywords ?? [],
    categorySlug: input.categorySlug === undefined ? "widgets" : input.categorySlug,
    curationStatus: input.curationStatus ?? "listed",
    verifiedPublisher: false,
    indexedAt,
  });
  await deps.db.insert(packageVersions).values({
    id: versionId,
    packageId,
    version,
    manifest: { id: input.name, version },
    npmIntegrity: "sha512-test",
    publishedAt: indexedAt,
    indexedAt,
  });
  for (const facet of input.facets ?? [{ kind: "widget", isolation: "isolated-ui" }]) {
    await deps.db.insert(packageFacets).values({
      id: deps.ids("pf"),
      packageVersionId: versionId,
      kind: facet.kind,
      isolation: facet.isolation,
      entry: facet.entry ?? "widgets/main/index.html",
    });
  }
  await syncPackageSearchDocument(deps, packageId);
  return packageId;
}
