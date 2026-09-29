import { describe, expect, it } from "vitest";

import { renderSocialCardSvg } from "../src";

describe("social card", () => {
  it("escapes publisher-controlled text and never emits script", () => {
    const svg = renderSocialCardSvg({
      name: "@evil/card",
      displayName: `</text><script>alert(1)</script>\u0000`,
      description: `"quoted" & <b>bold</b> onload='x'`,
      version: "1.0.0",
      isolation: ["isolated-ui"],
    });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('width="1200" height="630"');
    expect(svg).not.toMatch(/<script|<b>/);
    expect(svg.includes(String.fromCharCode(0))).toBe(false);
    expect(svg).toContain("&lt;/text&gt;&lt;script&gt;");
    expect(svg).toContain("&quot;quoted&quot; &amp;");
  });
});
