import { z } from "zod";

import { effectCategorySchema, isolationClassSchema, resourceProfileNameSchema } from "./manifest";
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from "./pagination";

/** npm package name rules (lowercase, optional scope, URL-safe, ≤214 chars). */
export const packageNameSchema = z
  .string()
  .min(1)
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/, { error: "must be a valid npm package name" });

export const curationStatusSchema = z.enum(["unreviewed", "listed", "featured", "hidden", "rejected"]);
export type CurationStatus = z.infer<typeof curationStatusSchema>;

/** Only these statuses are visible on public surfaces (web, API, MCP, sitemaps). */
export const PUBLIC_CURATION_STATUSES = ["listed", "featured"] as const satisfies readonly CurationStatus[];

/** Lowercase kebab slug used for categories and collections. */
export const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { error: "must be a lowercase slug" });
export const categorySlugSchema = slugSchema;

const isoDateTime = z.iso.datetime();

export const publisherRefSchema = z.object({
  slug: z.string(),
  name: z.string(),
  verified: z.boolean(),
});

export const packageSummarySchema = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  latestVersion: z.string().nullable(),
  publisher: publisherRefSchema.nullable(),
  categorySlug: z.string().nullable(),
  curationStatus: curationStatusSchema,
  keywords: z.array(z.string()),
  indexedAt: isoDateTime.nullable(),
  updatedAt: isoDateTime,
});
export type PackageSummary = z.infer<typeof packageSummarySchema>;

export const packageFacetSchema = z.object({
  kind: z.string(),
  isolation: z.string(),
  renderer: z.string().nullable(),
  entry: z.string(),
  widgetId: z.string().nullable(),
});

/**
 * Kinds of permission rows: one fact a manifest requests, flattened for listing and search.
 *
 * | kind | value | access |
 * | --- | --- | --- |
 * | `capability` | host capability ref | null |
 * | `network` | origin a widget may reach | null |
 * | `filesystem` | package-relative path | `read`, `write` (null on rows indexed before v1 paths were read as `read`) |
 * | `microphone`, `camera` | the device | null |
 * | `lifecycle` | install or update script | null |
 * | `service-capability` | capability ref a service provides | its effect category |
 * | `egress` | origin a service reaches through the host | secret the host adds, or null |
 * | `secret` | secret a person provides for the service | null |
 * | `connection-scope` | account scope the connection asks for | provider id |
 * | `connection-endpoint` | origin the host sends the account credential to | provider id |
 * | `browser-token` | provider a widget asks a scoped token from | its scopes, space-separated |
 * | `resource-profile` | resource profile asked for | `gpu` when a GPU is asked for, else null |
 */
export const PACKAGE_PERMISSION_KINDS = [
  "capability",
  "network",
  "filesystem",
  "microphone",
  "camera",
  "lifecycle",
  "service-capability",
  "egress",
  "secret",
  "connection-scope",
  "connection-endpoint",
  "browser-token",
  "resource-profile",
] as const;
export const packagePermissionKindSchema = z.enum(PACKAGE_PERMISSION_KINDS);
export type PackagePermissionKind = z.infer<typeof packagePermissionKindSchema>;

export const packagePermissionSchema = z.object({
  kind: packagePermissionKindSchema,
  value: z.string(),
  access: z.string().nullable(),
});

export const packageServiceCapabilitySchema = z.object({
  /** Name the service answers to on its own protocol. */
  tool: z.string(),
  /** Capability ref it becomes, under the package's own id. */
  ref: z.string(),
  summary: z.string(),
  effectCategory: effectCategorySchema,
  /** True when the capability runs as a job the widget can follow and stop. */
  job: z.boolean(),
  /** Connection scopes the capability needs. */
  requiredScopes: z.array(z.string()),
  /** Arguments that carry ids of files a widget holds, which the host lets the service read for that call. */
  inputArtifactFields: z.array(z.string()),
});

/** A service facet as declared: what it provides and what it reaches through the host. Requests, never grants. */
export const packageServiceSchema = z.object({
  facetId: z.string(),
  entry: z.string(),
  protocol: z.string(),
  capabilities: z.array(packageServiceCapabilitySchema),
  egress: z
    .object({
      /** Secrets a person types into ClarkCant; the service never sees their values. */
      secrets: z.array(z.object({ name: z.string(), purpose: z.string() })),
      origins: z.array(
        z.object({
          origin: z.string(),
          purpose: z.string(),
          credential: z.object({ secret: z.string(), header: z.string(), scheme: z.enum(["bearer", "raw"]) }).nullable(),
        }),
      ),
    })
    .nullable(),
  connection: z
    .object({
      provider: z.string(),
      displayName: z.string(),
      flow: z.literal("oauth-pkce"),
      authorizationEndpoint: z.string(),
      tokenEndpoint: z.string(),
      revocationEndpoint: z.string().nullable(),
      scopes: z.array(z.object({ scope: z.string(), purpose: z.string() })),
      /** Origins the host sends the account credential to. */
      endpoints: z.array(z.string()),
      probeUrl: z.string(),
    })
    .nullable(),
});
export type PackageService = z.infer<typeof packageServiceSchema>;

