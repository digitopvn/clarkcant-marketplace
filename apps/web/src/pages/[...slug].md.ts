import { isMarketplaceError } from "@marketplace/contracts";
import { HOME_PAGE_SLUG, getPublishedPage, pagePath, renderPageDocument } from "@marketplace/marketplace";
import { canonicalUrl } from "@marketplace/seo";
import type { APIRoute } from "astro";

import { createRequestContext } from "../server/request-context";
import { markdownResponse, notFoundText } from "../server/responses";

export const prerender = false;

/**
 * Markdown twin of a published builder page (`/about.md` mirrors `/about`). The body is the page engine's
 * `renderPage().markdown` for the live revision, the same text as `GET /api/v1/pages/{slug}?format=md`.
 */
export const GET: APIRoute = async ({ params }) => {
  const slug = params.slug ?? "";
  if (slug === HOME_PAGE_SLUG) return new Response(null, { status: 301, headers: { location: "/index.md" } });

  const { deps, vars } = createRequestContext();
  try {
    const page = await getPublishedPage(deps, slug);
    const path = pagePath(page.page.slug);
    const rendered = await renderPageDocument(deps, page.document, { mode: "public", siteUrl: vars.PUBLIC_SITE_URL, path });
    return markdownResponse(rendered.markdown, {
      canonical: canonicalUrl(vars.PUBLIC_SITE_URL, path),
      noindex: page.document.meta.noindex,
      etag: page.revisionId,
    });
  } catch (error) {
    if (isMarketplaceError(error) && (error.code === "not_found" || error.code === "validation_failed")) {
      return notFoundText("No published page at this address.");
    }
    throw error;
  }
};
