import { createRoute, z } from "@hono/zod-openapi";
import {
  listPackagesQuerySchema,
  packageDetailSchema,
  packageInstallSchema,
  packageSummarySchema,
  packageVersionSummarySchema,
  pageOf,
  semverSchema,
} from "@marketplace/contracts";
import { getPackage, getPackageInstall, listPackageVersions, listPackages } from "@marketplace/marketplace";

import { errorResponses } from "../http/errors";
import { createRouter } from "../http/router";

const packagePageSchema = pageOf(packageSummarySchema);

const nameParams = z.object({
  name: z
    .string()
    .min(1)
    .max(214)
    .openapi({ param: { name: "name", in: "path" }, example: "%40acme%2Fchart-widget" }),
});

const listPackagesRoute = createRoute({
  method: "get",
  path: "/packages",
  operationId: "listPackages",
  tags: ["packages"],
  summary: "List publicly visible packages",
  description:
    "Filters combine with AND: `q` (full text), `category`, facet `kind` and `isolation`, `platform`, `publisher` " +
    "(slug) and `curation` (`listed` or `featured`). Facet and platform filters apply to the latest version.",
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
  request: { params: nameParams },
  responses: {
    200: {
      description: "Package detail",
      content: { "application/json": { schema: packageDetailSchema } },
    },
    ...errorResponses(400, 404, 500),
  },
});

const listVersionsRoute = createRoute({
  method: "get",
  path: "/packages/{name}/versions",
  operationId: "listPackageVersions",
  tags: ["packages"],
  summary: "Every indexed version, newest first, with integrity and provenance facts",
  request: { params: nameParams },
  responses: {
    200: {
      description: "Indexed versions",
      content: {
        "application/json": {
          schema: z.object({ items: z.array(packageVersionSummarySchema) }).openapi("PackageVersionList"),
        },
      },
    },
    ...errorResponses(400, 404, 500),
  },
});

const installRoute = createRoute({
  method: "get",
  path: "/packages/{name}/install",
  operationId: "getPackageInstall",
  tags: ["packages"],
  summary: "Install coordinate for one exact version (latest unless `version` is given)",
  description:
    "Returns `{package, version, source: \"npm\", integrity}` plus the PROPOSED `clarkcant://install` deep link and a " +
    "CLI fallback. The marketplace never serves the artifact; ClarkCant downloads it from npm, re-verifies the " +
    "integrity and asks for consent. Nothing here grants permissions.",
  request: { params: nameParams, query: z.object({ version: semverSchema.optional() }) },
  responses: {
    200: { description: "Install coordinate", content: { "application/json": { schema: packageInstallSchema } } },
    ...errorResponses(400, 404, 500),
  },
});

export function createPackagesRouter() {
  return createRouter()
    .openapi(listPackagesRoute, async (c) => c.json(await listPackages(c.var.context.deps, c.req.valid("query")), 200))
    .openapi(getPackageRoute, async (c) =>
      c.json(await getPackage(c.var.context.deps, c.req.valid("param").name), 200),
    )
    .openapi(listVersionsRoute, async (c) =>
      c.json({ items: await listPackageVersions(c.var.context.deps, c.req.valid("param").name) }, 200),
    )
    .openapi(installRoute, async (c) =>
      c.json(
        await getPackageInstall(c.var.context.deps, c.req.valid("param").name, c.req.valid("query").version),
        200,
      ),
    );
}
