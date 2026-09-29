import type { Hook } from "@hono/zod-openapi";
import {
  MarketplaceError,
  errorBodySchema,
  statusForErrorCode,
  type ErrorBody,
  type ErrorCode,
} from "@marketplace/contracts";
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { ApiEnv } from "../types";

function errorBody(c: Context<ApiEnv>, code: ErrorCode, message: string, details?: unknown): ErrorBody {
  const body: ErrorBody = { error: { code, message, requestId: c.get("requestId") ?? "unknown" } };
  if (details !== undefined) body.error.details = details;
  return body;
}

function respond(c: Context<ApiEnv>, code: ErrorCode, message: string, details?: unknown, status?: number) {
  return c.json(errorBody(c, code, message, details), (status ?? statusForErrorCode(code)) as ContentfulStatusCode);
}

/**
 * Every failure leaves the API in the contracts error shape. Expected failures (`MarketplaceError`) keep their code;
 * anything else is logged with the request id and reported as `internal_error` without leaking internals.
 */
export const handleError: ErrorHandler<ApiEnv> = (error, c) => {
  if (error instanceof MarketplaceError) {
    if (error.code === "configuration_error" || error.code === "internal_error") {
      console.error(`[${c.get("requestId")}] ${error.code}: ${error.message}`);
    }
    return respond(c, error.code, error.message, error.details);
  }
  if (error instanceof HTTPException) {
    const code: ErrorCode = error.status === 401 ? "unauthorized" : error.status === 403 ? "forbidden" : "bad_request";
    return respond(c, code, error.message || code, undefined, error.status);
  }
  console.error(`[${c.get("requestId")}] unhandled error`, error);
  return respond(c, "internal_error", "An unexpected error occurred");
};

export const handleNotFound: NotFoundHandler<ApiEnv> = (c) =>
  respond(c, "not_found", `No route for ${c.req.method} ${new URL(c.req.url).pathname}`);

/** Turns request-validation failures into `validation_failed` with field-level details. */
export const validationHook: Hook<unknown, ApiEnv, string, unknown> = (result) => {
  if (!result.success) {
    throw new MarketplaceError("validation_failed", "request failed validation", {
      details: result.error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message })),
    });
  }
};

const ERROR_DESCRIPTIONS = {
  400: "Invalid request (`validation_failed` or `bad_request`)",
  404: "Not found",
  500: "Server error (`internal_error` or `configuration_error`)",
  501: "Not implemented yet",
} as const;

/** OpenAPI response entries for error statuses, all sharing the contracts error body. */
export function errorResponses<S extends keyof typeof ERROR_DESCRIPTIONS>(...statuses: S[]) {
  const responses = {} as Record<S, ErrorResponse>;
  for (const status of statuses) {
    responses[status] = {
      description: ERROR_DESCRIPTIONS[status],
      content: { "application/json": { schema: errorBodySchema } },
    };
  }
  return responses;
}

interface ErrorResponse {
  description: string;
  content: { "application/json": { schema: typeof errorBodySchema } };
}
