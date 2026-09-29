/**
 * Cookie consent state, shared by the server (banner visibility), the banner script and the theme toggle.
 *
 * The site sets no cookie and stores nothing for a signed-out visitor until they choose. The only optional storage
 * today is the theme preference (`theme` in localStorage, the "preferences" category). No analytics or advertising
 * runs; if that ever changes it needs its own category here and a new policy version.
 *
 * Cookie value: `v1.p1` (preferences allowed) or `v1.p0` (essential only).
 */

export const CONSENT_COOKIE = "cc_consent";
export const CONSENT_VERSION = "v1";
/** 180 days: long enough not to nag, short enough that choices are re-confirmed twice a year. */
export const CONSENT_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
/** Dispatched on `document` after the visitor saves a choice. `detail` is the new {@link ConsentState}. */
export const CONSENT_EVENT = "cc:consent-change";
/** The localStorage key gated by the preferences category. */
export const THEME_STORAGE_KEY = "theme";

export interface ConsentState {
  preferences: boolean;
}

const VALUE = /^v1\.p([01])$/;

export function parseConsent(value: string | null | undefined): ConsentState | null {
  const match = value ? VALUE.exec(value.trim()) : null;
  return match ? { preferences: match[1] === "1" } : null;
}

export function serializeConsent(state: ConsentState): string {
  return `${CONSENT_VERSION}.p${state.preferences ? "1" : "0"}`;
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
