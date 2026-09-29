/**
 * Every failure the SDK reports is a `MarketplaceApiError`. `code` is the API's stable error code (`not_found`,
 * `validation_failed`, `unauthorized`, …) or one of the client-side codes below; branch on `code`, never `message`.
 *
 * Client-side codes:
 * - `network_error`: the request never produced an HTTP response (DNS, TLS, connection reset, abort).
 * - `invalid_response`: the server answered with a body that is not the API's JSON shape.
 * - `authorization_pending` / `slow_down` / `access_denied` / `expired_token`: device-authorization outcomes.
 */
export class MarketplaceApiError extends Error {
  readonly code: string;
  /** HTTP status; 0 when no response was received. */
  readonly status: number;
  /** Server request id (`X-Request-Id`), when the server answered. Quote it in bug reports. */
  readonly requestId: string | undefined;
  /** Field-level issues for `validation_failed`; free-form context otherwise. */
  readonly details: unknown;

  constructor(input: { code: string; message: string; status: number; requestId?: string | undefined; details?: unknown; cause?: unknown }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "MarketplaceApiError";
    this.code = input.code;
    this.status = input.status;
    this.requestId = input.requestId;
    this.details = input.details;
  }
}

export function isMarketplaceApiError(value: unknown): value is MarketplaceApiError {
  return value instanceof MarketplaceApiError;
}

interface ErrorEnvelope {
  error: { code: string; message: string; requestId?: string; details?: unknown };
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (!value || typeof value !== "object") return false;
  const error = (value as { error?: unknown }).error;
  return (
    !!error &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

/** Converts a non-2xx API response (already parsed, or its raw text) into a `MarketplaceApiError`. */
export function errorFromResponse(response: Response, body: unknown): MarketplaceApiError {
  const requestId = response.headers.get("x-request-id") ?? undefined;
  if (isErrorEnvelope(body)) {
    return new MarketplaceApiError({
      code: body.error.code,
      message: body.error.message,
      status: response.status,
      requestId: body.error.requestId ?? requestId,
      details: body.error.details,
    });
  }
  return new MarketplaceApiError({
    code: response.status >= 500 ? "internal_error" : "invalid_response",
    message: `HTTP ${response.status} ${response.statusText}`.trim(),
    status: response.status,
    requestId,
    details: typeof body === "string" ? body.slice(0, 500) : undefined,
  });
}

export function networkError(error: unknown): MarketplaceApiError {
  const message = error instanceof Error ? error.message : String(error);
  return new MarketplaceApiError({ code: "network_error", message: `request failed: ${message}`, status: 0, cause: error });
}
