import {
  ANONYMOUS_ACTOR,
  MarketplaceError,
  hasScope,
  scopesForAccount,
  type Actor,
  type ApiScope,
  type RuntimeVars,
} from "@marketplace/contracts";
import { user } from "@marketplace/db";
import { verifyApiToken, type MarketplaceDeps } from "@marketplace/marketplace";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { eq } from "drizzle-orm";

import { isAdminAccount, syncAccountRole, type AdminPolicy } from "./admin-allowlist";
import { AUTH_BASE_PATH, OAUTH_API_SCOPES, apiAudience, createAuth, type MarketplaceAuth } from "./create-auth";
import { parseAuthSecrets } from "./secrets";

/** Everything needed to authenticate one request. Build it per request with `createAuthRuntime`. */
export interface AuthRuntime {
  auth: MarketplaceAuth;
  deps: MarketplaceDeps;
  origin: string;
  adminPolicy: AdminPolicy;
}

export interface CreateAuthRuntimeInput {
  deps: MarketplaceDeps;
  vars: RuntimeVars;
  /** Worker env (or any record) holding the auth secrets; validated here. */
  secrets: Record<string, unknown>;
  request: Request;
  waitUntil?: ((promise: Promise<unknown>) => void) | undefined;
}

/**
 * Local development serves on whatever localhost port `astro dev` picked, so the origin comes from the request;
 * deployed environments always use the configured `PUBLIC_SITE_URL`, never a client-controlled Host header.
 */
export function resolveAuthOrigin(vars: RuntimeVars, request: Request): string {
  return vars.ENVIRONMENT === "development" ? new URL(request.url).origin : vars.PUBLIC_SITE_URL;
}

export function createAuthRuntime(input: CreateAuthRuntimeInput): AuthRuntime {
  const origin = resolveAuthOrigin(input.vars, input.request);
  const adminPolicy: AdminPolicy = { adminEmails: input.vars.ADMIN_EMAILS, environment: input.vars.ENVIRONMENT };
  const auth = createAuth({
    db: input.deps.db,
    secrets: parseAuthSecrets(input.secrets),
    origin,
    adminPolicy,
    environment: input.vars.ENVIRONMENT,
    waitUntil: input.waitUntil,
  });
  return { auth, deps: input.deps, origin, adminPolicy };
}

/** How the actor authenticated. Only `cookie` credentials are exposed to CSRF and need an Origin check. */
export type CredentialKind = "none" | "cookie" | "session_bearer" | "api_token" | "oauth";

export interface RequestAuth {
  actor: Actor;
  credential: CredentialKind;
}

const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/;

/** True when the request presents any credential; lets hosts skip building Better Auth for anonymous traffic. */
export function requestCarriesCredentials(request: Request): boolean {
  if (request.headers.has("authorization")) return true;
  const cookie = request.headers.get("cookie");
  return cookie !== null && SESSION_COOKIE.test(cookie);
}

function invalidCredential(): MarketplaceError {
  return new MarketplaceError("unauthorized", "The credential is invalid, expired or revoked");
}

/**
 * Resolves the caller. An `Authorization` header is authoritative when present: a malformed or unknown bearer is
 * rejected (401) rather than silently downgraded to anonymous, so clients learn their token is bad.
 *
 * Bearer forms, told apart by shape:
 * - `cmk_…` personal API token → `token` actor, scopes = token grant ∩ account scopes now.
 * - three-part JWT → OAuth access token (audience `<origin>/api/v1`) → `token` actor, scopes = granted API scopes
 *   ∩ account scopes, never `admin`.
 * - anything else → Better Auth session token (device flow, bearer plugin) → `user` actor without `admin`.
 *
 * Without the header, the Better Auth session cookie yields a `user` actor with the account's full scopes.
 */
export async function resolveRequestAuth(runtime: AuthRuntime, request: Request): Promise<RequestAuth> {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    const token = match?.[1];
    if (!token) throw new MarketplaceError("unauthorized", "Authorization must use the Bearer scheme");
    if (token.startsWith("cmk_")) return { actor: await actorFromApiToken(runtime, token), credential: "api_token" };
    if (token.split(".").length === 3) return { actor: await actorFromOAuthToken(runtime, token), credential: "oauth" };
    const session = await runtime.auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
    if (!session) throw invalidCredential();
    return { actor: await actorFromAccount(runtime, session.user, { allowAdmin: false }), credential: "session_bearer" };
  }

  const cookie = request.headers.get("cookie");
  if (cookie === null || !SESSION_COOKIE.test(cookie)) return { actor: ANONYMOUS_ACTOR, credential: "none" };
  const session = await runtime.auth.api.getSession({ headers: new Headers({ cookie }) });
  if (!session) return { actor: ANONYMOUS_ACTOR, credential: "none" };
  return { actor: await actorFromAccount(runtime, session.user, { allowAdmin: true }), credential: "cookie" };
}

interface AccountRow {
  id: string;
  email: string;
  emailVerified: boolean;
  role?: string | null | undefined;
}

async function accountScopes(runtime: AuthRuntime, account: AccountRow): Promise<ApiScope[]> {
  // "on lookup": keep the stored role in step with the allowlist whenever the account is resolved.
  await syncAccountRole(runtime.deps.db, account, runtime.adminPolicy);
  return scopesForAccount(isAdminAccount(account, runtime.adminPolicy));
}

async function actorFromAccount(runtime: AuthRuntime, account: AccountRow, options: { allowAdmin: boolean }) {
  const scopes = await accountScopes(runtime, account);
  return {
    type: "user",
    userId: account.id,
    scopes: options.allowAdmin ? scopes : scopes.filter((scope) => scope !== "admin"),
  } satisfies Actor;
}

async function loadAccount(runtime: AuthRuntime, userId: string): Promise<AccountRow> {
  const [row] = await runtime.deps.db
    .select({ id: user.id, email: user.email, emailVerified: user.emailVerified, role: user.role })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!row) throw invalidCredential();
  return row;
}

async function actorFromApiToken(runtime: AuthRuntime, token: string): Promise<Actor> {
  const verified = await verifyApiToken(runtime.deps, token);
  if (!verified) throw invalidCredential();
  const allowed = await accountScopes(runtime, await loadAccount(runtime, verified.userId));
  return {
    type: "token",
    userId: verified.userId,
    tokenId: verified.tokenId,
    scopes: verified.scopes.filter((scope) => hasScope(allowed, scope)),
  };
}

async function actorFromOAuthToken(runtime: AuthRuntime, token: string): Promise<Actor> {
  let payload: Awaited<ReturnType<typeof verifyJwsAccessToken>>;
  try {
    payload = await verifyJwsAccessToken(token, {
      jwksFetch: async () => runtime.auth.api.getJwks(),
      verifyOptions: { issuer: `${runtime.origin}${AUTH_BASE_PATH}`, audience: apiAudience(runtime.origin) },
    });
  } catch {
    throw invalidCredential();
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) throw invalidCredential();
  const granted = typeof payload.scope === "string" ? payload.scope.split(" ") : [];
  const allowed = await accountScopes(runtime, await loadAccount(runtime, payload.sub));
  const clientId = typeof payload.azp === "string" ? payload.azp : typeof payload.client_id === "string" ? payload.client_id : "unknown";
  return {
    type: "token",
    userId: payload.sub,
    tokenId: `oauth:${clientId}`.slice(0, 200),
    scopes: OAUTH_API_SCOPES.filter((scope) => granted.includes(scope) && hasScope(allowed, scope)),
  };
}
