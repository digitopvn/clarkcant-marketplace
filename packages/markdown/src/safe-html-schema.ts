import { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";

/**
 * Strict allow-list for rendered Markdown. It starts from GitHub's schema (which already drops every `on*` handler,
 * `style` attribute and unknown element) and tightens it further:
 * - no embedded media containers or active content (`iframe`, `object`, `embed`, `svg`, `math`, `picture`/`source`);
 * - links may only use http(s) or mailto and images only https, so `javascript:`/`data:`/`vbscript:` URLs vanish;
 * - `script`, `style`, `iframe`, `noscript`, `template`, `textarea` are removed together with their content.
 */
export const strictSanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((tag) => !["picture", "source"].includes(tag)),
  strip: ["script", "style", "iframe", "noscript", "template", "textarea", "object", "embed", "svg", "math"],
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto"],
    src: ["https"],
    cite: ["https", "http"],
    longDesc: ["https", "http"],
  },
};
