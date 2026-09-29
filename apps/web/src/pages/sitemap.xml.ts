import { renderSitemapIndex } from "@marketplace/seo";
import type { APIRoute } from "astro";

import { createRequestContext } from "../server/request-context";
import { xmlResponse } from "../server/responses";
import { listSitemapSegments } from "../server/site-index";

export const prerender = false;

/** Sitemap index pointing at the segment files (`/sitemap-pages.xml`, `/sitemap-packages-1.xml`, …). */
export const GET: APIRoute = async () => {
  const { deps, vars } = createRequestContext();
  return xmlResponse(renderSitemapIndex(await listSitemapSegments(deps, vars.PUBLIC_SITE_URL)));
};
