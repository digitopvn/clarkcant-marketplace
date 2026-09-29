import { z } from "zod";

import { defineBlock } from "../define-block";
import { absoluteUrl, escapeHtml } from "../html";
import { escapeMarkdown, joinMarkdown, mdUrl } from "../markdown-text";
import type { MediaAsset } from "../types";
import { mediaIdSchema, plainText } from "./shared";

const mediaProps = z
  .object({
    /** Empty until an editor picks an image; an empty id renders an editor note and blocks publishing. */
    mediaId: z.union([z.literal(""), mediaIdSchema]).default(""),
    alt: plainText(300).default(""),
    decorative: z.boolean().default(false),
    caption: plainText(300).default(""),
    size: z.enum(["content", "wide", "full"]).default("content"),
  })
  .refine((props) => props.mediaId === "" || props.decorative || props.alt.length > 0, {
    error: "alt text is required unless the image is marked decorative",
    path: ["alt"],
  });

/** An image stored in R2, referenced by media id. The page stores the id, never a URL or bytes. */
export const mediaBlock = defineBlock<z.infer<typeof mediaProps>, MediaAsset | null>({
  type: "media",
  version: 1,
  propsSchema: mediaProps,
  defaultProps: { mediaId: "", alt: "", decorative: false, caption: "", size: "content" },
  load: (props, port) => (props.mediaId ? port.getMedia(props.mediaId) : null),
  renderWeb: ({ props, data, diagnose }) => {
    if (!props.mediaId) return diagnose("Choose an image for this block; it is hidden until one is set.");
    if (!data) return diagnose(`Media "${props.mediaId}" was not found; this block is hidden on the live page.`);
    const alt = props.decorative ? "" : props.alt;
    const dimensions = data.width && data.height ? ` width="${data.width}" height="${data.height}"` : "";
    const caption = props.caption ? `<figcaption>${escapeHtml(props.caption)}</figcaption>` : "";
    return (
      `<figure class="pe-block pe-media pe-size-${props.size}"><img src="${escapeHtml(data.url)}" alt="${escapeHtml(alt)}"` +
      `${dimensions} loading="lazy" decoding="async" />${caption}</figure>`
    );
  },
  renderMarkdown: ({ props, data, siteUrl }) => {
    if (!data) return "";
    const url = mdUrl(absoluteUrl(siteUrl, data.url));
    return joinMarkdown([`![${escapeMarkdown(props.decorative ? "" : props.alt)}](${url})`, props.caption ? `*${escapeMarkdown(props.caption)}*` : ""]);
  },
  getSemanticSummary: ({ props, data }) =>
    data ? `Image${props.decorative ? " (decorative)" : `: ${props.alt}`}${props.caption ? ` — ${props.caption}` : ""}.` : "",
  editor: {
    label: "Image",
    icon: "▣",
    description: "An uploaded image with alt text and an optional caption.",
    fields: [
      { kind: "reference", target: "media", name: "mediaId", label: "Media id", required: true, help: "Id of an uploaded image (med_…)." },
      { kind: "text", name: "alt", label: "Alt text", maxLength: 300, help: "Describe what the image shows." },
      { kind: "boolean", name: "decorative", label: "Decorative (no alt text)" },
      { kind: "text", name: "caption", label: "Caption", maxLength: 300 },
      {
        kind: "select",
        name: "size",
        label: "Size",
        options: [
          { value: "content", label: "Content width" },
          { value: "wide", label: "Wide" },
          { value: "full", label: "Full width" },
        ],
      },
    ],
  },
});
