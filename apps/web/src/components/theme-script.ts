/*
 * Applies a stored theme before first paint, but only when the visitor allowed preference storage (cookie
 * `cc_consent=v2.p1.a<0|1>`, see components/consent/consent.ts); otherwise the system preference applies.
 * Rendered inline by BaseLayout and allowed by hash in astro.config.ts, so keep it a fixed string.
 */
export const THEME_SCRIPT = `(() => {
  try {
    if (!/(?:^|;\\s*)cc_consent=v2\\.p1\\.a[01](?:;|$)/.test(document.cookie)) return;
    const theme = localStorage.getItem("theme");
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  } catch {
    /* Storage can be unavailable (privacy modes); the system preference applies. */
  }
})();`;
