import { z } from "zod";

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

export const packageVersionDetailSchema = z.object({
  version: z.string(),
  publishedAt: isoDateTime,
  indexedAt: isoDateTime,
  npmIntegrity: z.string(),
  tarballSha512Verified: z.boolean(),
  hasProvenance: z.boolean(),
  /** Sanitized at index time. */
  readmeHtml: z.string().nullable(),
  facets: z.array(packageFacetSchema),
  permissions: z.array(packagePermissionSchema),
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

export const packageSortSchema = z.enum(["latest", "name"]);
export type PackageSort = z.infer<typeof packageSortSchema>;

export const listPackagesQuerySchema = z.object({
  category: categorySlugSchema.optional(),
  sort: packageSortSchema.default("latest"),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).max(200).optional(),
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
