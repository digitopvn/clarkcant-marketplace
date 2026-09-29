import { PUBLIC_CURATION_STATUSES, type CurationStatus, type PackageSummary } from "@marketplace/contracts";
import { packages, publishers } from "@marketplace/db";
import { inArray } from "drizzle-orm";

/** Columns every package listing selects, so all read paths produce identical summaries. */
export const packageSummaryColumns = {
  id: packages.id,
  name: packages.name,
  displayName: packages.displayName,
  description: packages.description,
  latestVersion: packages.latestVersion,
  categorySlug: packages.categorySlug,
  curationStatus: packages.curationStatus,
  keywords: packages.keywords,
  verifiedPublisher: packages.verifiedPublisher,
  indexedAt: packages.indexedAt,
  updatedAt: packages.updatedAt,
  publisherSlug: publishers.slug,
  publisherName: publishers.name,
};

export interface PackageSummaryRow {
  id: string;
  name: string;
  displayName: string;
  description: string;
  latestVersion: string | null;
  categorySlug: string | null;
  curationStatus: CurationStatus;
  keywords: string[];
  verifiedPublisher: boolean;
  indexedAt: Date | null;
  updatedAt: Date;
  publisherSlug: string | null;
  publisherName: string | null;
}

/** Public surfaces only ever show listed or featured packages; this is the single place that rule lives. */
export const isPubliclyVisible = () => inArray(packages.curationStatus, [...PUBLIC_CURATION_STATUSES]);

export function toPackageSummary(row: PackageSummaryRow): PackageSummary {
  return {
    name: row.name,
    displayName: row.displayName,
    description: row.description,
    latestVersion: row.latestVersion,
    publisher:
      row.publisherSlug !== null && row.publisherName !== null
        ? { slug: row.publisherSlug, name: row.publisherName, verified: row.verifiedPublisher }
        : null,
    categorySlug: row.categorySlug,
    curationStatus: row.curationStatus,
    keywords: Array.isArray(row.keywords) ? row.keywords : [],
    indexedAt: row.indexedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}
