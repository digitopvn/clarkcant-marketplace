import { createRoute, z } from "@hono/zod-openapi";
import { ANONYMOUS_ACTOR, directoryEntrySchema, directoryFeedPageSchema, directoryFeedQuerySchema } from "@marketplace/contracts";
import { getDirectoryFeedPage } from "@marketplace/marketplace";

import { errorResponses } from "../http/errors";
import { createRouter } from "../http/router";

/** The feed is the same for every caller, so shared caches may hold a page briefly; indexing shows up within minutes. */
export const DIRECTORY_CACHE_CONTROL = "public, max-age=300, s-maxage=300";

// Rebuilt from the contract shapes with the OpenAPI-aware `z`, which is what names a component in the document.
const directoryEntry = z.strictObject(directoryEntrySchema.shape).openapi("DirectoryEntry");
const directoryFeedPage = z
  .strictObject({ ...directoryFeedPageSchema.shape, entries: z.array(directoryEntry) })
  .openapi("DirectoryFeedPage");

const getDirectoryRoute = createRoute({
  method: "get",
  path: "/directory",
  operationId: "getDirectoryFeed",
  tags: ["directory"],
  summary: "ClarkCant's directory feed (clarkcant-directory@1): one entry per listed npm package version",
  description:
    "The feed ClarkCant's official directory source reads. Each entry describes one publicly listed, measured " +
    "version in ClarkCant's `DirectoryEntry` shape: the `clarkcant.json` package id and facts, the npm coordinate, " +
    "and the runtime content `digest` and `sizeBytes` of the archive. Pages follow `nextCursor` (null on the last " +
    "page) and hold at most `limit` entries. When two npm packages declare one package id, only the holder is listed: " +
    "a verified publisher first, then the first to claim it. Entries are discovery claims, never authority: ClarkCant " +
    "re-resolves the npm version, verifies npm's integrity and the digest, and applies its own policy.",
  request: { query: directoryFeedQuerySchema },
  responses: {
    200: {
      description: "One page of the directory feed",
      content: { "application/json": { schema: directoryFeedPage } },
    },
    ...errorResponses(400, 500),
  },
});

export function createDirectoryRouter() {
  return createRouter().openapi(getDirectoryRoute, async (c) => {
    const page = await getDirectoryFeedPage(c.var.context.deps, c.req.valid("query"), {
      siteUrl: c.var.context.vars.PUBLIC_SITE_URL,
    });
    // A request that carried credentials keeps the actor middleware's `private, no-store`.
    if (c.var.actor === ANONYMOUS_ACTOR) c.header("Cache-Control", DIRECTORY_CACHE_CONTROL);
    return c.json(page, 200);
  });
}
