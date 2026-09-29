import type { APIRoute } from "astro";

import { createRequestContext } from "../server/request-context";
import { textResponse } from "../server/responses";
import { buildLlmsTxt } from "../server/site-index";

export const prerender = false;

/** The llms.txt guide (https://llmstxt.org): a curated map of the site's Markdown twins and API. */
export const GET: APIRoute = async () => {
  const { deps, vars } = createRequestContext();
  return textResponse(await buildLlmsTxt(deps, vars.PUBLIC_SITE_URL));
};
