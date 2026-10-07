import { z } from "zod";

// Explicit `.ts` imports only: `scripts/sync-clarkcant-fixtures.mjs` loads this module in plain Node (type stripping)
// to have ClarkCant's own `directoryEntrySchema` judge the entries it builds.
import {
  DEFAULT_RESOURCE_PROFILE,
  browserTokenDeclarationSchema,
  connectionScopeSchema,
  facetKindSchema,
  isolationClassSchema,
  networkOriginSchema,
  packageManifestSchema,
  platformSchema,
  readClarkcantManifest,
  resourceRequestSchema,
  semverSchema,
  serviceEgressSchema,
  upgradeWidgetManifestV1,
  type ClarkcantManifest,
  type PackageManifest,
} from "./manifest.ts";

/**
 * Mirror of ClarkCant's directory entry (`clarkcant/packages/contracts/src/directory.ts`, `declared-reach.ts`) and of
 * how ClarkCant builds one from a manifest (`clark widget publish`, `directoryEntryOf`). Copied, like the manifest
 * mirror, so the marketplace takes no build dependency on the runtime repo; `pnpm contract:check` replays entries this
 * module built through ClarkCant's own schema and reach derivation (`fixtures/upstream/clarkcant-directory/`).
 *
 * An entry is a discovery claim, never an authority: ClarkCant re-resolves the npm version, checks the registry's
 * integrity and the entry's `digest`, reads the downloaded `clarkcant.json` and asks its own policy. Nothing here
 * grants a permission.
 */

/** The feed format ClarkCant's directory provider reads (`DIRECTORY_FEED_FORMAT` in `marketplace-directory.ts`). */
export const DIRECTORY_FEED_FORMAT = "clarkcant-directory@1";

/** The longest version a listing may carry (`DIRECTORY_VERSION_MAX`). */
export const DIRECTORY_VERSION_MAX = 80;

const purposeSchema = z.string().min(1).max(300);
const egressSecretNameSchema = serviceEgressSchema.shape.secrets.element.shape.name;
const browserTokenProviderSchema = browserTokenDeclarationSchema.shape.provider;
const browserTokenScopeSchema = browserTokenDeclarationSchema.shape.scopes.element;

/** What a package reaches beyond its sandbox (`declaredReachSchema`). Binding in ClarkCant: an install refuses a mismatch. */
export const declaredReachSchema = z.strictObject({
  origins: z
    .array(z.strictObject({ origin: networkOriginSchema, purpose: purposeSchema, secret: egressSecretNameSchema.optional() }))
    .max(64),
  secrets: z.array(z.strictObject({ name: egressSecretNameSchema, purpose: purposeSchema })).max(64),
  browserTokens: z
    .array(
      z.strictObject({
        provider: browserTokenProviderSchema,
        scopes: z.array(browserTokenScopeSchema).min(1).max(64),
        purpose: purposeSchema,
      }),
    )
    .max(64),
  connections: z
    .array(
      z.strictObject({
        provider: z.string().min(1).max(64),
        displayName: z.string().min(1).max(120),
        scopes: z.array(z.strictObject({ scope: connectionScopeSchema, purpose: purposeSchema })).min(1).max(16),
        endpoints: z.array(networkOriginSchema).min(1).max(8),
      }),
    )
    .max(8)
    .optional(),
});
export type DeclaredReach = z.infer<typeof declaredReachSchema>;

export const riskLaneSchema = z.enum(["isolated-ui", "service", "declarative", "trusted-native"]);
export type RiskLane = z.infer<typeof riskLaneSchema>;

/** Where the artifact is fetched from. The marketplace lists npm packages only. */
export const npmPackageSourceSchema = z.strictObject({
  kind: z.literal("npm"),
  name: z.string().min(1).max(300),
  version: z.string().min(1).max(80),
});

/** ClarkCant's `directoryEntrySchema`, restricted to the npm source the marketplace serves. */
export const directoryEntrySchema = z
  .strictObject({
    packageId: z.string().min(1).max(160),
    version: semverSchema.max(DIRECTORY_VERSION_MAX, {
      error: `must be a semantic version of at most ${String(DIRECTORY_VERSION_MAX)} characters`,
    }),
    displayName: z.string().min(1).max(200),
    description: z.string().min(1).max(600),
    source: npmPackageSourceSchema,
    publisher: z.strictObject({
      id: z.string().min(1).max(160),
      sourceUrl: z.string().min(1).max(400),
      license: z.string().min(1).max(80),
    }),
    preview: z.strictObject({
      imageUrl: z.string().min(1).max(1000).optional(),
      videoUrl: z.string().min(1).max(1000).optional(),
    }),
    facets: z.array(facetKindSchema).min(1).max(64),
    isolations: z.array(z.strictObject({ facetKind: facetKindSchema, isolation: isolationClassSchema })).min(1).max(64),
    platforms: z.array(platformSchema).min(1),
    hostApi: z.strictObject({ min: z.int().nonnegative(), max: z.int().nonnegative() }),
    permissionsSummary: z.array(z.string().min(1).max(200)).max(64),
    declaredReach: declaredReachSchema.optional(),
    resources: resourceRequestSchema.optional(),
    riskTier: riskLaneSchema,
    sizeBytes: z.int().nonnegative(),
    digest: z.string().min(1).max(120),
  });
