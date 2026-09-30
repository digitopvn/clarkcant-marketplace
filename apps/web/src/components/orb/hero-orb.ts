/**
 * The home hero's Orb. A fixed string because the page engine places it beside the builder's hero (as host markup,
 * never taken from a page document) and the built-in landing uses the same markup. `mount-orb.ts` draws it; CSS
 * paints a static Orb when WebGL is missing. Decorative: the headline beside it carries the meaning.
 */
export const HERO_ORB_HTML = '<div class="orb orb--hero" aria-hidden="true"><canvas data-orb></canvas></div>';
