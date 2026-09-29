/**
 * The only way block renderers turn data into markup. Every interpolated value goes through `escapeHtml` (text and
 * attribute values alike, since both quote kinds are escaped), and every URL through `safeHref`, so a page document
 * can never inject markup, script or a `javascript:` link.
 */
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/**
 * Accepts site-relative paths (`/x`, `#x`), `mailto:` and absolute http(s) URLs; anything else (including
 * protocol-relative `//host` and `javascript:`) becomes `#`. The result is attribute-escaped.
 */
export function safeHref(url: string): string {
  const trimmed = url.trim();
  if (isSafeUrl(trimmed)) return escapeHtml(trimmed);
  return "#";
}

export function isSafeUrl(url: string): boolean {
  if (url.startsWith("#")) return true;
  if (url.startsWith("/")) return !url.startsWith("//") && !url.startsWith("/\\");
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" || parsed.protocol === "mailto:";
  } catch {
    return false;
  }
}

export function isExternalUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/** An anchor with escaped text; external links open normally but never pass the opener. */
export function link(href: string, text: string, className?: string): string {
  const rel = isExternalUrl(href) ? ' rel="noopener"' : "";
  const cls = className ? ` class="${escapeHtml(className)}"` : "";
  return `<a href="${safeHref(href)}"${cls}${rel}>${escapeHtml(text)}</a>`;
}

/** Site path of a package detail page. Scoped names keep their slash; each segment is percent-encoded. */
export function packagePath(name: string): string {
  return `/packages/${name.split("/").map(encodeURIComponent).join("/")}`;
}

/** JSON for a `<script type="application/ld+json">` body: `<` is escaped so the data can never close the tag. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replaceAll(String.fromCharCode(0x2028), "\\u2028")
    .replaceAll(String.fromCharCode(0x2029), "\\u2029");
}

/** Absolute URL for a site-relative path; absolute inputs are returned unchanged. */
export function absoluteUrl(siteUrl: string, path: string): string {
  if (isExternalUrl(path)) return path;
  return `${siteUrl}${path.startsWith("/") ? path : `/${path}`}`;
}
