import { MarketplaceError, requireScope, toAuditActor, type Actor } from "@marketplace/contracts";
import { MAX_UNTRUSTED_IMAGE_BYTES, MediaRejectedError, mediaUrlFor, storeUntrustedImage } from "@marketplace/media";
import { z } from "zod";

import { recordAuditEvent } from "../audit/audit-writer";
import type { MarketplaceDeps } from "../deps";
import { parseInput } from "../validation";

/** Upper bound for an editor upload. Matches the untrusted-image limit the media store enforces. */
export const MAX_UPLOAD_MEDIA_BYTES = MAX_UNTRUSTED_IMAGE_BYTES;

// Base64 inflates by 4/3; the string bound rejects oversized payloads before any decoding work.
const MAX_BASE64_LENGTH = Math.ceil(MAX_UPLOAD_MEDIA_BYTES / 3) * 4 + 4;

export const uploadMediaInputSchema = z.object({
  /** Standard base64 (no data: URL prefix). The image type is detected from the decoded bytes. */
  base64: z.string().min(4).max(MAX_BASE64_LENGTH),
  /** Suggested alt text echoed back for the caller's convenience; stored nowhere. */
  alt: z.string().max(300).optional(),
});
export type UploadMediaInput = z.input<typeof uploadMediaInputSchema>;

export interface UploadedMedia {
  id: string;
  url: string;
  contentType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
}

function decodeBase64(value: string): Uint8Array {
  const compact = value.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new MarketplaceError("validation_failed", "base64 is not valid standard base64", {
      details: [{ path: ["base64"], message: "must be standard base64 without a data: prefix" }],
    });
  }
  const binary = atob(compact);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Stores an editor-supplied image (`media:write`) in content-addressed R2 and returns its `med_…` id for page blocks.
 * Only PNG, JPEG, GIF and WebP within `MAX_UPLOAD_MEDIA_BYTES` are accepted; the type comes from the bytes, never
 * from a name. Identical bytes resolve to the existing media row.
 */
export async function uploadMedia(deps: MarketplaceDeps, actor: Actor, input: UploadMediaInput): Promise<UploadedMedia> {
  requireScope(actor, "media:write");
  const parsed = parseInput(uploadMediaInputSchema, input);
  if (!deps.media) throw new MarketplaceError("configuration_error", "MEDIA bucket binding is not configured");
  const bytes = decodeBase64(parsed.base64);

  let record;
  try {
    record = await storeUntrustedImage(
      { db: deps.db, bucket: deps.media, ids: deps.ids, now: deps.now },
      bytes,
      { ownerUserId: actor.userId ?? null, maxBytes: MAX_UPLOAD_MEDIA_BYTES },
    );
  } catch (error) {
    if (error instanceof MediaRejectedError) {
      throw new MarketplaceError("validation_failed", error.message, { details: [{ path: ["base64"], message: error.message }] });
    }
    throw error;
  }

  await recordAuditEvent(deps, {
    actor: toAuditActor(actor),
    action: "media.uploaded",
    subject: { type: "media", id: record.id },
    data: { contentType: record.contentType, bytes: record.bytes, sha256: record.sha256 },
  });
  return {
    id: record.id,
    url: mediaUrlFor(record.r2Key),
    contentType: record.contentType,
    bytes: record.bytes,
    width: record.width,
    height: record.height,
    sha256: record.sha256,
  };
}
