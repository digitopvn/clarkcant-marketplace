/**
 * Cloudflare D1 limits that local SQLite does not enforce, so tests alone never catch them:
 * at most 100 bound parameters per statement and 1000 queries per Worker invocation.
 * https://developers.cloudflare.com/d1/platform/limits/
 */
export const D1_MAX_BOUND_PARAMETERS = 100;

/**
 * Largest `IN (...)` list a query may bind. Leaves room for the handful of other parameters the same statement binds
 * (a page id, a status list, a limit).
 */
export const MAX_IN_LIST_PARAMETERS = 90;

/** Splits `items` into consecutive chunks of at most `size` (default {@link MAX_IN_LIST_PARAMETERS}). */
export function chunked<T>(items: readonly T[], size: number = MAX_IN_LIST_PARAMETERS): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`chunk size must be a positive integer, got ${size}`);
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}
