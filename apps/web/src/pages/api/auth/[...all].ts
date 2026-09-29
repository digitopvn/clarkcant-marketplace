import { isMarketplaceError, type ErrorBody } from "@marketplace/contracts";
import type { APIRoute } from "astro";

import { createWebAuthRuntime } from "../../../server/auth";

export const prerender = false;

/**
 * Better Auth endpoints (`/api/auth/*`): sign-in/up, sessions, passkeys, device authorization, OAuth 2.1/OIDC.
 * A fresh instance per request keeps the D1 binding and `waitUntil` scoped to this invocation. Invalid runtime
 * configuration (for example a missing BETTER_AUTH_SECRET) answers with the API error body naming the variable.
 */
export const ALL: APIRoute = async ({ request, locals }) => {
  let runtime;
  try {
    runtime = createWebAuthRuntime(request, { waitUntil: (promise) => locals.cfContext.waitUntil(promise) });
  } catch (error) {
    if (!isMarketplaceError(error)) throw error;
    const body: ErrorBody = {
      error: { code: error.code, message: error.message, requestId: crypto.randomUUID(), details: error.details },
    };
    return Response.json(body, { status: error.status, headers: { "cache-control": "no-store" } });
  }
  return runtime.auth.handler(request);
};
