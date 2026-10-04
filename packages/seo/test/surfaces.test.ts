import { describe, expect, it } from "vitest";

import {
  PACKAGES_PER_SITEMAP,
  SHARE_TARGETS,
  getShareTarget,
  parseSitemapSegment,
  renderCategoryMarkdown,
  renderCollectionMarkdown,
  renderCollectionsIndexMarkdown,
  renderHomeMarkdown,
  renderLlmsFullTxt,
  renderLlmsTxt,
  renderPackageMarkdown,
  renderPackagesIndexMarkdown,
  renderRobotsTxt,
  renderSitemapIndex,
  renderUrlset,
  shareFallbackText,
  sharePrompt,
  sitemapSegmentPath,
  sitemapSegments,
} from "../src";
import { INSTALL, SITE, VERSIONS, detail, summary } from "./fixtures";

describe("sitemaps", () => {
  it("renders an escaped urlset with W3C dates", () => {
    const xml = renderUrlset([
      { loc: `${SITE}/packages?a=1&b=2`, lastmod: "2026-09-02T10:00:00.000Z" },
      { loc: `${SITE}/about` },
    ]);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain(`<url><loc>${SITE}/packages?a=1&amp;b=2</loc><lastmod>2026-09-02</lastmod></url>`);
    expect(xml).toContain(`<url><loc>${SITE}/about</loc></url>`);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  it("refuses more URLs than the protocol allows", () => {
    expect(() => renderUrlset(Array.from({ length: 50_001 }, (_, index) => ({ loc: `${SITE}/${index}` })))).toThrow(RangeError);
  });

  it("segments the catalogue and round-trips segment paths", () => {
    expect(sitemapSegments(0).map(sitemapSegmentPath)).toEqual([
      "/sitemap-pages.xml",
      "/sitemap-categories.xml",
      "/sitemap-collections.xml",
      "/sitemap-packages-1.xml",
    ]);
    const segments = sitemapSegments(PACKAGES_PER_SITEMAP * 2 + 1);
    expect(segments.filter((segment) => segment.kind === "packages")).toHaveLength(3);
    for (const segment of segments) {
      const name = sitemapSegmentPath(segment).replace(/^\/sitemap-/, "").replace(/\.xml$/, "");
      expect(parseSitemapSegment(name)).toEqual(segment);
    }
    for (const bad of ["packages-0", "packages-01", "packages", "users", "pages.xml", "packages-1000000"]) {
      expect(parseSitemapSegment(bad)).toBeNull();
    }
  });

  it("renders a sitemap index", () => {
    const xml = renderSitemapIndex([{ loc: `${SITE}/sitemap-pages.xml`, lastmod: "2026-09-29" }]);
    expect(xml).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain(`<sitemap><loc>${SITE}/sitemap-pages.xml</loc><lastmod>2026-09-29</lastmod></sitemap>`);
  });
});

describe("robots.txt", () => {
  it("allows production crawling except private paths and names the sitemap", () => {
    const text = renderRobotsTxt({ siteUrl: SITE, allowIndexing: true });
    expect(text).toContain("User-agent: *\nAllow: /\n");
    for (const path of ["/admin", "/api/", "/preview/", "/account"]) expect(text).toContain(`Disallow: ${path}\n`);
    expect(text).toContain(`Sitemap: ${SITE}/sitemap.xml`);
    expect(text).toContain(`${SITE}/llms.txt`);
  });

  it("disallows everything outside production", () => {
    const text = renderRobotsTxt({ siteUrl: SITE, allowIndexing: false });
    expect(text).toContain("User-agent: *\nDisallow: /\n");
    expect(text).not.toContain("Allow: /");
  });
});

describe("llms.txt", () => {
  it("follows the llms.txt layout: H1, summary blockquote, H2 link sections", () => {
    const text = renderLlmsTxt({
      title: "ClarkCant Marketplace",
      summary: "Discovery for ClarkCant packages.",
      details: ["Every page has a Markdown twin."],
      sections: [
        { title: "Start here", links: [{ title: "Home", url: `${SITE}/index.md`, description: "Landing page [draft]" }] },
        { title: "Empty", links: [] },
      ],
    });
    expect(text).toBe(
      [
        "# ClarkCant Marketplace",
        "",
        "> Discovery for ClarkCant packages.",
        "",
        "Every page has a Markdown twin.",
        "",
        "## Start here",
        "",
        `- [Home](${SITE}/index.md): Landing page \\[draft\\]`,
        "",
      ].join("\n"),
    );
  });

  it("llms-full.txt inlines first-party documents with their source URL", () => {
    const text = renderLlmsFullTxt({
      title: "ClarkCant Marketplace",
      summary: "Full text.",
      documents: [{ title: "About", url: `${SITE}/about`, markdown: "# About\n\nWe curate." }],
    });
    expect(text).toContain(`---\n\nSource: <${SITE}/about>\n\n# About\n\nWe curate.`);
  });
});

describe("share targets", () => {
  const payload = { title: "Frame & #1 widget ✓", canonicalUrl: `${SITE}/packages/%40acme/frame`, markdownUrl: `${SITE}/packages/%40acme/frame.md` };

  it("encodes the whole prompt into prefill URLs so it round-trips exactly", () => {
    for (const target of SHARE_TARGETS.filter((item) => item.prefill)) {
      const url = new URL(target.url(payload));
      expect(url.protocol).toBe("https:");
      expect(url.searchParams.get("q")).toBe(sharePrompt(payload));
      expect(url.hash).toBe("");
    }
    expect(getShareTarget("chatgpt")?.url(payload)).toMatch(/^https:\/\/chatgpt\.com\/\?q=/);
    expect(getShareTarget("claude")?.url(payload)).toMatch(/^https:\/\/claude\.ai\/new\?q=/);
    expect(getShareTarget("perplexity")?.url(payload)).toMatch(/^https:\/\/www\.perplexity\.ai\/search\?q=/);
  });

  it("opens providers without prefill support on their start page", () => {
    const gemini = getShareTarget("gemini");
    expect(gemini?.prefill).toBe(false);
    expect(gemini?.url(payload)).toBe("https://gemini.google.com/app");
  });

  it("names both URLs in the prompt and the fallback, and bounds prompt length", () => {
    expect(sharePrompt(payload)).toContain(payload.markdownUrl);
    expect(sharePrompt(payload)).toContain(payload.canonicalUrl);
    expect(shareFallbackText(payload)).toBe(`${payload.canonicalUrl}\nMarkdown: ${payload.markdownUrl}`);
    expect(shareFallbackText({ ...payload, markdownUrl: null })).toBe(payload.canonicalUrl);
    expect(sharePrompt({ ...payload, title: "x".repeat(5_000) }).length).toBeLessThanOrEqual(1_500);
  });
});

describe("Markdown twins", () => {
  it("renders a package from its canonical record, escaping author text and leaving the README on npm", () => {
    const markdown = renderPackageMarkdown({ siteUrl: SITE, pkg: detail(), install: INSTALL, versions: VERSIONS });
    expect(markdown.startsWith("# Frame \\*widget\\*\n")).toBe(true);
    expect(markdown).toContain("Shows \\<b\\>frames\\</b\\> & more");
    expect(markdown).toContain('"package": "@acme/frame-widget"');
    expect(markdown).toContain("Listed: passed automated checks (manifest, integrity) when indexed; not reviewed by a person.");
    expect(markdown).toContain("Network access (Needs your consent): Can connect to https://api.example.com");
    expect(markdown).toContain(`[${SITE}/packages/%40acme/frame-widget](${SITE}/packages/%40acme/frame-widget)`);
    expect(markdown).not.toContain("third-party README text");
    expect(markdown).toContain("https://www.npmjs.com/package/@acme/frame-widget");
  });

  it("describes a service's capabilities, reach, secrets and account connection as requests", () => {
    const base = detail().latest;
    if (!base) throw new Error("fixture has a latest version");
    const latest = {
      ...base,
      manifestSchemaVersion: 2 as const,
      permissions: [
        { kind: "service-capability" as const, value: "com.acme.tasks.update@1", access: "external-write" },
        { kind: "egress" as const, value: "https://api.acme.example", access: "ACME_KEY" },
        { kind: "secret" as const, value: "ACME_KEY", access: null },
        { kind: "connection-scope" as const, value: "tasks.write", access: "acme.tasks" },
        { kind: "connection-endpoint" as const, value: "https://tasks.acme.example", access: "acme.tasks" },
        { kind: "resource-profile" as const, value: "background-compute", access: "gpu" },
      ],
      services: [
        {
          facetId: "com.acme.tasks.service",
          entry: "service/server.mjs",
          protocol: "mcp-stdio",
          capabilities: [
            {
              tool: "update_task",
              ref: "com.acme.tasks.update@1",
              summary: "Update a task",
              effectCategory: "external-write" as const,
              job: true,
              requiredScopes: ["tasks.write"],
              inputArtifactFields: ["attachment"],
            },
          ],
          egress: {
            secrets: [{ name: "ACME_KEY", purpose: "Signs requests in." }],
            origins: [
              {
                origin: "https://api.acme.example",
                purpose: "Reads the weather.",
                credential: { secret: "ACME_KEY", header: "authorization", scheme: "bearer" as const },
              },
            ],
          },
          connection: {
            provider: "acme.tasks",
            displayName: "Acme Tasks",
            flow: "oauth-pkce" as const,
            authorizationEndpoint: "https://tasks.acme.example/oauth/authorize?x=1",
            tokenEndpoint: "https://tasks.acme.example/oauth/token",
            revocationEndpoint: null,
            scopes: [{ scope: "tasks.write", purpose: "Updates your tasks." }],
            endpoints: ["https://tasks.acme.example"],
            probeUrl: "https://tasks.acme.example/api/me",
          },
        },
      ],
    };
    const markdown = renderPackageMarkdown({ siteUrl: SITE, pkg: detail({ latest }), install: INSTALL, versions: VERSIONS });
    expect(markdown).toContain("Service com.acme.tasks.service (mcp-stdio)");
    expect(markdown).toContain("(Higher risk): `com.acme.tasks.update@1, changes things in another service`.");
    expect(markdown).toContain("Runs as a job you can follow and stop. Needs account scope tasks.write.");
    expect(markdown).toContain("- `https://api.acme.example`: Reads the weather.");
    expect(markdown).toContain("- `ACME_KEY`: Signs requests in.");
    expect(markdown).toContain("You sign in at https://tasks.acme.example.");
    expect(markdown).toContain("- Scope `tasks.write`: Updates your tasks.");
    expect(markdown).toContain("- Account API: `https://tasks.acme.example`");
    // Rows the services section already explains are not repeated; the rest still are.
    expect(markdown).toContain("Other permissions");
    expect(markdown).toContain("Resource profile (Needs your consent): background-compute with a GPU");
    expect(markdown).not.toContain("Secret you provide");
    expect(markdown).not.toContain("Service network access");
  });

  it("renders a package without an indexed version", () => {
    const markdown = renderPackageMarkdown({ siteUrl: SITE, pkg: detail({ latest: null, latestVersion: null }), install: null, versions: [] });
    expect(markdown).toContain("This package has no indexed version yet.");
    expect(markdown).not.toContain("## Install");
  });

  it("renders categories and collections with links to package twins", () => {
    const category = renderCategoryMarkdown(SITE, { slug: "widgets", name: "Widgets", description: "Small apps", packageCount: 1 }, [summary("@s/a")], true);
    expect(category).toContain("# Widgets");
    expect(category).toContain(`[@s/a](${SITE}/packages/%40s/a.md)`);
    expect(category).toContain("?category=widgets");
    const collection = renderCollectionMarkdown(SITE, { slug: "picks", title: "Picks", description: "", packages: [] });
    expect(collection).toContain("This collection has no listed packages right now.");
  });

  it("renders the built-in home page with categories, featured and latest packages", () => {
    const markdown = renderHomeMarkdown({
      siteUrl: SITE,
      featured: [summary("@s/star", { curationStatus: "featured" })],
      latest: [summary("@s/new")],
      categories: [{ slug: "widgets", name: "Widgets", description: "", packageCount: 2 }],
    });
    expect(markdown.startsWith("# ClarkCant Marketplace\n")).toBe(true);
    expect(markdown).toContain(`[Widgets](${SITE}/categories/widgets.md) (2)`);
    expect(markdown).toContain("## Featured");
    expect(markdown).toContain(`[@s/star](${SITE}/packages/%40s/star.md)`);
    expect(markdown).toContain(`[llms.txt](${SITE}/llms.txt)`);
    const empty = renderHomeMarkdown({ siteUrl: SITE, featured: [], latest: [], categories: [] });
    expect(empty).not.toContain("## Featured");
    expect(empty).toContain("No packages are listed yet.");
  });

  it("renders the package listing and collections index with absolute links only", () => {
    const listing = renderPackagesIndexMarkdown({
      siteUrl: SITE,
      packages: [summary("@s/a")],
      categories: [{ slug: "widgets", name: "Widgets", description: "", packageCount: 1 }],
      hasMore: true,
    });
    expect(listing.startsWith("# All packages\n")).toBe(true);
    expect(listing).toContain(`[@s/a](${SITE}/packages/%40s/a.md)`);
    expect(listing).toContain(`[Widgets](${SITE}/categories/widgets.md) (1)`);
    expect(listing).toContain(`${SITE}/api/v1/packages`);
    expect(listing).not.toMatch(/\]\(\//);
    expect(renderPackagesIndexMarkdown({ siteUrl: SITE, packages: [], categories: [], hasMore: false })).toContain("No packages are listed yet.");

    const collections = renderCollectionsIndexMarkdown(SITE, [{ slug: "picks", title: "Picks", description: "Our *picks*" }]);
    expect(collections.startsWith("# Collections\n")).toBe(true);
    expect(collections).toContain(`[Picks](${SITE}/collections/picks.md): Our \\*picks\\*`);
    expect(renderCollectionsIndexMarkdown(SITE, [])).toContain("Curators have not published a collection yet.");
  });
});
