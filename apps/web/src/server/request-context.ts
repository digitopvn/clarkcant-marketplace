import { env } from "cloudflare:workers";
import type { ApiRequestContext } from "@marketplace/api";
import { parseRuntimeVars, type RuntimeVars } from "@marketplace/contracts";
import { createMarketplaceDeps } from "@marketplace/marketplace";

/**
 * Runtime variables, validated at request time so a misconfigured deployment fails with a `configuration_error`
 * naming the variable instead of misbehaving.
 */
export function runtimeVars(): RuntimeVars {
  return parseRuntimeVars({
    PUBLIC_SITE_URL: env.PUBLIC_SITE_URL,
    ENVIRONMENT: env.ENVIRONMENT,
    ADMIN_EMAILS: env.ADMIN_EMAILS,
  });
}

/** Per-request application context for pages and API routes. */
export function createRequestContext(): ApiRequestContext {
  return { vars: runtimeVars(), deps: createMarketplaceDeps({ d1: env.DB, queue: env.INGEST_QUEUE, media: env.MEDIA }) };
}
