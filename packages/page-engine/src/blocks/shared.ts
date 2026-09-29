import { packageNameSchema, slugSchema, type PackageSummary } from "@marketplace/contracts";
import { z } from "zod";

import { absoluteUrl, escapeHtml, isSafeUrl, packagePath } from "../html";
import { escapeMarkdown, mdLink } from "../markdown-text";

/** Single-line plain text: trimmed, bounded, no control characters. */
export const plainText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !hasControlCharacter(value), { error: "must not contain control characters" });

/** C0 controls other than tab and newline, and DEL: invisible characters that have no place in page text. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 8 || (code >= 11 && code <= 31) || code === 127) return true;
  }
  return false;
}

export const requiredText = (max: number) => plainText(max).min(1, { error: "is required" });

/** Link targets a block may store: site paths, fragments, mailto and http(s). Checked again at render time. */
export const hrefSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(isSafeUrl, { error: "must be a site path (/…), #fragment, mailto: or http(s) URL" });

/** Media ids are opaque ids issued by the media service (e.g. `med_…`). */
export const mediaIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, { error: "must be a media id" });

export const packageNameField = packageNameSchema;
export const slugField = slugSchema;

export const optionalHeading = plainText(160).default("");

export function sectionHeading(title: string, level = 2): string {
  return title ? `<h${level} class="pe-heading">${escapeHtml(title)}</h${level}>` : "";
}

export function packageCards(packages: readonly PackageSummary[]): string {
  if (packages.length === 0) return "";
  const items = packages
    .map((pkg) => {
      const publisher = pkg.publisher
        ? `${escapeHtml(pkg.publisher.name)}${pkg.publisher.verified ? ' <span class="pe-verified">verified publisher</span>' : ""}`
        : "Unclaimed publisher";
      const version = pkg.latestVersion ? ` · v${escapeHtml(pkg.latestVersion)}` : "";
      const description = pkg.description
        ? `<p class="pe-card-text">${escapeHtml(pkg.description)}</p>`
        : '<p class="pe-card-text pe-faint">No description provided.</p>';
      return (
        `<li><article class="pe-card"><h3 class="pe-card-title"><a href="${escapeHtml(packagePath(pkg.name))}">` +
        `${escapeHtml(pkg.displayName)}</a></h3><p class="pe-mono pe-faint">${escapeHtml(pkg.name)}${version}</p>` +
        `${description}<p class="pe-card-meta">${publisher}</p></article></li>`
      );
    })
    .join("");
  return `<ul class="pe-grid">${items}</ul>`;
}

/**
 * A link target as it must appear in a Markdown twin, which is read on its own (pasted into an assistant, fetched by
 * an agent): site paths and fragments become absolute URLs; mailto and external URLs are unchanged.
 */
export function markdownHref(siteUrl: string, pagePath: string, href: string): string {
  if (href.startsWith("#")) return `${absoluteUrl(siteUrl, pagePath)}${href}`;
  if (href.startsWith("/")) return absoluteUrl(siteUrl, href);
  return href;
}

/** Package lines for a Markdown twin; each links the package's own Markdown twin by absolute URL. */
export function packageListMarkdown(packages: readonly PackageSummary[], siteUrl: string): string {
  return packages
    .map((pkg) => {
      const description = pkg.description ? ` — ${escapeMarkdown(pkg.description)}` : "";
      const version = pkg.latestVersion ? ` (v${escapeMarkdown(pkg.latestVersion)})` : "";
      return `- ${mdLink(pkg.displayName, absoluteUrl(siteUrl, `${packagePath(pkg.name)}.md`))}${version}${description}`;
    })
    .join("\n");
}

export function packageItemList(
  name: string,
  packages: readonly PackageSummary[],
  siteUrl: string,
): Record<string, unknown>[] {
  if (packages.length === 0) return [];
  return [
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name,
      itemListElement: packages.map((pkg, index) => ({
        "@type": "ListItem",
        position: index + 1,
        url: absoluteUrl(siteUrl, packagePath(pkg.name)),
        name: pkg.displayName,
      })),
    },
  ];
}

export function emptyState(message: string): string {
  return `<p class="pe-empty">${escapeHtml(message)}</p>`;
}

export function listNames(packages: readonly PackageSummary[], max = 5): string {
  const names = packages.slice(0, max).map((pkg) => pkg.displayName);
  const rest = packages.length - names.length;
  return names.join(", ") + (rest > 0 ? ` and ${rest} more` : "");
}
