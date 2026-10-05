import type { ConsentState } from "./consent";

/**
 * Cloudflare Web Analytics, the only third-party script the site loads, and only after the visitor opts in to the
 * analytics category. It is cookieless and counts page views and page load timing. The beacon is loaded from {@link CF_BEACON_ORIGIN} and
 * reports to {@link CF_REPORT_ORIGIN}; both are allowed in the CSP (astro.config.ts) and nothing else is.
 *
 * The site token is public (it ships in every page that loads the beacon) and comes from the `CF_WEB_ANALYTICS_TOKEN`
 * wrangler var of each environment. Without a valid token nothing is rendered and nothing loads.
 */

export const CF_BEACON_ORIGIN = "https://static.cloudflareinsights.com";
export const CF_REPORT_ORIGIN = "https://cloudflareinsights.com";
export const CF_BEACON_SRC = `${CF_BEACON_ORIGIN}/beacon.min.js`;

/** Cloudflare site tokens are 32 hex characters; accept a little more so a format change does not silently disable it. */
const TOKEN = /^[A-Za-z0-9]{16,128}$/;

export type AnalyticsTokenResult = { token: string | null; invalid: boolean };

/** Validates the configured token. Empty or missing means analytics is off; anything malformed is reported, not used. */
export function parseAnalyticsToken(raw: unknown): AnalyticsTokenResult {
  if (typeof raw !== "string" || raw.trim() === "") return { token: null, invalid: false };
  const token = raw.trim();
  return TOKEN.test(token) ? { token, invalid: false } : { token: null, invalid: true };
}

/** The `data-cf-beacon` attribute value for a token. */
export function beaconConfig(token: string): string {
  return JSON.stringify({ token });
}

/** Whether this page view should load the beacon: a token is configured and the visitor allowed analytics. */
export function shouldLoadBeacon(consent: ConsentState | null, token: string | null | undefined): token is string {
  return consent?.analytics === true && typeof token === "string" && TOKEN.test(token);
}
