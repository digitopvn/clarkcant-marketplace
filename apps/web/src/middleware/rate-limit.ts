import { env } from "cloudflare:workers";
import type { MiddlewareHandler } from "astro";

import { logEvent, requestIdOf } from "./request-log";

/**
 * Per-caller request budgets backed by the Cloudflare Rate Limiting bindings declared in wrangler.jsonc. Counters
 * are per Cloudflare location and eventually consistent, so these are abuse brakes, not exact quotas. Callers are
 * keyed by credential (API token or session) when one is present, so users behind one NAT do not share a budget,
 * and by client IP otherwise.
 */

export type RateLimitBucket = "auth" | "publish" | "search" | "api";

const BINDING: Record<RateLimitBucket, "AUTH_RATE_LIMITER" | "PUBLISH_RATE_LIMITER" | "SEARCH_RATE_LIMITER" | "API_RATE_LIMITER"> = {
  auth: "AUTH_RATE_LIMITER",
  publish: "PUBLISH_RATE_LIMITER",
  search: "SEARCH_RATE_LIMITER",
  api: "API_RATE_LIMITER",
};

/** Every binding counts over a 60-second window. */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

/** Which budget a request draws from, or `null` for routes that are not rate limited (pages, assets, feeds). */
export function rateLimitBucket(method: string, url: URL): RateLimitBucket | null {
  const path = url.pathname;
  if (path === "/api/auth" || path.startsWith("/api/auth/")) return "auth";
  if (path.startsWith("/api/v1/publish/") && method !== "GET" && method !== "HEAD") return "publish";
  if (path === "/api/v1/search") return "search";
  if ((path === "/api/v1/packages" || path === "/packages") && url.searchParams.has("q")) return "search";
  if (path.startsWith("/api/v1/") || path === "/api/v1" || path === "/openapi.json" || path === "/mcp") return "api";
  return null;
}

const SESSION_COOKIE = /(?:^|;\s*)((?:__Secure-)?better-auth\.session_token)=([^;]+)/;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A stable, non-reversible caller key. Credentials are hashed so they never reach the rate-limit service. */
export async function rateLimitKey(request: Request, bucket: RateLimitBucket): Promise<string> {
  const authorization = request.headers.get("authorization");
  if (authorization) return `${bucket}:t:${await sha256Hex(authorization)}`;
  const session = SESSION_COOKIE.exec(request.headers.get("cookie") ?? "")?.[2];
  if (session) return `${bucket}:s:${await sha256Hex(session)}`;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  return `${bucket}:ip:${ip}`;
}

export function rateLimitedResponse(requestId: string, bucket: RateLimitBucket): Response {
  const body = {
    error: {
      code: "rate_limited",
      message: `Too many ${bucket} requests; retry after ${RATE_LIMIT_PERIOD_SECONDS} seconds`,
      requestId,
    },
  };
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": String(RATE_LIMIT_PERIOD_SECONDS),
      "x-request-id": requestId,
    },
  });
}

export const rateLimit: MiddlewareHandler = async (context, next) => {
  const bucket = rateLimitBucket(context.request.method, context.url);
  if (!bucket) return next();

  const limiter = (env as Partial<Record<(typeof BINDING)[RateLimitBucket], RateLimit>>)[BINDING[bucket]];
  if (!limiter) {
    // A deployment without the binding keeps serving (fail open) but says so loudly in the logs.
    logEvent("error", "rate_limit_binding_missing", { requestId: requestIdOf(context.locals), binding: BINDING[bucket] });
    return next();
  }

  let allowed = true;
  try {
    const outcome = await limiter.limit({ key: await rateLimitKey(context.request, bucket) });
    allowed = outcome.success;
  } catch (error) {
    // The limiter is an availability dependency, not a security boundary: an outage must not take the API down.
    logEvent("error", "rate_limit_check_failed", {
      requestId: requestIdOf(context.locals),
      bucket,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (allowed) return next();

  logEvent("warn", "rate_limited", { requestId: requestIdOf(context.locals), bucket, path: context.url.pathname });
  return rateLimitedResponse(requestIdOf(context.locals), bucket);
};
