import { env } from "cloudflare:workers";
import type { ApiRequestContext } from "@marketplace/api";
import { parseRuntimeVars, type RuntimeVars } from "@marketplace/contracts";
import { createMarketplaceDeps } from "@marketplace/marketplace";

import { parseAnalyticsToken } from "../components/consent/analytics";
import { logEvent } from "../middleware/request-log";

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

let reportedInvalidToken = false;

/**
 * The public Cloudflare Web Analytics site token (`CF_WEB_ANALYTICS_TOKEN`), or null when analytics is not configured.
 * A malformed value disables analytics and is logged once per isolate by name only, never echoed, so a typo cannot
 * break pages.
 */
export function analyticsToken(): string | null {
  const { token, invalid } = parseAnalyticsToken(env.CF_WEB_ANALYTICS_TOKEN);
  if (invalid && !reportedInvalidToken) {
    reportedInvalidToken = true;
    logEvent("warn", "analytics_token_invalid", { variable: "CF_WEB_ANALYTICS_TOKEN" });
  }
  return token;
}

/** Per-request application context for pages and API routes. */
export function createRequestContext(): ApiRequestContext {
  return { vars: runtimeVars(), deps: createMarketplaceDeps({ d1: env.DB, queue: env.INGEST_QUEUE, media: env.MEDIA }) };
}
