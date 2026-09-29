import type { APIRoute } from "astro";

import { createRequestContext } from "../server/request-context";
import { textResponse } from "../server/responses";
import { buildLlmsFullTxt } from "../server/site-index";

export const prerender = false;

/** The marketplace's own published pages as one Markdown document (package text stays on the package twins). */
export const GET: APIRoute = async () => {
  const { deps, vars } = createRequestContext();
  return textResponse(await buildLlmsFullTxt(deps, vars.PUBLIC_SITE_URL));
};
