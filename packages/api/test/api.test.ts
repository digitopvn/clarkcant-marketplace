import { MarketplaceError, errorBodySchema, parseRuntimeVars } from "@marketplace/contracts";
import { createMarketplaceDeps } from "@marketplace/marketplace";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { createApi } from "../src";
import { resetDatabase, seedPackage, testDeps } from "../../marketplace/test/support/seed";

const vars = parseRuntimeVars({ PUBLIC_SITE_URL: "http://localhost:4321", ENVIRONMENT: "development", ADMIN_EMAILS: "" });
const api = createApi({ resolveContext: () => ({ deps: createMarketplaceDeps({ d1: env.DB }), vars }) });
const call = (path: string, init?: RequestInit) => api.request(`http://localhost${path}`, init);

beforeAll(async () => {
  const deps = testDeps();
  await resetDatabase(deps);
  await seedPackage(deps, {
    name: "@acme/chart-widget",
    displayName: "Chart",
    description: "Charts for dashboards",
    categorySlug: "data",
    publisher: { slug: "acme", name: "Acme" },
  });
});

describe("public API", () => {
  it("reports health with a request id", async () => {
    const response = await call("/api/v1/health", { headers: { "X-Request-Id": "trace-12345678" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-Id")).toBe("trace-12345678");
    expect(await response.json()).toMatchObject({ status: "ok", environment: "development", checks: { database: "ok" } });
  });

  it("lists, fetches and searches packages through the application layer", async () => {
    const list = await call("/api/v1/packages");
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ items: [{ name: "@acme/chart-widget" }], nextCursor: null });

    const detail = await call("/api/v1/packages/%40acme%2Fchart-widget");
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ name: "@acme/chart-widget", publisher: { slug: "acme" } });

    const search = await call("/api/v1/search?q=dashboards");
    expect(await search.json()).toMatchObject({ query: "dashboards", items: [{ name: "@acme/chart-widget" }] });
  });

  it("serves categories and collections", async () => {
    const categories = (await (await call("/api/v1/categories")).json()) as { items: { slug: string; packageCount: number }[] };
    expect(categories.items).toHaveLength(6);
    expect(categories.items.find((category) => category.slug === "data")?.packageCount).toBe(1);
    expect(await (await call("/api/v1/collections")).json()).toEqual({ items: [] });
    expect((await call("/api/v1/categories/nope")).status).toBe(404);
  });

  it("returns the contracts error shape for validation errors, missing resources and unknown routes", async () => {
    for (const [path, status, code] of [
      ["/api/v1/packages?limit=500", 400, "validation_failed"],
      ["/api/v1/packages/missing-package", 404, "not_found"],
      ["/api/v1/does-not-exist", 404, "not_found"],
    ] as const) {
      const response = await call(path);
      expect(response.status, path).toBe(status);
      const body = errorBodySchema.parse(await response.json());
      expect(body.error.code, path).toBe(code);
      expect(body.error.requestId).toBe(response.headers.get("X-Request-Id"));
    }
  });

  it("fails fast with configuration_error when runtime configuration is invalid", async () => {
    const broken = createApi({
      resolveContext: () => {
        throw new MarketplaceError("configuration_error", "Invalid runtime configuration: ENVIRONMENT: invalid");
      },
    });
    const response = await broken.request("http://localhost/api/v1/health");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "configuration_error" } });
  });

  it("publishes an OpenAPI 3.1 document covering every public route", async () => {
    const response = await call("/openapi.json");
    expect(response.status).toBe(200);
    const document = (await response.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths)).toEqual(expect.arrayContaining([
      "/api/v1/categories",
      "/api/v1/categories/{slug}",
      "/api/v1/collections",
      "/api/v1/collections/{slug}",
      "/api/v1/health",
      "/api/v1/packages",
      "/api/v1/packages/{name}",
      "/api/v1/search",
    ]));
  });
});
