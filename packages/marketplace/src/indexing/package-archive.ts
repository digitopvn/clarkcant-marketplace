import { IndexingRejectedError } from "./indexing-errors";
import { DEFAULT_TAR_LIMITS, TarFormatError, readTarGz, type TarEntry } from "./tar-reader";

/**
 * Extracts the few files the marketplace reads from a package tarball. Nothing is executed or written anywhere;
 * every other file is skipped while streaming.
 */

export const MAX_MANIFEST_BYTES = 256 * 1024;
/**
 * README source kept for rendering. Markdown rendering cost grows faster than linearly with link-dense input, and the
 * rendered HTML is stored on the version row, so a larger README is omitted (with a recorded reason), not rendered.
 */
export const MAX_README_BYTES = 256 * 1024;
export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
export const MAX_PREVIEWS = 8;
/** Previews are kept in archive order until their combined size would pass this budget. */
export const MAX_PREVIEW_TOTAL_BYTES = 16 * 1024 * 1024;
/** Upper bound on bytes kept in memory: both manifests, at most two READMEs (see the selector) and the previews. */
export const MAX_KEPT_ARCHIVE_BYTES = 2 * MAX_MANIFEST_BYTES + 2 * MAX_README_BYTES + MAX_PREVIEW_TOTAL_BYTES;

const README_PATTERN = /^readme(?:\.(?:md|markdown|txt))?$/i;
const PREVIEW_PATTERN = /^previews\/[^/]+\.(?:png|jpe?g|gif|webp)$/i;
const COVER_PATTERN = /^previews\/cover\./i;
const MARKDOWN_README = /\.m(?:ark)?d(?:own)?$/i;

export interface ArchiveFile {
  path: string;
  bytes: Uint8Array;
}

export interface PackageArchive {
  /** Raw `clarkcant.json` text, or null when absent. */
  manifestText: string | null;
  /** Parsed `package.json`, or null when absent or not JSON. */
  packageJson: unknown;
  readme: { path: string; text: string } | null;
  /** A README the package ships but the marketplace does not keep, and why. */
  readmeOmitted: { path: string; size: number; reason: string } | null;
  /** Candidate preview images in display order (`cover.*` first). Content is sniffed later, never trusted by name. */
  previews: ArchiveFile[];
}

/** npm tarballs wrap everything in one top-level folder (usually `package/`); paths here are relative to it. */
function relativePath(path: string): string | null {
  const slash = path.indexOf("/");
  if (slash === -1) return null;
  const rest = path.slice(slash + 1);
  if (rest === "" || rest.split("/").some((part) => part === ".." || part === "")) return null;
  return rest;
}

/** Lower is preferred: README.md over README.txt or a bare README. */
const readmeRank = (rel: string) => (MARKDOWN_README.test(rel) ? 0 : 1);

/**
 * Chooses which entries to keep while the archive streams. Stateful, so memory stays bounded however the archive is
 * built: the first copy of a path wins, one cover plus at most `MAX_PREVIEWS - 1` other previews are kept within
 * `MAX_PREVIEW_TOTAL_BYTES`, and a README is kept only when no equally preferred README was kept before it.
 */
function createSelector(): (path: string, size: number) => number | null {
  const seen = new Set<string>();
  let keptReadmeRank: number | null = null;
  let hasCover = false;
  let otherPreviews = 0;
  let previewBytes = 0;
  return (path, size) => {
    const rel = relativePath(path);
    if (rel === null || seen.has(rel)) return null;
    let cap: number | null = null;
    if (rel === "clarkcant.json" || rel === "package.json") {
      cap = MAX_MANIFEST_BYTES;
    } else if (README_PATTERN.test(rel)) {
      const rank = readmeRank(rel);
      if (keptReadmeRank !== null && keptReadmeRank <= rank) return null;
      keptReadmeRank = rank;
      cap = MAX_README_BYTES;
    } else if (PREVIEW_PATTERN.test(rel)) {
      // An oversized preview is recorded without its bytes, so only in-cap previews use the budget.
      const kept = size <= MAX_PREVIEW_BYTES ? size : 0;
      if (previewBytes + kept > MAX_PREVIEW_TOTAL_BYTES) return null;
      if (COVER_PATTERN.test(rel)) {
        if (hasCover) return null;
        hasCover = true;
      } else {
        if (otherPreviews >= MAX_PREVIEWS - 1) return null;
        otherPreviews += 1;
      }
      previewBytes += kept;
      cap = MAX_PREVIEW_BYTES;
    }
    if (cap !== null) seen.add(rel);
    return cap;
  };
}

const decoder = new TextDecoder();

function previewOrder(left: ArchiveFile, right: ArchiveFile): number {
  const rank = (file: ArchiveFile) => (COVER_PATTERN.test(file.path) ? 0 : 1);
  return rank(left) - rank(right) || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export async function readPackageArchive(tarball: Uint8Array): Promise<PackageArchive> {
  let entries: TarEntry[];
  try {
    entries = await readTarGz(
      tarball,
      { select: createSelector() },
      { ...DEFAULT_TAR_LIMITS, maxKeptBytes: MAX_KEPT_ARCHIVE_BYTES },
    );
  } catch (error) {
    if (error instanceof TarFormatError) {
      throw new IndexingRejectedError("invalid_tarball", `tarball could not be read: ${error.message}`);
    }
    throw error;
  }

  const byPath = new Map<string, TarEntry>();
  for (const entry of entries) {
    const rel = relativePath(entry.path);
    if (rel !== null && !byPath.has(rel)) byPath.set(rel, entry);
  }

  const manifest = byPath.get("clarkcant.json");
  if (manifest && manifest.bytes === null) {
    throw new IndexingRejectedError("manifest_invalid", `clarkcant.json is larger than ${MAX_MANIFEST_BYTES} bytes`);
  }

  let packageJson: unknown = null;
  const pkg = byPath.get("package.json")?.bytes;
  if (pkg) {
    try {
      packageJson = JSON.parse(decoder.decode(pkg));
    } catch {
      packageJson = null;
    }
  }

  const readmeEntry = [...byPath.entries()]
    .filter(([rel]) => README_PATTERN.test(rel))
    .sort(([left], [right]) => readmeRank(left) - readmeRank(right))[0];
  const readmeBytes = readmeEntry?.[1].bytes ?? null;

  const previews = [...byPath.entries()]
    .filter(([rel, entry]) => PREVIEW_PATTERN.test(rel) && entry.bytes !== null)
    .map(([rel, entry]) => ({ path: rel, bytes: entry.bytes as Uint8Array }))
    .sort(previewOrder)
    .slice(0, MAX_PREVIEWS);

  return {
    manifestText: manifest?.bytes ? decoder.decode(manifest.bytes) : null,
    packageJson,
    readme: readmeEntry && readmeBytes ? { path: readmeEntry[0], text: decoder.decode(readmeBytes) } : null,
    readmeOmitted:
      readmeEntry && !readmeBytes
        ? {
            path: readmeEntry[0],
            size: readmeEntry[1].size,
            reason: `README is ${readmeEntry[1].size} bytes; the limit is ${MAX_README_BYTES}`,
          }
        : null,
    previews,
  };
}
