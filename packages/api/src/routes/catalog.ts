import { createRoute, z } from "@hono/zod-openapi";
import { categorySchema, collectionDetailSchema, collectionSummarySchema, slugSchema } from "@marketplace/contracts";
import { getCategory, getCollection, listCategories, listCollections } from "@marketplace/marketplace";

import { errorResponses } from "../http/errors";
import { createRouter } from "../http/router";
import { createCurationRouter } from "./curation";

const slugParams = z.object({
  slug: slugSchema,
});

function json<T extends z.ZodType>(description: string, schema: T) {
  return { description, content: { "application/json": { schema } } };
}

const listCategoriesRoute = createRoute({
  method: "get",
  path: "/categories",
  operationId: "listCategories",
  tags: ["catalog"],
  summary: "All categories with public package counts",
  responses: {
    200: json("Categories", z.object({ items: z.array(categorySchema) }).openapi("CategoryList")),
    ...errorResponses(500),
  },
});

const getCategoryRoute = createRoute({
  method: "get",
  path: "/categories/{slug}",
  operationId: "getCategory",
  tags: ["catalog"],
  summary: "One category with its public package count",
  request: { params: slugParams },
  responses: { 200: json("Category", categorySchema), ...errorResponses(400, 404, 500) },
});

const listCollectionsRoute = createRoute({
  method: "get",
  path: "/collections",
  operationId: "listCollections",
  tags: ["catalog"],
  summary: "Published editorial collections",
  responses: {
    200: json("Collections", z.object({ items: z.array(collectionSummarySchema) }).openapi("CollectionList")),
    ...errorResponses(500),
  },
});

const getCollectionRoute = createRoute({
  method: "get",
  path: "/collections/{slug}",
  operationId: "getCollection",
  tags: ["catalog"],
  summary: "One published collection with its public packages, in editorial order",
  request: { params: slugParams },
  responses: {
    200: json("Collection with its packages", collectionDetailSchema),
    ...errorResponses(400, 404, 500),
  },
});

/** Public catalog reads plus the curator commands that shape them (see `./curation`). */
export function createCatalogRouter() {
  return createRouter()
    .route("/", createCurationRouter())
    .openapi(listCategoriesRoute, async (c) => c.json({ items: await listCategories(c.var.context.deps) }, 200))
    .openapi(getCategoryRoute, async (c) =>
      c.json(await getCategory(c.var.context.deps, c.req.valid("param").slug), 200),
    )
    .openapi(listCollectionsRoute, async (c) => c.json({ items: await listCollections(c.var.context.deps) }, 200))
    .openapi(getCollectionRoute, async (c) =>
      c.json(await getCollection(c.var.context.deps, c.req.valid("param").slug), 200),
    );
}
