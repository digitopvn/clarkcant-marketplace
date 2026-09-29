import type { RuntimeVars } from "@marketplace/contracts";
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
  /** Reported in the OpenAPI document. */
  version?: string;
}
