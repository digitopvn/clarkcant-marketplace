import { buildDirectoryEntry, type DirectoryEntry, type DirectoryListingFacts } from "@marketplace/contracts";

import type { PackageIdHolder } from "./package-id-owners";

/**
 * The one rule deciding whether a measured version is a directory entry, shared by the feed and the per-version
 * status on PackageDetail so the two can never disagree.
 */

export interface MeasuredVersion {
  packageRowId: string;
  npmName: string;
  npmVersion: string;
  manifest: unknown;
  manifestId: string | null;
  contentDigest: string | null;
  sizeBytes: number | null;
  digestProblem: string | null;
}

export type DirectoryListing = { listed: true; entry: DirectoryEntry } | { listed: false; reason: string };

export function directoryListingOf(
  version: MeasuredVersion,
  holders: ReadonlyMap<string, PackageIdHolder>,
  preview: DirectoryListingFacts["preview"],
): DirectoryListing {
  if (version.contentDigest === null || version.sizeBytes === null) {
    return { listed: false, reason: version.digestProblem ?? "the archive has no runtime content digest" };
  }
  if (version.manifestId === null) {
    return { listed: false, reason: "the stored clarkcant.json is unreadable, so the version has no package id" };
  }
  const built = buildDirectoryEntry(version.manifest, {
    npmName: version.npmName,
    npmVersion: version.npmVersion,
    digest: version.contentDigest,
    sizeBytes: version.sizeBytes,
    preview,
  });
  if (!built.ok) return { listed: false, reason: built.reason };
  const holder = holders.get(version.manifestId);
  if (holder && holder.packageRowId !== version.packageRowId) {
    return {
      listed: false,
      reason:
        `the npm package "${holder.name}" holds the ClarkCant package id "${version.manifestId}" in the directory ` +
        "(a verified publisher first, then whoever claimed it first)",
    };
  }
  if (!holder) return { listed: false, reason: "the package is not publicly listed on the marketplace" };
  return { listed: true, entry: built.entry };
}