export const packageBrowserTokenSchema = z.object({
  facetId: z.string(),
  provider: z.string(),
  scopes: z.array(z.string()),
  purpose: z.string(),
});

export const packagePreviewSchema = z.object({
  kind: z.enum(["image", "video", "social_card"]),
  /** Site-relative URL of the content-addressed media object (`/media/sha256/…`). */
  url: z.string(),
  alt: z.string(),
  contentType: z.string(),
  width: z.int().nullable(),
  height: z.int().nullable(),
});
export type PackagePreview = z.infer<typeof packagePreviewSchema>;

export const packageSecurityCheckSchema = z.object({
  /** e.g. `integrity`, `provenance`, `install-scripts`. */
  check: z.string(),
  result: z.enum(["pass", "warn", "fail"]),
  details: z.unknown().nullable(),
});
export type PackageSecurityCheck = z.infer<typeof packageSecurityCheckSchema>;

/**
 * How a version appears in ClarkCant's directory feed (`GET /api/v1/directory`). Discovery facts only: ClarkCant
 * recomputes the digest after fetching from npm and asks its own policy.
 */
export const packageDirectoryStatusSchema = z.object({
  /** The ClarkCant package id the manifest declares (`clarkcant.json` `id`); null if the stored manifest is unreadable. */
  packageId: z.string().nullable(),
  /**
   * The runtime content digest of the npm archive, computed as ClarkCant computes it after fetching (`sha256:<hex>`);
   * null when it was not computed (see `reason`).
   */
  contentDigest: z.string().nullable(),
  /** Total bytes of the archive's regular files; null when the archive was not measured. */
  sizeBytes: z.int().nonnegative().nullable(),
  /** Whether the directory feed serves this version. */
  listed: z.boolean(),
  /** Why the feed does not serve it (another package holds the id, no publisher, no digest...); null when listed. */
  reason: z.string().nullable(),
});
export type PackageDirectoryStatus = z.infer<typeof packageDirectoryStatusSchema>;

export const packageVersionDetailSchema = z.object({
  version: z.string(),
  publishedAt: isoDateTime,
  indexedAt: isoDateTime,
  npmIntegrity: z.string(),
  tarballSha512Verified: z.boolean(),
  hasProvenance: z.boolean(),
  /** Sanitized at index time. */
  readmeHtml: z.string().nullable(),
  /** Platforms the manifest declares (`web`, `darwin-arm64`, …). */
  platforms: z.array(z.string()),
  /** Manifest format the version shipped: 2 (current), 1 (widget-only) or null (the schemaVersion-less draft). */
  manifestSchemaVersion: z.union([z.literal(1), z.literal(2)]).nullable(),
  facets: z.array(packageFacetSchema),
  permissions: z.array(packagePermissionSchema),
  /** Service facets with their declared capabilities, egress and account connection. */
  services: z.array(packageServiceSchema),
  /** Scoped provider tokens UI facets ask the host for. */
  browserTokens: z.array(packageBrowserTokenSchema),
  /** Resource profile requested; null means none was (ClarkCant runs it with its default profile). */
  resources: z.object({ profile: resourceProfileNameSchema, gpu: z.boolean() }).nullable(),
  previews: z.array(packagePreviewSchema),
  /** Automated facts recorded at index time. Distinct from curation: a passing check is not a review. */
  securityChecks: z.array(packageSecurityCheckSchema),
  /** The version as ClarkCant's directory feed describes it; null for a version indexed before it was measured. */
  directory: packageDirectoryStatusSchema.nullable(),
});
export type PackageVersionDetail = z.infer<typeof packageVersionDetailSchema>;

export const packageDetailSchema = packageSummarySchema.extend({
  homepage: z.string().nullable(),
  repositoryUrl: z.string().nullable(),
  license: z.string().nullable(),
  latest: packageVersionDetailSchema.nullable(),
  versions: z.array(z.object({ version: z.string(), publishedAt: isoDateTime })),
});
export type PackageDetail = z.infer<typeof packageDetailSchema>;

export const packageSortSchema = z.enum(["latest", "name", "relevance"]);
export type PackageSort = z.infer<typeof packageSortSchema>;

export const MAX_PACKAGE_QUERY_LENGTH = 200;

/** Public curation filter: only publicly visible statuses can be asked for. */
export const publicCurationFilterSchema = z.enum(PUBLIC_CURATION_STATUSES);

/**
 * Filters shared by `GET /packages` and `GET /search`. All are optional and combine with AND. Facet `kind` and
 * `isolation` apply to the latest version's facets; `platform` to the latest version's manifest.
 */
