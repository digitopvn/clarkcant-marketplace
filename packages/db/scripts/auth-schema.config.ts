/**
 * Schema-generation-only Better Auth configuration.
 *
 * `pnpm --filter @marketplace/db auth:schema` feeds this file to the Better Auth CLI so the auth tables in
 * `src/schema/auth.ts` are generated from the exact plugin set the runtime uses, instead of being hand-copied.
 * It never runs in a Worker: no secrets, no database connection. Keep the plugin list and `additionalFields`
 * identical to the runtime auth configuration (`packages/auth/src/create-auth.ts`), then regenerate and run `pnpm db:generate`.
 */
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { bearer, deviceAuthorization, jwt, organization } from "better-auth/plugins";

export const auth = betterAuth({
  baseURL: "http://localhost:4321",
  emailAndPassword: { enabled: true },
  // Runtime rate limits are stored in D1 (`rate_limit`) so they hold across isolates.
  rateLimit: { enabled: true, storage: "database" },
  user: {
    additionalFields: {
      role: { type: "string", required: true, defaultValue: "user", input: false },
    },
  },
  plugins: [
    organization(),
    passkey(),
    deviceAuthorization(),
    bearer(),
    jwt(),
    oauthProvider({ loginPage: "/login", consentPage: "/oauth/consent" }),
  ],
});
