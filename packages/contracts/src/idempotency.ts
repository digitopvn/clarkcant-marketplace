import { z } from "zod";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";

/** How long a completed response is replayed for the same key. After this, the key may be reused. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Printable ASCII without spaces, as recommended by the IETF Idempotency-Key header draft. */
export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(255)
  .regex(/^[\x21-\x7e]+$/, { error: "must be 8-255 printable ASCII characters without spaces" });

export type IdempotencyBegin =
  | { state: "new" }
  | { state: "replay"; statusCode: number; response: unknown }
  | { state: "in_progress" }
  | { state: "mismatch" };
