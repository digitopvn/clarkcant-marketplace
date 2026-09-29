import { listCategories, listPackages } from "@marketplace/marketplace";
import { canonicalUrl, renderPackagesIndexMarkdown } from "@marketplace/seo";
import type { APIRoute } from "astro";

import { createRequestContext } from "../server/request-context";
import { markdownResponse } from "../server/responses";

export const prerender = false;

/** Markdown twin of the unfiltered package listing (first page; the rest is reachable through the API). */
export const GET: APIRoute = async () => {
  const { deps, vars } = createRequestContext();
  const [categories, page] = await Promise.all([listCategories(deps), listPackages(deps, {})]);
  return markdownResponse(
    renderPackagesIndexMarkdown({ siteUrl: vars.PUBLIC_SITE_URL, packages: page.items, categories, hasMore: page.nextCursor !== null }),
    { canonical: canonicalUrl(vars.PUBLIC_SITE_URL, "/packages") },
  );
};
