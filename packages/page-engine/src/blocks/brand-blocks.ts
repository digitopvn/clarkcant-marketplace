import type { PackageSummary } from "@marketplace/contracts";
import { z } from "zod";

import { defineBlock } from "../define-block";
import { escapeHtml, isExternalUrl, packagePath, safeHref } from "../html";
import { escapeMarkdown, joinMarkdown, mdCode, mdHeading, mdLink } from "../markdown-text";
import type { MediaAsset } from "../types";
import { hrefSchema, markdownHref, mediaIdSchema, optionalHeading, packageNameField, plainText, requiredText, sectionHeading } from "./shared";

const logoProps = z.object({
  title: optionalHeading,
  logos: z
    .array(
      z.object({
        name: requiredText(80),
        mediaId: z.union([z.literal(""), mediaIdSchema]).default(""),
        href: z.union([z.literal(""), hrefSchema]).default(""),
      }),
    )
    .min(1)
    .max(24),
});
type LogoProps = z.infer<typeof logoProps>;

/** A row of logos. A logo without an image renders as its name, so the block never shows a broken image. */
export const logoCloudBlock = defineBlock<LogoProps, (MediaAsset | null)[]>({
  type: "logo-cloud",
  version: 1,
  propsSchema: logoProps,
  defaultProps: { title: "", logos: [{ name: "ClarkCant", mediaId: "", href: "https://clarkcant.cc" }] },
  load: (props, port) => Promise.all(props.logos.map((logo) => (logo.mediaId ? port.getMedia(logo.mediaId) : null))),
  renderWeb: ({ props, data, diagnose }) => {
    const items = props.logos
      .map((logo, index) => {
        const media = data[index] ?? null;
        const missing = logo.mediaId && !media ? diagnose(`Logo "${logo.name}" references missing media "${logo.mediaId}".`) : "";
        const mark = media
          ? `<img src="${escapeHtml(media.url)}" alt="${escapeHtml(logo.name)}" loading="lazy" decoding="async" />`
          : `<span class="pe-logo-name">${escapeHtml(logo.name)}</span>`;
        const rel = isExternalUrl(logo.href) ? ' rel="noopener"' : "";
        const body = logo.href ? `<a href="${safeHref(logo.href)}"${rel}>${mark}</a>` : mark;
        return `<li class="pe-logo">${body}${missing}</li>`;
      })
      .join("");
    return `<section class="pe-block pe-logos">${sectionHeading(props.title)}<ul class="pe-logo-list">${items}</ul></section>`;
  },
  renderMarkdown: ({ props, siteUrl, path }) =>
    joinMarkdown([
      props.title ? mdHeading(2, props.title) : "",
      props.logos
        .map((logo) => `- ${logo.href ? mdLink(logo.name, markdownHref(siteUrl, path, logo.href)) : escapeMarkdown(logo.name)}`)
        .join("\n"),
    ]),
  getSemanticSummary: ({ props }) => `Logos: ${props.logos.map((logo) => logo.name).join(", ")}.`,
  editor: {
    label: "Logo cloud",
    icon: "◇",
    description: "Names or logos of projects, partners or publishers, optionally linked.",
    fields: [
      { kind: "text", name: "title", label: "Heading", maxLength: 160 },
      {
        kind: "list",
        name: "logos",
        label: "Logos",
        itemLabel: "Logo",
        minItems: 1,
        maxItems: 24,
        fields: [
          { kind: "text", name: "name", label: "Name", required: true, maxLength: 80 },
          { kind: "reference", target: "media", name: "mediaId", label: "Logo image id" },
          { kind: "url", name: "href", label: "Link" },
        ],
      },
    ],
  },
});

const snippetProps = z.object({
  title: optionalHeading,
  /** Empty until chosen; an empty or unlisted package renders an editor note and blocks publishing. */
  packageName: z.union([z.literal(""), packageNameField]).default(""),
  /** Exact version to pin; empty uses the latest listed version at render time. */
  version: z.union([z.literal(""), z.string().trim().max(80).regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, { error: "must be an exact semver version" })]).default(""),
  note: plainText(300).default(""),
});
type SnippetProps = z.infer<typeof snippetProps>;

function coordinate(props: SnippetProps, pkg: PackageSummary | null): string {
  const version = props.version || pkg?.latestVersion || "";
  return version ? `${props.packageName}@${version}` : props.packageName;
}

/**
 * The npm coordinate of a package as a copyable command. npm distributes the package; ClarkCant installs it and asks
 * for each permission, which the note under the command says plainly.
 */
export const codeInstallSnippetBlock = defineBlock<SnippetProps, PackageSummary | null>({
  type: "code-install-snippet",
  version: 1,
  propsSchema: snippetProps,
  defaultProps: { title: "", packageName: "", version: "", note: "" },
  load: (props, port) => (props.packageName ? port.getPackage(props.packageName) : null),
  renderWeb: ({ props, data, diagnose }) => {
    if (!props.packageName) return diagnose("Choose a package for this install snippet.");
    const command = `npm install ${coordinate(props, data)}`;
    const missing = data ? "" : diagnose(`Package "${props.packageName}" is not listed in the marketplace.`);
    const detail = data ? ` <a href="${escapeHtml(packagePath(data.name))}">Package details</a>` : "";
    const note = props.note || "Install from inside ClarkCant, which shows every permission the package requests before it runs.";
    return (
      `<section class="pe-block pe-snippet">${sectionHeading(props.title, 3)}<pre class="pe-code"><code>${escapeHtml(command)}</code></pre>` +
      `<p class="pe-snippet-note">${escapeHtml(note)}${detail}</p>${missing}</section>`
    );
  },
  renderMarkdown: ({ props, data }) =>
    !props.packageName
      ? ""
      : joinMarkdown([
      props.title ? mdHeading(3, props.title) : "",
      mdCode(`npm install ${coordinate(props, data)}`, "sh"),
      escapeMarkdown(props.note || "Install from inside ClarkCant, which shows every permission the package requests before it runs."),
    ]),
  getSemanticSummary: ({ props, data }) => (props.packageName ? `Install command for npm package ${coordinate(props, data)}.` : ""),
  editor: {
    label: "Install snippet",
    icon: "$",
    description: "The npm install command for a package, pinned to a version.",
    fields: [
      { kind: "text", name: "title", label: "Heading", maxLength: 160 },
      { kind: "reference", target: "package", name: "packageName", label: "npm package name", required: true },
      { kind: "text", name: "version", label: "Exact version", help: "Leave empty to use the latest listed version.", maxLength: 80 },
      { kind: "textarea", name: "note", label: "Note", maxLength: 300 },
    ],
  },
});
