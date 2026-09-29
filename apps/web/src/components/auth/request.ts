/** Same-origin JSON calls from the auth islands to `/api/v1` and `/api/auth`. Cookies ride along automatically. */

export class RequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "RequestError";
    this.status = status;
    this.code = code;
  }
}

function messageFrom(body: unknown, status: number): { message: string; code?: string } {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const error = record.error;
    // Marketplace API error body: { error: { code, message } }.
    if (error && typeof error === "object") {
      const inner = error as Record<string, unknown>;
      if (typeof inner.message === "string") {
        return { message: inner.message, ...(typeof inner.code === "string" ? { code: inner.code } : {}) };
      }
    }
    // Better Auth / OAuth error bodies: { message } or { error, error_description }.
    if (typeof record.message === "string") return { message: record.message };
    if (typeof record.error_description === "string") return { message: record.error_description };
    if (typeof error === "string") return { message: error, code: error };
  }
  return { message: `Request failed (${status})` };
}

export async function requestJson<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: init.body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  let body: unknown = null;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    const { message, code } = messageFrom(body, response.status);
    throw new RequestError(response.status, message, code);
  }
  return body as T;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}

/** Only same-site relative paths are followed after sign-in; anything else falls back to the account page. */
export function safeNextPath(next: string | null | undefined, fallback = "/account"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}
