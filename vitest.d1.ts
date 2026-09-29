import path from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/** Must not exceed the newest date the pool's bundled workerd supports. Keep in step with the wrangler configs. */
export const COMPATIBILITY_DATE = "2026-08-15";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "migrations");
const APPLY_MIGRATIONS = path.resolve(import.meta.dirname, "test/d1/apply-migrations.ts");

/**
 * Vitest project that runs inside workerd with a real local D1 (`env.DB`) and the committed migrations applied
 * before each test file. Used by every package whose tests touch the database, so none of them mock it.
 */
export function d1TestProject(name: string, extra: { globalSetup?: string[] } = {}) {
  return defineConfig({
    plugins: [
      cloudflareTest(async () => ({
        miniflare: {
          compatibilityDate: COMPATIBILITY_DATE,
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          r2Buckets: ["MEDIA"],
          bindings: { TEST_MIGRATIONS: await readD1Migrations(MIGRATIONS_DIR) },
        },
      })),
    ],
    test: {
      name,
      include: ["test/**/*.test.ts"],
      setupFiles: [APPLY_MIGRATIONS],
      ...(extra.globalSetup ? { globalSetup: extra.globalSetup } : {}),
    },
  });
}
