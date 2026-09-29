import { IndexingRejectedError } from "./indexing-errors";
import { TarFormatError, readTarGz, type TarEntry } from "./tar-reader";

/**
 * Extracts the few files the marketplace reads from a package tarball. Nothing is executed or written anywhere;
 * every other file is skipped while streaming.
 */

export const MAX_MANIFEST_BYTES = 256 * 1024;
export const MAX_README_BYTES = 1024 * 1024;
export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
export const MAX_PREVIEWS = 8;

const README_PATTERN = /^readme(?:\.(?:md|markdown|txt))?$/i;
const PREVIEW_PATTERN = /^previews\/[^/]+\.(?:png|jpe?g|gif|webp)$/i;

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

function selectorFor(path: string): number | null {
  const rel = relativePath(path);
  if (rel === null) return null;
  if (rel === "clarkcant.json" || rel === "package.json") return MAX_MANIFEST_BYTES;
  if (README_PATTERN.test(rel)) return MAX_README_BYTES;
  if (PREVIEW_PATTERN.test(rel)) return MAX_PREVIEW_BYTES;
  return null;
}

const decoder = new TextDecoder();

function previewOrder(left: ArchiveFile, right: ArchiveFile): number {
  const rank = (file: ArchiveFile) => (/^previews\/cover\./i.test(file.path) ? 0 : 1);
  return rank(left) - rank(right) || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export async function readPackageArchive(tarball: Uint8Array): Promise<PackageArchive> {
  let entries: TarEntry[];
  try {
    entries = await readTarGz(tarball, { select: selectorFor });
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
    .filter(([rel, entry]) => README_PATTERN.test(rel) && entry.bytes !== null)
    // Prefer README.md over README.txt/README when a package ships several.
    .sort(([left], [right]) => Number(!/\.m(?:ark)?d(?:own)?$/i.test(left)) - Number(!/\.m(?:ark)?d(?:own)?$/i.test(right)))[0];

  const previews = [...byPath.entries()]
    .filter(([rel, entry]) => PREVIEW_PATTERN.test(rel) && entry.bytes !== null)
    .map(([rel, entry]) => ({ path: rel, bytes: entry.bytes as Uint8Array }))
    .sort(previewOrder)
    .slice(0, MAX_PREVIEWS);

  return {
    manifestText: manifest?.bytes ? decoder.decode(manifest.bytes) : null,
    packageJson,
    readme: readmeEntry ? { path: readmeEntry[0], text: decoder.decode(readmeEntry[1].bytes as Uint8Array) } : null,
    previews,
  };
}
