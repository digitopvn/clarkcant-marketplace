/**
 * Content Security Policy hashes for inline scripts Astro does not process itself (the inline theme script, the
 * builder canvas script). Astro's CSP (`security.csp` in astro.config.ts) is sent as a response header on this
 * adapter and includes whatever script hashes are inserted through `Astro.csp` from page or layout frontmatter.
 *
 * Inline styles are not handled here: on Astro 7.3 a runtime `insertStyleHash` never reaches the emitted policy,
 * so the fixed inline styles are hashed at build time in astro.config.ts instead.
 *
 * `Astro.csp` is undefined in `astro dev` (the feature is build-only), so callers pass it through as-is.
 */

export type CspHash = `sha256-${string}`;

const cache = new Map<string, Promise<CspHash>>();

async function computeHash(content: string): Promise<CspHash> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return `sha256-${btoa(binary)}`;
}

/** The CSP source expression for inline content, exactly as a browser hashes the element's text. */
export function cspHash(content: string): Promise<CspHash> {
  let hash = cache.get(content);
  if (!hash) {
    hash = computeHash(content);
    cache.set(content, hash);
  }
  return hash;
}

/** The subset of Astro's runtime CSP API used here. */
export interface CspInserter {
  insertScriptHash(hash: CspHash): void;
}

export async function allowInlineScripts(csp: CspInserter | undefined, ...contents: string[]): Promise<void> {
  if (!csp) return;
  for (const content of contents) csp.insertScriptHash(await cspHash(content));
}
