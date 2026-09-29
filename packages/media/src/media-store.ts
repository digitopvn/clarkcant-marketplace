import { media, type Database } from "@marketplace/db";
import { sql } from "drizzle-orm";

import { sniffImage } from "./image-sniffing.ts";

/** What media commands need. Kept separate from the marketplace deps so this package has no upward dependency. */
export interface MediaDeps {
  db: Database;
  bucket: R2Bucket;
  ids(prefix: string): string;
  now(): Date;
}

export interface MediaRecord {
  id: string;
  sha256: string;
  r2Key: string;
  contentType: string;
  bytes: number;
  width: number | null;
  height: number | null;
}

/** Content types the media route will ever serve, with the single extension each is stored under. */
export const MEDIA_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
} as const;
export type MediaContentType = keyof typeof MEDIA_EXTENSIONS;

/** Largest single object accepted from untrusted input (package previews). */
export const MAX_UNTRUSTED_IMAGE_BYTES = 5 * 1024 * 1024;

export const MEDIA_KEY_PATTERN = /^sha256\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})\.(png|jpg|gif|webp|svg)$/;

export class MediaRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaRejectedError";
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `sha256/ab/cd/<digest>.<ext>`: the two-level fan-out keeps listings small and the key alone proves the content. */
export function mediaKeyFor(sha256: string, contentType: MediaContentType): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new TypeError("sha256 must be 64 lowercase hex characters");
  return `sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.${MEDIA_EXTENSIONS[contentType]}`;
}

/** Site-relative URL the web Worker serves a media object from. */
export function mediaUrlFor(r2Key: string): string {
  return `/media/${r2Key}`;
}

async function storeBytes(
  deps: MediaDeps,
  bytes: Uint8Array,
  meta: { contentType: MediaContentType; width: number | null; height: number | null; ownerUserId: string | null },
): Promise<MediaRecord> {
  const sha256 = await sha256Hex(bytes);
  const existing = await deps.db.query.media.findFirst({ where: (row, { eq }) => eq(row.sha256, sha256) });
  if (existing) return toRecord(existing);

  const r2Key = mediaKeyFor(sha256, meta.contentType);
  // The object is written before its row: a crash in between leaves an unreferenced object (harmless, and reused by
  // the next identical upload), never a row pointing at nothing.
  await deps.bucket.put(r2Key, bytes, {
    httpMetadata: { contentType: meta.contentType, cacheControl: "public, max-age=31536000, immutable" },
    sha256,
  });
  const row = {
    id: deps.ids("med"),
    sha256,
    r2Key,
    contentType: meta.contentType,
    bytes: bytes.byteLength,
    width: meta.width,
    height: meta.height,
    ownerUserId: meta.ownerUserId,
    createdAt: deps.now(),
  };
  await deps.db.insert(media).values(row).onConflictDoNothing();
  // A concurrent writer may have inserted the same digest first; the stored row is authoritative.
  const stored = await deps.db.query.media.findFirst({ where: (entry, { eq }) => eq(entry.sha256, sha256) });
  if (!stored) throw new Error(`media row for ${sha256} vanished after insert`);
  return toRecord(stored);
}

/**
 * Stores an image from an untrusted source (e.g. a package tarball). The type comes from the bytes, never from a
 * file name; anything that is not a PNG, JPEG, GIF or WebP within the size limit is rejected.
 */
export async function storeUntrustedImage(
  deps: MediaDeps,
  bytes: Uint8Array,
  options: { ownerUserId?: string | null; maxBytes?: number } = {},
): Promise<MediaRecord> {
  const maxBytes = options.maxBytes ?? MAX_UNTRUSTED_IMAGE_BYTES;
  if (bytes.byteLength === 0) throw new MediaRejectedError("image is empty");
  if (bytes.byteLength > maxBytes) throw new MediaRejectedError(`image is ${bytes.byteLength} bytes; the limit is ${maxBytes}`);
  const sniffed = sniffImage(bytes);
  if (!sniffed) throw new MediaRejectedError("not a PNG, JPEG, GIF or WebP image");
  return storeBytes(deps, bytes, {
    contentType: sniffed.contentType,
    width: sniffed.width,
    height: sniffed.height,
    ownerUserId: options.ownerUserId ?? null,
  });
}

/**
 * Stores media the marketplace generated itself (e.g. a social card SVG built from escaped text). Callers vouch for
 * the content type; never route third-party bytes through here.
 */
export async function storeGeneratedMedia(
  deps: MediaDeps,
  bytes: Uint8Array,
  meta: { contentType: MediaContentType; width: number | null; height: number | null },
): Promise<MediaRecord> {
  return storeBytes(deps, bytes, { ...meta, ownerUserId: null });
}

/**
 * Deletes a media row and its object when nothing references it any more (account deletion, cleanup). Tables that
 * point at media declare `on delete restrict`, so a still-referenced row makes D1 refuse the delete; that is
 * reported as `false` and the object is kept.
 */
export async function deleteMediaIfUnreferenced(deps: MediaDeps, mediaId: string): Promise<boolean> {
  const row = await deps.db.query.media.findFirst({ where: (entry, { eq }) => eq(entry.id, mediaId) });
  if (!row) return false;
  try {
    await deps.db.delete(media).where(eqMediaId(mediaId));
  } catch (error) {
    if (error instanceof Error && /FOREIGN KEY constraint failed/i.test(`${error.message} ${String(error.cause ?? "")}`)) {
      return false;
    }
    throw error;
  }
  await deps.bucket.delete(row.r2Key);
  return true;
}

function eqMediaId(mediaId: string) {
  return sql`${media.id} = ${mediaId}`;
}

function toRecord(row: typeof media.$inferSelect): MediaRecord {
  return {
    id: row.id,
    sha256: row.sha256,
    r2Key: row.r2Key,
    contentType: row.contentType,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
  };
}
