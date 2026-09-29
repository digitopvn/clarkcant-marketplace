import { renderRobotsTxt } from "@marketplace/seo";
import type { APIRoute } from "astro";

import { runtimeVars } from "../server/request-context";
import { textResponse } from "../server/responses";

export const prerender = false;

/** Only production may be indexed; staging and local copies ask every crawler to stay out. */
export const GET: APIRoute = () => {
  const vars = runtimeVars();
  return textResponse(renderRobotsTxt({ siteUrl: vars.PUBLIC_SITE_URL, allowIndexing: vars.ENVIRONMENT === "production" }));
};
