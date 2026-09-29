import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "apps/web/vitest.config.ts", "apps/cli/vitest.config.ts", "apps/cli/vitest.node.config.ts"],
  },
});
