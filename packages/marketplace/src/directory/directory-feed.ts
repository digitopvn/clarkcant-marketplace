import {
  DIRECTORY_FEED_FORMAT,
  MarketplaceError,
  directoryFeedQuerySchema,
  type DirectoryEntry,
  type DirectoryFeedPage,
} from "@marketplace/contracts";
import { media, packagePreviews, packageVersionArtifacts, packageVersions, packages } from "@marketplace/db";
import { mediaUrlFor } from "@marketplace/media";
import { and, asc, eq, gt, inArray, isNotNull, type SQL } from "drizzle-orm";

import { MAX_IN_LIST_PARAMETERS, chunked } from "../d1-limits";
import type { MarketplaceDeps } from "../deps";
import { isPubliclyVisible } from "../packages/package-rows";
import { parseInput } from "../validation";
import { directoryListingOf } from "./directory-listing";
import { packageIdHolders } from "./package-id-owners";

/**
 * `GET /api/v1/directory`: ClarkCant's directory feed (`clarkcant-directory@1`). One entry per publicly visible,
 * measured version whose package holds its ClarkCant package id, in the order versions were indexed.
 *
 * Paging is a keyset over the version id, which is time-ordered: a cursor names the last version a page considered,
 * so a page never shifts when versions are indexed, hidden or relisted between requests, and new versions arrive on
 * later pages. ClarkCant reads at most 20 pages of 8 MiB, so a page also stops at {@link DIRECTORY_PAGE_BYTE_BUDGET}.
 *
 * Every entry is a discovery claim. ClarkCant re-resolves the npm version, checks npm's integrity and the entry's
 * digest against the bytes it fetched, and asks its own policy; nothing here grants anything.
 */

/** Serialized entry bytes one page holds at most; ClarkCant refuses a page over 8 MiB. */
export const DIRECTORY_PAGE_BYTE_BUDGET = 4 * 1024 * 1024;
/** Versions one request considers at most, so a run of unlisted versions cannot make a page unbounded work. */
export const MAX_DIRECTORY_ROWS_SCANNED = 1000;

const CURSOR_PATTERN = /^v1\.(pv_[0-9a-z]{26})$/;

export function encodeDirectoryCursor(versionId: string): string {
  return `v1.${versionId}`;
}

function decodeDirectoryCursor(cursor: string): string {
  const match = CURSOR_PATTERN.exec(cursor);
  if (!match?.[1]) {
    throw new MarketplaceError("validation_failed", "cursor is not one this feed returned", {
      details: [{ path: ["cursor"], message: "must be a nextCursor value from a previous page" }],
    });
  }
  return match[1];
}

export interface DirectoryFeedOptions {
  /** The marketplace origin (`PUBLIC_SITE_URL`): ClarkCant needs absolute preview URLs. */
  siteUrl: string;
}

const measuredColumns = {
  versionId: packageVersions.id,
  packageRowId: packages.id,
  npmName: packages.name,
  npmVersion: packageVersions.version,
  manifest: packageVersions.manifest,
  manifestId: packageVersionArtifacts.manifestId,
  contentDigest: packageVersionArtifacts.contentDigest,
  sizeBytes: packageVersionArtifacts.sizeBytes,
  digestProblem: packageVersionArtifacts.digestProblem,
};

function listableAfter(afterVersionId: string | null): SQL | undefined {
  return and(
    isPubliclyVisible(),
    isNotNull(packageVersionArtifacts.contentDigest),
    afterVersionId === null ? undefined : gt(packageVersions.id, afterVersionId),
  );
}

function measuredVersions(deps: MarketplaceDeps) {
  return deps.db
    .select(measuredColumns)
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .innerJoin(packageVersionArtifacts, eq(packageVersionArtifacts.packageVersionId, packageVersions.id));
}

/** The first image preview of each version, as an absolute URL. */
async function previewImages(deps: MarketplaceDeps, versionIds: string[], siteUrl: string): Promise<Map<string, string>> {
  const images = new Map<string, string>();
  for (const group of chunked(versionIds, MAX_IN_LIST_PARAMETERS)) {
    const rows = await deps.db
      .select({ versionId: packagePreviews.packageVersionId, r2Key: media.r2Key })
      .from(packagePreviews)
      .innerJoin(media, eq(media.id, packagePreviews.mediaId))
      .where(and(inArray(packagePreviews.packageVersionId, group), eq(packagePreviews.kind, "image")))
      .orderBy(asc(packagePreviews.packageVersionId), asc(packagePreviews.position));
    for (const row of rows) {
      if (!images.has(row.versionId)) images.set(row.versionId, new URL(mediaUrlFor(row.r2Key), siteUrl).toString());
    }
  }
  return images;
}

const encoder = new TextEncoder();

export async function getDirectoryFeedPage(
  deps: MarketplaceDeps,
  rawQuery: unknown,
  options: DirectoryFeedOptions,
): Promise<DirectoryFeedPage> {
  const query = parseInput(directoryFeedQuerySchema, rawQuery ?? {});
  let after = query.cursor === undefined ? null : decodeDirectoryCursor(query.cursor);
  const entries: DirectoryEntry[] = [];
  let bytes = 0;
  let scanned = 0;
  let exhausted = false;

  scan: while (entries.length < query.limit && scanned < MAX_DIRECTORY_ROWS_SCANNED) {
    const batchSize = Math.min(query.limit - entries.length + 1, MAX_DIRECTORY_ROWS_SCANNED - scanned);
    const rows = await measuredVersions(deps).where(listableAfter(after)).orderBy(asc(packageVersions.id)).limit(batchSize);
    if (rows.length === 0) {
      exhausted = true;
      break;
    }
    const holders = await packageIdHolders(
      deps,
      rows.flatMap((row) => (row.manifestId === null ? [] : [row.manifestId])),
    );
    const images = await previewImages(deps, rows.map((row) => row.versionId), options.siteUrl);
    for (const row of rows) {
      if (entries.length >= query.limit) break scan;
      scanned += 1;
      const imageUrl = images.get(row.versionId);
      const listing = directoryListingOf(row, holders, imageUrl === undefined ? {} : { imageUrl });
      if (listing.listed) {
        const size = encoder.encode(JSON.stringify(listing.entry)).byteLength + 1;
        // The budget never empties a page: one entry is far below ClarkCant's page cap on its own.
        if (entries.length > 0 && bytes + size > DIRECTORY_PAGE_BYTE_BUDGET) break scan;
        entries.push(listing.entry);
        bytes += size;
      }
      after = row.versionId;
    }
    if (rows.length < batchSize) exhausted = true;
    if (exhausted) break;
  }

  let nextCursor: string | null = null;
  if (!exhausted && after !== null) {
    const [more] = await deps.db
      .select({ id: packageVersions.id })
      .from(packageVersions)
      .innerJoin(packages, eq(packages.id, packageVersions.packageId))
      .innerJoin(packageVersionArtifacts, eq(packageVersionArtifacts.packageVersionId, packageVersions.id))
      .where(listableAfter(after))
      .limit(1);
    if (more) nextCursor = encodeDirectoryCursor(after);
  }
  return { format: DIRECTORY_FEED_FORMAT, entries, nextCursor };
}
