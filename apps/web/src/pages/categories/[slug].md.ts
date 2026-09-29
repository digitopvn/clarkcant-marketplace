import { isMarketplaceError } from "@marketplace/contracts";
import { getCategory, listPackages } from "@marketplace/marketplace";
import { canonicalUrl, categoryPath, renderCategoryMarkdown } from "@marketplace/seo";
import type { APIRoute } from "astro";

import { createRequestContext } from "../../server/request-context";
import { markdownResponse, notFoundText } from "../../server/responses";

export const prerender = false;

/** Markdown twin of a category page (first page of packages; the rest is reachable through the API). */
export const GET: APIRoute = async ({ params }) => {
  const { deps, vars } = createRequestContext();
  try {
    const category = await getCategory(deps, params.slug ?? "");
    const page = await listPackages(deps, { category: category.slug });
    return markdownResponse(renderCategoryMarkdown(vars.PUBLIC_SITE_URL, category, page.items, page.nextCursor !== null), {
      canonical: canonicalUrl(vars.PUBLIC_SITE_URL, categoryPath(category.slug)),
    });
  } catch (error) {
    if (isMarketplaceError(error) && (error.code === "not_found" || error.code === "validation_failed")) {
      return notFoundText("There is no category with this name.");
    }
    throw error;
  }
};
