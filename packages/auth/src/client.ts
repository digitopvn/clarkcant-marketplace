import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";

/**
 * Browser client for the web app's auth islands. It talks to the same-origin `/api/auth` mount.
 *
 * `oauthProviderClient` forwards the signed OAuth query of the current page on sign-in, so signing in on `/login`
 * during an OAuth authorization continues that authorization instead of stopping at the account page.
 * Import only from browser code: this entry point must not pull in the server factory.
 */
export function createMarketplaceAuthClient() {
  return createAuthClient({ basePath: "/api/auth", plugins: [passkeyClient(), oauthProviderClient()] });
}

export type MarketplaceAuthClient = ReturnType<typeof createMarketplaceAuthClient>;
