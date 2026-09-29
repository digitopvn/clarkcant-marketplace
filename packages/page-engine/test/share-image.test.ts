import { describe, expect, it } from "vitest";

import { applyPageOperations, registryBlockDefaults, renderPage, validatePageDocument, type MediaAsset } from "../src";
import { documentWith, memoryPort, renderOptions } from "./support";

const png: MediaAsset = { id: "med_card", url: "/media/sha256/ab/cd/card.png", contentType: "image/png", width: 1200, height: 630 };
const svg: MediaAsset = { id: "med_vector", url: "/media/sha256/ef/01/card.svg", contentType: "image/svg+xml", width: 1200, height: 630 };
const text = { id: "t", type: "rich-text", version: 1, props: { markdown: "Hello" } };

describe("page share image (meta.image)", () => {
  it("stays optional, so documents written before it existed still validate", () => {
    const legacy = documentWith([text]);
    expect("image" in legacy.meta).toBe(false);
    expect(validatePageDocument(legacy).ok).toBe(true);
    expect(validatePageDocument({ ...legacy, meta: { ...legacy.meta, image: "med_card" } }).ok).toBe(true);
    expect(validatePageDocument({ ...legacy, meta: { ...legacy.meta, image: "../etc/passwd" } }).ok).toBe(false);
    expect(validatePageDocument({ ...legacy, meta: { ...legacy.meta, image: "" } }).ok).toBe(false);
  });

  it("is set and cleared through set_page_seo", () => {
    const context = { newId: () => "gen", blockDefaults: registryBlockDefaults };
    const set = applyPageOperations(documentWith([text]), [{ op: "set_page_seo", seo: { image: "med_card" } }], context);
    expect(set.document.meta.image).toBe("med_card");
    // Other SEO fields are untouched by an image-only patch.
    expect(set.document.meta.title).toBe("About");

    const kept = applyPageOperations(set.document, [{ op: "set_page_seo", seo: { title: "New" } }], context);
    expect(kept.document.meta.image).toBe("med_card");

    const cleared = applyPageOperations(set.document, [{ op: "set_page_seo", seo: { image: null } }], context);
    expect("image" in cleared.document.meta).toBe(false);
    expect(validatePageDocument(cleared.document).ok).toBe(true);
  });

  it("resolves a raster upload as the social image", async () => {
    const document = { ...documentWith([text]), meta: { ...documentWith([]).meta, image: "med_card" } };
    const page = await renderPage(document, renderOptions(memoryPort({ media: [png] })));
    expect(page.socialImage).toEqual(png);
    expect(page.diagnostics).toEqual([]);
  });

  it("reports missing and non-raster images instead of advertising them", async () => {
    const base = documentWith([text]);
    const none = await renderPage(base, renderOptions(memoryPort()));
    expect(none.socialImage).toBeNull();
    expect(none.diagnostics).toEqual([]);

    const missing = await renderPage({ ...base, meta: { ...base.meta, image: "med_gone" } }, renderOptions(memoryPort()));
    expect(missing.socialImage).toBeNull();
    expect(missing.diagnostics).toEqual(['share image "med_gone" is not an uploaded media object']);

    const vector = await renderPage({ ...base, meta: { ...base.meta, image: "med_vector" } }, renderOptions(memoryPort({ media: [svg] })));
    expect(vector.socialImage).toBeNull();
    expect(vector.diagnostics[0]).toMatch(/image\/svg\+xml; use a PNG, JPEG, WebP or GIF image/);
  });
});
