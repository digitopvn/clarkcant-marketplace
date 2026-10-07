import { normalizeStoredManifest } from "@marketplace/contracts";
import { packageVersionArtifacts, packageVersions, packages } from "@marketplace/db";
import { asc, eq, isNull } from "drizzle-orm";

import type { MarketplaceDeps } from "../deps";
import { isIndexingRejection } from "../indexing/indexing-errors";
import { verifyTarballIntegrity } from "../indexing/integrity";
import { createNpmRegistry, resolveVersion, type NpmRegistry } from "../indexing/npm-registry";
import { computeRuntimeContentDigest } from "../indexing/runtime-content-digest";

/**
 * The per-version facts ClarkCant's directory needs and a manifest cannot give: the manifest's package id, and the
 * runtime content digest and size of the npm archive. Measured once per version, from tarball bytes that already
 * matched npm's sha512 integrity, and stored in `package_version_artifacts`.
 */

export type VersionArtifactRow = typeof packageVersionArtifacts.$inferInsert;

/** The package id a stored manifest declares, read as tolerantly as the rest of the listing reads it. */
export function manifestIdOf(storedManifest: unknown): string | null {
  return normalizeStoredManifest(storedManifest)?.id ?? null;
}

/**
 * Measures an integrity-verified tarball. An archive ClarkCant would refuse, or digest differently per platform, still
 * gets a row: no digest, and the reason, so the version is not measured again to the same answer.
 */
export async function measureVersionArtifact(
  deps: Pick<MarketplaceDeps, "now">,
  versionId: string,
  storedManifest: unknown,
  verifiedTarball: Uint8Array,
): Promise<VersionArtifactRow> {
  const measured = await computeRuntimeContentDigest(verifiedTarball);
  return {
    packageVersionId: versionId,
    manifestId: manifestIdOf(storedManifest),
    contentDigest: measured.ok ? measured.digest : null,
    sizeBytes: measured.ok ? measured.sizeBytes : null,
    fileCount: measured.ok ? measured.fileCount : null,
    digestProblem: measured.ok ? null : measured.reason,
    computedAt: deps.now(),
  };
}

/** Stores a measurement unless one is already there (two runs measuring one version write the same facts). */
export async function storeVersionArtifact(deps: MarketplaceDeps, row: VersionArtifactRow): Promise<void> {
  await deps.db.insert(packageVersionArtifacts).values(row).onConflictDoNothing();
}

export interface StoredVersion {
  id: string;
  packageName: string;
  version: string;
  npmIntegrity: string;
  manifest: unknown;
}

/**
 * Downloads a stored version's tarball again, checks it against the integrity recorded when it was indexed, and
 * measures it. A tarball npm no longer serves, or serves with other bytes, is a permanent fact about the version and
 * is recorded as a problem; anything else (network, registry outage) throws so the caller tries again later.
 * `tarballUrl` skips the packument when the caller has just resolved it.
 */
export async function remeasureStoredVersion(
  deps: MarketplaceDeps,
  registry: NpmRegistry,
  version: StoredVersion,
  tarballUrl?: string,
): Promise<VersionArtifactRow> {
  try {
    const url = tarballUrl ?? resolveVersion(await registry.fetchPackument(version.packageName), version.version).tarballUrl;
    const tarball = await registry.fetchTarball(url);
    await verifyTarballIntegrity(tarball, version.npmIntegrity);
    return await measureVersionArtifact(deps, version.id, version.manifest, tarball);
  } catch (error) {
    if (!isIndexingRejection(error)) throw error;
    return {
      packageVersionId: version.id,
      manifestId: manifestIdOf(version.manifest),
      contentDigest: null,
      sizeBytes: null,
      fileCount: null,
      digestProblem: `the indexed archive could not be fetched again (${error.code}: ${error.message})`.slice(0, 1000),
      computedAt: deps.now(),
    };
  }
}

/**
 * Measures an already indexed version that has no measurement yet, as part of indexing it again. Best effort: a
 * transient failure is logged and left to {@link backfillVersionArtifacts}, so it never fails the indexing run.
 */
export async function ensureVersionArtifact(
  deps: MarketplaceDeps,
  registry: NpmRegistry,
  version: StoredVersion,
  tarballUrl: string,
): Promise<void> {
  const [existing] = await deps.db
    .select({ id: packageVersionArtifacts.packageVersionId })
    .from(packageVersionArtifacts)
    .where(eq(packageVersionArtifacts.packageVersionId, version.id))
    .limit(1);
  if (existing) return;
  try {
    await storeVersionArtifact(deps, await remeasureStoredVersion(deps, registry, version, tarballUrl));
  } catch (error) {
    console.error(`directory: could not measure ${version.packageName}@${version.version}; the backfill retries it`, error);
  }
}

/** Versions one backfill run measures at most; each is a packument and a tarball download. */
export const DEFAULT_BACKFILL_LIMIT = 5;
export const MAX_BACKFILL_LIMIT = 50;

export interface BackfillVersionArtifactsOptions {
  registry?: NpmRegistry;
  limit?: number;
}

export interface BackfillVersionArtifactsResult {
  /** Versions now measured with a digest. */
  measured: number;
  /** Versions recorded without one (archive refused, gone from npm, or changed). */
  withoutDigest: number;
  /** Versions that failed transiently and stay owed. */
  failed: number;
}

/**
 * Measures versions indexed before `package_version_artifacts` existed, oldest first. The jobs Worker runs it on its
 * schedule with a small limit until none are owed; it is idempotent, and a version that fails transiently is simply
 * picked up by the next run.
 */
export async function backfillVersionArtifacts(
  deps: MarketplaceDeps,
  options: BackfillVersionArtifactsOptions = {},
): Promise<BackfillVersionArtifactsResult> {
  const registry = options.registry ?? createNpmRegistry();
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? DEFAULT_BACKFILL_LIMIT)), MAX_BACKFILL_LIMIT);
  const owed = await deps.db
    .select({
      id: packageVersions.id,
      packageName: packages.name,
      version: packageVersions.version,
      npmIntegrity: packageVersions.npmIntegrity,
      manifest: packageVersions.manifest,
    })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .leftJoin(packageVersionArtifacts, eq(packageVersionArtifacts.packageVersionId, packageVersions.id))
    .where(isNull(packageVersionArtifacts.packageVersionId))
    .orderBy(asc(packageVersions.id))
    .limit(limit);

  const result: BackfillVersionArtifactsResult = { measured: 0, withoutDigest: 0, failed: 0 };
  for (const version of owed) {
    try {
      const row = await remeasureStoredVersion(deps, registry, version);
      await storeVersionArtifact(deps, row);
      if (row.contentDigest) result.measured += 1;
      else result.withoutDigest += 1;
    } catch (error) {
      result.failed += 1;
      console.error(`directory: could not measure ${version.packageName}@${version.version}; retrying next run`, error);
    }
  }
  return result;
}
