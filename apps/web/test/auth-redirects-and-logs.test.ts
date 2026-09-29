import { describe, expect, it } from "vitest";

import { describeRedirectTarget, safeNextPath } from "../src/components/auth/request";
import { logPath } from "../src/middleware/request-log";

describe("post sign-in `next` redirect", () => {
  /** What `?next=` delivers to the page: `URLSearchParams` percent-decodes the raw query value. */
  const fromQuery = (raw: string) => new URL(`https://market.example/login?next=${raw}`).searchParams.get("next");

  it("keeps same-site paths with their query and fragment", () => {
    expect(safeNextPath("/account")).toBe("/account");
    expect(safeNextPath("/packages/@scope/pkg?tab=versions#readme")).toBe("/packages/@scope/pkg?tab=versions#readme");
    expect(safeNextPath(fromQuery("%2Fadmin%2Fpages%3Fq%3Dx"))).toBe("/admin/pages?q=x");
    expect(safeNextPath("/%2F%2Fevil.com")).toBe("/%2F%2Fevil.com");
  });

  it("falls back for anything that could leave the site", () => {
    const hostile = [
      null,
      undefined,
      "",
      "account",
      "https://evil.com/",
      "//evil.com",
      "/\\evil.com",
      "\\/evil.com",
      "/\\/evil.com",
      "/\t/evil.com",
      "/\n/evil.com",
      "/\r\n/evil.com",
      "/.//evil.com",
      "/%2e//evil.com",
      "/\u0000/evil.com",
      fromQuery("/%09/evil.com"),
      fromQuery("/%0a/evil.com"),
      fromQuery("/%0d/evil.com"),
      fromQuery("/%5C/evil.com"),
      fromQuery("%2F%2Fevil.com"),
      fromQuery("/%2F/evil.com"),
      fromQuery("%5C%2Fevil.com"),
      fromQuery("javascript:alert(1)"),
    ];
    for (const next of hostile) expect(safeNextPath(next), JSON.stringify(next)).toBe("/account");
    expect(safeNextPath("//evil.com", "/")).toBe("/");
  });

  it("never returns a value a browser would resolve off-site", () => {
    for (const next of ["/a", "/a/../b", "/./x", "/x?next=//evil.com", "/#//evil.com"]) {
      const resolved = new URL(safeNextPath(next), "https://market.example");
      expect(resolved.origin).toBe("https://market.example");
    }
  });
});

describe("OAuth consent redirect target", () => {
  const query = (redirect: string) => `?client_id=c&redirect_uri=${encodeURIComponent(redirect)}&sig=x`;

  it("names the host the decision is sent to, marking loopback apps", () => {
    expect(describeRedirectTarget(query("https://app.example.com/cb"))).toBe("app.example.com");
    expect(describeRedirectTarget(query("http://127.0.0.1:8765/callback"))).toBe("127.0.0.1:8765 (an app on this device)");
    expect(describeRedirectTarget(query("com.example.app:/oauth"))).toBe("com.example.app");
  });

  it("shows nothing when the query carries no usable redirect", () => {
    expect(describeRedirectTarget("?client_id=c")).toBeNull();
    expect(describeRedirectTarget(query("not a url"))).toBeNull();
  });
});

describe("request log paths", () => {
  it("redacts the bearer token of signed preview links and leaves other paths alone", () => {
    expect(logPath("/preview/eyJhbGciOi.abc-def")).toBe("/preview/:token");
    expect(logPath("/preview/tok/extra")).toBe("/preview/:token/extra");
    expect(logPath("/packages/preview/x")).toBe("/packages/preview/x");
    expect(logPath("/api/v1/search")).toBe("/api/v1/search");
  });
});
