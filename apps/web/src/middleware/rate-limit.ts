import { env } from "cloudflare:workers";
import type { MiddlewareHandler } from "astro";

import { logEvent, logPath, requestIdOf } from "./request-log";

/**
 * Per-caller request budgets backed by the Cloudflare Rate Limiting bindings declared in wrangler.jsonc. Counters
 * are per Cloudflare location and eventually consistent, so these are abuse brakes, not exact quotas.
 *
 * Callers are keyed by client IP (`CF-Connecting-IP`, set by Cloudflare's edge, not by the client). This middleware
 * runs before any authentication, so any credential it could see is unverified: keying on it would let a client
 * mint a fresh budget per request with random `Authorization` or session-cookie values. Callers sharing an IP
 * (NAT, CI egress) therefore share a budget.
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

/**
 * The caller key: the client IP, never a credential (credentials are unverified at this point). Outside
 * Cloudflare's edge (local dev, tests) the header is absent and every caller shares the `unknown` budget.
 * IPv6 clients are keyed by their /64 prefix (see {@link clientNetworkKey}).
 */
export function rateLimitKey(request: Request, bucket: RateLimitBucket): string {
  const ip = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  return `${bucket}:ip:${clientNetworkKey(ip)}`;
}

/**
 * The part of a client address that identifies one subscriber. An IPv6 subscriber is normally given a whole /64 and
 * can pick a fresh address from it for every request, so an IPv6 address is reduced to its first four hextets
 * (`2001:db8:0:1::/64`). IPv4 addresses, IPv4-mapped IPv6 addresses (reduced to the IPv4 address) and anything that
 * does not parse as IPv6 are returned as they are.
 */
export function clientNetworkKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const address = (ip.split("%", 1)[0] ?? ip).toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address)?.[1];
  if (mapped) return mapped;
  const halves = address.split("::");
  if (halves.length > 2) return ip;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  // An embedded IPv4 tail (`::1.2.3.4`) takes two hextets; it can only sit in the last 64 bits, so it is just counted.
  const width = (parts: string[]) => parts.reduce((sum, part) => sum + (part.includes(".") ? 2 : 1), 0);
  const missing = 8 - width(head) - width(tail);
  if (halves.length === 1 ? missing !== 0 : missing < 1) return ip;
  const hextets = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const prefix = hextets.slice(0, 4);
  if (!prefix.every((part) => /^[0-9a-f]{1,4}$/.test(part))) return ip;
  return `${prefix.map((part) => part.replace(/^0+(?=.)/, "")).join(":")}::/64`;
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
    const outcome = await limiter.limit({ key: rateLimitKey(context.request, bucket) });
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

  logEvent("warn", "rate_limited", { requestId: requestIdOf(context.locals), bucket, path: logPath(context.url.pathname) });
  return rateLimitedResponse(requestIdOf(context.locals), bucket);
};
