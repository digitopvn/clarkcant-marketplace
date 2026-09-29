import { DEFAULT_SOCIAL_IMAGE, SITE_DESCRIPTION, SITE_NAME, canonicalUrl, documentTitle, markdownPathFor } from "./site";

export interface SocialImage {
  /** Absolute or site-relative URL of a raster image (PNG/JPEG/WebP). */
  url: string;
  width?: number | null | undefined;
  height?: number | null | undefined;
  type?: string | null | undefined;
  alt?: string | null | undefined;
}

export interface PageMetaInput {
  siteUrl: string;
  /** Site-relative path of the page, without query or fragment. */
  path: string;
  title: string;
  description?: string | null | undefined;
  /** Page-specific card; the site default card is used when absent. */
  image?: SocialImage | null | undefined;
  /** `article` for editorial/docs/legal pages, `website` otherwise. */
  type?: "website" | "article";
  noindex?: boolean | undefined;
  /** Whether the page has a Markdown twin at `markdownPathFor(path)`. */
  markdown?: boolean;
  locale?: string | undefined;
}

export interface PageMeta {
  title: string;
  description: string;
  canonical: string;
  /** Absolute URL of the Markdown twin, or null when the page has none. */
  markdownUrl: string | null;
  /** `noindex` robots directive, or null when the page may be indexed. */
  robots: string | null;
  image: { url: string; width: number | null; height: number | null; type: string | null; alt: string };
  /** `<meta property=… content=…>` pairs. */
  openGraph: [property: string, content: string][];
  /** `<meta name=… content=…>` pairs. */
  twitter: [name: string, content: string][];
}

const MAX_DESCRIPTION = 300;

function clampDescription(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= MAX_DESCRIPTION ? clean : `${clean.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…`;
}

/** Open Graph wants `en_US`; BCP 47 tags use a hyphen. Unknown shapes are left out rather than guessed. */
function ogLocale(locale: string | undefined): string | null {
  if (!locale) return null;
  const match = /^([a-z]{2,3})(?:-([A-Za-z]{2}))?$/.exec(locale);
  if (!match?.[1]) return null;
  return match[2] ? `${match[1]}_${match[2].toUpperCase()}` : match[1];
}

/**
 * Everything a page head needs from one input: canonical URL, Markdown alternate, robots, Open Graph and Twitter
 * card tags. Pure, so the same description can be checked in tests and reused by other renderers.
 */
export function buildPageMeta(input: PageMetaInput): PageMeta {
  const canonical = canonicalUrl(input.siteUrl, input.path);
  const description = clampDescription(input.description || SITE_DESCRIPTION);
  const title = documentTitle(input.title);
  const image = input.image
    ? {
        url: canonicalUrl(input.siteUrl, input.image.url),
        width: input.image.width ?? null,
        height: input.image.height ?? null,
        type: input.image.type ?? null,
        alt: input.image.alt || input.title,
      }
    : {
        url: canonicalUrl(input.siteUrl, DEFAULT_SOCIAL_IMAGE.path),
        width: DEFAULT_SOCIAL_IMAGE.width,
        height: DEFAULT_SOCIAL_IMAGE.height,
        type: DEFAULT_SOCIAL_IMAGE.type,
        alt: DEFAULT_SOCIAL_IMAGE.alt,
      };

  const openGraph: [string, string][] = [
    ["og:site_name", SITE_NAME],
    ["og:type", input.type ?? "website"],
    ["og:title", input.title],
    ["og:description", description],
    ["og:url", canonical],
    ["og:image", image.url],
    ["og:image:alt", image.alt],
  ];
  if (image.type) openGraph.push(["og:image:type", image.type]);
  if (image.width && image.height) {
    openGraph.push(["og:image:width", String(image.width)], ["og:image:height", String(image.height)]);
  }
  const locale = ogLocale(input.locale);
  if (locale) openGraph.push(["og:locale", locale]);

  return {
    title,
    description,
    canonical,
    markdownUrl: input.markdown === false ? null : canonicalUrl(input.siteUrl, markdownPathFor(input.path)),
    robots: input.noindex ? "noindex" : null,
    image,
    openGraph,
    twitter: [
      ["twitter:card", "summary_large_image"],
      ["twitter:title", input.title],
      ["twitter:description", description],
      ["twitter:image", image.url],
      ["twitter:image:alt", image.alt],
    ],
  };
}
