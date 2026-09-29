import { AUTH_BASE_PATH, createAuthRuntime } from "@marketplace/auth";
import { parseRuntimeVars } from "@marketplace/contracts";
import { createMarketplaceDeps } from "@marketplace/marketplace";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { createApi } from "../src";

const ORIGIN = "http://localhost:4324";
const SECRET = `api-safety-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const vars = parseRuntimeVars({ PUBLIC_SITE_URL: ORIGIN, ENVIRONMENT: "development", ADMIN_EMAILS: "" });
const deps = () => createMarketplaceDeps({ d1: env.DB, media: env.MEDIA });
const authFor = (request: Request) => createAuthRuntime({ deps: deps(), vars, secrets: { BETTER_AUTH_SECRET: SECRET }, request });

const api = createApi({ resolveContext: () => ({ deps: deps(), vars }), resolveAuth: (request) => authFor(request) });
const call = (path: string, init: RequestInit = {}) => api.request(`${ORIGIN}${path}`, init);
const post = (path: string, body: unknown, headers: Record<string, string>) =>
  call(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const unique = (label: string) => `${label}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

async function signUp(email: string): Promise<string> {
  const request = new Request(`${ORIGIN}${AUTH_BASE_PATH}/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password: "correct horse battery", name: "Safety" }),
  });
  const response = await authFor(request).auth.handler(request);
  expect(response.status).toBe(200);
  const cookie = response.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0] ?? "")
    .find((entry) => entry.startsWith("better-auth.session_token="));
  if (!cookie) throw new Error("no session cookie");
  return cookie;
}

let ownerCookie = "";
let ownerSession: Record<string, string> = {};

beforeAll(async () => {
  ownerCookie = await signUp(`${unique("owner")}@example.test`);
  ownerSession = { cookie: ownerCookie, origin: ORIGIN };
});

describe("personal API tokens need a signed-in session", () => {
  it("refuses to let a token mint or revoke tokens, even one holding account:write", async () => {
    const created = await post("/api/v1/me/tokens", { name: "agent", scopes: ["account:read", "account:write"] }, ownerSession);
    expect(created.status).toBe(201);
    const token = (await created.json()) as { id: string; token: string };
    const bearer = { authorization: `Bearer ${token.token}` };

    const minted = await post("/api/v1/me/tokens", { name: "longer", scopes: ["account:read"], expiresInDays: 365 }, bearer);
    expect(minted.status).toBe(403);
    expect(await minted.json()).toMatchObject({ error: { code: "forbidden", details: { reason: "session_required" } } });

    const revoked = await call(`/api/v1/me/tokens/${token.id}`, { method: "DELETE", headers: bearer });
    expect(revoked.status).toBe(403);

    // Anonymous callers still learn they must sign in.
    expect((await post("/api/v1/me/tokens", { name: "x", scopes: ["account:read"] }, {})).status).toBe(401);

    expect((await call(`/api/v1/me/tokens/${token.id}`, { method: "DELETE", headers: ownerSession })).status).toBe(200);
  });
});

const base64url = (data: Uint8Array) =>
  btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function authCall(path: string, init: { body?: unknown; form?: Record<string, string>; cookie?: string } = {}) {
  const headers = new Headers({ origin: ORIGIN });
  if (init.cookie) headers.set("cookie", init.cookie);
  let body: string | undefined;
  if (init.form) {
    headers.set("content-type", "application/x-www-form-urlencoded");
    body = new URLSearchParams(init.form).toString();
  } else if (init.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.body);
  }
  const request = new Request(`${ORIGIN}${AUTH_BASE_PATH}${path}`, { method: body ? "POST" : "GET", headers, body });
  return authFor(request).auth.handler(request);
}

/** Registers a public native client and runs authorize (PKCE) → consent → token for the signed-in owner. */
async function oauthAccessToken(scope: string): Promise<string> {
  const redirectUri = "http://127.0.0.1:8799/callback";
  const registered = await authCall("/oauth2/register", {
    body: {
      client_name: "ClarkCant Desktop (device link test)",
      application_type: "native",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope,
    },
  });
  expect(registered.status, await registered.clone().text()).toBeLessThan(300);
  const { client_id } = (await registered.json()) as { client_id: string };

  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const query = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: redirectUri,
    scope,
    state: "s",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${ORIGIN}/api/v1`,
  });
  const authorize = await authCall(`/oauth2/authorize?${query}`, { cookie: ownerCookie });
  const consentLocation = authorize.headers.get("location") ?? "";
  expect(consentLocation).toContain("/oauth/consent");
  const consent = await authCall("/oauth2/consent", {
    body: { accept: true, oauth_query: new URL(consentLocation, ORIGIN).search.slice(1) },
    cookie: ownerCookie,
  });
  const consentBody = (await consent.json()) as { redirect_uri?: string; url?: string };
  const code = new URL(consentBody.redirect_uri ?? consentBody.url ?? "").searchParams.get("code") ?? "";

  const tokenResponse = await authCall("/oauth2/token", {
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id,
      code_verifier: verifier,
      resource: `${ORIGIN}/api/v1`,
    },
  });
  const tokens = (await tokenResponse.json()) as { access_token: string };
  expect(tokenResponse.status, JSON.stringify(tokens)).toBe(200);
  return tokens.access_token;
}

