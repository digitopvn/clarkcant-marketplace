import type { Category, CollectionDetail, PackageDetail, PackageSummary } from "@marketplace/contracts";

import { BRAND_URL, SITE_NAME, canonicalUrl, packagePath } from "./site";

/**
 * JSON-LD builders over canonical data (package rows, categories, collections, published page documents). Nothing
 * here is hand-authored schema copy: every value comes from the same record the HTML and Markdown render. Block
 * level data (FAQPage from FAQ blocks, ItemList from package blocks, publisher Organization/Person) is produced by
 * the page engine's blocks and validated with the same `validateJsonLd`.
 */
export type JsonLd = Record<string, unknown>;

const CONTEXT = "https://schema.org";

const PLATFORM_NAMES: Record<string, string> = {
  "darwin-arm64": "macOS (Apple silicon)",
  "linux-x64": "Linux (x64)",
  "win32-x64": "Windows (x64)",
  web: "Web",
};

/** SPDX identifiers link to the SPDX licence page; anything else (e.g. `SEE LICENSE IN …`) stays plain text. */
function licenseValue(license: string): string {
  return /^[A-Za-z0-9.+-]+$/.test(license) ? `https://spdx.org/licenses/${license}.html` : license;
}

export function organizationJsonLd(): JsonLd {
  return { "@context": CONTEXT, "@type": "Organization", name: "ClarkCant", url: BRAND_URL };
}

/** The marketplace itself, with the package search as a SearchAction. */
export function webSiteJsonLd(siteUrl: string): JsonLd {
  return {
    "@context": CONTEXT,
    "@type": "WebSite",
    name: SITE_NAME,
    url: canonicalUrl(siteUrl, "/"),
    publisher: { "@type": "Organization", name: "ClarkCant", url: BRAND_URL },
    potentialAction: {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: `${canonicalUrl(siteUrl, "/packages")}?q={search_term_string}` },
      "query-input": "required name=search_term_string",
    },
  };
}

export interface Crumb {
  name: string;
  path: string;
}

export function breadcrumbJsonLd(siteUrl: string, crumbs: readonly Crumb[]): JsonLd {
  return {
    "@context": CONTEXT,
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: canonicalUrl(siteUrl, crumb.path),
    })),
  };
}

/** A package as SoftwareSourceCode that targets ClarkCant, with the installable unit as its SoftwareApplication. */
export function packageJsonLd(siteUrl: string, pkg: PackageDetail): JsonLd {
  const url = canonicalUrl(siteUrl, packagePath(pkg.name));
  const platforms = (pkg.latest?.platforms ?? []).map((platform) => PLATFORM_NAMES[platform] ?? platform);
  const application: JsonLd = {
    "@type": "SoftwareApplication",
    name: pkg.displayName,
    applicationCategory: "ClarkCant package",
    ...(pkg.latestVersion ? { softwareVersion: pkg.latestVersion } : {}),
    ...(platforms.length > 0 ? { operatingSystem: platforms.join(", ") } : {}),
  };
  return {
    "@context": CONTEXT,
    "@type": "SoftwareSourceCode",
    name: pkg.displayName,
    alternateName: pkg.name,
    url,
    ...(pkg.description ? { description: pkg.description } : {}),
    ...(pkg.latestVersion ? { version: pkg.latestVersion } : {}),
    ...(pkg.repositoryUrl ? { codeRepository: pkg.repositoryUrl } : {}),
    ...(pkg.license ? { license: licenseValue(pkg.license) } : {}),
    ...(pkg.keywords.length > 0 ? { keywords: pkg.keywords.join(", ") } : {}),
    ...(pkg.latest?.publishedAt ? { datePublished: pkg.latest.publishedAt } : {}),
    dateModified: pkg.updatedAt,
    sameAs: [`https://www.npmjs.com/package/${pkg.name}`],
    runtimePlatform: "ClarkCant",
    targetProduct: application,
    ...(pkg.publisher ? { publisher: { "@type": "Organization", name: pkg.publisher.name } } : {}),
  };
}

export interface ListEntry {
  name: string;
  path: string;
}

export function itemListJsonLd(siteUrl: string, name: string, entries: readonly ListEntry[]): JsonLd {
  return {
    "@context": CONTEXT,
    "@type": "ItemList",
    name,
    numberOfItems: entries.length,
    itemListElement: entries.map((entry, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: entry.name,
      url: canonicalUrl(siteUrl, entry.path),
    })),
  };
}

export function packageListEntries(packages: readonly PackageSummary[]): ListEntry[] {
  return packages.map((pkg) => ({ name: pkg.displayName, path: packagePath(pkg.name) }));
}

export function categoryJsonLd(siteUrl: string, category: Category, packages: readonly PackageSummary[]): JsonLd {
  return itemListJsonLd(siteUrl, `${category.name} packages`, packageListEntries(packages));
}

export function collectionJsonLd(siteUrl: string, collection: CollectionDetail): JsonLd {
  return itemListJsonLd(siteUrl, collection.title, packageListEntries(collection.packages));
}

export interface ArticleInput {
  title: string;
  description?: string | undefined;
  path: string;
  /** ISO timestamp of the live revision. */
  dateModified: string;
  locale?: string | undefined;
}

/** Docs and legal pages are technical articles published by the marketplace operator. */
export function techArticleJsonLd(siteUrl: string, article: ArticleInput): JsonLd {
  return {
    "@context": CONTEXT,
    "@type": "TechArticle",
    headline: article.title.length > 110 ? `${article.title.slice(0, 109)}…` : article.title,
    ...(article.description ? { description: article.description } : {}),
    url: canonicalUrl(siteUrl, article.path),
    dateModified: article.dateModified,
    ...(article.locale ? { inLanguage: article.locale } : {}),
    publisher: { "@type": "Organization", name: "ClarkCant", url: BRAND_URL },
  };
}
