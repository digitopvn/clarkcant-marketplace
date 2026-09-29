import { createRoute, z } from "@hono/zod-openapi";
import { errorBodySchema, pageSlugSchema } from "@marketplace/contracts";
import { getPublishedPage, pageApiSchemas, pagePath, renderPageDocument } from "@marketplace/marketplace";

import { createRouter } from "../http/router";

const errorResponse = (description: string) => ({ description, content: { "application/json": { schema: errorBodySchema } } });

const getPageRoute = createRoute({
  method: "get",
  path: "/pages/{slug}",
  operationId: "getPublishedPage",
  tags: ["pages"],
  summary: "Get the published revision of a page (URL-encode nested slugs: docs%2Finstall)",
  description:
    "Returns the live `PageDocument` as JSON, or its Markdown rendering with `?format=md`. Drafts are never " +
    "returned here; unpublished pages answer 404.",
  request: {
    params: z.object({
      // Contracts schemas are plain zod (no `.openapi()` at runtime); the path parameter is documented by name.
      slug: pageSlugSchema,
    }),
    query: z.object({ format: z.enum(["json", "md"]).default("json") }),
  },
  responses: {
    200: {
      description: "The published page",
      content: {
        "application/json": { schema: pageApiSchemas.publishedPage },
        "text/markdown": { schema: z.string() },
      },
    },
    400: errorResponse("Invalid slug or format (`validation_failed`)"),
    404: errorResponse("No published page with this slug"),
    500: errorResponse("Server error"),
  },
});

/** Public, read-only page documents. Everything that changes pages lives under `/admin/pages`. */
export function createPagesRouter() {
  return createRouter().openapi(getPageRoute, async (c) => {
    const { deps, vars } = c.var.context;
    const { slug } = c.req.valid("param");
    const page = await getPublishedPage(deps, slug);
    c.header("ETag", `"${page.revisionId}"`);
    if (c.req.valid("query").format === "md") {
      const rendered = await renderPageDocument(deps, page.document, {
        mode: "public",
        siteUrl: vars.PUBLIC_SITE_URL,
        path: pagePath(page.page.slug),
      });
      // `c.body` keeps the typed-route contract while serving the Markdown alternate of the same resource.
      return c.body(rendered.markdown, 200, { "Content-Type": "text/markdown; charset=utf-8" }) as never;
    }
    return c.json(page, 200);
  });
}