export type DirectoryEntry = z.infer<typeof directoryEntrySchema>;

/** The page cap the API applies; ClarkCant reads at most 20 pages of at most 8 MiB and 5,000 entries in all. */
export const MAX_DIRECTORY_PAGE_SIZE = 250;
export const DIRECTORY_CURSOR_MAX = 200;

export const directoryFeedQuerySchema = z.object({
  cursor: z.string().min(1).max(DIRECTORY_CURSOR_MAX).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_DIRECTORY_PAGE_SIZE).default(MAX_DIRECTORY_PAGE_SIZE),
});
export type DirectoryFeedQuery = z.infer<typeof directoryFeedQuerySchema>;

/** One page of the feed: `{ format, entries, nextCursor }`, `nextCursor` null on the last page. */
export const directoryFeedPageSchema = z.strictObject({
  format: z.literal(DIRECTORY_FEED_FORMAT),
  entries: z.array(directoryEntrySchema),
  nextCursor: z.string().min(1).max(DIRECTORY_CURSOR_MAX).nullable(),
});
export type DirectoryFeedPage = z.infer<typeof directoryFeedPageSchema>;

/* ------------------------------------------------------------------ *
 * Building an entry from a manifest (ClarkCant: `clark widget publish`, `directoryEntryOf`)
 * ------------------------------------------------------------------ */

type Facet = PackageManifest["facets"][number];

/** Sorted by key with repeats removed, so two lists of the same items compare equal (`canonical` in declared-reach.ts). */
function canonical<T>(items: readonly T[], key: (item: T) => string): T[] {
  const unique = new Map<string, T>();
  for (const item of items) unique.set(key(item), item);
  return [...unique.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, item]) => item);
}

/** ClarkCant's `canonicalReach`. */
export function canonicalReach(reach: DeclaredReach): DeclaredReach {
  const connections = canonical(
    (reach.connections ?? []).map((entry) => ({
      provider: entry.provider,
      displayName: entry.displayName,
      scopes: canonical(
        entry.scopes.map((scope) => ({ scope: scope.scope, purpose: scope.purpose })),
        (scope) => JSON.stringify([scope.scope, scope.purpose]),
      ),
      endpoints: [...new Set(entry.endpoints)].sort(),
    })),
    (entry) => JSON.stringify([entry.provider, entry.displayName, entry.scopes, entry.endpoints]),
  );
  return {
    origins: canonical(
      reach.origins.map((entry) => ({
        origin: entry.origin,
        purpose: entry.purpose,
        ...(entry.secret === undefined ? {} : { secret: entry.secret }),
      })),
      (entry) => JSON.stringify([entry.origin, entry.purpose, entry.secret ?? ""]),
    ),
    secrets: canonical(
      reach.secrets.map((entry) => ({ name: entry.name, purpose: entry.purpose })),
      (entry) => JSON.stringify([entry.name, entry.purpose]),
    ),
    browserTokens: canonical(
      reach.browserTokens.map((entry) => ({ provider: entry.provider, scopes: [...new Set(entry.scopes)].sort(), purpose: entry.purpose })),
      (entry) => JSON.stringify([entry.provider, entry.scopes, entry.purpose]),
    ),
    ...(connections.length === 0 ? {} : { connections }),
  };
}

/** ClarkCant's `declaredReachOf`: service egress and connections, and UI browser tokens, in canonical form. */
export function declaredReachOf(manifest: { facets: readonly Facet[] }): DeclaredReach {
  const reach: DeclaredReach = { origins: [], secrets: [], browserTokens: [] };
  for (const facet of manifest.facets) {
    if (facet.kind === "tools" && facet.egress !== undefined) {
      for (const entry of facet.egress.origins) {
        reach.origins.push({
          origin: entry.origin,
          purpose: entry.purpose,
          ...(entry.credential === undefined ? {} : { secret: entry.credential.secret }),
        });
      }
      reach.secrets.push(...facet.egress.secrets);
    }
    if (facet.kind === "tools" && facet.connection !== undefined) {
      (reach.connections ??= []).push({
        provider: facet.connection.provider,
        displayName: facet.connection.displayName,
        scopes: facet.connection.scopes,
        endpoints: facet.connection.endpoints,
      });
    }
    if (facet.kind === "ui" && facet.browserTokens !== undefined) reach.browserTokens.push(...facet.browserTokens.providers);
  }
  return canonicalReach(reach);
}

export function declaredReachIsEmpty(reach: DeclaredReach): boolean {
  return (
    reach.origins.length === 0 &&
    reach.secrets.length === 0 &&
    reach.browserTokens.length === 0 &&
    (reach.connections?.length ?? 0) === 0
  );
}

const LANE_ORDER: readonly RiskLane[] = ["declarative", "isolated-ui", "service", "trusted-native"];

