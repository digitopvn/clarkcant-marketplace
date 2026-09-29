import { defineConfig, devices } from "@playwright/test";

// BASE_URL points the suite at a deployed environment (staging smoke). Without it, the suite
// starts the local dev server on the fixed port after applying local D1 migrations.
const externalBaseUrl = process.env.BASE_URL;
const LOCAL_URL = "http://localhost:4321";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: externalBaseUrl ?? LOCAL_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: "pnpm db:migrate:local && pnpm dev",
        url: `${LOCAL_URL}/api/v1/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        stdout: "pipe",
      },
});
