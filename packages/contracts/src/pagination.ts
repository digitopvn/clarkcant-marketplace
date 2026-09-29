import { z } from "zod";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * Offset pagination encoded as an opaque cursor. Clients must treat the cursor as opaque so the encoding can move
 * to keyset pagination without an API change.
 */
export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).max(200).optional(),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const OFFSET_CURSOR = /^o([0-9a-z]{1,11})$/;

export function encodeOffsetCursor(offset: number): string {
  return `o${offset.toString(36)}`;
}

/** Returns the offset a cursor encodes, or `null` for a malformed cursor so callers can reject it explicitly. */
export function decodeOffsetCursor(cursor: string | undefined): number | null {
  if (cursor === undefined) return 0;
  const match = OFFSET_CURSOR.exec(cursor);
  if (match?.[1] === undefined) return null;
  const offset = Number.parseInt(match[1], 36);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : null;
}
