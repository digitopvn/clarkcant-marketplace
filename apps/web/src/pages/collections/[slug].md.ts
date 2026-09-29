import { isMarketplaceError } from "@marketplace/contracts";
import { getCollection } from "@marketplace/marketplace";
import { canonicalUrl, collectionPath, renderCollectionMarkdown } from "@marketplace/seo";
import type { APIRoute } from "astro";

import { createRequestContext } from "../../server/request-context";
import { markdownResponse, notFoundText } from "../../server/responses";

export const prerender = false;

/** Markdown twin of a published collection. */
export const GET: APIRoute = async ({ params }) => {
  const { deps, vars } = createRequestContext();
  try {
    const collection = await getCollection(deps, params.slug ?? "");
    return markdownResponse(renderCollectionMarkdown(vars.PUBLIC_SITE_URL, collection), {
      canonical: canonicalUrl(vars.PUBLIC_SITE_URL, collectionPath(collection.slug)),
    });
  } catch (error) {
    if (isMarketplaceError(error) && (error.code === "not_found" || error.code === "validation_failed")) {
      return notFoundText("There is no published collection with this name.");
    }
    throw error;
  }
};
