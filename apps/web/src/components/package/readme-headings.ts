/**
 * A README is nested content on the package page: the page already owns the only `<h1>` (the package name) and a
 * visually hidden "README" `<h2>`. Shifting README headings down two levels keeps one `<h1>` per page and a valid
 * outline. The original level is kept in `data-readme-level` so the README keeps its visual hierarchy.
 *
 * Input is README HTML already sanitized at index time; this only renames heading tags, adds one attribute and may
 * drop a leading title that repeats the package name shown right above it.
 */
export function nestReadmeHeadings(html: string, packageTitle?: string): string {
  const nested = html.replace(/<(\/?)h([1-6])(?=[\s>/])([^>]*)>/gi, (_match, slash: string, level: string, rest: string) => {
    const original = Number(level);
    const shifted = Math.min(6, original + 2);
    return slash ? `</h${shifted}>` : `<h${shifted} data-readme-level="${original}"${rest}>`;
  });
  return packageTitle ? dropRepeatedTitle(nested, packageTitle) : nested;
}

const LEADING_TITLE = /^\s*<h3 data-readme-level="1"[^>]*>([\s\S]*?)<\/h3>\s*/i;

function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Most READMEs open with `# <package name>`; the page header already shows it, so the repeat is dropped. */
function dropRepeatedTitle(html: string, packageTitle: string): string {
  const match = LEADING_TITLE.exec(html);
  if (!match) return html;
  const heading = plainText(match[1] ?? "");
  const title = packageTitle.replace(/\s+/g, " ").trim().toLowerCase();
  return heading === title ? html.slice(match[0].length) : html;
}
