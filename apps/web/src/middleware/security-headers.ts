import type { MiddlewareHandler } from "astro";

/**
 * Response security headers for every route (pages, API, Markdown twins, feeds, media).
 *
 * Script and style sources are governed by the Content Security Policy Astro builds with hashes of every inline
 * script and style it renders (`security.csp` in astro.config.ts). On this adapter Astro sends it as a response
 * header; `frame-ancestors` and the other header-only directives are merged into that policy here. Where no
 * policy exists yet (dev server, endpoints), ours is the whole header.
 */

/** Browser features the site never uses; denied for the page and every frame it embeds. */
const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "browsing-topics=()",
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "serial=()",
  "usb=()",
].join(", ");

const HSTS = "max-age=63072000; includeSubDomains";

export interface SecurityHeaderInput {
  pathname: string;
  /** True when the site is served over HTTPS (every deployed environment). */
  https: boolean;
  contentType: string | null;
}

/** Signed previews may be framed by the site itself (builder side-by-side views); nothing else may be framed. */
function frameAncestors(pathname: string): "'self'" | "'none'" {
  return pathname.startsWith("/preview/") ? "'self'" : "'none'";
}

/**
 * The headers to set. `referrer-policy` and `x-frame-options` only apply when the route did not choose its own
 * (previews set a stricter referrer policy); `content-security-policy` is merged into an existing policy.
 */
export function securityHeadersFor(input: SecurityHeaderInput): Record<string, string> {
  const ancestors = frameAncestors(input.pathname);
  const isHtml = input.contentType?.toLowerCase().startsWith("text/html") ?? false;
  const csp = isHtml
    ? [`frame-ancestors ${ancestors}`, "object-src 'none'", "base-uri 'self'", "form-action 'self'", ...(input.https ? ["upgrade-insecure-requests"] : [])]
    : ["default-src 'none'", `frame-ancestors ${ancestors}`];

  return {
    "content-security-policy": csp.join("; "),
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-frame-options": ancestors === "'self'" ? "SAMEORIGIN" : "DENY",
    "permissions-policy": PERMISSIONS_POLICY,
    "cross-origin-opener-policy": "same-origin",
    ...(input.https ? { "strict-transport-security": HSTS } : {}),
  };
}

const ROUTE_CHOSEN = new Set(["referrer-policy", "x-frame-options"]);

function directiveName(directive: string): string {
  return directive.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

/**
 * Adds our directives to a policy the route (or Astro's hashed CSP) already set, keeping every directive it chose:
 * a directive that is already present is never duplicated or overridden.
 */
export function mergeCsp(existing: string, ours: string): string {
  const present = new Set(existing.split(";").map(directiveName).filter(Boolean));
  const missing = ours.split(";").filter((directive) => directive.trim() && !present.has(directiveName(directive)));
  if (missing.length === 0) return existing;
  return [existing.trim().replace(/;\s*$/, ""), ...missing.map((directive) => directive.trim())].join("; ");
}

/** Sets headers on a response, re-wrapping it when its headers are immutable (e.g. `Response.redirect`). */
export function withHeaders(response: Response, headers: Record<string, string>): Response {
  const apply = (target: Headers) => {
    for (const [name, value] of Object.entries(headers)) {
      if (ROUTE_CHOSEN.has(name) && target.has(name)) continue;
      const current = name === "content-security-policy" ? target.get(name) : null;
      target.set(name, current ? mergeCsp(current, value) : value);
    }
  };
  try {
    apply(response.headers);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    apply(copy.headers);
    return copy;
  }
}

export const securityHeaders: MiddlewareHandler = async (context, next) => {
  const response = await next();
  return withHeaders(
    response,
    securityHeadersFor({
      pathname: context.url.pathname,
      https: context.url.protocol === "https:",
      contentType: response.headers.get("content-type"),
    }),
  );
};
