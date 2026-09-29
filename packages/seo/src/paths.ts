/*
 * Site path rules with no imports, so browser code (the page builder, the share bar) can use them without pulling
 * the page engine into a client bundle.
 */

/**
 * Path of the Markdown twin of an HTML page: `/` becomes `/index.md`, `/packages/x` becomes `/packages/x.md`. Only
 * paths without a query or fragment have twins.
 */
export function markdownPathFor(path: string): string {
  if (path === "/" || path === "") return "/index.md";
  return `${path.replace(/\/+$/, "")}.md`;
}

export function categoryPath(slug: string): string {
  return `/categories/${encodeURIComponent(slug)}`;
}

export function collectionPath(slug: string): string {
  return `/collections/${encodeURIComponent(slug)}`;
}
