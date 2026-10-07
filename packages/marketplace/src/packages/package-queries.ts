import {
  MarketplaceError,
  listPackagesQuerySchema,
  normalizeStoredManifest,
  packageNameSchema,
  semverSchema,
  type ListPackagesQueryInput,
  type Page,
  type PackageDetail,
  type PackageInstall,
  type PackageService,
  type PackageSummary,
  type PackageVersionSummary,
} from "@marketplace/contracts";
import {
  media,
  packageAudits,
  packageFacets,
  packagePermissions,
  packagePreviews,
  packageVersions,
  packages,
  publishers,
} from "@marketplace/db";
import { mediaUrlFor } from "@marketplace/media";
import { and, asc, desc, eq } from "drizzle-orm";

import type { MarketplaceDeps } from "../deps";
import { directoryStatusOf, versionArtifactOf } from "../directory/directory-status";
import { manifestIdOf } from "../directory/version-artifacts";
import { findPackages } from "../search/search-packages";
import { parseInput } from "../validation";
import { isPubliclyVisible, latestFirst, packageSummaryColumns, toPackageSummary } from "./package-rows";

export { latestFirst, offsetFromCursor, toPage } from "./package-rows";

const MAX_VERSIONS_LISTED = 50;

/**
 * Public package listing with the shared filters (`q`, category, facet kind, isolation, platform, publisher…).
 * Accepts raw query-string values too: everything is validated against `listPackagesQuerySchema` here.
 */
export async function listPackages(
  deps: MarketplaceDeps,
  input: ListPackagesQueryInput | Record<string, string | undefined> = {},
): Promise<Page<PackageSummary>> {
  const { sort, ...query } = parseInput(listPackagesQuerySchema, input);
  return findPackages(deps, query, sort);
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

async function findPublicPackage(deps: MarketplaceDeps, rawName: unknown) {
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
  return row;
}

/** Full public detail for one package. Hidden, rejected and unreviewed packages are indistinguishable from absent. */
export async function getPackage(deps: MarketplaceDeps, rawName: unknown): Promise<PackageDetail> {
  const row = await findPublicPackage(deps, rawName);
  const versions = await deps.db
    .select({ version: packageVersions.version, publishedAt: packageVersions.publishedAt })
    .from(packageVersions)
    .where(eq(packageVersions.packageId, row.id))
    .orderBy(desc(packageVersions.publishedAt))
    .limit(MAX_VERSIONS_LISTED);

  return {
    ...toPackageSummary(row),
    homepage: row.homepage,
    repositoryUrl: row.repositoryUrl,
    license: row.license,
    latest: row.latestVersion ? await getVersionDetail(deps, row.id, row.name, row.latestVersion) : null,
    versions: versions.map((version) => ({ version: version.version, publishedAt: version.publishedAt.toISOString() })),
  };
}

/** Every indexed version of a public package, newest first, with its integrity and provenance facts. */
export async function listPackageVersions(deps: MarketplaceDeps, rawName: unknown): Promise<PackageVersionSummary[]> {
  const row = await findPublicPackage(deps, rawName);
  const versions = await deps.db
    .select()
    .from(packageVersions)
    .where(eq(packageVersions.packageId, row.id))
    .orderBy(desc(packageVersions.publishedAt), desc(packageVersions.version));
  return versions.map((version) => ({
    version: version.version,
    publishedAt: version.publishedAt.toISOString(),
    indexedAt: version.indexedAt.toISOString(),
    npmIntegrity: version.npmIntegrity,
    tarballSha512Verified: version.tarballSha512Verified,
    hasProvenance: version.provenance !== null && version.provenance !== undefined,
  }));
}

/**
 * PROPOSED ClarkCant deep link. ClarkCant registers no URL scheme yet; this is the shape the marketplace emits and
 * documents so the runtime can adopt it: `clarkcant://install?source=npm&package=<name>&version=<exact>`.
 */
export function openInClarkCantUrl(name: string, version: string): string {
  const params = new URLSearchParams({ source: "npm", package: name, version });
  return `clarkcant://install?${params.toString()}`;
}

/**
 * The install coordinate for a public package: one exact version (the latest unless `version` is given), its npm
 * integrity, the proposed deep link and a copyable command. ClarkCant must re-verify the integrity itself; nothing
 * here grants permissions.
 */
export async function getPackageInstall(
  deps: MarketplaceDeps,
  rawName: unknown,
  rawVersion?: unknown,
): Promise<PackageInstall> {
  const row = await findPublicPackage(deps, rawName);
  const version = rawVersion === undefined ? row.latestVersion : parseInput(semverSchema, rawVersion);
  if (!version) throw new MarketplaceError("not_found", `package "${row.name}" has no indexed version`);
  const [found] = await deps.db
    .select({ id: packageVersions.id, npmIntegrity: packageVersions.npmIntegrity, manifest: packageVersions.manifest })
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, row.id), eq(packageVersions.version, version)))
    .limit(1);
  if (!found) throw new MarketplaceError("not_found", `version ${version} of "${row.name}" is not indexed`);
  const artifact = await versionArtifactOf(deps, found.id);
  return {
    package: row.name,
    version,
    source: "npm",
    integrity: found.npmIntegrity,
    openInClarkCant: openInClarkCantUrl(row.name, version),
    cliCommand: `npm pack ${row.name}@${version}`,
    packageId: artifact ? artifact.manifestId : manifestIdOf(found.manifest),
    contentDigest: artifact?.contentDigest ?? null,
    sizeBytes: artifact?.sizeBytes ?? null,
  };
}

