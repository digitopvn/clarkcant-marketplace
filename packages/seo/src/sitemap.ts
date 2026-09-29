/**
 * XML sitemaps (sitemaps.org 0.9). The site publishes a sitemap index at `/sitemap.xml` that points at segment
 * files (`/sitemap-pages.xml`, `/sitemap-packages-1.xml`, …), so each segment stays well below the protocol's
 * 50,000 URL / 50 MB limits as the catalogue grows.
 */
export const SITEMAP_PROTOCOL_MAX_URLS = 50_000;
/** URLs per package segment; far below the protocol cap so a segment renders from one bounded query. */
export const PACKAGES_PER_SITEMAP = 5_000;

export interface SitemapUrl {
  loc: string;
  /** ISO timestamp or date; emitted as `YYYY-MM-DD` (W3C date) for stable output. */
  lastmod?: string | null | undefined;
}

export interface SitemapRef {
  loc: string;
  lastmod?: string | null | undefined;
}

export type SitemapSegment = { kind: "pages" } | { kind: "categories" } | { kind: "collections" } | { kind: "packages"; page: number };

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);
}

function w3cDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function entry(tag: "url" | "sitemap", item: SitemapUrl): string {
  const lastmod = w3cDate(item.lastmod);
  return `<${tag}><loc>${escapeXml(item.loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</${tag}>`;
}

export function renderUrlset(urls: readonly SitemapUrl[]): string {
  if (urls.length > SITEMAP_PROTOCOL_MAX_URLS) {
    throw new RangeError(`a sitemap holds at most ${SITEMAP_PROTOCOL_MAX_URLS} URLs, got ${urls.length}`);
  }
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    ...urls.map((url) => entry("url", url)),
    `</urlset>`,
    "",
  ].join("\n");
}

export function renderSitemapIndex(sitemaps: readonly SitemapRef[]): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    ...sitemaps.map((sitemap) => entry("sitemap", sitemap)),
    `</sitemapindex>`,
    "",
  ].join("\n");
}

export function sitemapSegmentPath(segment: SitemapSegment): string {
  return segment.kind === "packages" ? `/sitemap-packages-${segment.page}.xml` : `/sitemap-${segment.kind}.xml`;
}

/** Parses the `<segment>` of `/sitemap-<segment>.xml`; null for anything the site does not publish. */
export function parseSitemapSegment(value: string): SitemapSegment | null {
  if (value === "pages" || value === "categories" || value === "collections") return { kind: value };
  const match = /^packages-([1-9][0-9]{0,5})$/.exec(value);
  return match?.[1] ? { kind: "packages", page: Number(match[1]) } : null;
}

/** Segments for a catalogue of `packageCount` public packages (always at least one package segment). */
export function sitemapSegments(packageCount: number): SitemapSegment[] {
  const packagePages = Math.max(1, Math.ceil(packageCount / PACKAGES_PER_SITEMAP));
  return [
    { kind: "pages" },
    { kind: "categories" },
    { kind: "collections" },
    ...Array.from({ length: packagePages }, (_, index) => ({ kind: "packages" as const, page: index + 1 })),
  ];
}
