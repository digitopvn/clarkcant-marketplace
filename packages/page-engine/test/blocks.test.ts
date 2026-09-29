import { describe, expect, it } from "vitest";

import { describeBlocks, getLatestBlock, listBlocks, renderPage, validatePageDocument } from "../src";
import { documentWith, memoryPort, packageSummary, renderOptions } from "./support";

const port = memoryPort({
  packages: [
    packageSummary("@acme/chart-widget", { displayName: "Chart", curationStatus: "featured" }),
    packageSummary("clock-widget", { displayName: "Clock" }),
  ],
  collections: [
    { slug: "starter", title: "Starter kit", description: "Good first installs", packages: [packageSummary("clock-widget", { displayName: "Clock" })] },
  ],
  publishers: [{ slug: "acme", name: "Acme", kind: "org", verified: true, packages: [packageSummary("@acme/chart-widget", { displayName: "Chart" })] }],
  media: [{ id: "med_1", url: "/media/sha256/ab/cd/abcd.png", contentType: "image/png", width: 800, height: 400 }],
});

/** A realistic, valid props object per block type, plus one that must be rejected. */
const SAMPLES: Record<string, { valid: Record<string, unknown>; invalid: Record<string, unknown>; expectHtml: string; expectMd: string }> = {
  hero: { valid: { title: "Widgets <for> ClarkCant", subtitle: "Curated" }, invalid: { title: "" }, expectHtml: "Widgets &lt;for&gt; ClarkCant", expectMd: "# Widgets \\<for\\> ClarkCant" },
  "rich-text": { valid: { markdown: "## Why\n\nWe **curate** <script>alert(1)</script>" }, invalid: { markdown: 42 }, expectHtml: "<strong>curate</strong>", expectMd: "## Why" },
  media: { valid: { mediaId: "med_1", alt: "Screenshot" }, invalid: { mediaId: "med_1", alt: "" }, expectHtml: 'src="/media/sha256/ab/cd/abcd.png"', expectMd: "![Screenshot](https://market.example/media/sha256/ab/cd/abcd.png)" },
  "package-grid": { valid: { title: "Latest", limit: 2 }, invalid: { limit: 500 }, expectHtml: 'href="/packages/%40acme/chart-widget"', expectMd: "[Chart](https://market.example/packages/%40acme/chart-widget.md)" },
  "featured-packages": { valid: { title: "Featured" }, invalid: { limit: 0 }, expectHtml: "Chart", expectMd: "## Featured" },
  collection: { valid: { collectionSlug: "starter" }, invalid: { collectionSlug: "Bad Slug" }, expectHtml: "Starter kit", expectMd: "## Starter kit" },
  stats: { valid: { items: [{ label: "Listed", metric: "packages" }, { label: "Uptime", value: "99%" }] }, invalid: { items: [{ label: "Manual", metric: "manual" }] }, expectHtml: "<dd class=\"pe-stat-value\">2</dd>", expectMd: "**Listed:** 2" },
  cta: { valid: { title: "Publish", primary: { label: "Start", href: "/publish" } }, invalid: { primary: { label: "Evil", href: "javascript:alert(1)" } }, expectHtml: 'href="/publish"', expectMd: "[Start](https://market.example/publish)" },
  faq: { valid: { items: [{ question: "Is it free?", answer: "Yes." }] }, invalid: { items: [] }, expectHtml: "<summary>Is it free?</summary>", expectMd: "### Is it free?" },
  comparison: { valid: { columns: ["A", "B"], rows: [{ label: "Fast", values: ["yes", "no"] }] }, invalid: { columns: ["A", "B"], rows: [{ label: "Fast", values: ["yes", "no", "maybe"] }] }, expectHtml: '<th scope="row">Fast</th>', expectMd: "| Fast | yes | no |" },
  "logo-cloud": { valid: { logos: [{ name: "Acme", href: "https://acme.test" }] }, invalid: { logos: [{ name: "X", href: "javascript:x" }] }, expectHtml: 'href="https://acme.test" rel="noopener"', expectMd: "[Acme](https://acme.test)" },
  "code-install-snippet": { valid: { packageName: "clock-widget" }, invalid: { packageName: "Not A Name" }, expectHtml: "npm install clock-widget@1.2.3", expectMd: "npm install clock-widget@1.2.3" },
  "publisher-profile": { valid: { publisherSlug: "acme" }, invalid: { publisherSlug: "" , limit: 99 }, expectHtml: "verified publisher", expectMd: "## Acme (verified publisher)" },
};

