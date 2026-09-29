import { describe, expect, it } from "vitest";

import {
  CONSENT_COOKIE,
  consentCookieString,
  consentFromCookieHeader,
  parseConsent,
  serializeConsent,
} from "../src/components/consent/consent";
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
    expect(serializeConsent({ preferences: true })).toBe("v1.p1");
    expect(parseConsent("v1.p0")).toEqual({ preferences: false });
    for (const bad of ["", "v2.p1", "v1.p2", "yes", "v1.p1;x"]) expect(parseConsent(bad)).toBeNull();
    expect(consentFromCookieHeader(`theme=x; ${CONSENT_COOKIE}=v1.p1; other=1`)).toEqual({ preferences: true });
    expect(consentFromCookieHeader("other=1")).toBeNull();
  });

  it("is a first-party, Lax, 180-day cookie, Secure on HTTPS", () => {
    expect(consentCookieString({ preferences: false }, true)).toBe("cc_consent=v1.p0; Path=/; Max-Age=15552000; SameSite=Lax; Secure");
    expect(consentCookieString({ preferences: true }, false)).not.toContain("Secure");
  });
});
