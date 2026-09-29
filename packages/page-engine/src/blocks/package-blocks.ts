import type { CollectionDetail, PackageSummary } from "@marketplace/contracts";
import { z } from "zod";

import { defineBlock } from "../define-block";
import { absoluteUrl, escapeHtml, link } from "../html";
import { escapeMarkdown, joinMarkdown, mdHeading, mdLink } from "../markdown-text";
import type { PublisherProfile } from "../types";
import {
  emptyState,
  listNames,
  optionalHeading,
  packageCards,
  packageItemList,
  packageListMarkdown,
  plainText,
  sectionHeading,
  slugField,
} from "./shared";

const limit = (fallback: number) => z.int().min(1).max(24).default(fallback);

/*
 * Blocks bound to live marketplace data. They store a query (category, collection slug, publisher slug), never a
 * copy of the packages, so a published page always shows current, publicly visible listings. Revision pinning
 * freezes the query, not the results.
 */

const packageGridProps = z.object({
  title: optionalHeading,
  category: z.union([z.literal(""), slugField]).default(""),
  sort: z.enum(["latest", "name"]).default("latest"),
  limit: limit(6),
});

export const packageGridBlock = defineBlock<z.infer<typeof packageGridProps>, PackageSummary[]>({
  type: "package-grid",
  version: 1,
  propsSchema: packageGridProps,
  defaultProps: { title: "Latest packages", category: "", sort: "latest", limit: 6 },
  load: (props, port) => port.listPackages({ category: props.category || undefined, sort: props.sort, limit: props.limit }),
  renderWeb: ({ props, data }) =>
    `<section class="pe-block pe-packages">${sectionHeading(props.title)}` +
    `${data.length ? packageCards(data) : emptyState("No packages are listed here yet.")}</section>`,
  renderMarkdown: ({ props, data, siteUrl }) =>
    joinMarkdown([props.title ? mdHeading(2, props.title) : "", data.length ? packageListMarkdown(data, siteUrl) : "_No packages are listed here yet._"]),
  getStructuredData: ({ props, data, siteUrl }) => packageItemList(props.title || "Packages", data, siteUrl),
  getSemanticSummary: ({ props, data }) =>
    `${data.length} package${data.length === 1 ? "" : "s"}${props.category ? ` in category "${props.category}"` : ""}` +
    ` sorted by ${props.sort}${data.length ? `: ${listNames(data)}` : ""}.`,
  editor: {
    label: "Package grid",
    icon: "▦",
    description: "Live grid of listed packages, optionally filtered by category.",
    fields: [
      { kind: "text", name: "title", label: "Heading", maxLength: 160 },
      { kind: "reference", target: "category", name: "category", label: "Category slug", help: "Leave empty for all categories." },
      {
        kind: "select",
        name: "sort",
        label: "Order",
        options: [
          { value: "latest", label: "Latest first" },
          { value: "name", label: "By name" },
        ],
      },
      { kind: "number", name: "limit", label: "Number of packages", min: 1, max: 24 },
    ],
  },
});

const featuredProps = z.object({ title: optionalHeading, limit: limit(6) });

export const featuredPackagesBlock = defineBlock<z.infer<typeof featuredProps>, PackageSummary[]>({
  type: "featured-packages",
  version: 1,
  propsSchema: featuredProps,
  defaultProps: { title: "Featured", limit: 6 },
  load: (props, port) => port.listFeaturedPackages(props.limit),
  renderWeb: ({ props, data }) =>
    `<section class="pe-block pe-packages pe-featured">${sectionHeading(props.title)}` +
    `${data.length ? packageCards(data) : emptyState("Nothing is featured right now.")}</section>`,
  renderMarkdown: ({ props, data, siteUrl }) =>
    joinMarkdown([props.title ? mdHeading(2, props.title) : "", data.length ? packageListMarkdown(data, siteUrl) : "_Nothing is featured right now._"]),
  getStructuredData: ({ props, data, siteUrl }) => packageItemList(props.title || "Featured packages", data, siteUrl),
  getSemanticSummary: ({ data }) =>
    data.length ? `Featured packages: ${listNames(data)}.` : "Featured packages (none right now).",
  editor: {
    label: "Featured packages",
    icon: "★",
    description: "Packages curators marked as featured.",
    fields: [
      { kind: "text", name: "title", label: "Heading", maxLength: 160 },
      { kind: "number", name: "limit", label: "Number of packages", min: 1, max: 24 },
    ],
  },
});

const collectionProps = z.object({
  /** Empty until chosen; an empty or unknown slug renders an editor note and blocks publishing. */
  collectionSlug: z.union([z.literal(""), slugField]).default(""),
  title: optionalHeading,
  showDescription: z.boolean().default(true),
  limit: limit(12),
});

