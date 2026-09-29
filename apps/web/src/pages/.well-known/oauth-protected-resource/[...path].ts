import type { APIRoute } from "astro";

import { serveDiscovery } from "../../../server/mcp";

export const prerender = false;

/** RFC 9728 protected-resource metadata for `/mcp` (bare and `/mcp`-suffixed). */
export const ALL: APIRoute = ({ request, params }) => serveDiscovery("oauth-protected-resource", params.path, request);
