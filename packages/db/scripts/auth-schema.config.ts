/**
 * Schema-generation-only Better Auth configuration.
 *
 * `pnpm --filter @marketplace/db auth:schema` feeds this file to the Better Auth CLI so the auth tables in
 * `src/schema/auth.ts` are generated from the exact plugin set the runtime uses, instead of being hand-copied.
 * It never runs in a Worker: no secrets, no database connection. Keep the plugin list and `additionalFields`
 * identical to the runtime auth configuration, then regenerate and run `pnpm db:generate`.
 */
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { deviceAuthorization, jwt, organization } from "better-auth/plugins";

export const auth = betterAuth({
  baseURL: "http://localhost:4321",
  emailAndPassword: { enabled: true },
  user: {
    additionalFields: {
      role: { type: "string", required: true, defaultValue: "user", input: false },
    },
  },
  plugins: [
    organization(),
    passkey(),
    deviceAuthorization(),
    jwt(),
    oauthProvider({ loginPage: "/sign-in", consentPage: "/consent" }),
  ],
});
