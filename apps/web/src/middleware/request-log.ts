import type { MiddlewareHandler } from "astro";

/**
 * Structured request logging. Each request produces exactly one JSON line (`event: "request"`) carrying the request
 * id, so Workers Logs (`observability.enabled` in wrangler.jsonc) can filter and join by field. Query strings are
 * never logged: they can carry search terms, OAuth codes or device codes.
 */

export const REQUEST_ID_HEADER = "x-request-id";
const ACCEPTABLE_ID = /^[A-Za-z0-9._-]{8,128}$/;

export type LogLevel = "info" | "warn" | "error";

/** Writes one structured log line. Fields must not contain secrets, credentials or personal data. */
export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

/** Honours a well-formed caller id (the same rule the API applies) so traces join up; mints one otherwise. */
export function resolveRequestId(request: Request): string {
  const incoming = request.headers.get(REQUEST_ID_HEADER);
  return incoming && ACCEPTABLE_ID.test(incoming) ? incoming : crypto.randomUUID();
}

export function requestIdOf(locals: App.Locals): string {
  return locals.requestId ?? "unknown";
}

function setHeader(response: Response, name: string, value: string): Response {
  try {
    response.headers.set(name, value);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.set(name, value);
    return copy;
  }
}

export const requestLog: MiddlewareHandler = async (context, next) => {
  const started = Date.now();
  const requestId = resolveRequestId(context.request);
  context.locals.requestId = requestId;
  const base = { method: context.request.method, path: context.url.pathname };

  let response: Response;
  try {
    response = await next();
  } catch (error) {
    logEvent("error", "request_failed", {
      requestId,
      ...base,
      durationMs: Date.now() - started,
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
    throw error;
  }

  // The API mints and echoes its own id; log that one so the log line matches the error body the caller saw.
  const effectiveId = response.headers.get(REQUEST_ID_HEADER) ?? requestId;
  if (!response.headers.has(REQUEST_ID_HEADER)) response = setHeader(response, REQUEST_ID_HEADER, requestId);
  logEvent(response.status >= 500 ? "error" : "info", "request", {
    requestId: effectiveId,
    ...base,
    status: response.status,
    durationMs: Date.now() - started,
  });
  return response;
};
