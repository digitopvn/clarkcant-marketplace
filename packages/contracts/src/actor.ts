import { z } from "zod";

import type { AuditActor } from "./audit";
import { MarketplaceError } from "./errors";
import { API_SCOPES, PUBLIC_SCOPES, apiScopeSchema, hasScope, type ApiScope } from "./scopes";

/**
 * Who is making a request, resolved once per request by the interface (web middleware, API middleware, MCP) and
 * passed to application services. Services authorize with `requireScope`/`requireUser`; they never read cookies
 * or headers themselves.
 *
 * - `anonymous`: no credential; holds only `PUBLIC_SCOPES`.
 * - `user`: a Better Auth session (browser cookie, or a session token sent as `Authorization: Bearer`).
 * - `token`: a personal API token (`cmk_…`) or an OAuth access token; scopes are the token's grant intersected with
 *   what the owning account may do right now, so demoting an account also narrows its tokens.
 */
export const actorTypeValues = ["anonymous", "user", "token"] as const;

export const actorSchema = z.object({
  type: z.enum(actorTypeValues),
  /** Owning account; absent only for `anonymous`. */
  userId: z.string().min(1).optional(),
  /** Credential id for `token` actors: an API token id (`tok_…`) or `oauth:<clientId>`. */
  tokenId: z.string().min(1).optional(),
  scopes: z.array(apiScopeSchema),
});
export type Actor = z.infer<typeof actorSchema>;

export const ANONYMOUS_ACTOR: Actor = Object.freeze({ type: "anonymous", scopes: [...PUBLIC_SCOPES] }) as Actor;

/** Scopes a signed-in account holds. Admins (from the `ADMIN_EMAILS` allowlist) hold every scope. */
export const USER_SCOPES: readonly ApiScope[] = [
  ...PUBLIC_SCOPES,
  "packages:submit",
  "publishers:write",
  "account:read",
  "account:write",
  "devices:link",
];

export function scopesForAccount(isAdmin: boolean): ApiScope[] {
  return isAdmin ? [...API_SCOPES] : [...USER_SCOPES];
}

export function actorHasScope(actor: Actor, scope: ApiScope): boolean {
  return hasScope(actor.scopes, scope);
}

/**
 * Throws unless the actor holds `scope`: `unauthorized` (401) for an anonymous caller, who could succeed by signing
 * in, and `forbidden` (403) for an authenticated caller who lacks it.
 */
export function requireScope(actor: Actor, scope: ApiScope): void {
  if (actorHasScope(actor, scope)) return;
  if (actor.type === "anonymous") {
    throw new MarketplaceError("unauthorized", "Sign in or send an API token to do this", {
      details: { requiredScope: scope },
    });
  }
  throw new MarketplaceError("forbidden", `This credential lacks the "${scope}" scope`, {
    details: { requiredScope: scope },
  });
}

/** Returns the acting account id, or throws `unauthorized` for an anonymous caller. */
export function requireUser(actor: Actor): string {
  if (actor.type === "anonymous" || actor.userId === undefined) {
    throw new MarketplaceError("unauthorized", "Sign in or send an API token to do this");
  }
  return actor.userId;
}

/** How an authenticated actor appears in the audit log. Token actors are recorded by credential id. */
export function toAuditActor(actor: Actor): AuditActor {
  const userId = requireUser(actor);
  if (actor.type === "token" && actor.tokenId !== undefined) return { type: "token", id: actor.tokenId };
  return { type: "user", id: userId };
}
