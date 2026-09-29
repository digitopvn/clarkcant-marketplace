import type { AuthRuntime } from "@marketplace/auth";
import type { Actor, RuntimeVars } from "@marketplace/contracts";
import type { MarketplaceDeps } from "@marketplace/marketplace";

/** What every `/api/v1/*` handler can reach: application services' deps plus validated runtime vars. */
export interface ApiRequestContext {
  deps: MarketplaceDeps;
  vars: RuntimeVars;
}

/**
 * Hono context variables. Auth middleware extends this with the resolved actor; keep additions here so every
 * router sees one definition.
 */
export interface ApiVariables {
  requestId: string;
  context: ApiRequestContext;
  /** Resolved by the actor middleware for every `/api/v1/*` request; `ANONYMOUS_ACTOR` when no credential is sent. */
  actor: Actor;
}

export interface ApiEnv {
  Variables: ApiVariables;
}

export interface CreateApiOptions {
  /**
   * Builds the per-request context. Called once per `/api/v1/*` request, never at module load, so bindings are
   * always the current invocation's. Throwing a `MarketplaceError("configuration_error")` here yields a 500 with
   * that code rather than a crash.
   */
  resolveContext(request: Request): ApiRequestContext | Promise<ApiRequestContext>;
  /**
   * Builds the per-request auth runtime (Better Auth + admin policy) used to resolve `c.var.actor`. Called only
   * for requests that carry a credential. Hosts without auth omit it, and every caller is then anonymous.
   */
  resolveAuth?(request: Request, context: ApiRequestContext): AuthRuntime | Promise<AuthRuntime>;
  /** Reported in the OpenAPI document. */
  version?: string;
}
