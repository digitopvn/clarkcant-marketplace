import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

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
  vite: {
    plugins: [tailwindcss()],
  },
  server: { port: 4321 },
});
