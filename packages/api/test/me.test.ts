import { AUTH_BASE_PATH, createAuthRuntime } from "@marketplace/auth";
import { parseRuntimeVars } from "@marketplace/contracts";
import { media } from "@marketplace/db";
import { createMarketplaceDeps } from "@marketplace/marketplace";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { createApi } from "../src";

const ORIGIN = "http://localhost:4324";
const SECRET = `api-test-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const EMAIL = `me-${Date.now().toString(36)}@example.test`;
const vars = parseRuntimeVars({ PUBLIC_SITE_URL: ORIGIN, ENVIRONMENT: "development", ADMIN_EMAILS: EMAIL });
const deps = () => createMarketplaceDeps({ d1: env.DB, media: env.MEDIA });
const authFor = (request: Request) =>
  createAuthRuntime({ deps: deps(), vars, secrets: { BETTER_AUTH_SECRET: SECRET }, request });

const api = createApi({
  resolveContext: () => ({ deps: deps(), vars }),
  resolveAuth: (request) => authFor(request),
});
const call = (path: string, init: RequestInit = {}) => api.request(`${ORIGIN}${path}`, init);
const jsonInit = (method: string, body: unknown, headers: Record<string, string>): RequestInit => ({
  method,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

let cookie = "";

beforeAll(async () => {
  const request = new Request(`${ORIGIN}${AUTH_BASE_PATH}/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email: EMAIL, password: "correct horse battery", name: "Me" }),
  });
  const response = await authFor(request).auth.handler(request);
  expect(response.status).toBe(200);
  cookie = response.headers.getSetCookie().map((entry) => entry.split(";")[0] ?? "").find((entry) => entry.startsWith("better-auth.session_token=")) ?? "";
  expect(cookie).not.toBe("");
});

describe("/api/v1/me", () => {
  it("answers 401 without a credential and for an unknown bearer", async () => {
    const anonymous = await call("/api/v1/me");
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ error: { code: "unauthorized" } });
    expect((await call("/api/v1/me", { headers: { authorization: "Bearer cmk_nope" } })).status).toBe(401);
  });

  it("returns the session's profile with admin scopes for an allowlisted email", async () => {
    const response = await call("/api/v1/me", { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const profile = (await response.json()) as { email: string; role: string; scopes: string[] };
    expect(profile).toMatchObject({ email: EMAIL, role: "admin" });
    expect(profile.scopes).toContain("admin");
  });

  it("rejects cross-site cookie mutations and creates a token for a same-origin request", async () => {
    const evil = await call("/api/v1/me/tokens", jsonInit("POST", { name: "x", scopes: ["account:read"] }, { cookie, origin: "https://evil.example" }));
    expect(evil.status).toBe(403);
    expect(await evil.json()).toMatchObject({ error: { code: "forbidden", details: { reason: "csrf_origin_mismatch" } } });

    const created = await call(
      "/api/v1/me/tokens",
      jsonInit("POST", { name: "cli", scopes: ["account:read", "account:write", "pages:write"] }, { cookie, origin: ORIGIN }),
    );
    expect(created.status).toBe(201);
    const token = (await created.json()) as { id: string; token: string; scopes: string[] };
    expect(token.token).toMatch(/^cmk_/);

    const viaToken = await call("/api/v1/me", { headers: { authorization: `Bearer ${token.token}` } });
    expect(viaToken.status).toBe(200);
    expect(((await viaToken.json()) as { scopes: string[] }).scopes).toEqual(["account:read", "account:write", "pages:write"]);

    // Bearer requests are not subject to the Origin check, but still to scopes.
    const denied = await call(
      "/api/v1/me/tokens",
      jsonInit("POST", { name: "wider", scopes: ["admin"] }, { authorization: `Bearer ${token.token}`, origin: "https://elsewhere.example" }),
    );
    expect(denied.status).toBe(403);

    const listed = (await (await call("/api/v1/me/tokens", { headers: { cookie } })).json()) as { items: { id: string; lastUsedAt: string | null }[] };
    expect(listed.items.find((item) => item.id === token.id)?.lastUsedAt).not.toBeNull();

    const revoked = await call(`/api/v1/me/tokens/${token.id}`, { method: "DELETE", headers: { cookie, origin: ORIGIN } });
    expect(revoked.status).toBe(200);
    expect((await call("/api/v1/me", { headers: { authorization: `Bearer ${token.token}` } })).status).toBe(401);
  });

  it("links, lists and unlinks a ClarkCant device", async () => {
    const linked = await call(
      "/api/v1/me/devices/link",
      jsonInit("POST", { localPrincipalId: "prin_desk01", deviceLabel: "Desk" }, { cookie, origin: ORIGIN }),
    );
    expect(linked.status).toBe(200);
    const link = (await linked.json()) as { id: string };
    const bad = await call("/api/v1/me/devices/link", jsonInit("POST", { localPrincipalId: "nope", deviceLabel: "x" }, { cookie, origin: ORIGIN }));
    expect(bad.status).toBe(400);
    expect(((await (await call("/api/v1/me/devices", { headers: { cookie } })).json()) as { items: unknown[] }).items).toHaveLength(1);
    expect((await call(`/api/v1/me/devices/${link.id}`, { method: "DELETE", headers: { cookie, origin: ORIGIN } })).status).toBe(204);
  });

  it("creates a publisher and exports account data as an attachment", async () => {
    const created = await call(
      "/api/v1/me/publishers",
      jsonInit("POST", { slug: `me-${Date.now().toString(36)}`, name: "Me Co" }, { cookie, origin: ORIGIN }),
    );
    expect(created.status).toBe(201);
    const exported = await call("/api/v1/me/export", { headers: { cookie } });
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toContain("attachment");
    const data = (await exported.json()) as { profile: { email: string }; publishers: unknown[] };
    expect(data.profile.email).toBe(EMAIL);
    expect(data.publishers).toHaveLength(1);
    expect(((await (await call("/api/v1/me/packages", { headers: { cookie } })).json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("deletes the account through the media feature and ends the session", async () => {
    const key = `sha256/me/de/${Date.now().toString(36)}.png`;
    await env.MEDIA.put(key, new Uint8Array([1, 2, 3]));
    const profile = (await (await call("/api/v1/me", { headers: { cookie } })).json()) as { id: string };
    const mediaId = `med_${Date.now().toString(36)}`;
    await createMarketplaceDeps({ d1: env.DB }).db
      .insert(media)
      .values({ id: mediaId, sha256: `sha-${mediaId}`, r2Key: key, contentType: "image/png", bytes: 3, ownerUserId: profile.id });

    expect((await call("/api/v1/me", jsonInit("DELETE", { confirm: "yes" }, { cookie, origin: ORIGIN }))).status).toBe(400);
    const deleted = await call("/api/v1/me", jsonInit("DELETE", { confirm: "DELETE" }, { cookie, origin: ORIGIN }));
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ deleted: true, removed: { media: 1, publishers: 1 } });
    expect(await env.MEDIA.get(key)).toBeNull();
    const remaining = await createMarketplaceDeps({ d1: env.DB }).db.select({ id: media.id }).from(media);
    expect(remaining.map((row) => row.id)).not.toContain(mediaId);
    expect((await call("/api/v1/me", { headers: { cookie } })).status).toBe(401);
  });
});
