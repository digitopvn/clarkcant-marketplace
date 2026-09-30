import { z } from "zod";

import { defineBlock } from "../define-block";
import { escapeHtml } from "../html";
import { escapeMarkdown, joinMarkdown, mdHeading } from "../markdown-text";
import { plainText, requiredText } from "./shared";

const heroProps = z.object({
  eyebrow: plainText(80).default(""),
  title: requiredText(160),
  subtitle: plainText(400).default(""),
  align: z.enum(["start", "center"]).default("start"),
  tone: z.enum(["plain", "spectrum"]).default("plain"),
});

/** The page's main heading. It may hold call-to-action and install-snippet blocks as children. */
export const heroBlock = defineBlock({
  type: "hero",
  version: 1,
  propsSchema: heroProps,
  defaultProps: { eyebrow: "", title: "A clear headline", subtitle: "", align: "start", tone: "plain" },
  allowedChildren: ["cta", "code-install-snippet"],
  maxChildren: 3,
  renderWeb: ({ props, children, heroAccessory }) => {
    const eyebrow = props.eyebrow ? `<p class="pe-eyebrow">${escapeHtml(props.eyebrow)}</p>` : "";
    const subtitle = props.subtitle ? `<p class="pe-lede">${escapeHtml(props.subtitle)}</p>` : "";
    const rule = props.tone === "spectrum" ? '<div class="pe-spectrum" aria-hidden="true"></div>' : "";
    const actions = children.html ? `<div class="pe-hero-children">${children.html}</div>` : "";
    const content = `${eyebrow}<h1 class="pe-display">${escapeHtml(props.title)}</h1>${subtitle}${rule}${actions}`;
    if (!heroAccessory) return `<section class="pe-block pe-hero pe-align-${props.align}">${content}</section>`;
    return (
      `<section class="pe-block pe-hero pe-hero-with-accessory pe-align-${props.align}">` +
      `<div class="pe-hero-content">${content}</div><div class="pe-hero-accessory">${heroAccessory}</div></section>`
    );
  },
  renderMarkdown: ({ props, children }) =>
    joinMarkdown([
      props.eyebrow ? `*${escapeMarkdown(props.eyebrow)}*` : "",
      mdHeading(1, props.title),
      escapeMarkdown(props.subtitle),
      children.markdown,
    ]),
  getSemanticSummary: ({ props, children }) =>
    [`Page heading "${props.title}"${props.subtitle ? `: ${props.subtitle}` : ""}.`, ...children.summaries].join(" "),
  editor: {
    label: "Hero",
    icon: "H",
    description: "The page headline with an optional eyebrow and subtitle. Can hold calls to action and an install snippet.",
    fields: [
      { kind: "text", name: "eyebrow", label: "Eyebrow", maxLength: 80, help: "Short label above the headline." },
      { kind: "text", name: "title", label: "Headline", required: true, maxLength: 160 },
      { kind: "textarea", name: "subtitle", label: "Subtitle", maxLength: 400 },
      {
        kind: "select",
        name: "align",
        label: "Alignment",
        options: [
          { value: "start", label: "Start" },
          { value: "center", label: "Center" },
        ],
      },
      {
        kind: "select",
        name: "tone",
        label: "Accent",
        options: [
          { value: "plain", label: "Plain" },
          { value: "spectrum", label: "Spectrum rule" },
        ],
      },
    ],
  },
});
