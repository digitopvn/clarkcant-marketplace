import { MarkdownInputTooLargeError, renderMarkdownToSafeHtml } from "@marketplace/markdown";
import { z } from "zod";

import { defineBlock } from "../define-block";
import { markdownToPlainText, truncate } from "../markdown-text";

export const RICH_TEXT_MAX_LENGTH = 20_000;

/** Page content is written by site editors, so outbound links keep ranking but never get the opener. */
const EDITOR_LINK_REL = ["noopener", "noreferrer"] as const;

const richTextProps = z.object({
  markdown: z.string().max(RICH_TEXT_MAX_LENGTH).default(""),
  width: z.enum(["prose", "wide"]).default("prose"),
});

/**
 * Markdown prose. Stored as Markdown, rendered through the shared sanitizer (raw HTML never passes), and emitted
 * unchanged by the Markdown renderer, so the Markdown twin is exactly what the editor wrote.
 */
export const richTextBlock = defineBlock({
  type: "rich-text",
  version: 1,
  propsSchema: richTextProps,
  defaultProps: { markdown: "Write something useful here.", width: "prose" },
  load: (props) => {
    try {
      return renderMarkdownToSafeHtml(props.markdown, { linkRel: EDITOR_LINK_REL, maxLength: RICH_TEXT_MAX_LENGTH });
    } catch (error) {
      // The schema already bounds the length; this only guards a future limit change.
      if (error instanceof MarkdownInputTooLargeError) return "";
      throw error;
    }
  },
  renderWeb: ({ props, data }) =>
    data ? `<section class="pe-block pe-prose pe-width-${props.width}">${data}</section>` : "",
  renderMarkdown: ({ props }) => props.markdown.trim(),
  getSemanticSummary: ({ props }) => {
    const text = markdownToPlainText(props.markdown);
    return text ? `Text: ${truncate(text, 240)}` : "";
  },
  editor: {
    label: "Rich text",
    icon: "¶",
    description: "Headings, paragraphs, lists, links, tables and code written in Markdown. Raw HTML is not allowed.",
    fields: [
      {
        kind: "markdown",
        name: "markdown",
        label: "Content (Markdown)",
        maxLength: RICH_TEXT_MAX_LENGTH,
        help: "Markdown with GitHub tables and task lists. HTML tags are removed.",
      },
      {
        kind: "select",
        name: "width",
        label: "Width",
        options: [
          { value: "prose", label: "Reading width" },
          { value: "wide", label: "Wide" },
        ],
      },
    ],
  },
});
