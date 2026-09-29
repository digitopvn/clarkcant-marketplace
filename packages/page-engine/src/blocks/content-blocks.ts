import { z } from "zod";

import { defineBlock } from "../define-block";
import { escapeHtml, link } from "../html";
import { escapeMarkdown, joinMarkdown, mdHeading, mdLink, mdTableCell } from "../markdown-text";
import type { MarketplaceStats } from "../types";
import { hrefSchema, optionalHeading, plainText, requiredText, sectionHeading } from "./shared";

/* Blocks whose content is authored in the page itself (plus `stats`, which can bind live counts). */

const LIVE_METRICS = {
  packages: "Listed packages",
  publishers: "Publishers",
  categories: "Categories",
} as const satisfies Record<keyof MarketplaceStats, string>;

const statItem = z
  .object({
    label: requiredText(60),
    /** Either a live metric resolved at render time or a value the editor typed. */
    metric: z.enum(["manual", "packages", "publishers", "categories"]).default("manual"),
    value: plainText(24).default(""),
    description: plainText(160).default(""),
  })
  .refine((item) => item.metric !== "manual" || item.value.length > 0, {
    error: "a manual stat needs a value",
    path: ["value"],
  });

const statsProps = z.object({ title: optionalHeading, items: z.array(statItem).min(1).max(6) });
type StatsProps = z.infer<typeof statsProps>;

function statValues(props: StatsProps, stats: MarketplaceStats | null): string[] {
  return props.items.map((item) =>
    item.metric === "manual" ? item.value : stats ? stats[item.metric].toLocaleString("en-US") : "—",
  );
}

export const statsBlock = defineBlock<StatsProps, MarketplaceStats | null>({
  type: "stats",
  version: 1,
  propsSchema: statsProps,
  defaultProps: {
    title: "",
    items: [
      { label: LIVE_METRICS.packages, metric: "packages", value: "", description: "" },
      { label: LIVE_METRICS.publishers, metric: "publishers", value: "", description: "" },
    ],
  },
  load: (props, port) => (props.items.some((item) => item.metric !== "manual") ? port.getMarketplaceStats() : null),
  renderWeb: ({ props, data }) => {
    const values = statValues(props, data);
    const items = props.items
      .map(
        (item, index) =>
          `<div class="pe-stat"><dt>${escapeHtml(item.label)}</dt><dd class="pe-stat-value">${escapeHtml(values[index] ?? "")}</dd>` +
          `${item.description ? `<dd class="pe-stat-note">${escapeHtml(item.description)}</dd>` : ""}</div>`,
      )
      .join("");
    return `<section class="pe-block pe-stats">${sectionHeading(props.title)}<dl class="pe-stat-list">${items}</dl></section>`;
  },
  renderMarkdown: ({ props, data }) => {
    const values = statValues(props, data);
    return joinMarkdown([
      props.title ? mdHeading(2, props.title) : "",
      props.items
        .map((item, index) => `- **${escapeMarkdown(item.label)}:** ${escapeMarkdown(values[index] ?? "")}${item.description ? ` — ${escapeMarkdown(item.description)}` : ""}`)
        .join("\n"),
    ]);
  },
  getSemanticSummary: ({ props, data }) => {
    const values = statValues(props, data);
    return `Figures: ${props.items.map((item, index) => `${item.label} ${values[index] ?? ""}`).join("; ")}.`;
  },
  editor: {
    label: "Stats",
    icon: "#",
    description: "Up to six figures. Each is typed in or bound to a live marketplace count.",
    fields: [
      { kind: "text", name: "title", label: "Heading", maxLength: 160 },
      {
        kind: "list",
        name: "items",
        label: "Figures",
        itemLabel: "Figure",
        minItems: 1,
        maxItems: 6,
        fields: [
          { kind: "text", name: "label", label: "Label", required: true, maxLength: 60 },
          {
            kind: "select",
            name: "metric",
            label: "Source",
            options: [
              { value: "manual", label: "Typed value" },
              { value: "packages", label: "Live: listed packages" },
              { value: "publishers", label: "Live: publishers" },
              { value: "categories", label: "Live: categories" },
            ],
          },
          { kind: "text", name: "value", label: "Value (typed source only)", maxLength: 24 },
          { kind: "text", name: "description", label: "Note", maxLength: 160 },
        ],
      },
    ],
  },
});

