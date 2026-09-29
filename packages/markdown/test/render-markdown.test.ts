import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";
import { describe, expect, it } from "vitest";

import {
  MarkdownInputTooLargeError,
  renderMarkdownToSafeHtml,
  strictSanitizeSchema,
} from "../src/index.ts";

const BASE = "https://cdn.jsdelivr.net/npm/@acme/widget@1.2.3/";

describe("renderMarkdownToSafeHtml", () => {
  it("renders CommonMark and GFM", () => {
    const html = renderMarkdownToSafeHtml("# Title\n\n- [x] done\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n~~old~~");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<del>old</del>");
  });

  it("never passes raw HTML through", () => {
    const html = renderMarkdownToSafeHtml(
      'Hi <script>alert(1)</script>\n\n<iframe src="https://evil.example"></iframe>\n\n<img src="x" onerror="alert(1)">\n\n<div onclick="x()">t</div>',
    );
    // Inline raw tags are removed; text between them survives only as escaped text, never as markup.
    expect(html).not.toMatch(/<script|<iframe|<img|<div|onerror|onclick|evil\.example/i);
  });

  it("drops javascript:, data: and vbscript: URLs", () => {
    const html = renderMarkdownToSafeHtml(
      "[a](javascript:alert(1)) [b](JaVaScRiPt:alert(2)) [c](data:text/html,x) [d](vbscript:x) ![e](data:image/png;base64,AAAA)",
    );
    expect(html).not.toMatch(/javascript:|data:|vbscript:/i);
    expect(html).toContain(">a</a>");
  });

  it("marks outbound links nofollow ugc and keeps fragments", () => {
    const html = renderMarkdownToSafeHtml("[x](https://example.com/a) [y](#usage) <mailto:a@b.co>");
    expect(html).toContain('<a href="https://example.com/a" rel="nofollow ugc noopener noreferrer">x</a>');
    expect(html).toContain('href="#usage"');
    expect(html).toContain('href="mailto:a@b.co"');
    expect(html).not.toMatch(/mailto:a@b.co" rel/);
  });

  it("honours a custom link rel", () => {
    const html = renderMarkdownToSafeHtml("[x](https://example.com)", { linkRel: ["noopener"] });
    expect(html).toContain('rel="noopener"');
  });

  it("resolves relative images and links against baseUrl", () => {
    const html = renderMarkdownToSafeHtml("![shot](previews/a.png) [docs](docs/usage.md)", { baseUrl: BASE });
    expect(html).toContain(`src="${BASE}previews/a.png"`);
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(html).toContain(`href="${BASE}docs/usage.md"`);
  });

  it("drops relative images without a baseUrl but keeps their alt text", () => {
    const html = renderMarkdownToSafeHtml("![Screenshot of widget](previews/a.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("Screenshot of widget");
  });

  it("drops non-https images", () => {
    const html = renderMarkdownToSafeHtml("![a](http://example.com/a.png) ![b](https://example.com/b.png)");
    expect(html).not.toContain("http://example.com/a.png");
    expect(html).toContain('src="https://example.com/b.png"');
  });

  it("upgrades protocol-relative URLs to https", () => {
    const html = renderMarkdownToSafeHtml("![a](//example.com/a.png)");
    expect(html).toContain('src="https://example.com/a.png"');
  });

  it("rejects oversized input and invalid base URLs", () => {
    expect(() => renderMarkdownToSafeHtml("x".repeat(11), { maxLength: 10 })).toThrow(MarkdownInputTooLargeError);
    expect(() => renderMarkdownToSafeHtml("x", { baseUrl: "relative/" })).toThrow(TypeError);
    expect(() => renderMarkdownToSafeHtml("x", { baseUrl: "javascript:alert(1)" })).toThrow(TypeError);
  });
});

describe("strictSanitizeSchema", () => {
  // The Markdown pipeline never admits raw HTML, so the schema is exercised directly against a hostile HTML tree.
  function sanitize(tree: unknown): string {
    const processor = unified().use(rehypeSanitize, strictSanitizeSchema).use(rehypeStringify);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- hand-built hast tree for the test
    return processor.stringify(processor.runSync(tree as any));
  }
  const el = (tagName: string, properties: Record<string, unknown>, children: unknown[] = []) => ({
    type: "element",
    tagName,
    properties,
    children,
  });
  const text = (value: string) => ({ type: "text", value });

  it("strips scripts, styles, iframes, svg and on* handlers", () => {
    const html = sanitize({
      type: "root",
      children: [
        el("script", {}, [text("alert(1)")]),
        el("style", {}, [text("body{}")]),
        el("iframe", { src: "https://evil.example" }, [text("frame")]),
        el("svg", { onLoad: "alert(1)" }, [text("svg")]),
        el("p", { onClick: "alert(1)", onMouseOver: "x", style: "color:red" }, [text("ok")]),
        el("a", { href: "javascript:alert(1)" }, [text("link")]),
        el("img", { src: "data:image/svg+xml,<svg/>", onError: "x" }),
      ],
    });
    expect(html).toContain("<p>ok</p>");
    expect(html).not.toMatch(/script|style|iframe|svg|onclick|onmouseover|onerror|onload|javascript:|data:|alert/i);
  });
});
