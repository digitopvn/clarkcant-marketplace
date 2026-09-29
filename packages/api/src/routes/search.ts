import { createRoute } from "@hono/zod-openapi";
import { searchQuerySchema, searchResultSchema } from "@marketplace/contracts";
import { searchPackages } from "@marketplace/marketplace";

import { errorResponses } from "../http/errors";
import { createRouter } from "../http/router";

const searchRoute = createRoute({
  method: "get",
  path: "/search",
  operationId: "searchPackages",
  tags: ["search"],
  summary: "Full-text search over publicly visible packages; an empty `q` browses by recency",
  request: { query: searchQuerySchema },
  responses: {
    200: {
      description: "Ranked results",
      content: { "application/json": { schema: searchResultSchema } },
    },
    ...errorResponses(400, 500),
  },
});

export function createSearchRouter() {
  return createRouter().openapi(searchRoute, async (c) =>
    c.json(await searchPackages(c.var.context.deps, c.req.valid("query")), 200),
  );
}
