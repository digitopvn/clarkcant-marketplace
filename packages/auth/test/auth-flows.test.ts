import { parseRuntimeVars, type Actor } from "@marketplace/contracts";
import { user } from "@marketplace/db";
import { createApiToken, createMarketplaceDeps, revokeApiToken } from "@marketplace/marketplace";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  AUTH_BASE_PATH,
  apiAudience,
  assertSameOriginMutation,
  createAuthRuntime,
  isAdminAccount,
  parseAuthSecrets,
  resolveRequestAuth,
  type AuthRuntime,
} from "../src";

const ORIGIN = "http://localhost:4324";
const SECRET = `test-secret-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const deps = createMarketplaceDeps({ d1: env.DB });

function runtime(overrides: { adminEmails?: string; environment?: "development" | "staging" } = {}): AuthRuntime {
  const vars = parseRuntimeVars({
    PUBLIC_SITE_URL: ORIGIN,
    ENVIRONMENT: overrides.environment ?? "development",
    ADMIN_EMAILS: overrides.adminEmails ?? "",
  });
  return createAuthRuntime({ deps, vars, secrets: { BETTER_AUTH_SECRET: SECRET }, request: new Request(`${ORIGIN}/`) });
}

let emailCounter = 0;
const newEmail = (label: string) => `${label}-${Date.now().toString(36)}-${(emailCounter += 1)}@example.test`;

function authRequest(path: string, init: { method?: string; body?: unknown; cookie?: string; form?: Record<string, string> } = {}) {
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
  return new Request(`${ORIGIN}${AUTH_BASE_PATH}${path}`, { method: init.method ?? (body ? "POST" : "GET"), headers, body });
}

function sessionCookie(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0] ?? "")
    .find((entry) => entry.startsWith("better-auth.session_token="));
  if (!cookie) throw new Error(`no session cookie (status ${response.status})`);
  return cookie;
}

async function signUp(auth: AuthRuntime, email: string): Promise<string> {
  const response = await auth.auth.handler(
    authRequest("/sign-up/email", { body: { email, password: "correct horse battery", name: "Tester" } }),
  );
  expect(response.status).toBe(200);
  return sessionCookie(response);
}

const withCookie = (cookie: string, init: RequestInit = {}) =>
  new Request(`${ORIGIN}/api/v1/me`, { ...init, headers: { cookie, ...(init.headers ?? {}) } });
const withBearer = (token: string) => new Request(`${ORIGIN}/api/v1/me`, { headers: { authorization: `Bearer ${token}` } });

describe("auth secrets", () => {
  it("requires a strong secret and both GitHub halves together, without echoing values", () => {
    expect(() => parseAuthSecrets({ BETTER_AUTH_SECRET: "short" })).toThrowError(/BETTER_AUTH_SECRET/);
    expect(() => parseAuthSecrets({ BETTER_AUTH_SECRET: SECRET, GITHUB_CLIENT_ID: "id-only" })).toThrowError(/GITHUB_CLIENT_ID/);
    try {
      parseAuthSecrets({ BETTER_AUTH_SECRET: "short-secret-value" });
    } catch (error) {
      expect(String(error)).not.toContain("short-secret-value");
    }
    expect(parseAuthSecrets({ BETTER_AUTH_SECRET: SECRET, GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "" }).github).toBeNull();
  });
});

describe("admin allowlist", () => {
  it("grants admin only to allowlisted emails, and outside development only when verified", () => {
    const policy = { adminEmails: ["boss@example.test"], environment: "staging" as const };
    expect(isAdminAccount({ email: "Boss@Example.test", emailVerified: true }, policy)).toBe(true);
    expect(isAdminAccount({ email: "boss@example.test", emailVerified: false }, policy)).toBe(false);
    expect(isAdminAccount({ email: "boss@example.test", emailVerified: false }, { ...policy, environment: "development" })).toBe(true);
    expect(isAdminAccount({ email: "other@example.test", emailVerified: true }, policy)).toBe(false);
  });

  it("resolves sessions of allowlisted accounts as admins and mirrors the role on sign-in and lookup", async () => {
    const email = newEmail("admin");
    const cookie = await signUp(runtime({ adminEmails: email }), email);
    const [row] = await deps.db.select().from(user).where(eq(user.email, email));
    expect(row?.role).toBe("admin");

    const asAdmin = await resolveRequestAuth(runtime({ adminEmails: email }), withCookie(cookie));
    expect(asAdmin.credential).toBe("cookie");
    expect(asAdmin.actor.scopes).toContain("admin");

    // Removing the address from the allowlist demotes the account on its next request.
    const demoted = await resolveRequestAuth(runtime(), withCookie(cookie));
    expect(demoted.actor.scopes).not.toContain("admin");
    const [after] = await deps.db.select().from(user).where(eq(user.email, email));
    expect(after?.role).toBe("user");

    // Staging requires a verified address.
    const staging = await resolveRequestAuth(runtime({ adminEmails: email, environment: "staging" }), withCookie(cookie));
    expect(staging.actor.scopes).not.toContain("admin");
  });
});

describe("request actor resolution", () => {
  it("treats requests without credentials as anonymous and rejects malformed bearers", async () => {
    const auth = runtime();
    expect(await resolveRequestAuth(auth, new Request(`${ORIGIN}/api/v1/me`))).toMatchObject({
      credential: "none",
      actor: { type: "anonymous" },
    });
    await expect(
      resolveRequestAuth(auth, new Request(`${ORIGIN}/`, { headers: { authorization: "Basic abc" } })),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(resolveRequestAuth(auth, withBearer("not-a-session"))).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("accepts API tokens with scopes capped by the account, and rejects them once revoked", async () => {
    const email = newEmail("token");
    const auth = runtime({ adminEmails: email });
    const cookie = await signUp(auth, email);
    const { actor: owner } = await resolveRequestAuth(auth, withCookie(cookie));
    const token = await createApiToken(deps, owner, { name: "agent", scopes: ["account:read", "pages:write"] });

    const asToken = await resolveRequestAuth(auth, withBearer(token.token));
    expect(asToken).toMatchObject({ credential: "api_token", actor: { type: "token", tokenId: token.id } });
    expect(asToken.actor.scopes).toEqual(["account:read", "pages:write"]);

    // The owner loses admin rights: the token keeps only what a normal account may do.
    const capped = await resolveRequestAuth(runtime(), withBearer(token.token));
    expect(capped.actor.scopes).toEqual(["account:read"]);

    await revokeApiToken(deps, owner, token.id);
    await expect(resolveRequestAuth(auth, withBearer(token.token))).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("rejects cross-site cookie mutations but not bearer requests or safe methods", () => {
    const post = (headers: Record<string, string>) => new Request(`${ORIGIN}/api/v1/me/tokens`, { method: "POST", headers });
    expect(() => assertSameOriginMutation(post({ origin: "https://evil.example" }), "cookie", ORIGIN)).toThrowError(
      expect.objectContaining({ code: "forbidden" }),
    );
    expect(() => assertSameOriginMutation(post({}), "cookie", ORIGIN)).toThrowError(expect.objectContaining({ code: "forbidden" }));
    expect(() => assertSameOriginMutation(post({ origin: ORIGIN }), "cookie", ORIGIN)).not.toThrow();
    expect(() => assertSameOriginMutation(post({ "sec-fetch-site": "same-origin" }), "cookie", ORIGIN)).not.toThrow();
    expect(() => assertSameOriginMutation(post({ origin: "https://evil.example" }), "api_token", ORIGIN)).not.toThrow();
    expect(() =>
      assertSameOriginMutation(new Request(ORIGIN, { headers: { origin: "https://evil.example" } }), "cookie", ORIGIN),
    ).not.toThrow();
  });
});

describe("device authorization (CLI login)", () => {
  it("issues a session token usable as a bearer, without admin scope", async () => {
    const email = newEmail("device");
    const auth = runtime({ adminEmails: email });
    const cookie = await signUp(auth, email);

    const rejected = await auth.auth.handler(authRequest("/device/code", { body: { client_id: "unknown-client" } }));
    expect(rejected.status).toBe(400);

    const codeResponse = await auth.auth.handler(authRequest("/device/code", { body: { client_id: "clark-market-cli" } }));
    expect(codeResponse.status).toBe(200);
    const code = (await codeResponse.json()) as { device_code: string; user_code: string; verification_uri: string };
    expect(code.verification_uri).toContain("/device");

    const pending = await auth.auth.handler(
      authRequest("/device/token", {
        body: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: code.device_code, client_id: "clark-market-cli" },
      }),
    );
    expect(((await pending.json()) as { error: string }).error).toBe("authorization_pending");

    // The /device page claims the code for the signed-in session before the user approves it.
    const claim = await auth.auth.handler(authRequest(`/device?user_code=${encodeURIComponent(code.user_code)}`, { cookie }));
    expect(claim.status, await claim.clone().text()).toBe(200);
    const approve = await auth.auth.handler(authRequest("/device/approve", { body: { userCode: code.user_code }, cookie }));
    expect(approve.status, await approve.clone().text()).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 5_100));
    const tokenResponse = await auth.auth.handler(
      authRequest("/device/token", {
        body: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: code.device_code, client_id: "clark-market-cli" },
      }),
    );
    expect(tokenResponse.status).toBe(200);
    const { access_token } = (await tokenResponse.json()) as { access_token: string };

    const resolved = await resolveRequestAuth(auth, withBearer(access_token));
    expect(resolved.credential).toBe("session_bearer");
    expect(resolved.actor).toMatchObject({ type: "user" });
    expect(resolved.actor.scopes).toEqual(expect.arrayContaining(["account:write", "devices:link"]));
    expect(resolved.actor.scopes).not.toContain("admin");
  }, 20_000);
});

async function pkcePair() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const encode = (data: Uint8Array) => btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const verifier = encode(bytes);
  const challenge = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

describe("OAuth 2.1 provider (ClarkCant desktop / MCP groundwork)", () => {
  it("publishes discovery metadata", async () => {
    const auth = runtime();
    const response = await auth.auth.handler(authRequest("/.well-known/openid-configuration"));
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata.issuer).toBe(`${ORIGIN}${AUTH_BASE_PATH}`);
    expect(metadata.code_challenge_methods_supported).toContain("S256");
    expect(metadata.scopes_supported).toEqual(expect.arrayContaining(["openid", "account:read", "pages:write"]));
    expect(metadata.scopes_supported).not.toContain("admin");
    // Account changes (minting personal tokens, revoking grants) stay with signed-in sessions.
    expect(metadata.scopes_supported).not.toContain("account:write");
    // ClarkCant desktop links its install with this narrow scope instead.
    expect(metadata.scopes_supported).toContain("devices:link");
  });

  it("refuses to register a client that asks for account:write", async () => {
    const response = await runtime().auth.handler(
      authRequest("/oauth2/register", {
        body: {
          client_name: "Greedy client",
          application_type: "native",
          redirect_uris: ["http://127.0.0.1:8766/callback"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code"],
          response_types: ["code"],
          scope: "openid account:read account:write",
        },
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("runs register → authorize (PKCE) → consent → token and resolves the access token as a scoped actor", async () => {
    const email = newEmail("oauth");
    const auth = runtime();
    const cookie = await signUp(auth, email);
    const redirectUri = "http://127.0.0.1:8765/callback";

    const registered = await auth.auth.handler(
      authRequest("/oauth2/register", {
        body: {
          client_name: "ClarkCant Desktop (test)",
          application_type: "native",
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: "openid account:read publishers:write",
        },
      }),
    );
    expect(registered.status, await registered.clone().text()).toBeLessThan(300);
    const client = (await registered.json()) as { client_id: string };

    const { verifier, challenge } = await pkcePair();
    const authorizeQuery = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope: "openid account:read publishers:write",
      state: "state-123",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: apiAudience(ORIGIN),
    });
    const authorize = await auth.auth.handler(authRequest(`/oauth2/authorize?${authorizeQuery}`, { cookie }));
    const consentLocation = authorize.headers.get("location") ?? "";
    expect(authorize.status, await authorize.clone().text()).toBeGreaterThanOrEqual(300);
    expect(consentLocation).toContain("/oauth/consent");

    const consent = await auth.auth.handler(
      authRequest("/oauth2/consent", { body: { accept: true, oauth_query: new URL(consentLocation, ORIGIN).search.slice(1) }, cookie }),
    );
    const consentBody = (await consent.json()) as { redirect_uri?: string; url?: string };
    const callback = new URL(consentBody.redirect_uri ?? consentBody.url ?? "");
    expect(callback.searchParams.get("state")).toBe("state-123");
    const authorizationCode = callback.searchParams.get("code");
    expect(authorizationCode).toBeTruthy();

    const tokenResponse = await auth.auth.handler(
      authRequest("/oauth2/token", {
        form: {
          grant_type: "authorization_code",
          code: authorizationCode ?? "",
          redirect_uri: redirectUri,
          client_id: client.client_id,
          code_verifier: verifier,
          resource: apiAudience(ORIGIN),
        },
      }),
    );
    const tokens = (await tokenResponse.json()) as { access_token: string };
    expect(tokenResponse.status, JSON.stringify(tokens)).toBe(200);
    expect(tokens.access_token.split(".")).toHaveLength(3);

    const resolved = await resolveRequestAuth(auth, withBearer(tokens.access_token));
    expect(resolved.credential).toBe("oauth");
    const actor: Actor = resolved.actor;
    expect(actor).toMatchObject({ type: "token", tokenId: `oauth:${client.client_id}` });
    expect(actor.scopes.sort()).toEqual(["account:read", "publishers:write"]);

    // A tampered token fails signature verification.
    await expect(resolveRequestAuth(runtime(), withBearer(`${tokens.access_token}x`))).rejects.toMatchObject({
      code: "unauthorized",
    });
  });
});