const action = z.object({ label: requiredText(60), href: hrefSchema });

const ctaProps = z.object({
  title: plainText(160).default(""),
  body: plainText(400).default(""),
  primary: action,
  secondary: action.optional(),
});

export const ctaBlock = defineBlock({
  type: "cta",
  version: 1,
  propsSchema: ctaProps,
  defaultProps: { title: "", body: "", primary: { label: "Browse packages", href: "/packages" } },
  renderWeb: ({ props }) => {
    const title = props.title ? `<h2 class="pe-heading">${escapeHtml(props.title)}</h2>` : "";
    const body = props.body ? `<p class="pe-lede">${escapeHtml(props.body)}</p>` : "";
    const secondary = props.secondary ? link(props.secondary.href, props.secondary.label, "pe-button pe-button-quiet") : "";
    return (
      `<section class="pe-block pe-cta">${title}${body}<div class="pe-actions">` +
      `${link(props.primary.href, props.primary.label, "pe-button")}${secondary}</div></section>`
    );
  },
  renderMarkdown: ({ props }) =>
    joinMarkdown([
      props.title ? mdHeading(2, props.title) : "",
      escapeMarkdown(props.body),
      [mdLink(props.primary.label, props.primary.href), props.secondary ? mdLink(props.secondary.label, props.secondary.href) : ""]
        .filter(Boolean)
        .join(" · "),
    ]),
  getSemanticSummary: ({ props }) =>
    `Call to action${props.title ? ` "${props.title}"` : ""}: ${props.primary.label} (${props.primary.href})` +
    `${props.secondary ? `, ${props.secondary.label} (${props.secondary.href})` : ""}.`,
  editor: {
    label: "Call to action",
    icon: "→",
    description: "A short prompt with one or two links styled as buttons.",
    fields: [
      { kind: "text", name: "title", label: "Heading", maxLength: 160 },
      { kind: "textarea", name: "body", label: "Text", maxLength: 400 },
      {
        kind: "group",
        name: "primary",
        label: "Primary action",
        fields: [
          { kind: "text", name: "label", label: "Label", required: true, maxLength: 60 },
          { kind: "url", name: "href", label: "Link", required: true },
        ],
      },
      {
        kind: "group",
        name: "secondary",
        label: "Secondary action",
        optional: true,
        fields: [
          { kind: "text", name: "label", label: "Label", required: true, maxLength: 60 },
          { kind: "url", name: "href", label: "Link", required: true },
        ],
      },
    ],
  },
});

const faqProps = z.object({
  title: plainText(160).default("Frequently asked questions"),
  items: z
    .array(z.object({ question: requiredText(200), answer: requiredText(2000).max(2000) }))
    .min(1)
    .max(30),
});

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br />")}</p>`)
    .join("");
}

/** Question/answer pairs. Uses native `<details>` so it works without JavaScript and with the keyboard. */
export const faqBlock = defineBlock({
  type: "faq",
  version: 1,
  propsSchema: faqProps,
  defaultProps: {
    title: "Frequently asked questions",
    items: [{ question: "What is this page about?", answer: "Replace this with a real answer." }],
  },
  renderWeb: ({ props }) =>
    `<section class="pe-block pe-faq">${sectionHeading(props.title)}` +
    props.items
      .map((item) => `<details class="pe-faq-item"><summary>${escapeHtml(item.question)}</summary><div class="pe-faq-answer">${paragraphs(item.answer)}</div></details>`)
      .join("") +
    "</section>",
  renderMarkdown: ({ props }) =>
    joinMarkdown([
      props.title ? mdHeading(2, props.title) : "",
      ...props.items.map((item) => joinMarkdown([mdHeading(3, item.question), item.answer.split(/\n{2,}/).map(escapeMarkdown).join("\n\n")])),
    ]),
  getStructuredData: ({ props }) => [
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: props.items.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: { "@type": "Answer", text: item.answer },
      })),
    },
  ],
  getSemanticSummary: ({ props }) => `FAQ with ${props.items.length} question(s): ${props.items.map((item) => item.question).join(" | ")}.`,
  editor: {
    label: "FAQ",
    icon: "?",
    description: "Questions with plain-text answers. Emits FAQPage structured data.",
    fields: [
      { kind: "text", name: "title", label: "Heading", maxLength: 160 },
      {
        kind: "list",
        name: "items",
        label: "Questions",
        itemLabel: "Question",
        minItems: 1,
        maxItems: 30,
        fields: [
          { kind: "text", name: "question", label: "Question", required: true, maxLength: 200 },
          { kind: "textarea", name: "answer", label: "Answer", required: true, maxLength: 2000, help: "Blank lines start new paragraphs." },
        ],
      },
    ],
  },
});