describe("block registry", () => {
  it("registers the thirteen required blocks with valid defaults and JSON Schemas", () => {
    const types = listBlocks().map((block) => block.type);
    expect(new Set(types)).toEqual(new Set(Object.keys(SAMPLES)));
    for (const description of describeBlocks()) {
      expect(description.propsJsonSchema).toMatchObject({ type: "object" });
      expect(description.fields.length).toBeGreaterThan(0);
      expect(getLatestBlock(description.type)?.parseProps(description.defaultProps).success).toBe(true);
    }
  });

  for (const [type, sample] of Object.entries(SAMPLES)) {
    it(`${type}: validates props and renders HTML + Markdown`, async () => {
      const block = getLatestBlock(type);
      expect(block).toBeDefined();
      expect(block?.parseProps(sample.valid).success).toBe(true);
      expect(block?.parseProps(sample.invalid).success).toBe(false);

      const document = documentWith([{ id: "b1", type, version: 1, props: sample.valid }]);
      const validated = validatePageDocument(document);
      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      const page = await renderPage(validated.document, renderOptions(port));
      expect(page.html).toContain(sample.expectHtml);
      expect(page.markdown).toContain(sample.expectMd);
      expect(page.html).not.toContain("<script");
      expect(page.diagnostics).toEqual([]);
    });
  }
});

describe("block rendering safety", () => {
  it("escapes text everywhere and neutralises unsafe URLs that bypass validation", async () => {
    const page = await renderPage(
      documentWith([
        { id: "h", type: "hero", version: 1, props: { title: '"><img src=x onerror=alert(1)>' } },
        { id: "r", type: "rich-text", version: 1, props: { markdown: "[x](javascript:alert(1)) <iframe src=//evil></iframe>" } },
      ]),
      renderOptions(port),
    );
    expect(page.html).not.toMatch(/<img src=x/);
    expect(page.html).not.toContain("javascript:");
    expect(page.html).not.toContain("<iframe");
  });

  it("emits FAQPage and ItemList structured data and a WebPage entry", async () => {
    const page = await renderPage(
      documentWith([
        { id: "f", type: "faq", version: 1, props: { items: [{ question: "Q?", answer: "A." }] } },
        { id: "g", type: "package-grid", version: 1, props: {} },
      ]),
      renderOptions(port),
    );
    const types = page.structuredData.map((entry) => entry["@type"]);
    expect(types).toEqual(["WebPage", "FAQPage", "ItemList"]);
    expect(page.summary).toContain('Page "About"');
    expect(page.summary).toContain("FAQ with 1 question(s)");
  });

  it("reports unresolved bindings as diagnostics, visible only outside the public page", async () => {
    const document = documentWith([
      { id: "m", type: "media", version: 1, props: { mediaId: "med_missing", alt: "Gone" } },
      { id: "c", type: "collection", version: 1, props: {} },
    ]);
    const live = await renderPage(document, renderOptions(port, "public"));
    expect(live.diagnostics).toHaveLength(2);
    expect(live.html).not.toContain("pe-diagnostic");
    const preview = await renderPage(document, renderOptions(port, "preview"));
    expect(preview.html).toContain("pe-diagnostic");
  });

  it("wraps nodes with their ids only on the builder canvas", async () => {
    const document = documentWith([
      { id: "hero1", type: "hero", version: 1, props: { title: "Hi" }, children: [{ id: "cta1", type: "cta", version: 1, props: { primary: { label: "Go", href: "/packages" } } }] },
    ]);
    const canvas = await renderPage(document, renderOptions(port, "canvas"));
    expect(canvas.html).toContain('data-block-id="hero1"');
    expect(canvas.html).toContain('data-block-id="cta1"');
    const live = await renderPage(document, renderOptions(port));
    expect(live.html).not.toContain("data-block-id");
    expect(live.markdown).toContain("[Go](https://market.example/packages)");
  });

  it("writes absolute links in the Markdown twin so it stands on its own", async () => {
    const document = documentWith([
      { id: "c1", type: "cta", version: 1, props: { primary: { label: "Top", href: "#faq" }, secondary: { label: "Mail", href: "mailto:hi@market.example" } } },
      { id: "col", type: "collection", version: 1, props: { collectionSlug: "starter" } },
    ]);
    const page = await renderPage(document, renderOptions(port));
    expect(page.markdown).toContain("[Top](https://market.example/about#faq)");
    expect(page.markdown).toContain("[Mail](mailto:hi@market.example)");
    expect(page.markdown).toContain("(https://market.example/collections/starter.md)");
    expect(page.markdown).not.toMatch(/\]\(\//);
  });

  it("adds a page heading when the page does not open with a hero", async () => {
    const page = await renderPage(documentWith([{ id: "r", type: "rich-text", version: 1, props: { markdown: "Body" } }]), renderOptions(port));
    expect(page.html).toContain('<h1 class="pe-display">About</h1>');
    expect(page.markdown.startsWith("# About")).toBe(true);
  });
});
