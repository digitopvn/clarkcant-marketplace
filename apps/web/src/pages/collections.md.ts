import { listCollections } from "@marketplace/marketplace";
import { canonicalUrl, renderCollectionsIndexMarkdown } from "@marketplace/seo";
import type { APIRoute } from "astro";

import { createRequestContext } from "../server/request-context";
import { markdownResponse } from "../server/responses";

export const prerender = false;

/** Markdown twin of the collections index. */
export const GET: APIRoute = async () => {
  const { deps, vars } = createRequestContext();
  const collections = await listCollections(deps);
  return markdownResponse(renderCollectionsIndexMarkdown(vars.PUBLIC_SITE_URL, collections), {
    canonical: canonicalUrl(vars.PUBLIC_SITE_URL, "/collections"),
  });
};
