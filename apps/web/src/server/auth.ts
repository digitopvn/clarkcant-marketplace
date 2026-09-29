import { env } from "cloudflare:workers";
import type { ApiRequestContext } from "@marketplace/api";
import { createAuthRuntime, parseAuthSecrets, type AuthRuntime } from "@marketplace/auth";

import { createRequestContext } from "./request-context";

/**
 * Auth secrets are wrangler secrets (deployed) or `.dev.vars` entries (local), so the generated `Env` type does not
 * list them; they are read by name here and validated by `parseAuthSecrets`.
 */
function authSecrets(): Record<string, unknown> {
  const source = env as unknown as Record<string, unknown>;
  return {
    BETTER_AUTH_SECRET: source.BETTER_AUTH_SECRET,
    GITHUB_CLIENT_ID: source.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: source.GITHUB_CLIENT_SECRET,
  };
}

/** Per-request Better Auth runtime. `context` is reused when the caller already built one (the API does). */
export function createWebAuthRuntime(
  request: Request,
  options: { context?: ApiRequestContext; waitUntil?: (promise: Promise<unknown>) => void } = {},
): AuthRuntime {
  const { deps, vars } = options.context ?? createRequestContext();
  return createAuthRuntime({ deps, vars, secrets: authSecrets(), request, waitUntil: options.waitUntil });
}

/** GitHub sign-in is offered only when both GitHub secrets are configured. */
export function isGithubSignInEnabled(): boolean {
  return parseAuthSecrets(authSecrets()).github !== null;
}
