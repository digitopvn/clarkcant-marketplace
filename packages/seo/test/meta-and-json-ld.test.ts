import { renderPage, type PageDataPort } from "@marketplace/page-engine";
import { describe, expect, it } from "vitest";

import {
  SUPPORTED_JSON_LD_TYPES,
  breadcrumbJsonLd,
  buildPageMeta,
  collectionJsonLd,
  categoryJsonLd,
  markdownPathFor,
  organizationJsonLd,
  packageJsonLd,
  techArticleJsonLd,
  validateJsonLd,
  webSiteJsonLd,
} from "../src";
import { SITE, detail, summary } from "./fixtures";

describe("buildPageMeta", () => {
  it("derives canonical, Markdown alternate, Open Graph and Twitter tags from one input", () => {
    const meta = buildPageMeta({ siteUrl: `${SITE}/`, path: "/about", title: "About", description: "What we do", locale: "en-gb" });
    expect(meta.title).toBe("About · ClarkCant Marketplace");
    expect(meta.canonical).toBe(`${SITE}/about`);
    expect(meta.markdownUrl).toBe(`${SITE}/about.md`);
    expect(meta.robots).toBeNull();
    const og = Object.fromEntries(meta.openGraph);
    expect(og["og:url"]).toBe(`${SITE}/about`);
    expect(og["og:image"]).toBe(`${SITE}/og-default.png`);
    expect(og["og:image:width"]).toBe("1200");
    expect(og["og:locale"]).toBe("en_GB");
    expect(Object.fromEntries(meta.twitter)["twitter:card"]).toBe("summary_large_image");
  });

  it("uses a page image, noindex and no Markdown twin when asked", () => {
    const meta = buildPageMeta({
      siteUrl: SITE,
      path: "/packages",
      title: "ClarkCant Marketplace",
      image: { url: "/media/sha256/ab/cd/x.png", width: 1200, height: 630, type: "image/png" },
      noindex: true,
      markdown: false,
    });
    expect(meta.title).toBe("ClarkCant Marketplace");
    expect(meta.image.url).toBe(`${SITE}/media/sha256/ab/cd/x.png`);
    expect(meta.robots).toBe("noindex");
    expect(meta.markdownUrl).toBeNull();
    expect(meta.description.length).toBeGreaterThan(0);
  });

  it("clamps long descriptions and maps the home page to /index.md", () => {
    const meta = buildPageMeta({ siteUrl: SITE, path: "/", title: "Home", description: "x ".repeat(400) });
    expect(meta.description.length).toBeLessThanOrEqual(300);
    expect(meta.markdownUrl).toBe(`${SITE}/index.md`);
    expect(markdownPathFor("/packages/@a/b")).toBe("/packages/@a/b.md");
  });
});

describe("JSON-LD builders", () => {
  const pkg = detail();
  const cases: [string, Record<string, unknown>][] = [
    ["Organization", organizationJsonLd()],
    ["WebSite", webSiteJsonLd(SITE)],
    ["BreadcrumbList", breadcrumbJsonLd(SITE, [{ name: "Packages", path: "/packages" }, { name: pkg.displayName, path: "/packages/@acme/frame-widget" }])],
    ["SoftwareSourceCode", packageJsonLd(SITE, pkg)],
    ["ItemList", categoryJsonLd(SITE, { slug: "widgets", name: "Widgets", description: "", packageCount: 2 }, [summary("a"), summary("@s/b")])],
    ["ItemList", collectionJsonLd(SITE, { slug: "picks", title: "Picks", description: "", packages: [summary("a")] })],
    ["TechArticle", techArticleJsonLd(SITE, { title: "Privacy Policy", path: "/privacy", dateModified: "2026-09-29T00:00:00.000Z", locale: "en" })],
  ];

  it.each(cases)("%s is valid", (type, node) => {
    expect(node["@type"]).toBe(type);
    expect(validateJsonLd(node)).toEqual([]);
  });

  it("describes a package from its canonical record", () => {
    const node = packageJsonLd(SITE, pkg);
    expect(node).toMatchObject({
      name: "Frame *widget*",
      alternateName: "@acme/frame-widget",
      url: `${SITE}/packages/%40acme/frame-widget`,
      version: "1.2.3",
      license: "https://spdx.org/licenses/MIT.html",
      codeRepository: "https://github.com/acme/frame-widget",
      runtimePlatform: "ClarkCant",
      targetProduct: { "@type": "SoftwareApplication", operatingSystem: "Web, macOS (Apple silicon)" },
    });
    // Nothing from the README ends up in structured data.
    expect(JSON.stringify(node)).not.toContain("third-party README");
  });

  it("rejects relative URLs, broken positions, missing fields and unknown types", () => {
    expect(validateJsonLd({ ...packageJsonLd(SITE, pkg), url: "/packages/x" })).not.toEqual([]);
    const list = breadcrumbJsonLd(SITE, [
      { name: "Home", path: "/" },
      { name: "A", path: "/a" },
    ]);
    expect(validateJsonLd(list)).toEqual([]);
    expect(
      validateJsonLd({
        ...list,
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${SITE}/` },
          { "@type": "ListItem", position: 3, name: "A", item: `${SITE}/a` },
        ],
      }),
    ).not.toEqual([]);
    // A breadcrumb trail needs at least two items to be a rich result.
    expect(validateJsonLd(breadcrumbJsonLd(SITE, [{ name: "A", path: "/a" }]))).not.toEqual([]);
    expect(validateJsonLd({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [] })).not.toEqual([]);
    expect(validateJsonLd({ "@context": "https://schema.org", "@type": "Recipe", name: "x" })).toEqual([{ path: "@type", message: 'unsupported type "Recipe"' }]);
    expect(validateJsonLd({ "@type": "Organization", name: "x" })).not.toEqual([]);
  });

  it("validates the block-level JSON-LD the page engine emits (FAQPage, ItemList, Organization, WebPage)", async () => {
    const port: PageDataPort = {
      listPackages: async () => [summary("a"), summary("@s/b")],
      listFeaturedPackages: async () => [],
      getPackage: async () => null,
      getCollection: async () => null,
      getPublisher: async () => ({ slug: "acme", name: "Acme", kind: "org", verified: true, packages: [] }),
      getMedia: async () => null,
      getMarketplaceStats: async () => ({ packages: 2, publishers: 1, categories: 1 }),
    };
    const rendered = await renderPage(
      {
        schemaVersion: 1,
        layout: { id: "editorial", version: 1 },
        meta: { title: "Guide", description: "", locale: "en", noindex: false },
        blocks: [
          { id: "faq", type: "faq", version: 1, props: { title: "FAQ", items: [{ question: "Why?", answer: "Because." }] } },
          { id: "grid", type: "package-grid", version: 1, props: { title: "Latest", category: "", sort: "latest", limit: 6 } },
          { id: "pub", type: "publisher-profile", version: 1, props: { publisherSlug: "acme", intro: "", showPackages: false, limit: 6 } },
        ],
      },
      { mode: "public", port, siteUrl: SITE, path: "/guide" },
    );
    const types = rendered.structuredData.map((node) => node["@type"]);
    expect(types).toEqual(expect.arrayContaining(["WebPage", "FAQPage", "ItemList", "Organization"]));
    for (const node of rendered.structuredData) expect(validateJsonLd(node)).toEqual([]);
    expect(SUPPORTED_JSON_LD_TYPES).toEqual(expect.arrayContaining(types as string[]));
  });
});
