import type { PackageDirectoryStatus } from "@marketplace/contracts";
import { packageVersionArtifacts } from "@marketplace/db";
import { eq } from "drizzle-orm";

import type { MarketplaceDeps } from "../deps";
import { directoryListingOf } from "./directory-listing";
import { packageIdHolders } from "./package-id-owners";

export interface StoredVersionRef {
  versionId: string;
  packageRowId: string;
  npmName: string;
  npmVersion: string;
  manifest: unknown;
}

/** The stored measurement of one version, or null when it has not been measured yet. */
export async function versionArtifactOf(deps: MarketplaceDeps, versionId: string) {
  const [row] = await deps.db
    .select()
    .from(packageVersionArtifacts)
    .where(eq(packageVersionArtifacts.packageVersionId, versionId))
    .limit(1);
  return row ?? null;
}

/**
 * How one version appears in ClarkCant's directory feed, with the reason when it does not. Null for a version the
 * backfill has not measured yet.
 */
export async function directoryStatusOf(deps: MarketplaceDeps, version: StoredVersionRef): Promise<PackageDirectoryStatus | null> {
  const artifact = await versionArtifactOf(deps, version.versionId);
  if (!artifact) return null;
  const holders = await packageIdHolders(deps, artifact.manifestId === null ? [] : [artifact.manifestId]);
  // Previews do not change whether a version is listed, so the status needs no absolute URLs.
  const listing = directoryListingOf({ ...version, ...artifact }, holders, {});
  return {
    packageId: artifact.manifestId,
    contentDigest: artifact.contentDigest,
    sizeBytes: artifact.sizeBytes,
    listed: listing.listed,
    reason: listing.listed ? null : listing.reason,
  };
}
