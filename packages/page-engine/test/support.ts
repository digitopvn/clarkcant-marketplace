import type { CollectionDetail, PackageSummary, PageDocument } from "@marketplace/contracts";

import type { MediaAsset, PageDataPort, PublisherProfile, RenderOptions } from "../src";

export function packageSummary(name: string, overrides: Partial<PackageSummary> = {}): PackageSummary {
  return {
    name,
    displayName: overrides.displayName ?? name,
    description: "A package",
    latestVersion: "1.2.3",
    publisher: { slug: "acme", name: "Acme", verified: true },
    categorySlug: "widgets",
    curationStatus: "listed",
    keywords: [],
    indexedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

/** In-memory read port for renderer unit tests; the service tests exercise the D1-backed port. */
export function memoryPort(data: {
  packages?: PackageSummary[];
  collections?: CollectionDetail[];
  publishers?: PublisherProfile[];
  media?: MediaAsset[];
} = {}): PageDataPort {
  const packages = data.packages ?? [];
  return {
    listPackages: async ({ category, limit }) =>
      packages.filter((pkg) => !category || pkg.categorySlug === category).slice(0, limit),
    listFeaturedPackages: async (limit) => packages.filter((pkg) => pkg.curationStatus === "featured").slice(0, limit),
    getPackage: async (name) => packages.find((pkg) => pkg.name === name) ?? null,
    getCollection: async (slug) => data.collections?.find((collection) => collection.slug === slug) ?? null,
    getPublisher: async (slug) => data.publishers?.find((publisher) => publisher.slug === slug) ?? null,
    getMedia: async (id) => data.media?.find((media) => media.id === id) ?? null,
    getMarketplaceStats: async () => ({ packages: packages.length, publishers: 1, categories: 6 }),
  };
}

export function renderOptions(port: PageDataPort, mode: RenderOptions["mode"] = "public"): RenderOptions {
  return { mode, port, siteUrl: "https://market.example", path: "/about" };
}

export function documentWith(blocks: PageDocument["blocks"], layout = "editorial"): PageDocument {
  return {
    schemaVersion: 1,
    layout: { id: layout, version: 1 },
    meta: { title: "About", description: "About the marketplace", locale: "en", noindex: false },
    blocks,
  };
}
