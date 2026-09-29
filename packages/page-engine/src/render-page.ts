import type { BlockNode, PageDocument } from "@marketplace/contracts";

import { absoluteUrl, escapeHtml } from "./html";
import { assignRegions, getLayout } from "./layouts";
import { escapeMarkdown, joinMarkdown, mdHeading } from "./markdown-text";
import { getBlock } from "./registry";
import type { MediaAsset, RenderOptions, RenderedBlock, RenderedPage } from "./types";

/** Formats social platforms render as a card image (SVG is not accepted by the major unfurlers). */
const SOCIAL_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const EMPTY: RenderedBlock = { html: "", markdown: "", summary: "", structuredData: [], diagnostics: [] };

/**
 * The single renderer for page documents. The public route, the signed preview, the builder canvas, the Markdown
 * twin and agent views all call this, so what an editor sees is what gets published. Output HTML contains only
 * escaped text and sanitized Markdown HTML; the document itself never carries markup.
 */
export async function renderPage(document: PageDocument, options: RenderOptions): Promise<RenderedPage> {
  const diagnostics: string[] = [];
  const layout = getLayout(document.layout.id, document.layout.version);
  if (!layout) {
    diagnostics.push(`unknown layout ${document.layout.id}@${document.layout.version}`);
  }

  const rendered = await Promise.all(document.blocks.map((node) => renderNode(node, options)));
  const byNode = new Map(document.blocks.map((node, index) => [node, rendered[index] ?? EMPTY]));
  for (const block of rendered) diagnostics.push(...block.diagnostics);

  const startsWithHero = document.blocks[0]?.type === "hero";
  const pageHeading = startsWithHero
    ? ""
    : `<header class="pe-block pe-page-header"><h1 class="pe-display">${escapeHtml(document.meta.title)}</h1>` +
      `${document.meta.description ? `<p class="pe-lede">${escapeHtml(document.meta.description)}</p>` : ""}</header>`;

  let body: string;
  const placement = layout ? assignRegions(layout, document.blocks) : null;
  if (placement?.ok) {
    body = placement.regions
      .filter((slot) => slot.blocks.length > 0)
      .map(
        (slot) =>
          `<div class="pe-region pe-region-${escapeHtml(slot.region.id)}" data-region="${escapeHtml(slot.region.id)}">` +
          `${slot.blocks.map((node) => byNode.get(node)?.html ?? "").join("")}</div>`,
      )
      .join("");
  } else {
    if (placement && !placement.ok) diagnostics.push("blocks do not fit the layout's regions");
    body = `<div class="pe-region pe-region-main" data-region="main">${rendered.map((block) => block.html).join("")}</div>`;
  }

  const html = `<div class="pe-page pe-layout-${escapeHtml(document.layout.id)}">${pageHeading}${body}</div>`;

  const markdown = joinMarkdown([
    startsWithHero ? "" : mdHeading(1, document.meta.title),
    startsWithHero ? "" : escapeMarkdown(document.meta.description),
    ...rendered.map((block) => block.markdown),
  ]);

  const pageUrl = absoluteUrl(options.siteUrl, options.path);
  const structuredData = [
    {
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: document.meta.title,
      ...(document.meta.description ? { description: document.meta.description } : {}),
      url: pageUrl,
      inLanguage: document.meta.locale,
    },
    ...rendered.flatMap((block) => block.structuredData),
  ];

  const socialImage = await resolveSocialImage(document, options, diagnostics);

  const summaryLines = rendered.map((block) => block.summary).filter((line) => line.length > 0);
  const summary = [
    `Page "${document.meta.title}" at ${pageUrl}${layout ? ` (${layout.label} layout)` : ""}.`,
    document.meta.description,
    ...summaryLines.map((line) => `- ${line}`),
  ]
    .filter((line) => line.length > 0)
    .join("\n");

  return { html, markdown, structuredData, summary, diagnostics, socialImage };
}

async function resolveSocialImage(document: PageDocument, options: RenderOptions, diagnostics: string[]): Promise<MediaAsset | null> {
  const id = document.meta.image;
  if (!id) return null;
  const media = await options.port.getMedia(id);
  if (!media) {
    diagnostics.push(`share image "${id}" is not an uploaded media object`);
    return null;
  }
  if (!SOCIAL_IMAGE_TYPES.has(media.contentType)) {
    diagnostics.push(`share image "${id}" is ${media.contentType}; use a PNG, JPEG, WebP or GIF image`);
    return null;
  }
  return media;
}

async function renderNode(node: BlockNode, options: RenderOptions): Promise<RenderedBlock> {
  const block = getBlock(node.type, node.version);
  if (!block) {
    // A stored block this build cannot render stays in the document untouched; editors see why it is missing.
    const message = `${node.type} "${node.id}": this build has no renderer for ${node.type}@${node.version}`;
    return {
      ...EMPTY,
      html: options.mode === "public" ? "" : `<p class="pe-diagnostic" role="note">${escapeHtml(message)}</p>`,
      diagnostics: [message],
    };
  }
  const childResults = await Promise.all((node.children ?? []).map((child) => renderNode(child, options)));
  const result = await block.render(node, node.props, options, {
    html: childResults.map((child) => child.html).join(""),
    markdown: joinMarkdown(childResults.map((child) => child.markdown)),
    summaries: childResults.map((child) => child.summary).filter(Boolean),
    structuredData: childResults.flatMap((child) => child.structuredData),
    diagnostics: childResults.flatMap((child) => child.diagnostics),
  });
  if (options.mode !== "canvas") return result;
  // The builder canvas needs to know which markup belongs to which node, for click-to-select.
  return { ...result, html: `<div class="pe-node" data-block-id="${escapeHtml(node.id)}">${result.html}</div>` };
}