/** ClarkCant's `riskLaneFor`: the strongest lane among the facets, because a package is as trusted as its least isolated part. */
export function riskLaneFor(isolations: readonly RiskLane[]): RiskLane {
  let strongest: RiskLane = "declarative";
  for (const isolation of isolations) {
    if (LANE_ORDER.indexOf(isolation) > LANE_ORDER.indexOf(strongest)) strongest = isolation;
  }
  return strongest;
}

/** ClarkCant's `requestedSummary`: the host permissions a listing shows. */
export function requestedSummary(permissions: PackageManifest["permissions"]): string[] {
  const out = permissions.networkOrigins.map((origin) => "network: " + origin);
  for (const { path, access } of permissions.filesystem) out.push(`filesystem (${access}): ${path}`);
  if (permissions.microphone) out.push("microphone");
  if (permissions.camera) out.push("camera");
  return out;
}

/** Whether a resource request says anything an absent one does not (`requestsMoreThanDefault`). */
function requestsMoreThanDefault(resources: PackageManifest["resources"]): resources is NonNullable<PackageManifest["resources"]> {
  return resources !== undefined && (resources.profile !== DEFAULT_RESOURCE_PROFILE || resources.gpu === true);
}

/**
 * The canonical manifest ClarkCant reads a stored `clarkcant.json` as: schemaVersion 2 as written, schemaVersion 1
 * upgraded (`ui` facets, read-only filesystem paths). Null for anything ClarkCant does not read, including the
 * schemaVersion-less draft some old versions were indexed under.
 */
export function canonicalManifestOf(stored: unknown): PackageManifest | null {
  const read = readClarkcantManifest(stored);
  if (!read.ok) return null;
  const manifest: ClarkcantManifest = read.manifest;
  if (!("schemaVersion" in manifest)) return null;
  if (manifest.schemaVersion === 2) return manifest;
  const upgraded = packageManifestSchema.safeParse(upgradeWidgetManifestV1(manifest));
  return upgraded.success ? upgraded.data : null;
}

/** What the listing adds to the manifest: where the bytes are and what they measure. */
export interface DirectoryListingFacts {
  npmName: string;
  npmVersion: string;
  /** The runtime content digest (`sha256:<hex>`), as `clark widget pack` records it in `npm.contentDigest`. */
  digest: string;
  /** Total bytes of the archive's regular files, as `clark widget pack` records `npm.unpackedBytes`. */
  sizeBytes: number;
  /** Absolute preview URLs. */
  preview: { imageUrl?: string; videoUrl?: string };
}

/** The entry `clark widget publish` would write for this manifest and archive, before validation. */
export function directoryEntryOf(
  manifest: PackageManifest,
  publisher: DirectoryEntry["publisher"],
  listing: DirectoryListingFacts,
): DirectoryEntry {
  const reach = declaredReachOf(manifest);
  return {
    packageId: manifest.id,
    version: manifest.version,
    displayName: manifest.displayName,
    description: manifest.description,
    source: { kind: "npm", name: listing.npmName, version: listing.npmVersion },
    publisher,
    preview: listing.preview,
    facets: [...new Set(manifest.facets.map((facet) => facet.kind))],
    isolations: manifest.facets.map((facet) => ({ facetKind: facet.kind, isolation: facet.isolation })),
    platforms: manifest.platforms,
    hostApi: manifest.hostApi,
    permissionsSummary: requestedSummary(manifest.permissions),
    ...(declaredReachIsEmpty(reach) ? {} : { declaredReach: reach }),
    ...(requestsMoreThanDefault(manifest.resources) ? { resources: manifest.resources } : {}),
    riskTier: riskLaneFor(manifest.facets.map((facet) => facet.isolation)),
    sizeBytes: listing.sizeBytes,
    digest: listing.digest,
  };
}

export type DirectoryEntryResult = { ok: true; entry: DirectoryEntry } | { ok: false; reason: string };

/**
 * Builds and validates the directory entry for a stored manifest. A version that cannot be one is named with the
 * reason instead: ClarkCant refuses a whole feed when one entry does not match its schema, so an entry that does not
 * validate here is never served.
 */
export function buildDirectoryEntry(storedManifest: unknown, listing: DirectoryListingFacts): DirectoryEntryResult {
  const manifest = canonicalManifestOf(storedManifest);
  if (!manifest) {
    return { ok: false, reason: "ClarkCant does not read this clarkcant.json format, so it cannot be listed" };
  }
  if (!manifest.publisher) {
    return { ok: false, reason: "clarkcant.json declares no publisher, and a directory entry has to say who a package comes from" };
  }
  const { id, sourceUrl, license } = manifest.publisher;
  const parsed = directoryEntrySchema.safeParse(directoryEntryOf(manifest, { id, sourceUrl, license }, listing));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: `the directory entry would not match ClarkCant's schema (${issue ? `${issue.path.join(".") || "(entry)"}: ${issue.message}` : "invalid"})`,
    };
  }
  return { ok: true, entry: parsed.data };
}
