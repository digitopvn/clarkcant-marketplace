/**
 * Cookie consent state, shared by the server (banner visibility), the banner script, the theme toggle and the
 * analytics loader.
 *
 * The site sets no cookie and stores nothing for a signed-out visitor until they choose. Optional categories, both off
 * by default:
 * - preferences: the theme preference (`theme` in localStorage);
 * - analytics: Cloudflare Web Analytics (cookieless, page views and load timing), loaded only after opt-in (see analytics.ts).
 * Any further category needs its own flag here and a new policy version.
 *
 * Cookie value: `v2.p<0|1>.a<0|1>`, e.g. `v2.p1.a0` (preferences allowed, analytics declined). A `v1` value predates
 * the analytics category, so it is treated as no choice and the visitor is asked again.
 */

export const CONSENT_COOKIE = "cc_consent";
export const CONSENT_VERSION = "v2";
/** 180 days: long enough not to nag, short enough that choices are re-confirmed twice a year. */
export const CONSENT_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
/** Dispatched on `document` after the visitor saves a choice. `detail` is the new {@link ConsentState}. */
export const CONSENT_EVENT = "cc:consent-change";
/** The localStorage key gated by the preferences category. */
export const THEME_STORAGE_KEY = "theme";

export interface ConsentState {
  preferences: boolean;
  analytics: boolean;
}

/** The state before any choice and after "Essential only". */
export const ESSENTIAL_ONLY: Readonly<ConsentState> = { preferences: false, analytics: false };

const VALUE = /^v2\.p([01])\.a([01])$/;

export function parseConsent(value: string | null | undefined): ConsentState | null {
  const match = value ? VALUE.exec(value.trim()) : null;
  return match ? { preferences: match[1] === "1", analytics: match[2] === "1" } : null;
}

export function serializeConsent(state: ConsentState): string {
  return `${CONSENT_VERSION}.p${state.preferences ? "1" : "0"}.a${state.analytics ? "1" : "0"}`;
}

/** Reads the consent cookie out of a `Cookie` header or `document.cookie`. */
export function consentFromCookieHeader(header: string | null | undefined): ConsentState | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === CONSENT_COOKIE) return parseConsent(rest.join("="));
  }
  return null;
}

/** A `document.cookie` assignment string for the given choice. */
export function consentCookieString(state: ConsentState, secure: boolean): string {
  return [
    `${CONSENT_COOKIE}=${serializeConsent(state)}`,
    "Path=/",
    `Max-Age=${CONSENT_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** Browser only: whether the visitor has allowed preference storage. */
export function preferencesAllowed(): boolean {
  if (typeof document === "undefined") return false;
  return consentFromCookieHeader(document.cookie)?.preferences === true;
}
