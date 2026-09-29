import { parseSitemapSegment } from "@marketplace/seo";
import type { APIRoute } from "astro";

import { createRequestContext } from "../server/request-context";
import { notFoundText, xmlResponse } from "../server/responses";
import { renderSitemapSegment } from "../server/site-index";

export const prerender = false;

/** One sitemap segment. Unknown names and package segments past the end of the catalogue are 404s. */
export const GET: APIRoute = async ({ params }) => {
  const segment = parseSitemapSegment(params.segment ?? "");
  if (!segment) return notFoundText("No such sitemap.");
  const { deps, vars } = createRequestContext();
  const xml = await renderSitemapSegment(deps, vars.PUBLIC_SITE_URL, segment);
  return xml === null ? notFoundText("No such sitemap.") : xmlResponse(xml);
};
