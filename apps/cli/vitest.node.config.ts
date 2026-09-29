import { defineConfig } from "vitest/config";

/** Node-only CLI pieces: the credential file (permissions, atomic writes) and the process entry. */
export default defineConfig({
  test: { name: "cli-node", include: ["test-node/**/*.test.ts"], environment: "node" },
});
