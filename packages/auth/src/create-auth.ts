import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { API_SCOPES, type ApiScope, type EnvironmentName } from "@marketplace/contracts";
import { schema, user, type Database } from "@marketplace/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, deviceAuthorization, jwt, organization } from "better-auth/plugins";
import { eq } from "drizzle-orm";

import { syncAccountRole, type AdminPolicy } from "./admin-allowlist";
import type { AuthSecrets } from "./secrets";

/** Better Auth is mounted here by the web Worker (`apps/web/src/pages/api/auth/[...all].ts`). */
export const AUTH_BASE_PATH = "/api/auth";
export const LOGIN_PAGE = "/login";
export const CONSENT_PAGE = "/oauth/consent";
export const DEVICE_VERIFICATION_PAGE = "/device";

/** Public clients allowed to start the device authorization flow (CLI login). */
export const DEVICE_CLIENT_IDS = ["clark-market-cli", "clarkcant-desktop"] as const;

/**
 * Scopes an OAuth client must never hold. Clients register themselves without an account (RFC 7591), so one
 * consent click must not hand them account control:
 * - `admin`: agents and third-party clients never receive admin authority; an admin who needs automation mints a
 *   scoped personal API token from a browser session instead.
 * - `account:write`: it covers minting personal API tokens (which outlive the grant and its revocation), revoking
 *   OAuth grants and accepting invitations. Account changes stay with signed-in sessions. Clients that link a
 *   ClarkCant install (e.g. ClarkCant desktop) request the narrow `devices:link` scope instead.
 */
const OAUTH_WITHHELD_SCOPES: readonly ApiScope[] = ["admin", "account:write"];

/**
 * Scopes an OAuth client may request. Access tokens resolve to this list ∩ the grant, so a token issued before a
 * scope was withheld loses it too.
 */
export const OAUTH_API_SCOPES: readonly ApiScope[] = API_SCOPES.filter((scope) => !OAUTH_WITHHELD_SCOPES.includes(scope));
export const OIDC_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

/**
 * Organization writes go through the marketplace publisher service, which keeps `publishers` in step and audits
 * every change. Better Auth's own organization mutation endpoints are therefore disabled.
 */
const DISABLED_PATHS = [
  // Replaced by the OAuth provider's token endpoint; a session must not be exchangeable for a JWT here.
  "/token",
  "/organization/create",
  "/organization/update",
  "/organization/delete",
  "/organization/invite-member",
  "/organization/accept-invitation",
  "/organization/reject-invitation",
  "/organization/cancel-invitation",
  "/organization/remove-member",
  "/organization/update-member-role",
  "/organization/leave",
];

export interface CreateAuthOptions {
  db: Database;
  secrets: AuthSecrets;
  /** Public origin, e.g. `https://marketplace.example` (no trailing slash). */
  origin: string;
  adminPolicy: AdminPolicy;
  environment: EnvironmentName;
  /** `ctx.waitUntil` of the current invocation, for Better Auth background work. */
  waitUntil?: ((promise: Promise<unknown>) => void) | undefined;
}

/** The OAuth resource identifier (JWT `aud`) for the marketplace REST API. */
export function apiAudience(origin: string): string {
  return `${origin}/api/v1`;
}

/**
 * The OAuth resource identifier (JWT `aud`) for the MCP endpoint. MCP clients request tokens for the resource named
 * in `/.well-known/oauth-protected-resource/mcp` (RFC 8707/9728), so it must be a registered resource here.
 */
export function mcpAudience(origin: string): string {
  return `${origin}/mcp`;
}

/**
 * Builds a Better Auth instance for one request. Never cache it at module scope: it closes over the current
 * invocation's D1 binding (and `waitUntil`), which must not leak into another request.
 */
export function createAuth(options: CreateAuthOptions) {
  const { db, secrets, origin, adminPolicy, environment } = options;
  const secure = origin.startsWith("https://");
  const audience = apiAudience(origin);

  return betterAuth({
    appName: "ClarkCant Marketplace",
    baseURL: origin,
    basePath: AUTH_BASE_PATH,
    secret: secrets.betterAuthSecret,
    trustedOrigins: [origin],
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    disabledPaths: DISABLED_PATHS,
    emailAndPassword: { enabled: true, minPasswordLength: 10, maxPasswordLength: 128, autoSignIn: true },
    socialProviders: secrets.github
      ? { github: { clientId: secrets.github.clientId, clientSecret: secrets.github.clientSecret } }
      : {},
    user: {
      additionalFields: {
        role: { type: "string", required: true, defaultValue: "user", input: false },
      },
    },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    // Fixed windows kept in D1 (the `rate_limit` table) so limits hold across isolates. Stricter rules protect
    // credential-guessing and registration endpoints.
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 120,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 3600, max: 10 },
        "/device/code": { window: 60, max: 10 },
        "/oauth2/register": { window: 3600, max: 20 },
        "/passkey/verify-authentication": { window: 60, max: 20 },
      },
    },
    advanced: {
      useSecureCookies: secure,
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      ...(options.waitUntil ? { backgroundTasks: { handler: options.waitUntil } } : {}),
    },
    databaseHooks: {
      session: {
        create: {
          // "ADMIN_EMAILS → role on sign-in": the stored role mirrors the allowlist at every new session.
          after: async (created) => {
            const [account] = await db.select().from(user).where(eq(user.id, created.userId)).limit(1);
            if (account) await syncAccountRole(db, account, adminPolicy);
          },
        },
      },
    },
    plugins: [
      organization({ allowUserToCreateOrganization: false, creatorRole: "owner" }),
      passkey({ rpID: new URL(origin).hostname, rpName: "ClarkCant Marketplace", origin }),
      deviceAuthorization({
        verificationUri: DEVICE_VERIFICATION_PAGE,
        expiresIn: "10m",
        interval: "5s",
        validateClient: (clientId) => (DEVICE_CLIENT_IDS as readonly string[]).includes(clientId),
      }),
      // Lets CLI and MCP callers send a session token (e.g. from the device flow) as `Authorization: Bearer`.
      bearer(),
      jwt(),
      oauthProvider({
        loginPage: LOGIN_PAGE,
        consentPage: CONSENT_PAGE,
        scopes: [...OIDC_SCOPES, ...OAUTH_API_SCOPES],
        clientRegistrationDefaultScopes: ["openid", "profile", "account:read"],
        clientRegistrationAllowedScopes: [...OIDC_SCOPES, ...OAUTH_API_SCOPES],
        // MCP clients register themselves (RFC 7591) without an account; they are public clients bound to PKCE.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        resources: [audience, mcpAudience(origin)],
        clientRegistrationDefaultResources: [audience, mcpAudience(origin)],
      }),
    ],
    telemetry: { enabled: false },
    ...(environment === "development" ? {} : { logger: { level: "warn" as const } }),
  });
}

export type MarketplaceAuth = ReturnType<typeof createAuth>;
