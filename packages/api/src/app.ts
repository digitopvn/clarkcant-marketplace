import { OpenAPIHono } from "@hono/zod-openapi";

import { handleError, handleNotFound, validationHook } from "./http/errors";
import { requestId } from "./http/request-id";
import { createAdminRouter } from "./routes/admin";
import { createCatalogRouter } from "./routes/catalog";
import { createHealthRouter } from "./routes/health";
import { createMeRouter } from "./routes/me";
import { createPackagesRouter } from "./routes/packages";
import { createPagesRouter } from "./routes/pages";
import { createPublishRouter } from "./routes/publish";
import { createSearchRouter } from "./routes/search";
import type { ApiEnv, CreateApiOptions } from "./types";

export const API_BASE_PATH = "/api/v1";
export const OPENAPI_PATH = "/openapi.json";

const API_DESCRIPTION =
  "Discovery and curation for ClarkCant packages. The marketplace lists and describes packages; npm distributes " +
  "them and ClarkCant installs and runs them. Nothing returned by this API grants runtime permissions.";

/**
 * Builds the public HTTP API. It serves `/api/v1/*` and `/openapi.json`; the host (the Astro web Worker) forwards
 * those paths here. Handlers only translate HTTP to application-service calls: no SQL and no business rules live in
 * this package.
 */
export function createApi(options: CreateApiOptions) {
  const app = new OpenAPIHono<ApiEnv>({ defaultHook: validationHook });

  app.use("*", requestId);
  app.use(`${API_BASE_PATH}/*`, async (c, next) => {
    c.set("context", await options.resolveContext(c.req.raw));
    await next();
  });

  app.route(API_BASE_PATH, createHealthRouter());
  app.route(API_BASE_PATH, createPackagesRouter());
  app.route(API_BASE_PATH, createSearchRouter());
  app.route(API_BASE_PATH, createCatalogRouter());
  app.route(API_BASE_PATH, createPagesRouter());
  app.route(API_BASE_PATH, createMeRouter());
  app.route(API_BASE_PATH, createPublishRouter());
  app.route(API_BASE_PATH, createAdminRouter());

  app.doc31(OPENAPI_PATH, (c) => ({
    openapi: "3.1.0",
    info: { title: "ClarkCant Marketplace API", version: options.version ?? "1.0.0", description: API_DESCRIPTION },
    servers: [{ url: new URL(c.req.url).origin }],
    tags: [
      { name: "system", description: "Health and metadata" },
      { name: "packages", description: "Package listings" },
      { name: "search", description: "Full-text search" },
      { name: "catalog", description: "Categories and collections" },
    ],
  }));

  app.onError(handleError);
  app.notFound(handleNotFound);
  return app;
}

export type MarketplaceApi = ReturnType<typeof createApi>;
