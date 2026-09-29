import { z } from "zod";

import { isolationClassSchema } from "./manifest";
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

export const packagePermissionSchema = z.object({
  kind: z.enum(["capability", "network", "filesystem", "microphone", "camera", "lifecycle"]),
  value: z.string(),
  access: z.string().nullable(),
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
  facets: z.array(packageFacetSchema),
  permissions: z.array(packagePermissionSchema),
  previews: z.array(packagePreviewSchema),
  /** Automated facts recorded at index time. Distinct from curation: a passing check is not a review. */
  securityChecks: z.array(packageSecurityCheckSchema),
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