export const packageFilterShape = {
  q: z.string().trim().max(MAX_PACKAGE_QUERY_LENGTH).default(""),
  category: categorySlugSchema.optional(),
  kind: z.string().min(1).max(32).regex(/^[a-z-]+$/).optional(),
  isolation: isolationClassSchema.optional(),
  platform: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/).optional(),
  publisher: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  curation: publicCurationFilterSchema.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).max(200).optional(),
};

/** Without `sort`, results are ranked by relevance when `q` is set and newest-first otherwise. */
export const listPackagesQuerySchema = z.object({
  ...packageFilterShape,
  sort: packageSortSchema.optional(),
});
export type ListPackagesQuery = z.infer<typeof listPackagesQuerySchema>;
export type ListPackagesQueryInput = z.input<typeof listPackagesQuerySchema>;

export const categorySchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  packageCount: z.int().nonnegative(),
});
export type Category = z.infer<typeof categorySchema>;

export const collectionSummarySchema = z.object({
  slug: z.string(),
  title: z.string(),
  description: z.string(),
});
export type CollectionSummary = z.infer<typeof collectionSummarySchema>;

export const collectionDetailSchema = collectionSummarySchema.extend({
  packages: z.array(packageSummarySchema),
});
export type CollectionDetail = z.infer<typeof collectionDetailSchema>;

export const packageVersionSummarySchema = z.object({
  version: z.string(),
  publishedAt: isoDateTime,
  indexedAt: isoDateTime,
  npmIntegrity: z.string(),
  tarballSha512Verified: z.boolean(),
  hasProvenance: z.boolean(),
});
export type PackageVersionSummary = z.infer<typeof packageVersionSummarySchema>;

/**
 * Everything ClarkCant needs to install one exact version from npm. The marketplace never serves the artifact:
 * ClarkCant fetches it from npm and must re-verify `integrity` itself before asking the user for consent.
 */
export const packageInstallSchema = z.object({
  package: z.string(),
  version: z.string(),
  source: z.literal("npm"),
  integrity: z.string(),
  /**
   * PROPOSED contract: ClarkCant does not register a URL scheme yet. Shape:
   * `clarkcant://install?source=npm&package=<url-encoded name>&version=<exact version>`.
   */
  openInClarkCant: z.string(),
  /** Copyable fallback that fetches the exact tarball npm serves, for manual verification or offline install. */
  cliCommand: z.string(),
  /** The ClarkCant package id the version's manifest declares. */
  packageId: z.string().nullable(),
  /**
   * The runtime content digest ClarkCant should find after extracting the archive (`sha256:<hex>`), null when it was
   * not computed. A claim to check, never a substitute for checking.
   */
  contentDigest: z.string().nullable(),
  /** Total bytes of the archive's regular files, null when not measured. */
  sizeBytes: z.int().nonnegative().nullable(),
});
export type PackageInstall = z.infer<typeof packageInstallSchema>;

export const setCurationStatusInputSchema = z.object({
  status: curationStatusSchema,
  /** Shown to other curators in the audit log; never to the public. */
  reason: z.string().trim().max(500).optional(),
});
export type SetCurationStatusInput = z.infer<typeof setCurationStatusInputSchema>;

export const featurePackageInputSchema = z.object({
  featured: z.boolean(),
});
export type FeaturePackageInput = z.infer<typeof featurePackageInputSchema>;

export const curationStateSchema = z.object({
  name: z.string(),
  curationStatus: curationStatusSchema,
});
export type CurationState = z.infer<typeof curationStateSchema>;

const collectionFields = {
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(600),
  published: z.boolean(),
  position: z.int().min(0).max(10_000),
};

/** Every change to a collection is one of these commands (admin, `packages:curate`). */
export const collectionCommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    title: collectionFields.title,
    description: collectionFields.description.default(""),
    published: collectionFields.published.default(false),
    position: collectionFields.position.default(0),
  }),
  z.object({
    action: z.literal("update"),
    title: collectionFields.title.optional(),
    description: collectionFields.description.optional(),
    published: collectionFields.published.optional(),
    position: collectionFields.position.optional(),
  }),
  z.object({
    action: z.literal("add_item"),
    packageName: packageNameSchema,
    note: z.string().trim().max(300).optional(),
  }),
  z.object({ action: z.literal("remove_item"), packageName: packageNameSchema }),
  z.object({ action: z.literal("reorder"), packageNames: z.array(packageNameSchema).min(1).max(200) }),
]);
export type CollectionCommand = z.infer<typeof collectionCommandSchema>;
export type CollectionCommandInput = z.input<typeof collectionCommandSchema>;

/** Admin view of a collection, including unpublished state and items whatever their curation status. */
export const collectionStateSchema = z.object({
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  published: z.boolean(),
  position: z.int(),
  items: z.array(z.object({ packageName: z.string(), position: z.int(), note: z.string().nullable() })),
});
export type CollectionState = z.infer<typeof collectionStateSchema>;
