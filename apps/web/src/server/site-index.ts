import {
  PACKAGES_PER_SITEMAP,
  SITE_DESCRIPTION,
  SITE_NAME,
  canonicalUrl,
  categoryPath,
  collectionPath,
  markdownPathFor,
  packagePath,
  renderLlmsFullTxt,
  renderLlmsTxt,
  renderUrlset,
  sitemapSegmentPath,
  sitemapSegments,
  type LlmsDocument,
  type LlmsLink,
  type SitemapSegment,
  type SitemapUrl,
} from "@marketplace/seo";
import {
  countPublicPackages,
  listCategories,
  listFeaturedPackages,
  listLatestPackages,
  listPublicPackageIndex,
  listPublishedCollectionIndex,
  listPublishedPages,
  renderPageDocument,
  type MarketplaceDeps,
  type PublishedPageEntry,
} from "@marketplace/marketplace";

/*
 * Site-wide machine-readable indexes: sitemaps and llms.txt. They list only public, indexable resources: published
 * pages without `noindex`, categories with listed packages, published collections and public packages that have
 * an indexed version.
 */

/** Built-in HTML routes that are always public. */
const STATIC_PATHS = ["/packages", "/collections"] as const;

/** Upper bound for llms-full.txt, so one request never renders an unbounded number of pages. */
const LLMS_FULL_MAX_PAGES = 50;

/** One-line meaning of the trust labels, repeated wherever agents read the catalogue. */
export const TRUST_NOTES = [
  "Curation: \"listed\" means a package passed automated checks (manifest, integrity) when indexed and was not reviewed by a person; \"featured\" means marketplace curators chose it. Hidden and rejected packages are not published anywhere.",
  "A \"verified\" publisher proved control of a web domain with a DNS TXT record; it says nothing about code quality. npm provenance is recorded when present, not verified by the marketplace.",
  "Every public HTML page has a Markdown twin at the same path plus `.md` (the home page: `/index.md`).",
];

function indexablePages(pages: readonly PublishedPageEntry[]): PublishedPageEntry[] {
  return pages.filter((page) => !page.document.meta.noindex);
}

async function sitemapUrls(deps: MarketplaceDeps, siteUrl: string, segment: SitemapSegment): Promise<SitemapUrl[]> {
  switch (segment.kind) {
    case "pages": {
      const pages = indexablePages(await listPublishedPages(deps));
      const urls: SitemapUrl[] = [];
      if (!pages.some((page) => page.path === "/")) urls.push({ loc: canonicalUrl(siteUrl, "/") });
      for (const path of STATIC_PATHS) urls.push({ loc: canonicalUrl(siteUrl, path) });
      for (const page of pages) urls.push({ loc: canonicalUrl(siteUrl, page.path), lastmod: page.publishedAt });
      return urls;
    }
    case "categories":
      return (await listCategories(deps))
        .filter((category) => category.packageCount > 0)
        .map((category) => ({ loc: canonicalUrl(siteUrl, categoryPath(category.slug)) }));
    case "collections":
      return (await listPublishedCollectionIndex(deps)).map((collection) => ({
        loc: canonicalUrl(siteUrl, collectionPath(collection.slug)),
        lastmod: collection.updatedAt,
      }));
    case "packages": {
      const entries = await listPublicPackageIndex(deps, { offset: (segment.page - 1) * PACKAGES_PER_SITEMAP, limit: PACKAGES_PER_SITEMAP });
      return entries.map((entry) => ({ loc: canonicalUrl(siteUrl, packagePath(entry.name)), lastmod: entry.updatedAt }));
    }
  }
}

/** The segments listed in `/sitemap.xml`. */
export async function listSitemapSegments(deps: MarketplaceDeps, siteUrl: string): Promise<{ loc: string }[]> {
  const segments = sitemapSegments(await countPublicPackages(deps));
  return segments.map((segment) => ({ loc: canonicalUrl(siteUrl, sitemapSegmentPath(segment)) }));
}