function platformsOf(manifest: unknown): string[] {
  if (typeof manifest !== "object" || manifest === null) return [];
  const platforms = (manifest as { platforms?: unknown }).platforms;
  return Array.isArray(platforms) ? platforms.filter((entry): entry is string => typeof entry === "string") : [];
}

function schemaVersionOf(manifest: unknown): 1 | 2 | null {
  if (typeof manifest !== "object" || manifest === null) return null;
  const schemaVersion = (manifest as { schemaVersion?: unknown }).schemaVersion;
  return schemaVersion === 1 || schemaVersion === 2 ? schemaVersion : null;
}

/**
 * What a version's manifest declares beyond flat permission rows: services with their capabilities, egress and account
 * connection, scoped browser tokens and the resource profile. Read from the immutable stored manifest, which is the
 * record of what was validated; a row that no longer matches the mirror shows no details rather than failing the page.
 */
function declaredReach(manifest: unknown): Pick<NonNullable<PackageDetail["latest"]>, "services" | "browserTokens" | "resources"> {
  const normalized = normalizeStoredManifest(manifest);
  if (!normalized) return { services: [], browserTokens: [], resources: null };
  const services: PackageService[] = normalized.services.map((service) => ({
    facetId: service.facetId,
    entry: service.entry,
    protocol: service.protocol,
    capabilities: service.capabilities.map((capability) => ({
      tool: capability.tool,
      ref: capability.ref,
      summary: capability.summary,
      effectCategory: capability.effectCategory,
      job: capability.execution?.kind === "job",
      requiredScopes: capability.requiredScopes ?? [],
      inputArtifactFields: capability.inputArtifacts?.fields ?? [],
    })),
    egress: service.egress
      ? {
          secrets: service.egress.secrets.map((secret) => ({ name: secret.name, purpose: secret.purpose })),
          origins: service.egress.origins.map((origin) => ({
            origin: origin.origin,
            purpose: origin.purpose,
            credential: origin.credential
              ? { secret: origin.credential.secret, header: origin.credential.header, scheme: origin.credential.scheme }
              : null,
          })),
        }
      : null,
    connection: service.connection
      ? {
          provider: service.connection.provider,
          displayName: service.connection.displayName,
          flow: service.connection.flow,
          authorizationEndpoint: service.connection.authorization.authorizationEndpoint,
          tokenEndpoint: service.connection.authorization.tokenEndpoint,
          revocationEndpoint: service.connection.authorization.revocationEndpoint ?? null,
          scopes: service.connection.scopes.map((scope) => ({ scope: scope.scope, purpose: scope.purpose })),
          endpoints: service.connection.endpoints,
          probeUrl: service.connection.probe.url,
        }
      : null,
  }));
  return { services, browserTokens: normalized.browserTokens, resources: normalized.resources };
}

async function getVersionDetail(
  deps: MarketplaceDeps,
  packageId: string,
  packageName: string,
  version: string,
): Promise<PackageDetail["latest"]> {
  const [row] = await deps.db
    .select()
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.version, version)))
    .limit(1);
  if (!row) return null;

  const [facets, permissions, previews, checks, directory] = await Promise.all([
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
    deps.db
      .select({
        kind: packagePreviews.kind,
        alt: packagePreviews.alt,
        r2Key: media.r2Key,
        contentType: media.contentType,
        width: media.width,
        height: media.height,
      })
      .from(packagePreviews)
      .innerJoin(media, eq(media.id, packagePreviews.mediaId))
      .where(eq(packagePreviews.packageVersionId, row.id))
      .orderBy(asc(packagePreviews.position)),
    deps.db
      .select({ check: packageAudits.check, result: packageAudits.result, details: packageAudits.details })
      .from(packageAudits)
      .where(eq(packageAudits.packageVersionId, row.id))
      .orderBy(asc(packageAudits.check)),
    directoryStatusOf(deps, {
      versionId: row.id,
      packageRowId: packageId,
      npmName: packageName,
      npmVersion: row.version,
      manifest: row.manifest,
    }),
  ]);

  return {
    version: row.version,
    publishedAt: row.publishedAt.toISOString(),
    indexedAt: row.indexedAt.toISOString(),
    npmIntegrity: row.npmIntegrity,
    tarballSha512Verified: row.tarballSha512Verified,
    hasProvenance: row.provenance !== null && row.provenance !== undefined,
    readmeHtml: row.readmeHtml,
    platforms: platformsOf(row.manifest),
    manifestSchemaVersion: schemaVersionOf(row.manifest),
    facets,
    permissions,
    ...declaredReach(row.manifest),
    previews: previews.map((preview) => ({
      kind: preview.kind,
      url: mediaUrlFor(preview.r2Key),
      alt: preview.alt,
      contentType: preview.contentType,
      width: preview.width,
      height: preview.height,
    })),
    securityChecks: checks.map((check) => ({ ...check, details: check.details ?? null })),
    directory,
  };
}

function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit) || 1, 1), 50);
}
