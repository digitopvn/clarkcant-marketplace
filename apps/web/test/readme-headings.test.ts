import { describe, expect, it } from "vitest";

import { nestReadmeHeadings } from "../src/components/package/readme-headings";

describe("nestReadmeHeadings", () => {
  it("moves README headings below the page's h1 and README h2", () => {
    expect(nestReadmeHeadings('<h1 id="x">Title</h1><p>a</p><h2>Usage</h2>')).toBe(
      '<h3 data-readme-level="1" id="x">Title</h3><p>a</p><h4 data-readme-level="2">Usage</h4>',
    );
  });

  it("caps deep headings at h6 and leaves other tags alone", () => {
    expect(nestReadmeHeadings("<h5>a</h5><H6>b</H6><hr><header>c</header>")).toBe(
      '<h6 data-readme-level="5">a</h6><h6 data-readme-level="6">b</h6><hr><header>c</header>',
    );
  });

  it("drops a leading title that repeats the package name, and only that", () => {
    expect(nestReadmeHeadings("<h1>Example  <code>frame</code> widget</h1>\n<p>Body</p>", "Example frame widget")).toBe("<p>Body</p>");
    expect(nestReadmeHeadings("<h1>Other</h1><p>Body</p>", "Example")).toBe('<h3 data-readme-level="1">Other</h3><p>Body</p>');
    expect(nestReadmeHeadings("<p>Intro</p><h1>Example</h1>", "Example")).toBe('<p>Intro</p><h3 data-readme-level="1">Example</h3>');
  });
});