const comparisonProps = z
  .object({
    title: optionalHeading,
    columns: z.array(requiredText(60)).min(2).max(4),
    rows: z
      .array(z.object({ label: requiredText(80), values: z.array(plainText(120)).min(2).max(4) }))
      .min(1)
      .max(30),
  })
  .superRefine((props, ctx) => {
    props.rows.forEach((row, index) => {
      if (row.values.length !== props.columns.length) {
        ctx.addIssue({
          code: "custom",
          path: ["rows", index, "values"],
          message: `row "${row.label}" has ${row.values.length} values but the table has ${props.columns.length} columns`,
        });
      }
    });
  });

export const comparisonBlock = defineBlock({
  type: "comparison",
  version: 1,
  propsSchema: comparisonProps,
  defaultProps: {
    title: "",
    columns: ["Option A", "Option B"],
    rows: [{ label: "Feature", values: ["Yes", "No"] }],
  },
  renderWeb: ({ props }) => {
    const head = `<tr><td></td>${props.columns.map((column) => `<th scope="col">${escapeHtml(column)}</th>`).join("")}</tr>`;
    const body = props.rows
      .map((row) => `<tr><th scope="row">${escapeHtml(row.label)}</th>${row.values.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`)
      .join("");
    return (
      `<section class="pe-block pe-comparison">${sectionHeading(props.title)}<div class="pe-table-scroll" tabindex="0" role="region" ` +
      `aria-label="${escapeHtml(props.title || "Comparison table")}"><table><thead>${head}</thead><tbody>${body}</tbody></table></div></section>`
    );
  },
  renderMarkdown: ({ props }) =>
    joinMarkdown([
      props.title ? mdHeading(2, props.title) : "",
      [
        `| | ${props.columns.map(mdTableCell).join(" | ")} |`,
        `| --- | ${props.columns.map(() => "---").join(" | ")} |`,
        ...props.rows.map((row) => `| ${mdTableCell(row.label)} | ${row.values.map(mdTableCell).join(" | ")} |`),
      ].join("\n"),
    ]),
  getSemanticSummary: ({ props }) =>
    `Comparison of ${props.columns.join(", ")} across ${props.rows.map((row) => row.label).join(", ")}.`,
  editor: {
    label: "Comparison table",
    icon: "⊞",
    description: "A table comparing two to four options row by row.",
    fields: [
      { kind: "text", name: "title", label: "Heading", maxLength: 160 },
      { kind: "list", name: "columns", label: "Columns", itemLabel: "Column", minItems: 2, maxItems: 4, fields: [{ kind: "text", name: "", label: "Column name", required: true, maxLength: 60 }] },
      {
        kind: "list",
        name: "rows",
        label: "Rows",
        itemLabel: "Row",
        minItems: 1,
        maxItems: 30,
        fields: [
          { kind: "text", name: "label", label: "Row label", required: true, maxLength: 80 },
          { kind: "list", name: "values", label: "Values (one per column)", itemLabel: "Value", minItems: 2, maxItems: 4, fields: [{ kind: "text", name: "", label: "Value", maxLength: 120 }] },
        ],
      },
    ],
  },
});