/** A segment's urlset, or null for a package segment past the end of the catalogue. */
export async function renderSitemapSegment(deps: MarketplaceDeps, siteUrl: string, segment: SitemapSegment): Promise<string | null> {
  if (segment.kind === "packages") {
    const pages = Math.max(1, Math.ceil((await countPublicPackages(deps)) / PACKAGES_PER_SITEMAP));
    if (segment.page > pages) return null;
  }
  return renderUrlset(await sitemapUrls(deps, siteUrl, segment));
}

function twin(siteUrl: string, path: string): string {
  return canonicalUrl(siteUrl, markdownPathFor(path));
}

export async function buildLlmsTxt(deps: MarketplaceDeps, siteUrl: string): Promise<string> {
  const [pages, collections, categories, featured, latest] = await Promise.all([
    listPublishedPages(deps).then(indexablePages),
    listPublishedCollectionIndex(deps),
    listCategories(deps),
    listFeaturedPackages(deps, 12),
    listLatestPackages(deps, 12),
  ]);
  const pageLink = (page: PublishedPageEntry): LlmsLink => ({
    title: page.document.meta.title,
    url: twin(siteUrl, page.path),
    description: page.document.meta.description,
  });
  const packageLink = (pkg: { name: string; displayName: string; description: string }): LlmsLink => ({
    title: `${pkg.displayName} (${pkg.name})`,
    url: twin(siteUrl, packagePath(pkg.name)),
    description: pkg.description,
  });
  const featuredNames = new Set(featured.map((pkg) => pkg.name));

  return renderLlmsTxt({
    title: SITE_NAME,
    summary: `${SITE_DESCRIPTION} The marketplace discovers and curates, npm distributes, and the ClarkCant app installs and runs packages after reviewing their permissions.`,
    details: TRUST_NOTES,
    sections: [
      {
        title: "Start here",
        links: [
          { title: "Home", url: twin(siteUrl, "/"), description: "What the marketplace lists and how installing works" },
          { title: "HTTP API (OpenAPI 3.1)", url: canonicalUrl(siteUrl, "/openapi.json"), description: "Search, package details, install coordinates" },
          ...pages.filter((page) => page.kind !== "legal" && page.path !== "/").map(pageLink),
        ],
      },
      {
        title: "Categories",
        links: categories
          .filter((category) => category.packageCount > 0)
          .map((category) => ({ title: category.name, url: twin(siteUrl, categoryPath(category.slug)), description: category.description })),
      },
      {
        title: "Collections",
        links: collections.map((collection) => ({ title: collection.title, url: twin(siteUrl, collectionPath(collection.slug)), description: collection.description })),
      },
      { title: "Featured packages", links: featured.map(packageLink) },
      { title: "Recently updated packages", links: latest.filter((pkg) => !featuredNames.has(pkg.name)).map(packageLink) },
      { title: "Policies", links: pages.filter((page) => page.kind === "legal").map(pageLink) },
      {
        title: "Optional",
        links: [
          { title: "Full text of the site's own pages", url: canonicalUrl(siteUrl, "/llms-full.txt") },
          { title: "Sitemap", url: canonicalUrl(siteUrl, "/sitemap.xml"), description: "Every public package and page" },
        ],
      },
    ],
  });
}

/**
 * The marketplace's own pages inlined as Markdown. Package descriptions and READMEs are third-party text and are
 * deliberately left out; agents follow the package twins listed in llms.txt instead.
 */
export async function buildLlmsFullTxt(deps: MarketplaceDeps, siteUrl: string): Promise<string> {
  const pages = indexablePages(await listPublishedPages(deps)).slice(0, LLMS_FULL_MAX_PAGES);
  const documents: LlmsDocument[] = [];
  for (const page of pages) {
    const rendered = await renderPageDocument(deps, page.document, { mode: "public", siteUrl, path: page.path });
    documents.push({ title: page.document.meta.title, url: canonicalUrl(siteUrl, page.path), markdown: rendered.markdown });
  }
  return renderLlmsFullTxt({ title: SITE_NAME, summary: SITE_DESCRIPTION, details: TRUST_NOTES, documents });
}
