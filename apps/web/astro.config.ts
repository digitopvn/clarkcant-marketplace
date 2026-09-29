import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { BLOCK_STYLES } from "../../packages/page-engine/src/block-styles";
import { canvasStyle } from "./src/components/admin/canvas-document";

/** CSP source expression for inline content, hashed exactly as the browser hashes the element's text. */
function sha256(content: string): `sha256-${string}` {
  return `sha256-${createHash("sha256").update(content, "utf8").digest("base64")}`;
}

// Inline <style> elements Astro does not hash itself. They are fixed at build time, so they are allowed here:
// Astro 7.3's runtime `Astro.csp.insertStyleHash` does not reach the emitted policy, while script inserts do.
// - the page engine's block styles (components/page-engine/RenderedPage.astro, on every rendered page);
// - the builder canvas stylesheet (srcdoc iframes inherit the builder page's policy; see admin/pages/[id].astro).
const TOKENS_CSS = readFileSync(new URL("./src/styles/tokens.css", import.meta.url), "utf8");
const INLINE_STYLE_HASHES = [sha256(BLOCK_STYLES), sha256(canvasStyle(`${TOKENS_CSS}\n${BLOCK_STYLES}`))];

// Server-rendered on Cloudflare Workers. The target environment (top-level dev, `staging`, `production`) is chosen
// at build time with CLOUDFLARE_ENV, which selects the matching block of wrangler.jsonc.
export default defineConfig({
  output: "server",
  // Sessions are not used, so the adapter must not provision a SESSION KV namespace.
  session: false,
  adapter: cloudflare({
    // Images are served as-is; avoids an IMAGES binding the platform does not need yet.
    imageService: "passthrough",
  }),
  integrations: [react()],
  // Content Security Policy for every server-rendered page, emitted as a <meta> tag with a hash for each script and
  // style Astro renders (islands, bundled scripts, inlined CSS). Inline content Astro does not process itself is
  // allowed by hash at runtime (src/server/csp.ts). Directives that only work as a header (frame-ancestors) are sent
  // by src/middleware/security-headers.ts. Not active under `astro dev` (Vite serves unhashed modules).
  security: {
    csp: {
      algorithm: "SHA-256",
      directives: [
        "default-src 'self'",
        // README and preview images may be hosted by package authors; they can never run code.
        "img-src 'self' data: https:",
        "font-src 'self' https://fonts.gstatic.com",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "manifest-src 'self'",
        "worker-src 'none'",
      ],
      styleDirective: {
        // React islands set `style` attributes (e.g. the builder canvas width); inline <style> elements still need
        // a hash. `'unsafe-inline'` scoped to attributes cannot load or run anything.
        resources: ["'self'", "https://fonts.googleapis.com", { resource: "'unsafe-inline'", kind: "attribute" }],
        hashes: INLINE_STYLE_HASHES,
      },
      scriptDirective: {
        resources: ["'self'"],
      },
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
  server: { port: 4321 },
});
