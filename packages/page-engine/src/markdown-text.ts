/**
 * Helpers for the Markdown renderer. Markdown output is built from the page AST, never scraped from HTML, and every
 * piece of plain text is escaped so a title like `*new*` stays literal text.
 */

/** CRLF, a lone LF or a lone CR: each ends a line in Markdown. */
const LINE_BREAKS = /\r\n?|\n/g;

export function escapeMarkdown(value: string): string {
  const inline = value.replace(LINE_BREAKS, " ").replace(/([\\`*_[\]<>|~])/g, "\\$1");
  // Block syntax (headings, list markers, setext underlines) only counts at the start of a line, and values are
  // single-line, so only the start needs escaping. This keeps ordinary punctuation readable.
  return inline.replace(/^(\s*)([#+=-])/, "$1\\$2").replace(/^(\s*\d+)([.)])/, "$1\\$2");
}

/** Percent-encodes the characters that would end or break a Markdown link destination. */
export function mdUrl(url: string): string {
  return url.replace(/[()\s<>]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

export function mdLink(text: string, href: string): string {
  return `[${escapeMarkdown(text)}](${mdUrl(href)})`;
}

export function mdHeading(level: number, text: string): string {
  return `${"#".repeat(Math.min(Math.max(level, 1), 6))} ${escapeMarkdown(text)}`;
}

/** A fenced code block whose fence is longer than any backtick run in the content. */
export function mdCode(code: string, language = ""): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${code}\n${fence}`;
}

/**
 * An inline code span that shows `value` literally: the fence is longer than any backtick run inside it, so the value
 * cannot close the span early and turn the rest into links or HTML. Code spans are single-line, so line breaks become
 * spaces. A value that starts or ends with a backtick or a space is padded, because CommonMark strips one space from
 * each side; a value of only spaces is not, because CommonMark keeps those as they are. An empty value becomes a span
 * of one space: an empty pair of backticks would be literal text that a later backtick on the line could pair with.
 */
export function mdInlineCode(value: string): string {
  const text = value.replace(LINE_BREAKS, " ");
  if (text === "") return "` `";
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = !/^ +$/.test(text) && /^[` ]|[` ]$/.test(text) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

export function mdTableCell(value: string): string {
  return escapeMarkdown(value);
}

/** Joins non-empty Markdown sections with one blank line between them. */
export function joinMarkdown(parts: readonly string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
}

/** First `max` characters of a text, cut at a word boundary, for semantic summaries. */
export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Plain text from Markdown source, good enough for summaries (not for display). */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
