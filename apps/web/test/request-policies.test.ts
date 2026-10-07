import { describe, expect, it } from "vitest";

import { CF_BEACON_SRC, beaconConfig, parseAnalyticsToken, shouldLoadBeacon } from "../src/components/consent/analytics";
import {
  CONSENT_COOKIE,
  ESSENTIAL_ONLY,
  consentCookieString,
  consentFromCookieHeader,
  parseConsent,
  serializeConsent,
} from "../src/components/consent/consent";
import { THEME_SCRIPT } from "../src/components/theme-script";
import { optOutOfEdgeTransforms, preferredEncoding, withNoTransform } from "../src/middleware/edge-transform-opt-out";
import { rateLimitBucket, rateLimitKey, rateLimitedResponse } from "../src/middleware/rate-limit";
import { resolveRequestId } from "../src/middleware/request-log";
import { mergeCsp, securityHeadersFor, withHeaders } from "../src/middleware/security-headers";

const html = "text/html; charset=utf-8";

describe("security headers", () => {
  it("forbids framing everywhere except signed previews, which only the site itself may frame", () => {
    const page = securityHeadersFor({ pathname: "/packages", https: true, contentType: html });
    expect(page["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page["x-frame-options"]).toBe("DENY");
    const preview = securityHeadersFor({ pathname: "/preview/tok", https: true, contentType: html });
    expect(preview["content-security-policy"]).toContain("frame-ancestors 'self'");
    expect(preview["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("sends HSTS only over HTTPS and locks down non-HTML responses", () => {
    const https = securityHeadersFor({ pathname: "/", https: true, contentType: html });
    expect(https["strict-transport-security"]).toBe("max-age=63072000; includeSubDomains");
    expect(https["x-content-type-options"]).toBe("nosniff");
    expect(https["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(https["permissions-policy"]).toContain("camera=()");
    expect(https["content-security-policy"]).toContain("object-src 'none'");
    expect(securityHeadersFor({ pathname: "/", https: false, contentType: html })["strict-transport-security"]).toBeUndefined();
    const json = securityHeadersFor({ pathname: "/api/v1/health", https: true, contentType: "application/json" });
    expect(json["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  it("merges header-only directives into a policy the route or Astro already set, never overriding it", () => {
    const astro = "default-src 'self'; script-src 'self' 'sha256-abc'; object-src 'none';";
    expect(mergeCsp(astro, "frame-ancestors 'none'; object-src 'self'; base-uri 'self'")).toBe(
      "default-src 'self'; script-src 'self' 'sha256-abc'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
    );
    expect(mergeCsp("frame-ancestors 'self'", "frame-ancestors 'none'")).toBe("frame-ancestors 'self'");
  });

  it("keeps the route's own choices and re-wraps immutable responses", () => {
    const media = new Response("x", { headers: { "content-security-policy": "default-src 'none'; sandbox", "referrer-policy": "no-referrer" } });
    const out = withHeaders(media, securityHeadersFor({ pathname: "/media/x", https: true, contentType: "image/svg+xml" }));
    expect(out.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox; frame-ancestors 'none'");
    expect(out.headers.get("referrer-policy")).toBe("no-referrer");
    expect(out.headers.get("x-content-type-options")).toBe("nosniff");

    const redirect = withHeaders(Response.redirect("https://market.example/", 302), { "x-content-type-options": "nosniff" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("edge transform opt-out", () => {
  it("adds no-transform to an HTML page's Cache-Control and keeps the route's directives", () => {
    expect(withNoTransform(null)).toBe("no-transform");
    expect(withNoTransform("private, no-store")).toBe("private, no-store, no-transform");
    expect(withNoTransform("public, No-Transform")).toBe("public, No-Transform");
  });

  it("prefers brotli, then gzip, and honours q=0", () => {
    expect(preferredEncoding("gzip, deflate, br, zstd")).toBe("br");
    expect(preferredEncoding("br;q=0, gzip;q=0.8")).toBe("gzip");
    expect(preferredEncoding("identity")).toBeNull();
    expect(preferredEncoding(null)).toBeNull();
  });

  it("marks HTML no-transform and has the runtime compress it, leaving other responses alone", () => {
    const page = optOutOfEdgeTransforms(
      new Response("<p>hi</p>", { headers: { "content-type": html, "content-length": "9", vary: "Cookie" } }),
      "br",
    );
    expect(page.headers.get("cache-control")).toBe("no-transform");
    expect(page.headers.get("content-encoding")).toBe("br");
    expect(page.headers.get("content-length")).toBeNull();
    expect(page.headers.get("vary")).toBe("Cookie, Accept-Encoding");

    const uncompressed = optOutOfEdgeTransforms(new Response("<p>hi</p>", { headers: { "content-type": html } }), null);
    expect(uncompressed.headers.get("cache-control")).toBe("no-transform");
    expect(uncompressed.headers.get("content-encoding")).toBeNull();

    const preEncoded = optOutOfEdgeTransforms(
      new Response("x", { headers: { "content-type": html, "content-encoding": "gzip" } }),
      "br",
    );
    expect(preEncoded.headers.get("content-encoding")).toBe("gzip");

    const json = optOutOfEdgeTransforms(Response.json({ ok: true }), "br");
    expect(json.headers.get("cache-control")).toBeNull();
    expect(json.headers.get("content-encoding")).toBeNull();
  });
});

describe("rate limit buckets", () => {
  const bucket = (method: string, url: string) => rateLimitBucket(method, new URL(url, "https://market.example"));

  it("maps auth, publish, search and API routes to their budgets and leaves pages alone", () => {
    expect(bucket("POST", "/api/auth/sign-in/email")).toBe("auth");
    expect(bucket("POST", "/api/v1/publish/submit")).toBe("publish");
    expect(bucket("GET", "/api/v1/publish/submissions/sub_1")).toBe("api");
    expect(bucket("GET", "/api/v1/search?q=chart")).toBe("search");
    expect(bucket("GET", "/api/v1/packages?q=chart")).toBe("search");
    expect(bucket("GET", "/packages?q=chart")).toBe("search");
    expect(bucket("GET", "/api/v1/packages")).toBe("api");
    expect(bucket("POST", "/mcp")).toBe("api");
    expect(bucket("GET", "/packages")).toBeNull();
    expect(bucket("GET", "/about")).toBeNull();
    expect(bucket("GET", "/sitemap.xml")).toBeNull();
  });

  it("keys callers by client IP only, so unverified credentials cannot mint fresh budgets", () => {
    const ip = { "cf-connecting-ip": "203.0.113.9" };
    const anonymous = new Request("https://market.example/api/v1/search", { headers: ip });
    expect(rateLimitKey(anonymous, "search")).toBe("search:ip:203.0.113.9");

    // Rotating random bearer tokens or session cookies from one IP must all land in that IP's bucket.
    for (const headers of [
      { ...ip, authorization: `Bearer ${crypto.randomUUID()}` },
      { ...ip, authorization: `Bearer cmk_${crypto.randomUUID()}` },
      { ...ip, cookie: `__Secure-better-auth.session_token=${crypto.randomUUID()}` },
      { ...ip, cookie: `better-auth.session_token=${crypto.randomUUID()}`, authorization: "Bearer x" },
    ]) {
      const key = rateLimitKey(new Request("https://market.example/api/v1/search", { headers }), "search");
      expect(key).toBe("search:ip:203.0.113.9");
    }

    expect(rateLimitKey(new Request("https://market.example/api/v1/me"), "api")).toBe("api:ip:unknown");
  });

  it("keys IPv6 callers by their /64, so rotating addresses inside it shares one budget", () => {
    const key = (ip: string) =>
      rateLimitKey(new Request("https://market.example/api/v1/search", { headers: { "cf-connecting-ip": ip } }), "search");
    for (const ip of [
      "2001:db8:0:1::1",
      "2001:0db8:0000:0001:aaaa:bbbb:cccc:dddd",
      "2001:DB8:0:1:ffff::",
      "2001:db8:0:1:1:2:3.4.5.6",
    ]) {
      expect(key(ip)).toBe("search:ip:2001:db8:0:1::/64");
    }
    expect(key("2001:db8:0:2::1")).toBe("search:ip:2001:db8:0:2::/64");
    expect(key("2001:db8::1")).toBe("search:ip:2001:db8:0:0::/64");
    expect(key("::1")).toBe("search:ip:0:0:0:0::/64");
    expect(key("::ffff:203.0.113.9")).toBe("search:ip:203.0.113.9");
    // Values that are not IPv6 are passed through rather than collapsed into a shared key.
    expect(key("2001:db8::1::2")).toBe("search:ip:2001:db8::1::2");
  });

  it("answers 429 in the API error shape with Retry-After", async () => {
    const response = rateLimitedResponse("req_12345678", "search");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toEqual({
      error: { code: "rate_limited", message: "Too many search requests; retry after 60 seconds", requestId: "req_12345678" },
    });
  });
});

describe("request ids", () => {
  it("honours a well-formed caller id and mints one otherwise", () => {
    const given = new Request("https://market.example/", { headers: { "x-request-id": "trace-abc-123" } });
    expect(resolveRequestId(given)).toBe("trace-abc-123");
    const bad = new Request("https://market.example/", { headers: { "x-request-id": "<script>" } });
    expect(resolveRequestId(bad)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("consent cookie", () => {
  it("round-trips choices and rejects anything else", () => {
    expect(serializeConsent({ preferences: true, analytics: false })).toBe("v2.p1.a0");
    expect(serializeConsent({ preferences: false, analytics: true })).toBe("v2.p0.a1");
    expect(parseConsent("v2.p0.a0")).toEqual(ESSENTIAL_ONLY);
    expect(parseConsent("v2.p1.a1")).toEqual({ preferences: true, analytics: true });
    for (const bad of ["", "v2.p1", "v2.p1.a2", "v3.p1.a1", "yes", "v2.p1.a1;x"]) expect(parseConsent(bad)).toBeNull();
    expect(consentFromCookieHeader(`theme=x; ${CONSENT_COOKIE}=v2.p1.a0; other=1`)).toEqual({ preferences: true, analytics: false });
    expect(consentFromCookieHeader("other=1")).toBeNull();
  });

  it("asks again when a stored choice predates the analytics category", () => {
    expect(parseConsent("v1.p1")).toBeNull();
    expect(consentFromCookieHeader(`${CONSENT_COOKIE}=v1.p0`)).toBeNull();
  });

  it("is a first-party, Lax, 180-day cookie, Secure on HTTPS", () => {
    expect(consentCookieString(ESSENTIAL_ONLY, true)).toBe("cc_consent=v2.p0.a0; Path=/; Max-Age=15552000; SameSite=Lax; Secure");
    expect(consentCookieString({ preferences: true, analytics: true }, false)).not.toContain("Secure");
  });

  it("lets the inline theme script apply a stored theme only with preferences consent", () => {
    // The theme script is a fixed string run before first paint, so it matches the cookie itself.
    const source = /if \(!\/(.+?)\/\.test\(document\.cookie\)\)/.exec(THEME_SCRIPT)?.[1];
    expect(source).toBeDefined();
    const allowsTheme = (value: string) => new RegExp(source ?? "(?!)").test(`other=1; ${CONSENT_COOKIE}=${value}`);
    expect(allowsTheme(serializeConsent({ preferences: true, analytics: false }))).toBe(true);
    expect(allowsTheme(serializeConsent({ preferences: true, analytics: true }))).toBe(true);
    expect(allowsTheme(serializeConsent({ preferences: false, analytics: true }))).toBe(false);
    expect(allowsTheme("v1.p1")).toBe(false);
  });
});

describe("analytics gating", () => {
  const token = "0123456789abcdef0123456789abcdef";

  it("treats a missing or empty token as off and a malformed one as invalid, never echoing it", () => {
    expect(parseAnalyticsToken(undefined)).toEqual({ token: null, invalid: false });
    expect(parseAnalyticsToken("  ")).toEqual({ token: null, invalid: false });
    expect(parseAnalyticsToken(` ${token} `)).toEqual({ token, invalid: false });
    for (const bad of ['abc"><script>', "short", "x".repeat(129), 42]) {
      expect(parseAnalyticsToken(bad)).toEqual(typeof bad === "string" ? { token: null, invalid: true } : { token: null, invalid: false });
    }
  });

  it("loads the beacon only with analytics consent and a configured token", () => {
    expect(shouldLoadBeacon(null, token)).toBe(false);
    expect(shouldLoadBeacon(ESSENTIAL_ONLY, token)).toBe(false);
    expect(shouldLoadBeacon({ preferences: true, analytics: false }, token)).toBe(false);
    expect(shouldLoadBeacon({ preferences: false, analytics: true }, null)).toBe(false);
    expect(shouldLoadBeacon({ preferences: false, analytics: true }, "")).toBe(false);
    expect(shouldLoadBeacon({ preferences: false, analytics: true }, token)).toBe(true);
  });

  it("points the beacon at Cloudflare with the token as JSON", () => {
    expect(CF_BEACON_SRC).toBe("https://static.cloudflareinsights.com/beacon.min.js");
    expect(JSON.parse(beaconConfig(token))).toEqual({ token });
  });
});
