import { createRoute, z } from "@hono/zod-openapi";
import { listPackagesQuerySchema, packageDetailSchema, packageSummarySchema, pageOf } from "@marketplace/contracts";
import { getPackage, listPackages } from "@marketplace/marketplace";

import { errorResponses } from "../http/errors";
import { createRouter } from "../http/router";

const packagePageSchema = pageOf(packageSummarySchema);

const listPackagesRoute = createRoute({
  method: "get",
  path: "/packages",
  operationId: "listPackages",
  tags: ["packages"],
  summary: "List publicly visible packages",
  request: { query: listPackagesQuerySchema },
  responses: {
    200: { description: "A page of packages", content: { "application/json": { schema: packagePageSchema } } },
    ...errorResponses(400, 500),
  },
});

const getPackageRoute = createRoute({
  method: "get",
  path: "/packages/{name}",
  operationId: "getPackage",
  tags: ["packages"],
  summary: "Get one package by npm name (URL-encode scoped names: %40scope%2Fname)",
  request: {
    params: z.object({
      name: z
        .string()
        .min(1)
        .max(214)
        .openapi({ param: { name: "name", in: "path" }, example: "%40acme%2Fchart-widget" }),
    }),
  },
  responses: {
    200: {
      description: "Package detail",
      content: { "application/json": { schema: packageDetailSchema } },
    },
    ...errorResponses(400, 404, 500),
  },
});

export function createPackagesRouter() {
  return createRouter()
    .openapi(listPackagesRoute, async (c) => c.json(await listPackages(c.var.context.deps, c.req.valid("query")), 200))
    .openapi(getPackageRoute, async (c) =>
      c.json(await getPackage(c.var.context.deps, c.req.valid("param").name), 200),
    );
}
