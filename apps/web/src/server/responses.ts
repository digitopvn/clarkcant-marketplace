/**
 * Responses for the machine-readable surfaces (Markdown twins, robots.txt, llms.txt, sitemaps). They are public and
 * change only when the catalogue changes, so shared caches may keep them for a few minutes.
 */

const PUBLIC_CACHE = "public, max-age=300, stale-while-revalidate=600";

export interface MarkdownResponseOptions {
  /** Absolute URL of the HTML page this document mirrors; sent as `Link: rel="canonical"`. */
  canonical: string;
  noindex?: boolean;
  etag?: string;
}

/**
 * A Markdown twin. The `Link` header names the HTML page as canonical so search engines index the page, not both.
 * `noindex` twins also carry `X-Robots-Tag`.
 */
export function markdownResponse(body: string, options: MarkdownResponseOptions): Response {
  const headers = new Headers({
    "content-type": "text/markdown; charset=utf-8",
    "cache-control": PUBLIC_CACHE,
    link: `<${options.canonical}>; rel="canonical"`,
  });
  if (options.noindex) headers.set("x-robots-tag", "noindex");
  if (options.etag) headers.set("etag", `"${options.etag}"`);
  return new Response(body, { status: 200, headers });
}

/**
 * Plain text. `noindex` keeps agent-facing guides (llms.txt) out of search results while they stay fetchable, so a
 * search hit lands on the HTML page instead.
 */
export function textResponse(body: string, options: { noindex?: boolean } = {}): Response {
  const headers = new Headers({ "content-type": "text/plain; charset=utf-8", "cache-control": PUBLIC_CACHE });
  if (options.noindex) headers.set("x-robots-tag", "noindex");
  return new Response(body, { status: 200, headers });
}

export function xmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/xml; charset=utf-8", "cache-control": PUBLIC_CACHE } });
}

export function notFoundText(message: string): Response {
  return new Response(`${message}\n`, { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
