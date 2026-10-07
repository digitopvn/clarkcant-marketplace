import { expect, test } from "@playwright/test";

test("home page renders the shell and a search form", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(/ClarkCant Marketplace/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("search")).toBeVisible();
  await expect(page.getByRole("contentinfo")).toContainText("npm distributes");
});

test("package search submits to the packages page", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Search packages").fill("widget");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/\/packages\?q=widget/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("widget");
});

test("health endpoint reports a reachable database", async ({ request }) => {
  const response = await request.get("/api/v1/health");
  expect(response.status()).toBe(200);
  expect(response.headers()["x-request-id"]).toBeTruthy();
  const body = (await response.json()) as { status: string; checks: { database: string } };
  expect(body.status).toBe("ok");
  expect(body.checks.database).toBe("ok");
});

test("OpenAPI document lists the public routes", async ({ request }) => {
  const response = await request.get("/openapi.json");
  expect(response.status()).toBe(200);
  const doc = (await response.json()) as { openapi: string; paths: Record<string, unknown> };
  expect(doc.openapi).toMatch(/^3\.1/);
  expect(Object.keys(doc.paths)).toEqual(
    expect.arrayContaining(["/api/v1/health", "/api/v1/packages", "/api/v1/search", "/api/v1/categories"]),
  );
});

test("directory feed serves a page ClarkCant can read, cacheable by shared caches", async ({ request }) => {
  const response = await request.get("/api/v1/directory", { headers: { accept: "application/json" } });
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("public");
  const body = (await response.json()) as { format: string; entries: unknown[]; nextCursor: string | null };
  expect(body.format).toBe("clarkcant-directory@1");
  expect(Array.isArray(body.entries)).toBe(true);
  expect(body.nextCursor === null || typeof body.nextCursor === "string").toBe(true);
});
