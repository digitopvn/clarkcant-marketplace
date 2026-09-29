import { absoluteUrl, packagePath } from "@marketplace/page-engine";

import { categoryPath, collectionPath, markdownPathFor } from "./paths";

/**
 * Site-wide naming and URL rules shared by every machine-readable surface (meta tags, JSON-LD, sitemaps, llms.txt,
 * Markdown twins, share targets), so a page is described by the same canonical URL everywhere.
 */
export const SITE_NAME = "ClarkCant Marketplace";
export const SITE_DESCRIPTION = "Discover and curate ClarkCant packages distributed through npm.";
/** The public brand site of the product the marketplace serves. */
export const BRAND_URL = "https://clarkcant.cc";

/** Site default social card (PNG, served from `apps/web/public`), used when a page has no card of its own. */
export const DEFAULT_SOCIAL_IMAGE = { path: "/og-default.png", width: 1200, height: 630, type: "image/png", alt: SITE_NAME } as const;

/** `https://host/` becomes `https://host`; the site origin is always handled without a trailing slash. */
export function normalizeSiteUrl(siteUrl: string): string {
  return siteUrl.replace(/\/+$/, "");
}

/** Absolute canonical URL for a site-relative path. */
export function canonicalUrl(siteUrl: string, path: string): string {
  return absoluteUrl(normalizeSiteUrl(siteUrl), path);
}

/** Full document title: page title plus the site name, unless the page is the site itself. */
export function documentTitle(title: string): string {
  return title === SITE_NAME ? title : `${title} · ${SITE_NAME}`;
}

export { categoryPath, collectionPath, markdownPathFor, packagePath };
