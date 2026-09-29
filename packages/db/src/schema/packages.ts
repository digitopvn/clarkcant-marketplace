import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { user } from "./auth";
import { createdAt, timestampMs, updatedAt } from "./columns";
import { media } from "./media";
import { publishers } from "./publishers";

export const CURATION_STATUSES = ["unreviewed", "listed", "featured", "hidden", "rejected"] as const;
export const SUBMISSION_STATUSES = ["queued", "indexing", "indexed", "failed"] as const;
export const PERMISSION_KINDS = ["capability", "network", "filesystem", "microphone", "camera", "lifecycle"] as const;
export const PREVIEW_KINDS = ["image", "video", "social_card"] as const;

/**
 * One row per npm package name. Mutable listing state (curation, latest version, denormalised search fields) lives
 * here; everything that describes a specific published artifact lives on the immutable `package_versions` rows.
 */
export const packages = sqliteTable(
  "packages",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    publisherId: text("publisher_id").references(() => publishers.id, { onDelete: "set null" }),
    displayName: text("display_name").notNull(),
    description: text("description").notNull().default(""),
    latestVersion: text("latest_version"),
    homepage: text("homepage"),
    repositoryUrl: text("repository_url"),
    license: text("license"),
    keywords: text("keywords", { mode: "json" }).$type<string[]>().notNull().default([]),
    categorySlug: text("category_slug"),
    curationStatus: text("curation_status", { enum: CURATION_STATUSES }).notNull().default("unreviewed"),
    verifiedPublisher: integer("verified_publisher", { mode: "boolean" }).notNull().default(false),
    indexedAt: timestampMs("indexed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("packages_name_uidx").on(table.name),
    index("packages_publisher_idx").on(table.publisherId),
    index("packages_category_idx").on(table.categorySlug, table.curationStatus),
    index("packages_curation_indexed_idx").on(table.curationStatus, table.indexedAt),
  ],
);

/** Immutable once written: a published version is a fact about npm, not editable listing copy. */
export const packageVersions = sqliteTable(
  "package_versions",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    manifest: text("manifest", { mode: "json" }).$type<unknown>().notNull(),
    readmeMd: text("readme_md"),
    /** Sanitized HTML rendered from `readme_md`; never raw package HTML. */
    readmeHtml: text("readme_html"),
    npmIntegrity: text("npm_integrity").notNull(),
    tarballSha512Verified: integer("tarball_sha512_verified", { mode: "boolean" }).notNull().default(false),
    provenance: text("provenance", { mode: "json" }).$type<unknown>(),
    publishedAt: timestampMs("published_at").notNull(),
    indexedAt: timestampMs("indexed_at").notNull(),
  },
  (table) => [
    uniqueIndex("package_versions_package_version_uidx").on(table.packageId, table.version),
    index("package_versions_published_idx").on(table.packageId, table.publishedAt),
  ],
);

export const packageFacets = sqliteTable(
  "package_facets",
  {
    id: text("id").primaryKey(),
    packageVersionId: text("package_version_id")
      .notNull()
      .references(() => packageVersions.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    isolation: text("isolation").notNull(),
    renderer: text("renderer"),
    entry: text("entry").notNull(),
    widgetId: text("widget_id"),
  },
  (table) => [
    index("package_facets_version_idx").on(table.packageVersionId),
    index("package_facets_kind_idx").on(table.kind, table.isolation),
  ],
);

export const packagePermissions = sqliteTable(
  "package_permissions",
  {
    id: text("id").primaryKey(),
    packageVersionId: text("package_version_id")
      .notNull()
      .references(() => packageVersions.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: PERMISSION_KINDS }).notNull(),
    value: text("value").notNull(),
    access: text("access"),
  },
  (table) => [index("package_permissions_version_idx").on(table.packageVersionId)],
);

export const packagePreviews = sqliteTable(
  "package_previews",
  {
    id: text("id").primaryKey(),
    packageVersionId: text("package_version_id")
      .notNull()
      .references(() => packageVersions.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: PREVIEW_KINDS }).notNull(),
    mediaId: text("media_id")
      .notNull()
      .references(() => media.id, { onDelete: "restrict" }),
    alt: text("alt").notNull().default(""),
    position: integer("position").notNull().default(0),
  },
  (table) => [index("package_previews_version_idx").on(table.packageVersionId, table.position)],
);

/** A publisher's request to take ownership of a listing indexed before they claimed it. */
export const packageClaims = sqliteTable(
  "package_claims",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    publisherId: text("publisher_id")
      .notNull()
      .references(() => publishers.id, { onDelete: "cascade" }),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
    evidence: text("evidence", { mode: "json" }).$type<unknown>(),
    decidedAt: timestampMs("decided_at"),
    createdAt: createdAt(),
  },
  (table) => [
    index("package_claims_package_idx").on(table.packageId, table.status),
    index("package_claims_publisher_idx").on(table.publisherId),
  ],
);

/**
 * Security facts about a version (integrity, provenance, static checks). Kept apart from curation so "featured"
 * can never be read as "audited", and an audit result never changes a curation decision implicitly.
 */
export const packageAudits = sqliteTable(
  "package_audits",
  {
    id: text("id").primaryKey(),
    packageVersionId: text("package_version_id")
      .notNull()
      .references(() => packageVersions.id, { onDelete: "cascade" }),
    check: text("check").notNull(),
    result: text("result", { enum: ["pass", "warn", "fail"] }).notNull(),
    details: text("details", { mode: "json" }).$type<unknown>(),
    createdAt: createdAt(),
  },
  (table) => [index("package_audits_version_idx").on(table.packageVersionId, table.check)],
);

export const packageSubmissions = sqliteTable(
  "package_submissions",
  {
    id: text("id").primaryKey(),
    packageName: text("package_name").notNull(),
    version: text("version"),
    submittedBy: text("submitted_by").references(() => user.id, { onDelete: "set null" }),
    status: text("status", { enum: SUBMISSION_STATUSES }).notNull().default("queued"),
    error: text("error"),
    workflowId: text("workflow_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("package_submissions_name_idx").on(table.packageName, table.createdAt),
    index("package_submissions_status_idx").on(table.status),
  ],
);
