import { packageVersionArtifacts, packageVersions, packages } from "@marketplace/db";
import { and, eq, inArray, isNotNull, min } from "drizzle-orm";

import { MAX_IN_LIST_PARAMETERS, chunked } from "../d1-limits";
import type { MarketplaceDeps } from "../deps";
import { isPubliclyVisible } from "../packages/package-rows";

/**
 * Who holds a ClarkCant package id in the directory feed.
 *
 * npm names are unique; the `id` inside `clarkcant.json` is not, and ClarkCant installs by that id. When two npm
 * packages declare the same id, the feed lists only one of them, chosen deterministically:
 *
 * 1. a package whose publisher the marketplace verified wins over one it did not;
 * 2. then the package that claimed the id first (its earliest indexed version declaring the id);
 * 3. then the npm name, in byte order, so equal timestamps still give one answer.
 *
 * Only publicly visible packages with a measured version claim an id, so a curator hiding the holder hands the id to
 * the next claimant. The others stay on the marketplace, flagged on their detail page, and out of the feed. This is a
 * discovery rule, never an authority: ClarkCant decides what an install of that id may do.
 */

export interface PackageIdHolder {
  /** The marketplace package row that holds the id. */
  packageRowId: string;
  name: string;
}

interface Claim {
  manifestId: string;
  packageRowId: string;
  name: string;
  verified: boolean;
  firstClaimAt: number;
}

function byPrecedence(a: Claim, b: Claim): number {
  if (a.verified !== b.verified) return a.verified ? -1 : 1;
  if (a.firstClaimAt !== b.firstClaimAt) return a.firstClaimAt - b.firstClaimAt;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** The holder of each given package id; an id no public package claims is absent from the map. */
export async function packageIdHolders(
  deps: MarketplaceDeps,
  manifestIds: Iterable<string>,
): Promise<Map<string, PackageIdHolder>> {
  const ids = [...new Set(manifestIds)];
  const claims: Claim[] = [];
  for (const group of chunked(ids, MAX_IN_LIST_PARAMETERS)) {
    const rows = await deps.db
      .select({
        manifestId: packageVersionArtifacts.manifestId,
        packageRowId: packages.id,
        name: packages.name,
        verified: packages.verifiedPublisher,
        firstClaimAt: min(packageVersions.indexedAt),
      })
      .from(packageVersionArtifacts)
      .innerJoin(packageVersions, eq(packageVersions.id, packageVersionArtifacts.packageVersionId))
      .innerJoin(packages, eq(packages.id, packageVersions.packageId))
      .where(
        and(
          inArray(packageVersionArtifacts.manifestId, group),
          isNotNull(packageVersionArtifacts.contentDigest),
          isPubliclyVisible(),
        ),
      )
      .groupBy(packageVersionArtifacts.manifestId, packages.id);
    for (const row of rows) {
      if (row.manifestId === null) continue;
      claims.push({
        manifestId: row.manifestId,
        packageRowId: row.packageRowId,
        name: row.name,
        verified: row.verified,
        firstClaimAt: row.firstClaimAt?.getTime() ?? Number.MAX_SAFE_INTEGER,
      });
    }
  }

  const holders = new Map<string, PackageIdHolder>();
  for (const claim of claims.sort(byPrecedence)) {
    if (!holders.has(claim.manifestId)) holders.set(claim.manifestId, { packageRowId: claim.packageRowId, name: claim.name });
  }
  return holders;
}