export const collectionBlock = defineBlock<z.infer<typeof collectionProps>, CollectionDetail | null>({
  type: "collection",
  version: 1,
  propsSchema: collectionProps,
  defaultProps: { collectionSlug: "", title: "", showDescription: true, limit: 12 },
  load: (props, port) => (props.collectionSlug ? port.getCollection(props.collectionSlug) : null),
  renderWeb: ({ props, data, diagnose }) => {
    if (!props.collectionSlug) return diagnose("Choose a collection for this block.");
    if (!data) return diagnose(`Collection "${props.collectionSlug}" does not exist or is not published.`);
    const packages = data.packages.slice(0, props.limit);
    const description = props.showDescription && data.description ? `<p class="pe-lede">${escapeHtml(data.description)}</p>` : "";
    const more = `<p class="pe-more">${link(`/collections/${data.slug}`, `See the whole ${data.title} collection`)}</p>`;
    return (
      `<section class="pe-block pe-packages pe-collection">${sectionHeading(props.title || data.title)}${description}` +
      `${packages.length ? packageCards(packages) : emptyState("This collection has no listed packages yet.")}${more}</section>`
    );
  },
  renderMarkdown: ({ props, data, siteUrl }) => {
    if (!data) return "";
    const packages = data.packages.slice(0, props.limit);
    return joinMarkdown([
      mdHeading(2, props.title || data.title),
      props.showDescription ? escapeMarkdown(data.description) : "",
      packages.length ? packageListMarkdown(packages, siteUrl) : "_This collection has no listed packages yet._",
      mdLink(`See the whole ${data.title} collection`, absoluteUrl(siteUrl, `/collections/${data.slug}.md`)),
    ]);
  },
  getStructuredData: ({ props, data, siteUrl }) =>
    data ? packageItemList(props.title || data.title, data.packages.slice(0, props.limit), siteUrl) : [],
  getSemanticSummary: ({ data }) =>
    data ? `Collection "${data.title}" with ${data.packages.length} package(s)${data.packages.length ? `: ${listNames(data.packages)}` : ""}.` : "",
  editor: {
    label: "Collection",
    icon: "❏",
    description: "Packages from a curated collection, in the curator's order.",
    fields: [
      { kind: "reference", target: "collection", name: "collectionSlug", label: "Collection slug", required: true },
      { kind: "text", name: "title", label: "Heading override", maxLength: 160, help: "Defaults to the collection title." },
      { kind: "boolean", name: "showDescription", label: "Show collection description" },
      { kind: "number", name: "limit", label: "Number of packages", min: 1, max: 24 },
    ],
  },
});

const publisherProps = z.object({
  publisherSlug: z.union([z.literal(""), slugField]).default(""),
  showPackages: z.boolean().default(true),
  limit: limit(6),
  intro: plainText(400).default(""),
});

export const publisherProfileBlock = defineBlock<z.infer<typeof publisherProps>, PublisherProfile | null>({
  type: "publisher-profile",
  version: 1,
  propsSchema: publisherProps,
  defaultProps: { publisherSlug: "", showPackages: true, limit: 6, intro: "" },
  load: (props, port) =>
    props.publisherSlug ? port.getPublisher(props.publisherSlug, props.showPackages ? props.limit : 0) : null,
  renderWeb: ({ props, data, diagnose }) => {
    if (!props.publisherSlug) return diagnose("Choose a publisher for this block.");
    if (!data) return diagnose(`Publisher "${props.publisherSlug}" was not found.`);
    const badge = data.verified ? ' <span class="pe-verified">verified publisher</span>' : "";
    const intro = props.intro ? `<p class="pe-lede">${escapeHtml(props.intro)}</p>` : "";
    const packages = props.showPackages
      ? data.packages.length
        ? packageCards(data.packages)
        : emptyState("No listed packages from this publisher yet.")
      : "";
    return (
      `<section class="pe-block pe-publisher"><p class="pe-eyebrow">${data.kind === "org" ? "Publisher" : "Author"}</p>` +
      `<h2 class="pe-heading">${escapeHtml(data.name)}${badge}</h2>${intro}${packages}</section>`
    );
  },
  renderMarkdown: ({ props, data, siteUrl }) => {
    if (!data) return "";
    return joinMarkdown([
      mdHeading(2, `${data.name}${data.verified ? " (verified publisher)" : ""}`),
      escapeMarkdown(props.intro),
      props.showPackages ? packageListMarkdown(data.packages, siteUrl) : "",
    ]);
  },
  getStructuredData: ({ data, siteUrl, path }) =>
    data
      ? [
          {
            "@context": "https://schema.org",
            "@type": data.kind === "org" ? "Organization" : "Person",
            name: data.name,
            url: absoluteUrl(siteUrl, path),
          },
        ]
      : [],
  getSemanticSummary: ({ data }) =>
    data
      ? `Publisher ${data.name}${data.verified ? " (verified)" : ""}${data.packages.length ? ` with packages: ${listNames(data.packages)}` : ""}.`
      : "",
  editor: {
    label: "Publisher profile",
    icon: "◎",
    description: "A publisher's name, verification state and listed packages.",
    fields: [
      { kind: "reference", target: "publisher", name: "publisherSlug", label: "Publisher slug", required: true },
      { kind: "textarea", name: "intro", label: "Intro", maxLength: 400 },
      { kind: "boolean", name: "showPackages", label: "Show packages" },
      { kind: "number", name: "limit", label: "Number of packages", min: 1, max: 24 },
    ],
  },
});
