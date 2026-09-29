import { isMarketplaceError } from "@marketplace/contracts";
import { getPackage, getPackageInstall, listPackageVersions } from "@marketplace/marketplace";
import { canonicalUrl, packagePath, renderPackageMarkdown } from "@marketplace/seo";
import type { APIRoute } from "astro";

import { createRequestContext } from "../../server/request-context";
import { markdownResponse, notFoundText } from "../../server/responses";
import { decodeRouteParam } from "../../server/route-params";

export const prerender = false;

/** Markdown twin of a package page, rendered from the same canonical records (never from the README HTML). */
export const GET: APIRoute = async ({ params }) => {
  const name = decodeRouteParam(params.name);
  const { deps, vars } = createRequestContext();
  try {
    const pkg = await getPackage(deps, name);
    const [versions, install] = await Promise.all([
      listPackageVersions(deps, name),
      pkg.latestVersion ? getPackageInstall(deps, name) : Promise.resolve(null),
    ]);
    return markdownResponse(renderPackageMarkdown({ siteUrl: vars.PUBLIC_SITE_URL, pkg, install, versions }), {
      canonical: canonicalUrl(vars.PUBLIC_SITE_URL, packagePath(pkg.name)),
    });
  } catch (error) {
    if (isMarketplaceError(error) && (error.code === "not_found" || error.code === "validation_failed")) {
      return notFoundText("No listed package has this name.");
    }
    throw error;
  }
};
