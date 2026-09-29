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

/** Placeholder origin for resolving `next`; never visible to the visitor, only compared against. */
const NEXT_BASE = "https://next.invalid";
/** Control characters and backslashes: URL parsers strip or reinterpret them (`/\t/evil.com` becomes `//evil.com`). */
// eslint-disable-next-line no-control-regex -- matching control characters is the point of this pattern.
const UNSAFE_NEXT_CHARACTERS = /[\u0000-\u001f\u007f\\]/;

/**
 * Only same-site paths are followed after sign-in; anything else falls back to the account page. `next` is parsed
 * the way a browser would parse it and must stay on the site's own origin; the normalised path, query and fragment
 * are returned so the value handed to `Location`, `window.location` or GitHub's `callbackURL` is exactly what was
 * checked.
 */
export function safeNextPath(next: string | null | undefined, fallback = "/account"): string {
  if (!next || !next.startsWith("/") || UNSAFE_NEXT_CHARACTERS.test(next)) return fallback;
  let url: URL;
  try {
    url = new URL(next, NEXT_BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== NEXT_BASE) return fallback;
  const path = url.pathname + url.search + url.hash;
  // Dot segments can normalise into a protocol-relative path (`/.//evil.com` → `//evil.com`); refuse those too.
  return path.startsWith("//") ? fallback : path;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * Where the decision sends the visitor, from the `redirect_uri` of the authorization query (signed by the server,
 * so it is the URI the client registered). Client names are chosen by whoever registered the client, so the
 * destination host is the one detail a visitor can check against the app they meant to connect.
 */
export function describeRedirectTarget(search: string): string | null {
  const raw = new URLSearchParams(search).get("redirect_uri");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (LOOPBACK_HOSTS.has(url.hostname)) return `${url.host} (an app on this device)`;
    return url.protocol === "https:" || url.protocol === "http:" ? url.host : url.protocol.replace(/:$/, "");
  } catch {
    return null;
  }
}
