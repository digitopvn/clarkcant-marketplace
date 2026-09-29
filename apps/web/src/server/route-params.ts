/**
 * Astro passes route params without percent-decoding them, so the canonical package URL
 * (`/packages/%40scope/name`, the form every sitemap, JSON-LD and page-engine link uses) would arrive as
 * `%40scope/name`. Decoding here makes the encoded and the literal `@` form reach the same package. A malformed
 * escape is passed through unchanged and then fails the service's own name validation (a 404).
 */
export function decodeRouteParam(value: string | undefined): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
