import { escapeMarkdown, joinMarkdown, mdHeading, mdLink } from "@marketplace/page-engine";

/**
 * `llms.txt` (https://llmstxt.org): an H1 title, a blockquote summary, optional detail paragraphs, then H2
 * sections of annotated links. It is a curated map, not a dump: it points at Markdown twins and machine interfaces.
 * `llms-full.txt` inlines first-party Markdown documents (marketplace pages, policies, category descriptions) and
 * never third-party package READMEs, which stay behind each package's own Markdown URL.
 */
export interface LlmsLink {
  title: string;
  url: string;
  description?: string | undefined;
}

export interface LlmsSection {
  title: string;
  links: readonly LlmsLink[];
}

export interface LlmsTxtInput {
  title: string;
  summary: string;
  details?: readonly string[];
  sections: readonly LlmsSection[];
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function linkLine(link: LlmsLink): string {
  const description = link.description ? oneLine(link.description) : "";
  return `- ${mdLink(oneLine(link.title), link.url)}${description ? `: ${escapeMarkdown(description)}` : ""}`;
}

export function renderLlmsTxt(input: LlmsTxtInput): string {
  const sections = input.sections
    .filter((section) => section.links.length > 0)
    .map((section) => joinMarkdown([mdHeading(2, section.title), section.links.map(linkLine).join("\n")]));
  return `${joinMarkdown([
    mdHeading(1, input.title),
    `> ${escapeMarkdown(oneLine(input.summary))}`,
    ...(input.details ?? []),
    ...sections,
  ])}\n`;
}

export interface LlmsDocument {
  title: string;
  /** Canonical URL of the HTML page the Markdown was rendered from. */
  url: string;
  markdown: string;
}

export interface LlmsFullInput {
  title: string;
  summary: string;
  details?: readonly string[];
  documents: readonly LlmsDocument[];
}

export function renderLlmsFullTxt(input: LlmsFullInput): string {
  const documents = input.documents.map((document) =>
    joinMarkdown(["---", `Source: <${document.url}>`, document.markdown]),
  );
  return `${joinMarkdown([
    mdHeading(1, input.title),
    `> ${escapeMarkdown(oneLine(input.summary))}`,
    ...(input.details ?? []),
    ...documents,
  ])}\n`;
}
