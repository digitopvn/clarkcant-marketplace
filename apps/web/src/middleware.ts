import { requestCarriesCredentials, resolveRequestAuth } from "@marketplace/auth";
import { ANONYMOUS_ACTOR, actorHasScope, isMarketplaceError, type Actor } from "@marketplace/contracts";
import { defineMiddleware } from "astro:middleware";

import { createWebAuthRuntime } from "./server/auth";

declare global {
  // Astro declares `App.Locals` as a global namespace; augmenting it is the only way to type `locals`.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace App {
    interface Locals {
      /** The caller of this page request. `/api/*` routes resolve their own actor inside the API. */
      actor: Actor;
    }
  }
}

const ADMIN_PREFIX = "/admin";

function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_PREFIX || pathname.startsWith(`${ADMIN_PREFIX}/`);
}

function forbiddenPage(): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Forbidden · ClarkCant Marketplace</title></head><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem"><h1>403 — Admins only</h1><p>Your account is signed in but is not on the marketplace admin allowlist.</p><p><a href="/account">Go to your account</a></p></body></html>`;
  return new Response(html, {
    status: 403,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" },
  });
}

/**
 * Resolves the page caller from the session cookie. A stale or revoked session is treated as anonymous on pages
 * (the visitor simply signs in again); the API instead answers 401 for invalid credentials.
 */
async function resolvePageActor(request: Request, waitUntil: (promise: Promise<unknown>) => void): Promise<Actor> {
  if (!requestCarriesCredentials(request)) return ANONYMOUS_ACTOR;
  try {
    const { actor } = await resolveRequestAuth(createWebAuthRuntime(request, { waitUntil }), request);
    return actor;
  } catch (error) {
    if (isMarketplaceError(error) && error.code === "unauthorized") return ANONYMOUS_ACTOR;
    throw error;
  }
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    context.locals.actor = ANONYMOUS_ACTOR;
    return next();
  }

  const actor = await resolvePageActor(context.request, (promise) => context.locals.cfContext.waitUntil(promise));
  context.locals.actor = actor;

  if (isAdminPath(pathname)) {
    if (actor.type === "anonymous") {
      return context.redirect(`/login?next=${encodeURIComponent(pathname + context.url.search)}`, 302);
    }
    if (!actorHasScope(actor, "admin")) return forbiddenPage();
  }

  const response = await next();
  if (actor.type !== "anonymous") {
    // Personalised pages must never be stored by shared caches. Some responses (e.g. `Response.redirect`) carry
    // immutable headers, so those are re-wrapped first.
    try {
      response.headers.set("cache-control", "private, no-store");
    } catch {
      const copy = new Response(response.body, response);
      copy.headers.set("cache-control", "private, no-store");
      return copy;
    }
  }
  return response;
});
