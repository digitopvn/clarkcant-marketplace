import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/db/src/schema/index.ts",
  out: "./migrations",
  strict: true,
  verbose: true,
});
