import type {
  Category,
  CollectionDetail,
  CollectionSummary,
  PackageDetail,
  PackagePreview,
  PackageSummary,
} from "@marketplace/contracts";
import {
  breadcrumbJsonLd,
  categoryJsonLd,
  categoryPath,
  collectionJsonLd,
  collectionPath,
  itemListJsonLd,
  packageJsonLd,
  packageListEntries,
  packagePath,
  type SocialImage,
} from "@marketplace/seo";

import type { SeoProps } from "../layouts/BaseLayout.astro";

/*
 * Head descriptions for catalogue pages, kept out of the page templates so each page only passes one `seo` prop.
 */

/** Link unfurlers (Slack, X, LinkedIn, iMessage) do not render SVG cards; only raster cards are advertised. */
const RASTER_CARD_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function socialCardImage(card: PackagePreview | null): SocialImage | null {
  if (!card || !RASTER_CARD_TYPES.has(card.contentType)) return null;
  return { url: card.url, width: card.width, height: card.height, type: card.contentType, alt: card.alt };
}

export function packageSeo(siteUrl: string, pkg: PackageDetail, socialCard: PackagePreview | null): SeoProps {
  const path = packagePath(pkg.name);
  const crumbs = [
    { name: "Packages", path: "/packages" },
    ...(pkg.categorySlug ? [{ name: pkg.categorySlug, path: categoryPath(pkg.categorySlug) }] : []),
    { name: pkg.displayName, path },
  ];
  return {
    path,
    image: socialCardImage(socialCard),
    jsonLd: [packageJsonLd(siteUrl, pkg), breadcrumbJsonLd(siteUrl, crumbs)],
  };
}

/** Later pages of a paginated listing stay crawlable (links are followed) but only the first page is indexed. */
export function categorySeo(siteUrl: string, category: Category, items: readonly PackageSummary[], paginated: boolean): SeoProps {
  const path = categoryPath(category.slug);
  return {
    path,
    noindex: paginated,
    jsonLd: [
      categoryJsonLd(siteUrl, category, items),
      breadcrumbJsonLd(siteUrl, [
        { name: "Packages", path: "/packages" },
        { name: category.name, path },
      ]),
    ],
  };
}

/** The package listing: only the unfiltered first page is indexed, has a Markdown twin and carries its list. */
export function packagesIndexSeo(siteUrl: string, items: readonly PackageSummary[], indexable: boolean): SeoProps {
  return {
    path: "/packages",
    markdown: indexable,
    noindex: !indexable,
    share: indexable,
    jsonLd: indexable
      ? [
          itemListJsonLd(siteUrl, "ClarkCant packages", packageListEntries(items)),
          breadcrumbJsonLd(siteUrl, [{ name: "Packages", path: "/packages" }]),
        ]
      : [],
  };
}

export function collectionsIndexSeo(siteUrl: string, collections: readonly CollectionSummary[]): SeoProps {
  return {
    path: "/collections",
    jsonLd: [
      itemListJsonLd(
        siteUrl,
        "ClarkCant package collections",
        collections.map((collection) => ({ name: collection.title, path: collectionPath(collection.slug) })),
      ),
      breadcrumbJsonLd(siteUrl, [{ name: "Collections", path: "/collections" }]),
    ],
  };
}

export function collectionSeo(siteUrl: string, collection: CollectionDetail): SeoProps {
  const path = collectionPath(collection.slug);
  return {
    path,
    jsonLd: [
      collectionJsonLd(siteUrl, collection),
      breadcrumbJsonLd(siteUrl, [
        { name: "Collections", path: "/collections" },
        { name: collection.title, path },
      ]),
    ],
  };
}
