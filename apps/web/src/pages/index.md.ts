import { isMarketplaceError } from "@marketplace/contracts";
import {
  HOME_PAGE_SLUG,
  getPublishedPage,
  listCategories,
  listFeaturedPackages,
  listLatestPackages,
  renderPageDocument,
} from "@marketplace/marketplace";
import { canonicalUrl, renderHomeMarkdown } from "@marketplace/seo";
import type { APIRoute } from "astro";

import { createRequestContext } from "../server/request-context";
import { markdownResponse } from "../server/responses";

export const prerender = false;

/** Markdown twin of `/`: the published builder home page when there is one, else the built-in landing. */
export const GET: APIRoute = async () => {
  const { deps, vars } = createRequestContext();
  const canonical = canonicalUrl(vars.PUBLIC_SITE_URL, "/");
  try {
    const page = await getPublishedPage(deps, HOME_PAGE_SLUG);
    const rendered = await renderPageDocument(deps, page.document, { mode: "public", siteUrl: vars.PUBLIC_SITE_URL, path: "/" });
    return markdownResponse(rendered.markdown, { canonical, noindex: page.document.meta.noindex, etag: page.revisionId });
  } catch (error) {
    if (!isMarketplaceError(error) || error.code !== "not_found") throw error;
  }
  const [featured, latest, categories] = await Promise.all([listFeaturedPackages(deps), listLatestPackages(deps), listCategories(deps)]);
  return markdownResponse(renderHomeMarkdown({ siteUrl: vars.PUBLIC_SITE_URL, featured, latest, categories }), { canonical });
};