describe("ClarkCant device linking over OAuth", () => {
  it("links, lists and unlinks with devices:link, but cannot mint tokens or change the account", async () => {
    const bearer = { authorization: `Bearer ${await oauthAccessToken("openid devices:link")}` };

    const linked = await post("/api/v1/me/devices/link", { localPrincipalId: "prin_oauthdesk1", deviceLabel: "Desk" }, bearer);
    expect(linked.status, await linked.clone().text()).toBe(200);
    const link = (await linked.json()) as { id: string };
    const listed = (await (await call("/api/v1/me/devices", { headers: bearer })).json()) as { items: { id: string }[] };
    expect(listed.items.map((item) => item.id)).toContain(link.id);

    const minted = await post("/api/v1/me/tokens", { name: "escalate", scopes: ["devices:link"] }, bearer);
    expect(minted.status).toBe(403);
    expect((await call("/api/v1/me", { method: "DELETE", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ confirm: "DELETE" }) })).status).toBe(403);
    expect((await call("/api/v1/me/oauth/grants/any-client", { method: "DELETE", headers: bearer })).status).toBe(403);
    expect((await post("/api/v1/me/publishers", { slug: unique("oauthpub").toLowerCase().slice(0, 40), name: "No" }, bearer)).status).toBe(403);
    expect((await call("/api/v1/me", { headers: bearer })).status).toBe(403);

    expect((await call(`/api/v1/me/devices/${link.id}`, { method: "DELETE", headers: bearer })).status).toBe(204);
  });
});

describe("Idempotency-Key on /me writes", () => {
  it("replays a publisher creation and rejects a reused key with a different body", async () => {
    const key = { ...ownerSession, "idempotency-key": unique("pub-key") };
    const slug = unique("idem").toLowerCase().slice(0, 40);
    const first = await post("/api/v1/me/publishers", { slug, name: "Idem Co" }, key);
    expect(first.status).toBe(201);
    const second = await post("/api/v1/me/publishers", { slug, name: "Idem Co" }, key);
    expect(second.status).toBe(201);
    expect(((await second.json()) as { id: string }).id).toBe(((await first.json()) as { id: string }).id);

    const reused = await post("/api/v1/me/publishers", { slug: `${slug}-b`, name: "Other" }, key);
    expect(reused.status).toBe(422);
    expect(await reused.json()).toMatchObject({ error: { code: "idempotency_key_reused" } });
  });

  it("never replays a token's plaintext: a retry answers 409 naming the token already created", async () => {
    const headers = { ...ownerSession, "idempotency-key": unique("tok-key") };
    const body = { name: "retry", scopes: ["account:read"] };
    const first = await post("/api/v1/me/tokens", body, headers);
    expect(first.status).toBe(201);
    const created = (await first.json()) as { id: string; token: string };
    expect(created.token).toMatch(/^cmk_/);

    const retry = await post("/api/v1/me/tokens", body, headers);
    expect(retry.status).toBe(409);
    const retryBody = await retry.text();
    expect(retryBody).toContain(created.id);
    expect(retryBody).not.toContain(created.token);

    const listed = (await (await call("/api/v1/me/tokens", { headers: { cookie: ownerCookie } })).json()) as { items: { name: string }[] };
    expect(listed.items.filter((item) => item.name === "retry")).toHaveLength(1);
  });
});

describe("publisher invitations", () => {
  it("can only be accepted by an account whose email is verified", async () => {
    const slug = unique("inv").toLowerCase().slice(0, 40);
    const publisher = (await (await post("/api/v1/me/publishers", { slug, name: "Inviter" }, ownerSession)).json()) as { id: string };
    const inviteeEmail = `${unique("invitee")}@example.test`;
    const inviteeCookie = await signUp(inviteeEmail);
    const invited = await post(`/api/v1/me/publishers/${publisher.id}/invitations`, { email: inviteeEmail, role: "member" }, ownerSession);
    expect(invited.status, await invited.clone().text()).toBe(201);
    const invitation = (await invited.json()) as { id: string };

    const invitee = { cookie: inviteeCookie, origin: ORIGIN };
    const unverified = await post(`/api/v1/me/invitations/${invitation.id}/accept`, {}, invitee);
    expect(unverified.status).toBe(403);
    expect(await unverified.json()).toMatchObject({ error: { code: "forbidden", details: { reason: "email_unverified" } } });

    await env.DB.prepare("UPDATE user SET email_verified = 1 WHERE email = ?").bind(inviteeEmail).run();
    const accepted = await post(`/api/v1/me/invitations/${invitation.id}/accept`, {}, invitee);
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    expect(await accepted.json()).toMatchObject({ id: publisher.id });
  });
});
