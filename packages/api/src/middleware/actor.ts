import { assertSameOriginMutation, requestCarriesCredentials, resolveRequestAuth } from "@marketplace/auth";
import { ANONYMOUS_ACTOR } from "@marketplace/contracts";
import { createMiddleware } from "hono/factory";

import type { ApiEnv, CreateApiOptions } from "../types";

/**
 * Sets `c.var.actor` for every `/api/v1/*` request and enforces CSRF protection for cookie-authenticated
 * mutations. Requests without any credential skip Better Auth entirely and act as `ANONYMOUS_ACTOR`. Invalid
 * bearer credentials fail with 401 here, before any handler runs; authorization (scopes) stays in the services.
 */
export function actorMiddleware(options: Pick<CreateApiOptions, "resolveAuth">) {
  return createMiddleware<ApiEnv>(async (c, next) => {
    const request = c.req.raw;
    if (!options.resolveAuth || !requestCarriesCredentials(request)) {
      c.set("actor", ANONYMOUS_ACTOR);
      return next();
    }
    const runtime = await options.resolveAuth(request, c.var.context);
    const { actor, credential } = await resolveRequestAuth(runtime, request);
    assertSameOriginMutation(request, credential, runtime.origin);
    c.set("actor", actor);
    // Personalised responses must never be stored by shared caches.
    c.header("Cache-Control", "private, no-store");
    c.header("Vary", "Authorization, Cookie", { append: true });
    return next();
  });
}
