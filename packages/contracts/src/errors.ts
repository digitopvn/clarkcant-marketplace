import { z } from "zod";

/**
 * Stable, machine-readable error codes. Clients (web, CLI, MCP, agents) branch on `code`, never on `message`.
 * Adding a code is backward compatible; renaming or removing one is a breaking API change.
 */
export const errorCodeSchema = z.enum([
  "bad_request",
  "validation_failed",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "idempotency_key_reused",
  "idempotency_in_progress",
  "rate_limited",
  "configuration_error",
  "not_implemented",
  "internal_error",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorBodySchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    requestId: z.string(),
    /** Field-level issues for `validation_failed`; free-form context otherwise. Never contains secrets. */
    details: z.unknown().optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  idempotency_key_reused: 422,
  idempotency_in_progress: 409,
  rate_limited: 429,
  configuration_error: 500,
  not_implemented: 501,
  internal_error: 500,
};

export function statusForErrorCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

/**
 * The only error type application services throw on purpose. Interfaces translate it into their own shape (HTTP
 * error body, MCP tool error, CLI exit code); anything else reaching an interface is an `internal_error`.
 */
export class MarketplaceError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, options?: { details?: unknown; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "MarketplaceError";
    this.code = code;
    this.details = options?.details;
  }

  get status(): number {
    return statusForErrorCode(this.code);
  }
}

/**
 * Thrown by seams whose behaviour a later delivery owns. It fails loudly (HTTP 501) rather than pretending to
 * succeed, so an unfinished path can never be mistaken for a working one.
 */
export class NotImplementedError extends MarketplaceError {
  readonly feature: string;

  constructor(feature: string) {
    super("not_implemented", `${feature} is not implemented yet`, { details: { feature } });
    this.name = "NotImplementedError";
    this.feature = feature;
  }
}

export function isMarketplaceError(value: unknown): value is MarketplaceError {
  return value instanceof MarketplaceError;
}
