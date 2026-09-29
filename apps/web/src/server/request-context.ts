import { env } from "cloudflare:workers";
import type { ApiRequestContext } from "@marketplace/api";
import { parseRuntimeVars } from "@marketplace/contracts";
import { createMarketplaceDeps } from "@marketplace/marketplace";

/**
 * Per-request application context for pages and API routes. Runtime variables are validated here, at request time,
 * so a misconfigured deployment fails with a `configuration_error` naming the variable instead of misbehaving.
 */
export function createRequestContext(): ApiRequestContext {
  const vars = parseRuntimeVars({
    PUBLIC_SITE_URL: env.PUBLIC_SITE_URL,
    ENVIRONMENT: env.ENVIRONMENT,
    ADMIN_EMAILS: env.ADMIN_EMAILS,
  });
  return { vars, deps: createMarketplaceDeps({ d1: env.DB, queue: env.INGEST_QUEUE, media: env.MEDIA }) };
}
