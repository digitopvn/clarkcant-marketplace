export { isAdminAccount, syncAccountRole, type AccountRole, type AdminPolicy } from "./admin-allowlist";
export {
  AUTH_BASE_PATH,
  CONSENT_PAGE,
  DEVICE_CLIENT_IDS,
  DEVICE_VERIFICATION_PAGE,
  LOGIN_PAGE,
  OAUTH_API_SCOPES,
  OIDC_SCOPES,
  apiAudience,
  createAuth,
  type CreateAuthOptions,
  type MarketplaceAuth,
} from "./create-auth";
export { assertSameOriginMutation } from "./csrf";
export {
  createAuthRuntime,
  resolveAuthOrigin,
  requestCarriesCredentials,
  resolveRequestAuth,
  type AuthRuntime,
  type CreateAuthRuntimeInput,
  type CredentialKind,
  type RequestAuth,
} from "./request-auth";
export { authSecretsSchema, parseAuthSecrets, type AuthSecrets } from "./secrets";
// Scope helpers live in contracts so every package shares one definition; re-exported for convenience.
export { requireScope, requireUser, scopesForAccount, type Actor } from "@marketplace/contracts";
